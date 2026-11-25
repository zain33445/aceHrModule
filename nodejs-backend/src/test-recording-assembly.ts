/**
 * test-recording-assembly.ts — checks run splitting + ffmpeg assembly without a DB.
 *
 * Generates two short WebM files with ffmpeg-static, cuts each into 5 arbitrary
 * byte chunks (simulating two MediaRecorder runs in one session), assembles them
 * and checks the output duration (~6s) and run count. Run: npm run test-recording-assembly
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import assert from 'assert';
import { spawnSync } from 'child_process';
import { assembleChunkFiles } from './services/recording.service';
import { probeDims, reencodeArgs, initFromChunks, remuxChunks, remuxTail, decodesClean } from './services/recording-v2.service';

const ffmpeg: string = require('ffmpeg-static');

function makeWebm(out: string, freq: number) {
  const r = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', `testsrc=duration=3:size=320x240:rate=10`,
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=3`,
    '-c:v', 'libvpx', '-c:a', 'libvorbis', '-shortest', out,
  ]);
  assert.strictEqual(r.status, 0, `ffmpeg generate failed: ${r.stderr?.toString().slice(-300)}`);
}

/** Split a file's bytes into n arbitrary pieces written as separate files. */
function splitToChunks(file: string, dir: string, prefix: string, n = 5): string[] {
  const buf = fs.readFileSync(file);
  const size = Math.ceil(buf.length / n);
  const paths: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = path.join(dir, `${prefix}-${String(i).padStart(5, '0')}.webm`);
    fs.writeFileSync(p, buf.subarray(i * size, (i + 1) * size));
    paths.push(p);
  }
  return paths;
}

