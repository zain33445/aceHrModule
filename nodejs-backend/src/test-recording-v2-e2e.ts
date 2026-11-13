/**
 * test-recording-v2-e2e.ts — live check of screen recording v2 (docs/recording-v2.md §9, backend part).
 *
 * Needs a running backend on API_BASE and its database, started with RECORDINGS_DIR pointing at a
 * scratch folder; run this script with the SAME RECORDINGS_DIR (the retention check deletes files
 * in-process). Uses the seeded users manan (admin), daood (employee, recorded), haseeb (employee,
 * used as an "HR viewer"). Everything it creates is removed at the end; the retention setting and
 * haseeb's recording tab grant are restored.
 *
 *   npm run test-recording-v2-e2e
 */
import 'dotenv/config';
import axios, { AxiosRequestConfig } from 'axios';
import WebSocket from 'ws';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import prisma from './prisma';
import { runRetentionOnce } from './services/recording-v2.service';
import { recordingDateFor, ruleForUser } from './services/recording-day';

const API = process.env.API_BASE || 'http://localhost:5000/api';
const WS = API.replace(/^http/, 'ws').replace(/\/api$/, '');
const V2 = `${API}/recording/v2`;

const ADMIN = { username: 'manan', password: 'admin123' };
const EMPLOYEE = { username: 'daood', password: '1234' };
const OTHER = { username: 'haseeb', password: '1234' };

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noThrow: AxiosRequestConfig = { validateStatus: () => true };
const bearer = (t: string): AxiosRequestConfig => ({ ...noThrow, headers: { Authorization: `Bearer ${t}` } });
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const rid = () => crypto.randomBytes(4).toString('hex');

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms: number, step = 1000): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v as T;
    await sleep(step);
  }
  return null;
}

/** A tiny real WebM, split into byte parts like MediaRecorder timeslices. */
function makeRun(seconds: number, parts: number, size = '320x240'): Buffer[] {
  const ff: string = require('ffmpeg-static');
  const out = path.join(os.tmpdir(), `rec-v2-${rid()}.webm`);
  const r = spawnSync(ff, ['-y', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=${size}:rate=10`, '-c:v', 'libvpx', '-b:v', '200k', out]);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr?.toString().slice(-300)}`);
  const buf = fs.readFileSync(out);
  fs.unlinkSync(out);
  const n = Math.ceil(buf.length / parts);
  return Array.from({ length: parts }, (_, i) => buf.subarray(i * n, (i + 1) * n));
}

function durationOf(file: string): number {
  const ff: string = require('ffmpeg-static');
  const r = spawnSync(ff, ['-i', file]);
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(r.stderr.toString());
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : -1;
}

function openSocket(url: string) {
  const ws = new WebSocket(url);
  const msgs: any[] = [];
  ws.on('message', (d) => { try { msgs.push(JSON.parse(d.toString())); } catch { /* ignore */ } });
  const opened = new Promise<boolean>((res) => { ws.once('open', () => res(true)); ws.once('error', () => res(false)); ws.once('unexpected-response', () => res(false)); });
  const waitFor = async (pred: (m: any) => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = msgs.find(pred);
      if (hit) return hit;
      await sleep(50);
    }
    return null;
  };
  return { ws, msgs, opened, waitFor };
}

async function connectAgentV2(token: string) {
  const a = openSocket(`${WS}/recording-ws`);
  await a.opened;
  await a.waitFor((m) => m.type === 'AUTH_REQUIRED');
  a.ws.send(JSON.stringify({ type: 'AUTH', token, protocol: 2, deviceId: 'e2e-device', version: 'e2e' }));
  const connected = await a.waitFor((m) => m.type === 'CONNECTED');
  return { ...a, connected };
}

const register = (tok: string, segId: string, startedAt: Date, extra: object = {}) =>
  axios.put(`${V2}/segments/${segId}`, { startedAt: startedAt.toISOString(), mime: 'video/webm;codecs=vp8', width: 320, height: 240, deviceId: 'e2e-device', ...extra }, bearer(tok));

const putChunk = (tok: string, segId: string, seq: number | string, body: Buffer, hdr: Record<string, string> = {}, sum: string | null = sha(body)) =>
  axios.put(`${V2}/segments/${segId}/chunks/${seq}`, body, {
    ...noThrow,
    headers: {
      'Content-Type': 'application/octet-stream',
      Authorization: `Bearer ${tok}`,
      ...(sum ? { 'X-Chunk-Sha256': sum } : {}),
      'X-Captured-At': new Date().toISOString(),
      'X-Duration-Ms': '1000',
      'X-Logged-Out': '0',
      ...hdr,
    },
    maxBodyLength: Infinity,
  });

const close = (tok: string, segId: string, lastSeq: number, lostSeqs: number[] = []) =>
  axios.post(`${V2}/segments/${segId}/close`, { lastSeq, endedAt: new Date().toISOString(), lostSeqs }, bearer(tok));
