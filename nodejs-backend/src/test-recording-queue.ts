/**
 * test-recording-queue.ts — assembly queue order, failure backoff and the ffmpeg timeout. No DB needed.
 * (Importing the service opens the Prisma pool lazily; nothing is queried.) Run: npm run test-recording-queue
 */
import assert from 'assert';
import { spawnSync } from 'child_process';
import { pickAssemblies, assemblyBackoffMs, AssemblyCandidate, expectedMs, shortProblem, reencodeKeptVideo, videoPackets, joinVerified, isInfraFailure, isAmbiguousFailure, ambiguousIsTransient } from './services/recording-v2.service';
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