function duration(file: string): number {
  const r = spawnSync(ffmpeg, ['-i', file]);
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.stderr.toString());
  assert.ok(m, 'no Duration in ffmpeg output');
  return Number(m![1]) * 3600 + Number(m![2]) * 60 + Number(m![3]);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-asm-'));
  try {
    const srcDir = path.join(root, 'src');
    const outDir = path.join(root, 'out');
    fs.mkdirSync(srcDir);
    fs.mkdirSync(outDir);

    makeWebm(path.join(srcDir, 'a.webm'), 440);
    makeWebm(path.join(srcDir, 'b.webm'), 880);
    const a = splitToChunks(path.join(srcDir, 'a.webm'), srcDir, 'a');
    const b = splitToChunks(path.join(srcDir, 'b.webm'), srcDir, 'b');

    // Two runs in one session. A missing chunk file must be skipped, not fatal.
    const two = await assembleChunkFiles([...a, path.join(srcDir, 'does-not-exist.webm'), ...b], outDir);
    assert.strictEqual(two.runs, 2, `expected 2 runs, got ${two.runs}`);
    const d2 = duration(two.outputPath);
    assert.ok(Math.abs(d2 - 6) <= 1, `two-run duration ${d2}s not ~6s`);

    // Single run.
    const one = await assembleChunkFiles(a, outDir);
    assert.strictEqual(one.runs, 1);
    const d1 = duration(one.outputPath);
    assert.ok(Math.abs(d1 - 3) <= 1, `single-run duration ${d1}s not ~3s`);

    // Only the two outputs may remain (temp/run files cleaned).
    const left = fs.readdirSync(outDir).sort();
    assert.strictEqual(left.length, 2, `unexpected leftovers: ${left.join(', ')}`);

    // Codec/dims probing + normalising a mismatched clip to the reference (vp9 320x240) via reencodeArgs.
    const gen = (out: string, size: string, v: string[]) => {
      const r = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', `testsrc=duration=2:size=${size}:rate=10`, ...v, out]);
      assert.strictEqual(r.status, 0, `ffmpeg generate failed: ${r.stderr?.toString().slice(-300)}`);
    };
    const ref = path.join(srcDir, 'ref9.webm'), odd = path.join(srcDir, 'odd8.webm'), norm = path.join(srcDir, 'norm.webm');
    gen(ref, '320x240', reencodeArgs('vp9'));
    gen(odd, '160x120', reencodeArgs('vp8'));
    const dRef = await probeDims(ref), dOdd = await probeDims(odd);
    assert.deepStrictEqual([dRef?.codec, dRef?.width, dRef?.height], ['vp9', 320, 240]);
    assert.deepStrictEqual([dOdd?.codec, dOdd?.width, dOdd?.height], ['vp8', 160, 120]);
    const vf = 'scale=320:240:force_original_aspect_ratio=decrease,pad=320:240:(ow-iw)/2:(oh-ih)/2';
    const rn = spawnSync(ffmpeg, ['-y', '-i', odd, '-vf', vf, ...reencodeArgs(dRef!.codec), '-f', 'webm', norm]);
    assert.strictEqual(rn.status, 0, `normalise failed: ${rn.stderr?.toString().slice(-300)}`);
    const dNorm = await probeDims(norm);
    assert.deepStrictEqual([dNorm?.codec, dNorm?.width, dNorm?.height], ['vp9', 320, 240]);


    // Realistic MediaRecorder-like WebM: VP9, live (unknown-size Segment, no Cues), 1 s clusters, a keyframe every 5 s,
    // cut at arbitrary bytes. A tail without seq 0 (chunks 3..5) gets the header of chunk 0 and must play.
    const live = path.join(srcDir, 'live.webm');
    const rl = spawnSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=24:size=320x180:rate=15', '-pix_fmt', 'yuv420p', '-c:v', 'libvpx-vp9', '-b:v', '200k', '-g', '75',
      '-deadline', 'realtime', '-cpu-used', '8', '-f', 'webm', '-live', '1', '-cluster_time_limit', '1000', live]);
    assert.strictEqual(rl.status, 0, `live generate failed: ${rl.stderr?.toString().slice(-300)}`);
    const liveBuf = fs.readFileSync(live);
    const cuts = [0, 1, 70_001, 151_003, 233_777, 301_234, 367_891, liveBuf.length]; // chunk 0 is ONE byte (a still screen): the header continues in chunk 1
    const lp = cuts.slice(0, -1).map((c, i) => { const p = path.join(srcDir, `live-${i}.part`); fs.writeFileSync(p, liveBuf.subarray(c, cuts[i + 1])); return p; });
    const init = initFromChunks([fs.readFileSync(lp[0]), fs.readFileSync(lp[1])]);
    assert.ok(init && init.length > 100 && init.length < 2000, 'init bytes from chunk 0');
    const temps: string[] = [];
    const noHdr = await remuxChunks(lp.slice(4), 12_000, outDir, 'nohdr', temps);
    assert.strictEqual(noHdr, null, 'a tail without any header must not be accepted');
    const grafted = await remuxTail(lp.slice(4), 12_000, outDir, 'graft', temps, init!);
    assert.ok(grafted, 'tail + init must remux');
    assert.ok((grafted!.probe.packets ?? 0) > 100, `grafted packets ${grafted!.probe.packets}`);
    assert.ok(await decodesClean(grafted!.file), 'grafted tail decodes 3 s without errors');
    assert.ok(grafted!.probe.durationMs > 8000 && grafted!.probe.durationMs < 16000, `grafted duration ${grafted!.probe.durationMs} ms`);
    // a tail that starts INSIDE the header (first stored chunk is seq 1: rest of the header, then clusters): the header must not be put in front of it twice
    const inside = await remuxTail(lp.slice(1), 25_000, outDir, 'inside', temps, init!);
    assert.ok(inside, 'tail that starts inside the header must remux');
    assert.ok((inside!.probe.packets ?? 0) > 340, `whole stream from seq 1: ${inside!.probe.packets} packets`);
    assert.ok(await decodesClean(inside!.file), 'decodes cleanly');
    for (const t of temps) fs.rmSync(t, { force: true });
    console.log(`PASS graft: a tail starting inside the header (seq 1) = ${inside!.probe.packets} packets`);
    console.log(`PASS graft: VP9 live, 1 s clusters, cut at arbitrary bytes: tail chunks 4..6 + init (${init!.length} B) = ${grafted!.probe.packets} packets, ${Math.round(grafted!.probe.durationMs / 100) / 10} s`);

    console.log(`PASS probe+normalise vp8 160x120 -> vp9 320x240`);
    console.log(`PASS two-run: runs=2 duration=${d2.toFixed(2)}s | single-run: runs=1 duration=${d1.toFixed(2)}s`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
