/**
 * repair-recordings.ts — one-off repair of v2 recording sessions (docs/recording-v2.md, "Repair").
 *
 *   npm run repair-recordings -- [--dry-run] [--apply --yes] [--session <id>] [--user <id>]
 *
 * Dry run is the default. For every v2 session it
 *   (a) puts unreadable segments that still have unpurged chunk rows back into the queue and clears the session's
 *       attempts / backoff / error (what the admin "Retry" does; the running server's queue then does the ffmpeg work),
 *   (b) adds the missing chunk row for a chunk file `segments/<segmentId>/<seq>.webm` that has none (the file is never
 *       touched), then re-evaluates its segment; files modified in the last 10 minutes are skipped (the running server may
 *       be between writing the file and inserting its row); folders of segments the DB does not know are only reported,
 *   (c) reports, without changing anything: collision files, a missing generation file, and a video that is much
 *       shorter than the chunks of its assembled segments.
 * HARD RULE: nothing is deleted, moved or overwritten, no chunk row is removed.
 * --apply is refused unless --yes is given too; both modes print the database host and RECORDINGS_DIR first.
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import prisma from './prisma';
import { RECORDINGS_DIR, sha256File } from './services/recording.service';
import { reviveUnreadable, chunkRowsAdded, expectedMs } from './services/recording-v2.service';

const SHORT_MS = 2 * 60_000;
const FRESH_MS = 10 * 60_000; // a file this young may still be getting its row from the running server
const argv = process.argv.slice(2);
const has = (n: string) => argv.includes(n);
const value = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const usage = 'usage: npm run repair-recordings -- [--dry-run] [--apply --yes] [--session <id>] [--user <id>]';

function dbTarget(): string {
  try { const u = new URL(process.env.DATABASE_URL ?? ''); return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`; }
  catch { return '(DATABASE_URL missing or unreadable)'; }
}

const ls = (dir: string) => fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
const min = (ms: number) => (ms / 60_000).toFixed(1);

async function main() {
  const apply = has('--apply');
  const unknown = argv.filter((a, i) => a.startsWith('--') ? !['--dry-run', '--apply', '--yes', '--session', '--user'].includes(a) : !['--session', '--user'].includes(argv[i - 1]));
  if (unknown.length || (has('--session') && !value('--session')) || (has('--user') && !value('--user')) || (apply && has('--dry-run'))) {
    console.error(`${usage}\nunknown or conflicting arguments: ${unknown.join(' ') || '(see usage)'}`);
    return 2;
  }
  console.log(`Database:       ${dbTarget()}\nRECORDINGS_DIR: ${RECORDINGS_DIR}\nMode:           ${apply ? 'APPLY' : 'dry run (nothing is changed)'}`);
  if (apply && !has('--yes')) {
    console.error('Refusing to change anything: --apply also needs --yes, once you have checked the database host and RECORDINGS_DIR above.');
    return 2;
  }

  const sessions = await prisma.recordingSession.findMany({
    where: { recording_date: { not: null }, ...(value('--session') ? { id: value('--session') } : {}), ...(value('--user') ? { user_id: value('--user') } : {}) },
    orderBy: [{ recording_date: 'asc' }, { created_at: 'asc' }],
    select: { id: true, user_id: true, recording_date: true, dir_path: true, generation: true, file_path: true, duration_ms: true },
  });

  let withFindings = 0, revivedTotal = 0, rowsTotal = 0;
  for (const s of sessions) {
    const notes: string[] = [];

    // (a) unreadable segments with chunks that are not in the video
    const toRevive = await prisma.recordingSegment.count({ where: { session_id: s.id, state: 'unreadable', chunks: { some: { purged_at: null } } } });
    if (toRevive) {
      const n = apply ? await reviveUnreadable(s.id) : toRevive;
      revivedTotal += n;
      notes.push(`${apply ? 'revived' : 'would revive'} ${n} unreadable segment(s)`);
    }

    // (b) chunk files without a row; (c) collisions
    if (s.dir_path) {
      const segIds = new Set((await prisma.recordingSegment.findMany({ where: { session_id: s.id }, select: { id: true } })).map((x) => x.id));
      const have = new Set((await prisma.recordingChunk.findMany({ where: { session_id: s.id, seq: { not: null } }, select: { segment_id: true, seq: true } })).map((c) => `${c.segment_id}:${c.seq}`));
      const missing: { segmentId: string; file: string; seq: number }[] = [];
      let unknownFolders = 0, fresh = 0;
      for (const f of await ls(path.join(s.dir_path, 'segments'))) {
        if (!f.isDirectory()) continue;
        if (!segIds.has(f.name)) { unknownFolders++; continue; }
        for (const e of await ls(path.join(s.dir_path, 'segments', f.name))) {
          const m = e.isFile() ? /^(\d{1,7})\.webm$/.exec(e.name) : null;
          if (!m || have.has(`${f.name}:${+m[1]}`)) continue;
          const file = path.join(s.dir_path, 'segments', f.name, e.name);
          if (Date.now() - (await fs.promises.stat(file)).mtimeMs < FRESH_MS) fresh++;
          else missing.push({ segmentId: f.name, file, seq: +m[1] });
        }
      }
      if (missing.length) {
        let added = 0;
        if (apply) {
          for (const x of missing) {
            const size = (await fs.promises.stat(x.file)).size;
            try {
              await prisma.recordingChunk.create({ data: { session_id: s.id, segment_id: x.segmentId, seq: x.seq, file_path: x.file, file_size: size, sha256: await sha256File(x.file), logged_out: false } });
              added++;
            } catch (err: any) {
              if (err?.code !== 'P2002') throw err; // the server stored the same chunk meanwhile
            }
          }
          for (const id of new Set(missing.map((x) => x.segmentId))) await chunkRowsAdded(id);
        } else added = missing.length;
        rowsTotal += added;
        notes.push(`${apply ? 'added' : 'would add'} ${added} missing chunk row(s)`);
      }
      if (fresh) notes.push(`${fresh} chunk file(s) without a row skipped (modified in the last 10 minutes)`);
      if (unknownFolders) notes.push(`${unknownFolders} folder(s) of unknown segments (not touched)`);
      const collisions = (await ls(path.join(s.dir_path, 'collisions'))).filter((e) => e.isFile()).length;
      if (collisions) notes.push(`${collisions} collision file(s) (kept, not touched)`);
    }

    // (c) what the server cannot repair
    if (s.generation > 0 && (!s.file_path || !fs.existsSync(s.file_path))) notes.push(`generation file is missing (generation ${s.generation}: ${s.file_path ?? 'no path'})`);
    if (s.generation > 0 && s.duration_ms !== null) {
      const expected = expectedMs(await prisma.recordingChunk.findMany({ where: { session_id: s.id, segment: { state: 'assembled' } }, select: { duration_ms: true } }));
      if (expected - s.duration_ms > SHORT_MS) notes.push(`video is ${min(s.duration_ms)} of ${min(expected)} min of the assembled chunks: shorter than recorded, cannot be repaired from the server`);
    }

    if (notes.length) {
      withFindings++;
      console.log(`session ${s.id} (user ${s.user_id}, day ${s.recording_date!.toISOString().slice(0, 10)}): ${notes.join('; ')}`);
    }
  }
  console.log(`Total: ${sessions.length} session(s) checked, ${withFindings} with something to report. ${apply ? 'Changed' : 'Would change'}: ${revivedTotal} segment(s) ${apply ? 'revived' : 'to revive'}, ${rowsTotal} chunk row(s) ${apply ? 'added' : 'to add'}. Nothing is ever deleted.`);
  if (!apply) console.log('Dry run: nothing was changed. Run with --apply --yes to do it.');
  return 0;
}

main().then(
  async (code) => { await prisma.$disconnect(); process.exit(code); },
  async (err) => { console.error('repair-recordings failed:', err); await prisma.$disconnect().catch(() => {}); process.exit(1); },
);
