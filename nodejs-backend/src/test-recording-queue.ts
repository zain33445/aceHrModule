/**
 * test-recording-queue.ts — assembly queue order, failure backoff and the ffmpeg timeout. No DB needed.
 * (Importing the service opens the Prisma pool lazily; nothing is queried.) Run: npm run test-recording-queue
 */
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { pickAssemblies, assemblyBackoffMs, AssemblyCandidate, expectedMs, shortProblem, reencodeKeptVideo, videoPackets, joinVerified, isInfraFailure, isAmbiguousFailure, ambiguousIsTransient } from './services/recording-v2.service';
import { assemblyDue, rebuildKeepsVideo, extractInit, initFromChunks, firstClusterAt, keptFilesDeletable, chooseRef, tailStartMs, parseManifest, partsExpired } from './services/recording-v2.service';
import { runFfmpeg, DEFAULT_FFMPEG_TIMEOUT_MS } from './services/recording.service';

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const MIN = 60_000;
let n = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  assert.deepStrictEqual(got, want, `${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  n++;
};
const cand = (id: string, attempts: number, idleMin: number, nextInMin: number | null = null): AssemblyCandidate => ({
  id, attempts, lastChunkAt: new Date(NOW - idleMin * MIN), nextAt: nextInMin === null ? null : new Date(NOW + nextInMin * MIN),
});

async function main() {
  // ── pickAssemblies ───────────────────────────────────────
  eq('untried (0 attempts) beats failed, whatever the age', pickAssemblies([cand('failed', 1, 600), cand('fresh', 0, 40)], NOW, 1), ['fresh']);
  eq('fewer attempts first', pickAssemblies([cand('a3', 3, 900), cand('a1', 1, 100), cand('a2', 2, 500)], NOW, 3), ['a1', 'a2', 'a3']);
  eq('same attempts: oldest last chunk first', pickAssemblies([cand('new', 0, 40), cand('old', 0, 900), cand('mid', 0, 300)], NOW, 3), ['old', 'mid', 'new']);
  eq('only freeSlots are returned', pickAssemblies([cand('a', 0, 100), cand('b', 0, 200), cand('c', 0, 300)], NOW, 2), ['c', 'b']);
  eq('no free slot → nothing', pickAssemblies([cand('a', 0, 100)], NOW, 0), []);
  eq('nothing pending → nothing', pickAssemblies([], NOW, 1), []);
  eq('assembly_next_at in the future is skipped', pickAssemblies([cand('wait', 0, 500, 10), cand('go', 2, 100)], NOW, 2), ['go']);
  eq('assembly_next_at in the past or exactly now is due', pickAssemblies([cand('past', 1, 100, -5), cand('now', 1, 200, 0)], NOW, 2), ['now', 'past']);
  const input = [cand('b', 1, 10), cand('a', 0, 20)];
  pickAssemblies(input, NOW, 2);
  eq('the input list is not reordered', input.map((c) => c.id), ['b', 'a']);

  // ── backoff ──────────────────────────────────────────────
  eq('backoff after 1 failure = 10 min', assemblyBackoffMs(1), 10 * MIN);
  eq('backoff doubles', [assemblyBackoffMs(2), assemblyBackoffMs(3)], [20 * MIN, 40 * MIN]);
  eq('backoff capped at 6 h', [assemblyBackoffMs(10), assemblyBackoffMs(40)], [6 * 60 * MIN, 6 * 60 * MIN]);

  // ── starvation: 3 always-failing small sessions + 1 healthy big one, sweep every 5 min, one slot ──
  for (const startAttempts of [1, 0]) {
    type S = AssemblyCandidate & { fails: boolean; runs: number; done: boolean };
    const mk = (id: string, fails: boolean, idleMin: number): S => ({ ...cand(id, startAttempts, idleMin), fails, runs: 0, done: false });
    const sessions: S[] = [mk('small-1', true, 900), mk('small-2', true, 800), mk('small-3', true, 700), mk('big', false, 40)];
    let healthyRanAtSweep = -1;
    for (let sweep = 0; sweep < 288; sweep++) { // 24 h
      const t = NOW + sweep * 5 * MIN;
      const pick = pickAssemblies(sessions.filter((s) => !s.done), t, 1)[0];
      if (!pick) continue;
      const s = sessions.find((x) => x.id === pick)!;
      s.runs++;
      if (!s.fails) { s.done = true; healthyRanAtSweep = sweep; continue; }
      s.attempts++;
      s.nextAt = new Date(t + assemblyBackoffMs(s.attempts));
    }
    assert.ok(healthyRanAtSweep >= 0 && healthyRanAtSweep <= 3, `startAttempts=${startAttempts}: healthy session ran at sweep ${healthyRanAtSweep}, want within the first 4`);
    n++;
    const worst = Math.max(...sessions.filter((s) => s.fails).map((s) => s.runs));
    assert.ok(worst <= 14, `startAttempts=${startAttempts}: a failing session ran ${worst}x in 24 h (96x was the starvation bug)`);
    n++;
  }

  // ── coverage: expected = Σ chunk duration (null = 10 s, each capped at 60 s); tolerance max(15 s, 1 %) ──
  eq('expected: null = 10 s, a chunk counts at most 60 s', expectedMs([{ duration_ms: null }, { duration_ms: 600_000 }, { duration_ms: 1000 }]), 71_000);
  eq('an hour that is 6 s short is fine (the worst of 15 real segments)', shortProblem(3_600_000 - 6000, 3_600_000), null);
  eq('1.8 s short of a 110 s segment is fine', shortProblem(108_200, 110_000), null);
  eq('15 s short of 110 s is still fine (floor 15 s)', shortProblem(95_000, 110_000), null);
  eq('37 s short of an hour is flagged (1 % = 36 s)', shortProblem(3_600_000 - 37_000, 3_600_000), 'only 59.4 of 60.0 min readable');
  eq('6 min short of an hour is flagged', typeof shortProblem(3_240_000, 3_600_000), 'string');
  eq('playing longer than expected (PC slept) is fine', shortProblem(200_000, 110_000), null);
  eq('a re-encode may lose 5 s at most', [reencodeKeptVideo(60_000, 55_000), reencodeKeptVideo(60_000, 54_999)], [true, false]);

  // ── join verification: duration AND video packets ──
  eq('packets parsed from ffmpeg -v verbose', videoPackets(['x', '[out#0/null @ 0000]   Output stream #0:0 (video): 30 packets muxed (19930 bytes); ', '[out#0/null @ 0000]   Output stream #0:1 (audio): 131 packets muxed (5106 bytes);'].join('\n')), 30);
  eq('no packet line → null', videoPackets('size=N/A time=00:00:02.90'), null);
  eq('join ok: duration and packets', joinVerified({ ms: 6000, packets: 60 }, { ms: 5950, packets: 60 }), true);
  eq('join lost an input but exited 0: fewer packets → rejected', joinVerified({ ms: 6000, packets: 60 }, { ms: 5950, packets: 30 }), false);
  eq('join too short by duration → rejected', joinVerified({ ms: 6000, packets: 60 }, { ms: 3000, packets: 60 }), false);
  eq('packets unknown → duration check only', joinVerified({ ms: 6000, packets: null }, { ms: 5950, packets: 60 }), true);

  // ── infrastructure failures are not the media's fault ──
  eq('missing binary / spawn error is infrastructure', isInfraFailure({ code: -1, stderr: 'spawn ENOENT' }), true);
  eq('a timeout is not', isInfraFailure({ code: -1, stderr: 'timeout' }), false);
  eq('killed (code null) is infrastructure', isInfraFailure({ code: null, stderr: '' }), true);
  eq('Windows 0xC000013A is infrastructure', isInfraFailure({ code: 0xC000013A, stderr: '' }), true);
  eq('disk full is certain infrastructure', isInfraFailure({ code: 1, stderr: 'x No space left on device' }), true);
  const amb = ['Cannot allocate memory', 'Input/output error', 'Permission denied'];
  eq('memory / I/O / permission texts are NOT certain (corrupt media prints them too)', amb.map((m) => isInfraFailure({ code: 1, stderr: `x ${m}` })), [false, false, false]);
  eq('…they are ambiguous', amb.map((m) => isAmbiguousFailure({ code: 1, stderr: `x ${m}` })), [true, true, true]);
  eq('certain infrastructure and plain bad media are not ambiguous', [isAmbiguousFailure({ code: -1, stderr: 'spawn ENOENT' }), isAmbiguousFailure({ code: 1, stderr: 'Invalid data found when processing input' })], [false, false]);
  eq('ambiguous: throws for the first 3 attempts, from the 4th run it is that segment\'s problem', [0, 1, 2, 3, 4].map(ambiguousIsTransient), [true, true, true, false, false]);
  eq('invalid media is not', isInfraFailure({ code: 1, stderr: 'Invalid data found when processing input' }), false);
  eq('no explicit timeout means 3 h, never forever', DEFAULT_FFMPEG_TIMEOUT_MS, 3 * 3600_000);

  // ── stage 2: init bytes (EBML header .. first Cluster) ──
  const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
  const SEG_UNKNOWN = Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  const INFO = Buffer.from([0x15, 0x49, 0xa9, 0x66, 0x83, 1, 2, 3]);
  const CLUSTER = Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x84, 9, 9, 9, 9]);
  const head = Buffer.concat([EBML, SEG_UNKNOWN, INFO]);
  eq('init = the bytes before the first Cluster', extractInit(Buffer.concat([head, CLUSTER, Buffer.alloc(50, 7)]))?.equals(head), true);
  eq('not a WebM start → no init', extractInit(Buffer.concat([Buffer.alloc(20, 1), CLUSTER])), null);
  eq('no Cluster in the chunk → no init', extractInit(Buffer.concat([head, Buffer.alloc(100, 3)])), null);
  eq('a Cluster beyond 64 KB → no init', extractInit(Buffer.concat([EBML, SEG_UNKNOWN, Buffer.alloc(70_000, 1), CLUSTER])), null);
  const knownSeg = Buffer.concat([EBML, Buffer.from([0x18, 0x53, 0x80, 0x67, 0x40, 0x28]), INFO]); // Segment with a known size (2-byte size field)
  const fixed = extractInit(Buffer.concat([knownSeg, CLUSTER]))!;
  eq('a known-size Segment becomes unknown-size (grafted clusters must not fall outside it)', fixed.subarray(EBML.length, EBML.length + SEG_UNKNOWN.length).equals(SEG_UNKNOWN) && fixed.subarray(EBML.length + SEG_UNKNOWN.length).equals(INFO), true);

  // ── when a session is due: idle 30 min, or the day is over AND the last chunk is 5 min old (a backlog upload is not rebuilt per chunk) ──
  const END = NOW - 60 * MIN; // the recording day ended 60 min ago (grace 30 min is over)
  eq('idle for 30 min → due, whatever the day', [assemblyDue(NOW, NOW - 31 * MIN, NOW + 5 * 3600_000), assemblyDue(NOW, NOW - 29 * MIN, NOW + 5 * 3600_000)], [true, false]);
  eq('day over, but a chunk arrived 1 min ago → not due (the backlog is still coming)', assemblyDue(NOW, NOW - 1 * MIN, END), false);
  eq('day over, 4 min 59 s without a chunk → not due; 5 min → due', [assemblyDue(NOW, NOW - 299_000, END), assemblyDue(NOW, NOW - 5 * MIN, END)], [false, true]);
  eq('day ended only 10 min ago (grace not over): needs the 30 min idle', assemblyDue(NOW, NOW - 10 * MIN, NOW - 10 * MIN), false);
  eq('a starving backlog: a chunk every minute for a finished day never makes it due', Array.from({ length: 120 }, (_, i) => assemblyDue(NOW + i * MIN, NOW + i * MIN - MIN, END)).some(Boolean), false);

  // ── a rebuilt segment never replaces its old parts with less video ──
  const part = (durationMs: number, packets: number | null) => ({ durationMs, packets });
  eq('rebuild as long as the parts it replaces → ok', rebuildKeepsVideo([part(8000, 80)], part(8000, 80)), true);
  eq('rebuild 2 s shorter → ok (the slack), 2.001 s shorter → not', [rebuildKeepsVideo([part(8000, null)], part(6000, null)), rebuildKeepsVideo([part(8000, null)], part(5999, null))], [true, false]);
  eq('the sum of several replaced parts counts', rebuildKeepsVideo([part(4000, 40), part(5000, 50)], part(6999, null)), false);
  eq('fewer packets than the parts it replaces → not ok, when both are known', rebuildKeepsVideo([part(8000, 80)], part(8000, 60)), false);
  eq('packets unknown on either side → the duration decides', [rebuildKeepsVideo([part(8000, null)], part(8000, 1)), rebuildKeepsVideo([part(8000, 80)], part(8000, null))], [true, true]);

  // ── stage 2: the header may be spread over several chunks (a still screen: seq 0 can be 1 byte) ──
  const whole = Buffer.concat([head, CLUSTER, Buffer.alloc(50, 7)]);
  const edge = head.length; // the Cluster id starts here
  let splitsOk = true;
  for (let o = 1; o < whole.length; o++) if (!initFromChunks([whole.subarray(0, o), whole.subarray(o)])?.equals(head)) splitsOk = false;
  eq('the header is found whatever byte the two chunks are cut at (also inside the Cluster id)', splitsOk, true);
  eq('1-byte seq 0, header continues in seq 1', initFromChunks([whole.subarray(0, 1), whole.subarray(1)])?.equals(head), true);
  eq('three chunks: 1 byte, then up to inside the Cluster id, then the rest', initFromChunks([whole.subarray(0, 1), whole.subarray(1, edge + 2), whole.subarray(edge + 2)])?.equals(head), true);
  eq('the Cluster only in the third chunk', initFromChunks([whole.subarray(0, 5), whole.subarray(5, edge - 1), whole.subarray(edge - 1)])?.equals(head), true);
  eq('no Cluster in any chunk → null', initFromChunks([head.subarray(0, 1), head.subarray(1)]), null);
  eq('no chunks → null', initFromChunks([]), null);
  eq('chunks that are not the start of a WebM → null', initFromChunks([Buffer.alloc(1, 9), whole.subarray(1)]), null);
  eq('more than 64 KB before a Cluster → null', initFromChunks([EBML, SEG_UNKNOWN, Buffer.alloc(40_000, 1), Buffer.alloc(40_000, 1), CLUSTER]), null);

  // a tail (chunks from seq k) is cut at its first Cluster id, wherever the chunk boundaries fall
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-q-'));
  try {
    const tailBytes = Buffer.concat([Buffer.alloc(40, 5), CLUSTER, Buffer.alloc(30, 6)]); // mid-cluster garbage, then a Cluster
    const at = tailBytes.indexOf(CLUSTER);
    let cutsOk = true;
    for (let o = 0; o <= tailBytes.length; o++) {
      const parts = [tailBytes.subarray(0, o), tailBytes.subarray(o)].filter((b) => b.length);
      const files = parts.map((b, i) => { const p = path.join(tmp, `t${o}-${i}`); fs.writeFileSync(p, b); return p; });
      const r = await firstClusterAt(files);
      const global = r ? parts.slice(0, r.index).reduce((a, b) => a + b.length, 0) + r.offset : -1;
      if (global !== at) cutsOk = false;
    }
    eq('the first Cluster id of a tail is located at every chunk boundary (also inside the id)', cutsOk, true);
    const none = path.join(tmp, 'none'); fs.writeFileSync(none, Buffer.alloc(100, 3));
    eq('a tail without any Cluster id → null', await firstClusterAt([none]), null);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  // ── stage 2: when kept chunk files may be deleted ──
  const DAYMS = 86_400_000;
  const seg0 = { state: 'assembled', problem: null as string | null, agent_closed_at: new Date(NOW) as Date | null, last_seq: 2 as number | null, lost_seqs: [] as number[] };
  const rows = (seqs: number[], purged = true, ageDays = 1) => seqs.map((seq) => ({ seq, purged_at: purged ? new Date(NOW) : null, uploaded_at: new Date(NOW - ageDays * DAYMS) }));
  eq('agent-closed, complete, all purged, no problem → delete', keptFilesDeletable(seg0, rows([0, 1, 2]), NOW), true);
  eq('an unpurged row (late chunk) → keep', keptFilesDeletable(seg0, [...rows([0, 1]), ...rows([2], false)], NOW), false);
  eq('a missing seq that is not lost → keep', keptFilesDeletable(seg0, rows([0, 2]), NOW), false);
  eq('a missing seq that the agent declared lost → delete', keptFilesDeletable({ ...seg0, lost_seqs: [1] }, rows([0, 2]), NOW), true);
  eq('a problem text (short / grafted) keeps the files', keptFilesDeletable({ ...seg0, problem: 'only 1.0 of 2.0 min readable' }, rows([0, 1, 2]), NOW), false);
  eq('state other than assembled → keep', keptFilesDeletable({ ...seg0, state: 'unreadable' }, rows([0, 1, 2]), NOW), false);
  eq('agent closed without a last_seq → keep', keptFilesDeletable({ ...seg0, last_seq: null }, rows([0, 1, 2]), NOW), false);
  eq('never closed by the agent: kept for 16 days after its last chunk', [keptFilesDeletable({ ...seg0, agent_closed_at: null }, rows([0, 1, 2], true, 15), NOW), keptFilesDeletable({ ...seg0, agent_closed_at: null }, rows([0, 1, 2], true, 17), NOW)], [false, true]);
  eq('never closed but a chunk is still unpurged → keep even after 16 days', keptFilesDeletable({ ...seg0, agent_closed_at: null }, [...rows([0, 1], true, 20), ...rows([2], false, 20)], NOW), false);
  eq('no rows → nothing to delete', keptFilesDeletable(seg0, [], NOW), false);

  // ── stage 2: reference size ──
  const sz = (w: number, h: number, ms: number, codec = 'vp8') => ({ w, h, codec, ms });
  eq('no base: the size with the most video wins, not the first one', chooseRef(null, [sz(320, 180, 3000), sz(640, 360, 2000), sz(640, 360, 2000)]).ref, { w: 640, h: 360, codec: 'vp8' });
  eq('no base: a big size beats a longer small one (sizes under 640 wide only if nothing else)', chooseRef(null, [sz(320, 180, 9000), sz(1280, 720, 1000)]).ref, { w: 1280, h: 720, codec: 'vp8' });
  eq('no base: only small sizes → the longest of them', chooseRef(null, [sz(160, 90, 1000), sz(320, 180, 3000)]).ref, { w: 320, h: 180, codec: 'vp8' });
  eq('no base: tie → larger area', chooseRef(null, [sz(800, 450, 2000), sz(1280, 720, 2000)]).ref, { w: 1280, h: 720, codec: 'vp8' });
  eq('no base, no material → nothing', chooseRef(null, []), { ref: null, rebase: false });
  eq('a base keeps its size even when the new material differs', chooseRef(sz(1280, 720, 5000), [sz(640, 360, 9000)]), { ref: { w: 1280, h: 720, codec: 'vp8' }, rebase: false });
  eq('a base under 640 wide and shorter than the new material of a proper size → new size, base re-encoded', chooseRef(sz(320, 180, 4000), [sz(640, 360, 3000), sz(640, 360, 3000)]), { ref: { w: 640, h: 360, codec: 'vp8' }, rebase: true });
  eq('…not when the new material is not longer than the base', chooseRef(sz(320, 180, 8000), [sz(640, 360, 3000)]), { ref: { w: 320, h: 180, codec: 'vp8' }, rebase: false });
  eq('…not when the new material is small too', chooseRef(sz(320, 180, 4000), [sz(480, 270, 9000)]), { ref: { w: 320, h: 180, codec: 'vp8' }, rebase: false });

  // ── stage 2: where a tail sits in time, manifest shape, expiry ──
  eq('tail start = segment start + earlier chunk durations (missing / null = 10 s)', tailStartMs(new Date(1000), [{ seq: 0, duration_ms: 2000 }, { seq: 1, duration_ms: null }], 3), 1000 + 2000 + 10_000 + 10_000);
  eq('a head (first seq 0) starts with the segment', tailStartMs(new Date(1000), [], 0), 1000);
  const item = { file: 'parts/a-0-g1.webm', segmentId: 'a', firstSeq: 0, startMs: 5, durationMs: 1000, packets: 10 };
  eq('manifest: valid shape is returned', parseManifest({ ref: { w: 640, h: 360, codec: 'vp8' }, items: [item, { ...item, segmentId: null, packets: null }] })?.items.length, 2);
  eq('manifest: garbage → null (the session then falls back to its generation file)', [parseManifest(null), parseManifest('x'), parseManifest({ items: 'no' }), parseManifest({ ref: null, items: [{ file: 1 }] }), parseManifest({ ref: null, items: [{ ...item, startMs: 'x' }] })], [null, null, null, null, null]);
  eq('parts expire when the recording day is older than the keep days (today 2026-11-25, keep 4)', [partsExpired('2026-11-21', NOW, 4), partsExpired('2026-11-20', NOW, 4)], [false, true]);

  // ── ffmpeg timeout: a 20 s real-time job is killed after 1 s ──
  const t0 = Date.now();
  const r = await runFfmpeg(['-re', '-f', 'lavfi', '-i', 'testsrc=duration=20:size=64x64:rate=5', '-f', 'null', '-'], { timeoutMs: 1000 });
  eq('timed-out ffmpeg resolves code -1 / stderr "timeout"', [r.code, r.stderr], [-1, 'timeout']);
  assert.ok(Date.now() - t0 < 10_000, `timeout took ${Date.now() - t0} ms`);
  n++;
  const ok = await runFfmpeg(['-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x64:rate=5', '-f', 'null', '-'], { timeoutMs: 60_000 });
  eq('a job that finishes in time is untouched', ok.code, 0);
  const ff: string = require('ffmpeg-static');
  const help = spawnSync(ff, ['-nostdin', '-version']);
  eq('this ffmpeg build accepts -nostdin', help.status, 0);

  console.log(`PASS ${n} checks (queue order, backoff, starvation simulation, ffmpeg timeout)`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