const manifest = (tok: string, segId: string) => axios.get(`${V2}/segments/${segId}/manifest`, bearer(tok));
const sessionRow = (id: string) => prisma.recordingSession.findUnique({ where: { id } });

async function main() {
  const testStart = new Date();
  const sockets: WebSocket[] = [];

  console.log(`\nRecording v2 e2e against ${API}\n`);
  const emp = (await prisma.user.findUnique({ where: { username: EMPLOYEE.username } }))!;
  const other = (await prisma.user.findUnique({ where: { username: OTHER.username } }))!;
  const empId = emp.id;

  const v2Existing = await prisma.recordingSession.count({ where: { user_id: empId, recording_date: { not: null } } });
  if (v2Existing) throw new Error(`${EMPLOYEE.username} already has ${v2Existing} v2 recording session(s) — refusing to run`);
  const activeLegacy = await prisma.recordingSession.count({ where: { user_id: empId, status: { in: ['pending', 'recording'] } } });
  if (activeLegacy) throw new Error(`${EMPLOYEE.username} already has an active recording session — refusing to run`);

  // State to restore afterwards
  const prevSetting = await prisma.appSetting.findUnique({ where: { key: 'recording.retention_days' } });
  const prevQuality = await prisma.appSetting.findUnique({ where: { key: 'recording.quality' } });
  const otherHadGrant = !!(await prisma.userTabAccess.findUnique({ where: { user_id_tab_key: { user_id: other.id, tab_key: 'recording' } } }));
  if (otherHadGrant) throw new Error(`${OTHER.username} already holds the recording tab — refusing to run (would lose the grant semantics under test)`);

  const rule = await ruleForUser(empId);
  const dayOf = (d: Date) => recordingDateFor(d, rule);
  let sessionIds: string[] = [];

  try {
    const adminTok = (await axios.post(`${API}/auth/login`, ADMIN)).data.token as string;
    const empTok = (await axios.post(`${API}/auth/login`, EMPLOYEE)).data.token as string;
    const otherTok = (await axios.post(`${API}/auth/login`, OTHER)).data.token as string;
    const agentTok = (await axios.post(`${API}/recording/agent-auth`, { user_id: empId }, bearer(empTok))).data.token as string;
    const otherAgentTok = (await axios.post(`${API}/recording/agent-auth`, {}, bearer(otherTok))).data.token as string;
    const adminAgentTok = (await axios.post(`${API}/recording/agent-auth`, {}, bearer(adminTok))).data.token as string;

    // ── Segment registration ───────────────────────────────
    console.log('Segment registration');
    const now = new Date();
    const segA = `e2e-segA-${rid()}`, segB = `e2e-segB-${rid()}`, segD = `e2e-segD-${rid()}`;
    check('registration without a token → 401', (await axios.put(`${V2}/segments/${segA}`, { startedAt: now.toISOString() }, noThrow)).status === 401);
    check('invalid segment id → 400', (await register(agentTok, 'short', now)).status === 400);
    check('path-like segment id → 400', (await axios.put(`${V2}/segments/..%5Cevil-id-123`, { startedAt: now.toISOString() }, bearer(agentTok))).status === 400);
    check('missing startedAt → 400', (await axios.put(`${V2}/segments/${segA}`, {}, bearer(agentTok))).status === 400);

    const regA = await register(agentTok, segA, now, { recordingDate: dayOf(now) });
    check('register creates the segment (201)', regA.status === 201 && regA.data.segmentId === segA && regA.data.state === 'open', JSON.stringify(regA.data));
    const S = regA.data.sessionId as string;
    sessionIds.push(S);
    check('server assigns the recording day from the user\'s shift', regA.data.recordingDate === dayOf(now), `${regA.data.recordingDate} vs ${dayOf(now)}`);
    const regAagain = await register(agentTok, segA, now);
    check('registering again is idempotent (200, same session)', regAagain.status === 200 && regAagain.data.sessionId === S);
    const regB = await register(agentTok, segB, new Date(now.getTime() + 1000));
    check('a second segment on the same day reuses the session', regB.status === 201 && regB.data.sessionId === S);
    check('another user cannot register an existing segment (403)', (await register(otherAgentTok, segA, now)).status === 403);

    const sRow = await sessionRow(S);
    check('session row is v2 (recording_date set, dir_path fixed)', !!sRow?.recording_date && !!sRow?.dir_path && sRow.dir_path.includes(`(${S})`) && sRow.dir_path.includes(emp.id), sRow?.dir_path ?? '');
    check('session folder exists', !!sRow?.dir_path && fs.existsSync(sRow.dir_path));

    // Race-safe creation: two segments for a brand-new day at the same time → one session
    const oldDay = new Date(Date.now() - 40 * 86_400_000);
    const segC1 = `e2e-segC1-${rid()}`, segC2 = `e2e-segC2-${rid()}`;
    const [c1, c2] = await Promise.all([register(agentTok, segC1, oldDay), register(agentTok, segC2, new Date(oldDay.getTime() + 500))]);
    check('concurrent first registrations succeed', c1.status === 201 && c2.status === 201, `${c1.status}/${c2.status}`);
    check('…and share ONE session', c1.data.sessionId === c2.data.sessionId);
    const oldSession = c1.data.sessionId as string;
    sessionIds.push(oldSession);
    const dupCount = await prisma.recordingSession.count({ where: { user_id: empId, recording_date: (await sessionRow(oldSession))!.recording_date } });
    check('exactly one session row for that (user, day)', dupCount === 1, `${dupCount} rows`);

    // ── Multi-monitor: segment screen ──────────────────────
    console.log('Segment screen');
    const scrDay = new Date(Date.now() - 50 * 86_400_000);
    const segS1 = `e2e-segS1-${rid()}`, segS2 = `e2e-segS2-${rid()}`, segS3 = `e2e-segS3-${rid()}`, segS4 = `e2e-segS4-${rid()}`;
    const rS1 = await register(agentTok, segS1, scrDay, { screen: 2 });
    sessionIds.push(rS1.data.sessionId);
    await register(agentTok, segS2, new Date(scrDay.getTime() + 1000), { screen: 99 });
    await register(agentTok, segS3, new Date(scrDay.getTime() + 2000), { screen: 2.5 });
    await register(agentTok, segS4, new Date(scrDay.getTime() + 3000), { screen: 1 });
    const scr = async (id: string) => (await prisma.recordingSegment.findUnique({ where: { id } }))?.screen;
    check('screen is stored on the segment', (await scr(segS1)) === 2 && (await scr(segS4)) === 1);
    check('invalid screen (99, 2.5) -> null', (await scr(segS2)) === null && (await scr(segS3)) === null);
    check('a segment registered without screen has null', (await scr(segB)) === null);
    check('re-PUT without screen keeps the stored value', (await register(agentTok, segS1, scrDay)).status === 200 && (await scr(segS1)) === 2);
    check('re-PUT with an invalid screen keeps the stored value', (await register(agentTok, segS1, scrDay, { screen: 0 })).status === 200 && (await scr(segS1)) === 2);
    const dayList = await axios.get(`${API}/recording/days?from=${dayOf(scrDay)}&to=${dayOf(scrDay)}&userId=${empId}`, bearer(adminTok));
    const dayItem = (dayList.data.items ?? []).find((i: any) => i.sessionId === rS1.data.sessionId);
    check('/days item has screens = distinct non-null screens (2)', dayItem?.screens === 2, JSON.stringify(dayItem));
    const sdet = await axios.get(`${API}/recording/sessions/${rS1.data.sessionId}`, bearer(adminTok));
    const segScr = Object.fromEntries((sdet.data.segments ?? []).map((s: any) => [s.id, s.screen]));
    check('/sessions/:id segments include screen', segScr[segS1] === 2 && segScr[segS2] === null && segScr[segS4] === 1, JSON.stringify(segScr));

    // ── Chunk ingest ───────────────────────────────────────
    console.log('Chunk ingest');
    const runA = makeRun(3, 3);
    for (let i = 0; i < runA.length; i++) {
      const r = await putChunk(agentTok, segA, i, runA[i]);
      check(`chunk ${i} stored (201)`, r.status === 201 && r.data.ok === true, `${r.status} ${JSON.stringify(r.data)}`);
    }
    const stored = await prisma.recordingChunk.findUnique({ where: { segment_id_seq: { segment_id: segA, seq: 1 } } });
    check('chunk row has sha256 and no chunk_index', stored?.sha256 === sha(runA[1]) && stored?.chunk_index === null);
    check('chunk file at segments/<segmentId>/<seq>.webm', !!stored && stored.file_path === path.join(sRow!.dir_path!, 'segments', segA, '1.webm') && fs.readFileSync(stored.file_path).equals(runA[1]));
    const afterChunks = await sessionRow(S);
    check('session.last_chunk_at set and status recording', !!afterChunks?.last_chunk_at && afterChunks.status === 'recording');

    const dup = await putChunk(agentTok, segA, 1, runA[1]);
    check('same seq + same sha → 200 duplicate', dup.status === 200 && dup.data.duplicate === true, `${dup.status} ${JSON.stringify(dup.data)}`);
    const other1 = crypto.randomBytes(2048);
    const conflict = await putChunk(agentTok, segA, 1, other1);
    check('same seq + different sha → 201 conflict', conflict.status === 201 && conflict.data.conflict === true, `${conflict.status} ${JSON.stringify(conflict.data)}`);
    check('original chunk not overwritten', fs.readFileSync(stored!.file_path).equals(runA[1]));
    const collDir = path.join(sRow!.dir_path!, 'collisions');
    const collFiles = fs.existsSync(collDir) ? fs.readdirSync(collDir) : [];
    check('conflicting bytes kept under collisions/', collFiles.length === 1 && fs.readFileSync(path.join(collDir, collFiles[0])).equals(other1));

    check('body ≠ X-Chunk-Sha256 → 400', (await putChunk(agentTok, segA, 5, runA[0], {}, sha(runA[1]))).status === 400);
    check('missing X-Chunk-Sha256 → 400', (await putChunk(agentTok, segA, 5, runA[0], {}, null)).status === 400);
    check('non-hex X-Chunk-Sha256 → 400', (await putChunk(agentTok, segA, 5, runA[0], {}, 'zz'.repeat(32))).status === 400);
    check('bad seq → 400', (await putChunk(agentTok, segA, 'abc', runA[0])).status === 400);
    // S3 (edge cases): malformed optional metadata is stored as null/default, never refused (on segC2, so segA's manifest stays [0,1,2])
    const badLo = await putChunk(agentTok, segC2, 0, runA[0], { 'X-Logged-Out': 'yes' });
    check('malformed X-Logged-Out → 201, stored with logged_out=false', badLo.status === 201 && (await prisma.recordingChunk.findUnique({ where: { segment_id_seq: { segment_id: segC2, seq: 0 } } }))?.logged_out === false, `${badLo.status}`);
    check('empty body → 400', (await putChunk(agentTok, segA, 5, Buffer.alloc(0))).status === 400);
    check('corrupt-in-transit chunk was not stored', !(await prisma.recordingChunk.findUnique({ where: { segment_id_seq: { segment_id: segA, seq: 5 } } })));
    const unreg = await putChunk(agentTok, `e2e-nope-${rid()}`, 0, runA[0]);
    check('unregistered segment → 404 segment_not_registered', unreg.status === 404 && unreg.data.error === 'segment_not_registered', `${unreg.status} ${JSON.stringify(unreg.data)}`);
    check('another user\'s agent cannot upload into the segment (403)', (await putChunk(otherAgentTok, segA, 9, runA[0])).status === 403);
    check('another user cannot read the manifest (403)', (await manifest(otherAgentTok, segA)).status === 403);
    check('another user cannot close the segment (403)', (await close(otherAgentTok, segA, 2)).status === 403);
    check('chunk without a token → 401', (await axios.put(`${V2}/segments/${segA}/chunks/9`, runA[0], { ...noThrow, headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-Sha256': sha(runA[0]) } })).status === 401);

    // ── Manifest + close semantics ─────────────────────────
    console.log('Manifest and close');
    const mf = await manifest(agentTok, segA);
    check('manifest lists stored seqs', mf.status === 200 && JSON.stringify(mf.data.have) === '[0,1,2]' && mf.data.state === 'open' && mf.data.lastSeq === null, JSON.stringify(mf.data));
    check('manifest of unknown segment → 404', (await manifest(agentTok, `e2e-nope-${rid()}`)).status === 404);
    check('close with bad lastSeq → 400', (await close(agentTok, segA, 1.5 as any)).status === 400);
    check('close with lostSeqs outside 0..lastSeq → 400', (await close(agentTok, segA, 2, [7])).status === 400);
    const clA = await close(agentTok, segA, 2);
    check('close with every seq stored → complete', clA.status === 200 && clA.data.state === 'complete', JSON.stringify(clA.data));
    check('close is idempotent', (await close(agentTok, segA, 2)).data.state === 'complete');

    const runB = makeRun(3, 3);
    await putChunk(agentTok, segB, 0, runB[0]);
    await putChunk(agentTok, segB, 1, runB[1]);
    const clB = await close(agentTok, segB, 2);
    check('close with a missing seq → stays closed (waiting)', clB.status === 200 && clB.data.state === 'closed', JSON.stringify(clB.data));
    await putChunk(agentTok, segB, 2, runB[2]);
    check('late missing chunk completes the segment', (await manifest(agentTok, segB)).data.state === 'complete');

    // incomplete (lostSeqs) — on the old-day session so it does not enter the generations below
    const runC = makeRun(2, 2);
    await putChunk(agentTok, segC1, 0, runC[0]);
    const clC = await close(agentTok, segC1, 1, [1]);
    check('close with lostSeqs → incomplete', clC.status === 200 && clC.data.state === 'incomplete', JSON.stringify(clC.data));
    const segRow = await prisma.recordingSegment.findUnique({ where: { id: segC1 } });
    check('segment row stores last_seq, lost_seqs, ended_at', segRow?.last_seq === 1 && JSON.stringify(segRow.lost_seqs) === '[1]' && !!segRow.ended_at);

    // ── Retention (scoped to the test user) ─────────────────
    console.log('Retention setting');
    check('settings GET without a token → 401', (await axios.get(`${API}/recording/settings`, noThrow)).status === 401);
    check('settings GET as admin → number', typeof (await axios.get(`${API}/recording/settings`, bearer(adminTok))).data.retentionDays === 'number');
    check('settings PUT invalid value → 400', (await axios.put(`${API}/recording/settings`, { retentionDays: 45 }, bearer(adminTok))).status === 400);
    check('settings PUT as non-admin → 403', (await axios.put(`${API}/recording/settings`, { retentionDays: 30 }, bearer(empTok))).status === 403);
    check('settings PUT 0 → 200', (await axios.put(`${API}/recording/settings`, { retentionDays: 0 }, bearer(adminTok))).data.retentionDays === 0);
    await prisma.recordingSession.update({ where: { id: oldSession }, data: { status: 'stopped' } });
    const none = await runRetentionOnce({ onlyUserId: empId });
    check('retention 0 (forever) deletes nothing', none.sessions === 0 && !!(await sessionRow(oldSession)));
    const put30 = await axios.put(`${API}/recording/settings`, { retentionDays: 30 }, bearer(adminTok));
    check('settings PUT 30 → saved and readable', put30.status === 200 && (await axios.get(`${API}/recording/settings`, bearer(adminTok))).data.retentionDays === 30);
    // S6: retention protects sessions with unassembled segments or chunks newer than 7 days. First show that:
    const protectedRun = await runRetentionOnce({ onlyUserId: empId });
    check('retention 30 skips the 40-day-old session while it has unassembled segments / fresh chunks', protectedRun.sessions === 0 && !!(await sessionRow(oldSession)));
    // …then make it eligible (segments assembled, chunks received > 7 days ago) so deletion stays covered.
    await prisma.recordingSegment.updateMany({ where: { session_id: oldSession }, data: { state: 'assembled' } });
    await prisma.recordingChunk.updateMany({ where: { session_id: oldSession }, data: { uploaded_at: new Date(Date.now() - 8 * 86_400_000) } });
    const oldDir = (await sessionRow(oldSession))!.dir_path!;
    const ran = await runRetentionOnce({ onlyUserId: empId });
    check('retention 30 deletes the 40-day-old session (rows)', ran.sessions === 1 && !(await sessionRow(oldSession)) && !(await prisma.recordingSegment.findUnique({ where: { id: segC1 } })));
    const root = path.resolve(process.env.RECORDINGS_DIR || '');
    if (process.env.RECORDINGS_DIR && path.resolve(oldDir).startsWith(root)) check('…and its folder', !fs.existsSync(oldDir));
    else console.log('  SKIP  folder deletion check (set RECORDINGS_DIR to the server\'s scratch folder)');
    check('today\'s session is untouched', !!(await sessionRow(S)));
    sessionIds = sessionIds.filter((i) => i !== oldSession);

    // ── Assembly: generation 1 ──────────────────────────────
    console.log('Assembly generation 1 (on-demand via GET file)');
    const first = await axios.get(`${API}/recording/sessions/${S}/file`, { ...bearer(adminTok), responseType: 'arraybuffer' });
    check('file before any generation → 409 and assembly starts', first.status === 409);
    console.log('  …waiting for assembly');
    const g1 = await until(async () => { const r = await sessionRow(S); return r && r.generation >= 1 && r.file_path ? r : null; }, 120_000);
    check('generation 1 produced', !!g1, g1 ? '' : `assembly_error=${(await sessionRow(S))?.assembly_error}`);
    const g1File = g1?.file_path ?? '';
    check('file is recording-g1.webm in the session folder', g1File === path.join(sRow!.dir_path!, 'recording-g1.webm') && fs.existsSync(g1File), g1File);
    const g1Dur = g1File && fs.existsSync(g1File) ? durationOf(g1File) : -1;
    check('generation 1 joins segment A + B (~6s)', g1Dur > 5 && g1Dur < 7.5, `duration ${g1Dur}s`);
    check('duration_ms recorded', !!g1 && g1.duration_ms !== null && Math.abs(g1.duration_ms / 1000 - g1Dur) < 1.5, `${g1?.duration_ms}ms`);
    check('assembly_error cleared, attempts reset', g1?.assembly_error === null && g1?.assembly_attempts === 0);
    const segsAfter = await prisma.recordingSegment.findMany({ where: { session_id: S } });
    check('segments A and B are assembled with generation 1', segsAfter.filter((s) => s.state === 'assembled' && s.generation === 1).length === 2, JSON.stringify(segsAfter.map((s) => [s.id.slice(0, 8), s.state, s.generation])));
    const chunksAfter = await prisma.recordingChunk.findMany({ where: { session_id: S } });
    check('chunk rows marked purged_at', chunksAfter.length >= 6 && chunksAfter.every((c) => c.purged_at !== null));
    check('chunk files purged after assembly', chunksAfter.every((c) => !fs.existsSync(c.file_path)));
    check('only one recording-g*.webm present', fs.readdirSync(sRow!.dir_path!).filter((f) => /^recording-g\d+\.webm$/.test(f)).length === 1);

    const dl = await axios.get(`${API}/recording/sessions/${S}/file`, { ...bearer(adminTok), responseType: 'arraybuffer' });
    check('download serves the generation (200)', dl.status === 200 && dl.data.byteLength === fs.statSync(g1File).size, `${dl.status}`);
    const ranged = await axios.get(`${API}/recording/sessions/${S}/file`, { ...bearer(adminTok), headers: { Authorization: `Bearer ${adminTok}`, Range: 'bytes=0-99' }, responseType: 'arraybuffer' });
    check('Range request → 206, 100 bytes', ranged.status === 206 && ranged.data.byteLength === 100);
    const detail = await axios.get(`${API}/recording/sessions/${S}`, bearer(adminTok));
    check('session detail lists segments', detail.status === 200 && Array.isArray(detail.data.segments) && detail.data.segments.length === 2);

    // after purge: duplicates still recognised, different bytes kept aside
    const dupPurged = await putChunk(agentTok, segA, 0, runA[0]);
    check('re-upload of a purged chunk (same sha) → 200 duplicate', dupPurged.status === 200 && dupPurged.data.duplicate === true, `${dupPurged.status} ${JSON.stringify(dupPurged.data)}`);
    const confPurged = await putChunk(agentTok, segA, 0, crypto.randomBytes(1024));
    check('different bytes for a purged chunk → conflict, kept aside', confPurged.status === 201 && confPurged.data.conflict === true);
    check('purged chunk was not resurrected', !fs.existsSync(path.join(sRow!.dir_path!, 'segments', segA, '0.webm')));

    // ── Assembly: generation 2 = generation 1 + new segment (different size → re-encode) ─────────
    console.log('Assembly generation 2 (new segment at 640x480)');
    const runD = makeRun(3, 3, '640x480');
    const regD = await register(agentTok, segD, new Date(now.getTime() + 60_000), { width: 640, height: 480 });
    check('new segment reopens the session', regD.status === 201 && regD.data.sessionId === S && (await sessionRow(S))?.status === 'recording');
    for (let i = 0; i < runD.length; i++) await putChunk(agentTok, segD, i, runD[i]);
    check('segment D completes on close', (await close(agentTok, segD, 2)).data.state === 'complete');
    const midDl = await axios.get(`${API}/recording/sessions/${S}/file`, { ...bearer(adminTok), responseType: 'arraybuffer' });
    check('GET file with unassembled data still serves the last good generation', midDl.status === 200);
    const g2 = await until(async () => { const r = await sessionRow(S); return r && r.generation >= 2 ? r : null; }, 150_000);
    check('generation 2 produced', !!g2, g2 ? '' : `assembly_error=${(await sessionRow(S))?.assembly_error}`);
    const g2File = g2?.file_path ?? '';
    const g2Dur = g2File && fs.existsSync(g2File) ? durationOf(g2File) : -1;
    check('generation 2 = generation 1 + segment D (~9s)', g2Dur > g1Dur + 2 && g2Dur < g1Dur + 4.5, `g1=${g1Dur}s g2=${g2Dur}s`);
    check('file is recording-g2.webm; generation 1 file removed', g2File.endsWith('recording-g2.webm') && !fs.existsSync(g1File));
    const sD = await prisma.recordingSegment.findUnique({ where: { id: segD } });
    check('segment D assembled with generation 2', sD?.state === 'assembled' && sD.generation === 2);
    const dChunks = await prisma.recordingChunk.findMany({ where: { segment_id: segD } });
    check('segment D chunk files purged', dChunks.length === 3 && dChunks.every((c) => c.purged_at !== null && !fs.existsSync(c.file_path)));

    // ── Access control ──────────────────────────────────────
    console.log('Access control');
    const readRoutes = [
      ['GET', `${API}/recording/sessions`],
      ['GET', `${API}/recording/sessions/${S}`],
      ['GET', `${API}/recording/status/${empId}`],
      ['GET', `${API}/recording/agents`],
      ['GET', `${API}/recording/agents-status`],
      ['GET', `${API}/recording/settings`],
      ['POST', `${API}/recording/admin-ws-token`],
    ] as const;
    const call = (m: string, url: string, tok?: string) =>
      axios.request({ method: m as any, url, data: m === 'POST' ? {} : undefined, ...(tok ? bearer(tok) : noThrow) });
    for (const [m, url] of readRoutes) {
      const label = `${m} ${url.replace(API, '').replace(S, ':id').replace(empId, ':userId')}`;
      check(`${label}: no token → 401`, (await call(m, url)).status === 401);
      check(`${label}: employee without grant → 403`, (await call(m, url, otherTok)).status === 403);
      check(`${label}: admin → 200`, (await call(m, url, adminTok)).status === 200);
    }
    check('session file: employee without grant → 403', (await axios.get(`${API}/recording/sessions/${S}/file`, bearer(otherTok))).status === 403);
    check('session stream: employee without grant → 403', (await axios.get(`${API}/recording/sessions/${S}/stream`, bearer(otherTok))).status === 403);

    check('tab-access toggle without a token → 401', (await axios.post(`${API}/tab-access/toggle`, { user_id: other.id, tab_key: 'recording', granted: true }, noThrow)).status === 401);
    check('tab-access toggle by a non-admin → 403 (no self-grant)', (await axios.post(`${API}/tab-access/toggle`, { user_id: other.id, tab_key: 'recording', granted: true }, bearer(otherTok))).status === 403);
    check('…and nothing was granted', !(await prisma.userTabAccess.findUnique({ where: { user_id_tab_key: { user_id: other.id, tab_key: 'recording' } } })));
    const grant = await axios.post(`${API}/tab-access/toggle`, { user_id: other.id, tab_key: 'recording', granted: true }, bearer(adminTok));
    check('tab-access toggle by admin → 200', grant.status === 200 && grant.data.success === true);

    for (const [m, url] of readRoutes) {
      const label = `${m} ${url.replace(API, '').replace(S, ':id').replace(empId, ':userId')}`;
      check(`${label}: HR with grant → 200`, (await call(m, url, otherTok)).status === 200);
    }
    check('session file: HR with grant → 200', (await axios.get(`${API}/recording/sessions/${S}/file`, { ...bearer(otherTok), headers: { Authorization: `Bearer ${otherTok}`, Range: 'bytes=0-9' }, responseType: 'arraybuffer' })).status === 206);
    check('start (admin-only): HR with grant → 403', (await axios.post(`${API}/recording/session/start`, { user_id: empId }, bearer(otherTok))).status === 403);
    check('stop (admin-only): HR with grant → 403', (await axios.post(`${API}/recording/session/stop`, { session_id: S }, bearer(otherTok))).status === 403);
    check('settings PUT (admin-only): HR with grant → 403', (await axios.put(`${API}/recording/settings`, { retentionDays: 60 }, bearer(otherTok))).status === 403);

    const hrWsTok = (await axios.post(`${API}/recording/admin-ws-token`, {}, bearer(otherTok))).data.token as string;
    const hrWs = openSocket(`${WS}/admin-recording-ws?token=${encodeURIComponent(hrWsTok)}`);
    sockets.push(hrWs.ws);
    check('admin-ws token of a granted HR viewer is accepted by the gateway', (await hrWs.opened) && !!(await hrWs.waitFor((m) => m.type === 'CONNECTED' && m.adminId === other.id)));
    hrWs.ws.close();

    const revoke = await axios.post(`${API}/tab-access/toggle`, { user_id: other.id, tab_key: 'recording', granted: false }, bearer(adminTok));
    check('revoking the grant → 200', revoke.status === 200);
    check('after revoke: HR → 403 again', (await axios.get(`${API}/recording/sessions`, bearer(otherTok))).status === 403);

    // ── Protocol 2 gateway ──────────────────────────────────
    console.log('Protocol 2 gateway');
    const legacyBefore = await prisma.recordingSession.count({ where: { user_id: empId, recording_date: null, created_at: { gte: testStart } } });
    const agent = await connectAgentV2(agentTok);
    sockets.push(agent.ws);
    const c = agent.connected;
    check('protocol-2 AUTH → CONNECTED', !!c && c.userId === empId && c.protocol === 2, JSON.stringify(c));
    check('CONNECTED.record is true for an employee', c?.record === true);
    check('CONNECTED carries the recordingDay rule', Number.isInteger(c?.recordingDay?.boundaryMinutes) && Number.isInteger(c?.recordingDay?.shiftStartMinutes) && c.recordingDay.boundaryMinutes === rule.boundaryMinutes && c.recordingDay.shiftStartMinutes === rule.shiftStartMinutes, JSON.stringify(c?.recordingDay));
    check('CONNECTED carries serverTime', typeof c?.serverTime === 'string' && !isNaN(Date.parse(c.serverTime)));
    check('CONNECTED carries a valid quality', ['480p', '720p', '1080p'].includes(c?.quality), String(c?.quality));
    check('settings GET as admin → quality is 480p/720p/1080p', ['480p', '720p', '1080p'].includes((await axios.get(`${API}/recording/settings`, bearer(adminTok))).data.quality));
    check('settings PUT invalid quality → 400', (await axios.put(`${API}/recording/settings`, { quality: '4k' }, bearer(adminTok))).status === 400);
    const putQ = await axios.put(`${API}/recording/settings`, { quality: '1080p' }, bearer(adminTok));
    check('settings PUT quality 1080p → 200 with quality', putQ.status === 200 && putQ.data.quality === '1080p');
    check('connected v2 agent receives RECORDING_SETTINGS 1080p', !!(await agent.waitFor((m) => m.type === 'RECORDING_SETTINGS' && m.quality === '1080p')));
    agent.ws.send(JSON.stringify({ type: 'STATUS', state: 'recording', segmentId: segD, sessionId: S, loggedIn: true, backlogChunks: 3, backlogBytes: 1234, diskFreeBytes: 99999, version: 'e2e' }));
    console.log('  …waiting 7s: a v2 agent must not receive START_RECORDING / schedules or trigger a reconcile');
    await sleep(7000);
    check('no START_RECORDING / STOP_RECORDING sent to a protocol-2 agent', !agent.msgs.some((m) => m.type === 'START_RECORDING' || m.type === 'STOP_RECORDING'));
    check('no legacy session was created by the connection', (await prisma.recordingSession.count({ where: { user_id: empId, recording_date: null, created_at: { gte: testStart } } })) === legacyBefore);

    const st = (await axios.get(`${API}/recording/agents-status`, bearer(adminTok))).data as any[];
    const mine = st.find((a) => a.userId === empId);
    check('agents-status reports the connected v2 agent with its latest STATUS', !!mine && mine.connected === true && mine.protocol === 2 && mine.state === 'recording' && mine.segmentId === segD && mine.backlogChunks === 3 && mine.loggedIn === true && typeof mine.lastStatusAt === 'string', JSON.stringify(mine));

    const adminAgent = await connectAgentV2(adminAgentTok);
    sockets.push(adminAgent.ws);
    check('CONNECTED.record is false for an admin', adminAgent.connected?.record === false, JSON.stringify(adminAgent.connected));
    adminAgent.ws.close();

    const before = (await sessionRow(S))?.status;
    agent.ws.close();
    console.log('  …waiting 11s: disconnect of a v2 agent must not stop sessions');
    await sleep(11_000);
    check('disconnect of a protocol-2 agent does not stop the session', before === 'recording' && (await sessionRow(S))?.status === 'recording', `${before} → ${(await sessionRow(S))?.status}`);
    const st2 = ((await axios.get(`${API}/recording/agents-status`, bearer(adminTok))).data as any[]).find((a) => a.userId === empId);
    check('agents-status keeps the last STATUS after disconnect (connected=false)', !!st2 && st2.connected === false && st2.state === 'recording');

    const fresh = await connectAgentV2(agentTok);
    sockets.push(fresh.ws);
    check('fresh protocol-2 CONNECTED carries quality 1080p', fresh.connected?.quality === '1080p', String(fresh.connected?.quality));
    await prisma.appSetting.deleteMany({ where: { key: 'recording.retention_days' } }); // restored in finally
    check('retention unset → GET returns 30', (await axios.get(`${API}/recording/settings`, bearer(adminTok))).data.retentionDays === 30);
  } finally {
    for (const s of sockets) { try { s.close(); } catch { /* ignore */ } }
    await sleep(500);

    // restore settings / grants
    if (prevSetting) await prisma.appSetting.upsert({ where: { key: prevSetting.key }, create: { key: prevSetting.key, value: prevSetting.value, updated_by: prevSetting.updated_by }, update: { value: prevSetting.value, updated_by: prevSetting.updated_by } });
    else await prisma.appSetting.deleteMany({ where: { key: 'recording.retention_days' } });
    if (prevQuality) await prisma.appSetting.upsert({ where: { key: prevQuality.key }, create: { key: prevQuality.key, value: prevQuality.value, updated_by: prevQuality.updated_by }, update: { value: prevQuality.value, updated_by: prevQuality.updated_by } });
    else await prisma.appSetting.deleteMany({ where: { key: 'recording.quality' } });
    await prisma.userTabAccess.deleteMany({ where: { user_id: other.id, tab_key: 'recording' } });

    // sessions + files
    const mine = await prisma.recordingSession.findMany({ where: { user_id: empId, created_at: { gte: testStart } }, select: { id: true, dir_path: true } });
    const ids = new Set([...sessionIds, ...mine.map((s) => s.id)]);
    const rows = await prisma.recordingSession.findMany({ where: { id: { in: [...ids] } }, select: { id: true, dir_path: true } });
    for (const r of rows) {
      if (r.dir_path && r.dir_path.endsWith(`(${r.id})`)) await fs.promises.rm(r.dir_path, { recursive: true, force: true }).catch(() => {});
    }
    await prisma.recordingSession.deleteMany({ where: { id: { in: [...ids] } } }); // segments + chunks cascade
    await prisma.auditLog.deleteMany({
      where: { created_at: { gte: testStart }, OR: [{ action: { contains: '/recording/' } }, { action: { contains: '/tab-access/' } }] },
    });
    console.log(`\nCleanup: removed ${ids.size} test session(s), restored retention setting and tab grants`);
    await prisma.$disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error('E2E crashed:', err?.response?.data ?? err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
