/**
 * test-recording-edge-e2e.ts — server edge cases S1–S29 of docs/recording-edge-cases.md (TDD).
 *
 * Needs a running backend on API_BASE and its database, started with RECORDINGS_DIR pointing at a
 * scratch folder; run this script with the SAME RECORDINGS_DIR and the same .env (retention, sweeper and
 * assembly are driven IN-PROCESS: runRetentionOnce / sweepV2 / assembleSessionV2 / assembleOnDemand).
 * Seeded users: manan (admin), daood (employee, recorded), haseeb (employee: HR viewer, later deactivated).
 * Everything created is removed at the end; haseeb's status/grant and the retention setting are restored.
 *
 *   npm run test-recording-edge-e2e
 */
import 'dotenv/config';
import axios, { AxiosRequestConfig } from 'axios';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import prisma from './prisma';
import { activeAssemblyCount } from './services/recording.service';
import * as v2svc from './services/recording-v2.service';
import { runRetentionOnce, sweepV2, assembleOnDemand, assembleSessionV2, pumpAssemblies } from './services/recording-v2.service';

process.env.RECORDING_PREBOOT_GRACE_MS = '0';

const API = process.env.API_BASE || 'http://localhost:5000/api';
const ORIGIN = API.replace(/\/api$/, '');
const WS = ORIGIN.replace(/^http/, 'ws');
const V2 = `${API}/recording/v2`;
// The "public default" agent secret. If the deployment sets AGENT_JWT_SECRET, that is the agent secret instead.
const AGENT_SECRET = process.env.AGENT_JWT_SECRET || 'ace-agent-secret-change-in-prod';

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
const bearer = (t: string, extra: Record<string, string> = {}): AxiosRequestConfig => ({ ...noThrow, headers: { Authorization: `Bearer ${t}`, ...extra } });
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const rid = () => crypto.randomBytes(4).toString('hex');
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);
const dateOnlyUtc = (d: Date) => new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`);

async function until<T>(fn: () => Promise<T | null | undefined | false>, ms: number, step = 500): Promise<T | null> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v as T;
    await sleep(step);
  }
  return null;
}

/** A tiny real WebM, split into byte parts like MediaRecorder timeslices. */
function makeRun(seconds: number, parts: number): Buffer[] {
  const ff: string = require('ffmpeg-static');
  const out = path.join(os.tmpdir(), `rec-edge-${rid()}.webm`);
  const r = spawnSync(ff, ['-y', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x240:rate=10`, '-c:v', 'libvpx', '-b:v', '200k', out]);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr?.toString().slice(-300)}`);
  const buf = fs.readFileSync(out);
  fs.unlinkSync(out);
  const n = Math.ceil(buf.length / parts);
  return Array.from({ length: parts }, (_, i) => buf.subarray(i * n, (i + 1) * n));
}

const CLUSTER_ID = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
/** Broken chunk shapes seen in production, cut from one real WebM (160x90, a keyframe every 2 s, many small clusters). */
function makeBadMedia() {
  const ff: string = require('ffmpeg-static');
  const out = path.join(os.tmpdir(), `rec-edge-bad-${rid()}.webm`);
  const r = spawnSync(ff, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=160x90:rate=10', '-c:v', 'libvpx', '-b:v', '100k', '-g', '20', '-cluster_size_limit', '2000', '-cluster_time_limit', '500', out]);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr?.toString().slice(-300)}`);
  const buf = fs.readFileSync(out);
  fs.unlinkSync(out);
  const at: number[] = [];
  for (let i = buf.indexOf(CLUSTER_ID); i >= 0; i = buf.indexOf(CLUSTER_ID, i + 1)) at.push(i);
  const init = buf.subarray(0, at[0]);
  return {
    cutCluster: Buffer.concat([init, buf.subarray(at[0], at[0] + 40)]), // header + a cluster cut before its first frame: remux exits 0, zero packets
    deltaOnly: Buffer.concat([init, buf.subarray(at[3], at[4])]), // header + one cluster without a keyframe: zero packets
    junk: crypto.randomBytes(3000), // not WebM at all
  };
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
  const waitFor = async (pred: (m: any) => boolean, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = msgs.find(pred);
      if (hit) return hit;
      await sleep(50);
    }
    return null;
  };
  const send = (m: object) => ws.send(JSON.stringify(m));
  return { ws, msgs, opened, waitFor, send };
}

async function connectAgent(token: string) {
  const a = openSocket(`${WS}/recording-ws`);
  await a.opened;
  await a.waitFor((m) => m.type === 'AUTH_REQUIRED');
  a.send({ type: 'AUTH', token, protocol: 2, deviceId: 'e2e-edge', version: 'e2e-edge' });
  const connected = await a.waitFor((m) => m.type === 'CONNECTED');
  return { ...a, connected };
}

async function connectViewer(wsToken: string) {
  const v = openSocket(`${WS}/admin-recording-ws?token=${encodeURIComponent(wsToken)}`);
  const ok = await v.opened;
  const connected = ok ? await v.waitFor((m) => m.type === 'CONNECTED') : null;
  return { ...v, ok, connected };
}

const register = (tok: string, segId: string, startedAt: Date | string, extra: object = {}) =>
  axios.put(`${V2}/segments/${segId}`, { startedAt: typeof startedAt === 'string' ? startedAt : startedAt.toISOString(), mime: 'video/webm;codecs=vp8', width: 320, height: 240, deviceId: 'e2e-edge', ...extra }, bearer(tok));

const putChunk = (tok: string, segId: string, seq: number, body: Buffer, hdr: Record<string, string> = {}) =>
  axios.put(`${V2}/segments/${segId}/chunks/${seq}`, body, {
    ...noThrow,
    headers: {
      'Content-Type': 'application/octet-stream',
      Authorization: `Bearer ${tok}`,
      'X-Chunk-Sha256': sha(body),
      'X-Captured-At': new Date().toISOString(),
      'X-Duration-Ms': '1000',
      'X-Logged-Out': '0',
      ...hdr,
    },
    maxBodyLength: Infinity,
  });

const close = (tok: string, segId: string, lastSeq: number) =>
  axios.post(`${V2}/segments/${segId}/close`, { lastSeq, endedAt: new Date().toISOString(), lostSeqs: [] }, bearer(tok));
const manifest = (tok: string, segId: string) => axios.get(`${V2}/segments/${segId}/manifest`, bearer(tok));
const sessionRow = (id: string) => prisma.recordingSession.findUnique({ where: { id } });
const segRow = (id: string) => prisma.recordingSegment.findUnique({ where: { id } });
const chunkRow = (segId: string, seq: number) => prisma.recordingChunk.findUnique({ where: { segment_id_seq: { segment_id: segId, seq } } });
const newSeg = (p: string) => `e2e-edge-${p}-${rid()}`;

async function main() {
  const testStart = new Date();
  const sockets: WebSocket[] = [];
  const tmpFiles: string[] = [];

  console.log(`\nRecording edge-case e2e (S1–S29) against ${API}\n`);
  if (process.env.AGENT_JWT_SECRET) console.log('  note: AGENT_JWT_SECRET is set — S8 forges tokens with it (the agent secret), not the built-in default\n');
  const emp = (await prisma.user.findUnique({ where: { username: EMPLOYEE.username } }))!;
  const other = (await prisma.user.findUnique({ where: { username: OTHER.username } }))!;
  const adminRow = (await prisma.user.findUnique({ where: { username: ADMIN.username } }))!;
  const empId = emp.id;

  for (const u of [emp, other]) {
    const n = await prisma.recordingSession.count({ where: { user_id: u.id, recording_date: { not: null } } });
    if (n) throw new Error(`${u.username} already has ${n} v2 recording session(s) — refusing to run`);
  }
  if (await prisma.recordingSession.count({ where: { user_id: empId, status: { in: ['pending', 'recording'] } } })) {
    throw new Error(`${EMPLOYEE.username} already has an active recording session — refusing to run`);
  }
  if (await prisma.userTabAccess.findUnique({ where: { user_id_tab_key: { user_id: other.id, tab_key: 'recording' } } })) {
    throw new Error(`${OTHER.username} already holds the recording tab — refusing to run`);
  }

  const tabSnapshot = await prisma.userTabAccess.findMany({ where: { user_id: { in: [emp.id, other.id] } }, select: { user_id: true, tab_key: true } });
  const prevSetting = await prisma.appSetting.findUnique({ where: { key: 'recording.retention_days' } });
  const prevOtherStatus = other.status;
  const sessionIds = new Set<string>();
  const track = (id: string) => { sessionIds.add(id); return id; };

  try {
    const adminTok = (await axios.post(`${API}/auth/login`, ADMIN)).data.token as string;
    const empTok = (await axios.post(`${API}/auth/login`, EMPLOYEE)).data.token as string;
    const otherTok = (await axios.post(`${API}/auth/login`, OTHER)).data.token as string;
    const agentTok = (await axios.post(`${API}/recording/agent-auth`, { user_id: empId }, bearer(empTok))).data.token as string;
    const otherAgentTok = (await axios.post(`${API}/recording/agent-auth`, {}, bearer(otherTok))).data.token as string; // before any deactivation
    const adminAgentTok = (await axios.post(`${API}/recording/agent-auth`, {}, bearer(adminTok))).data.token as string;
    const wsToken = async (tok = adminTok) => (await axios.post(`${API}/recording/admin-ws-token`, {}, bearer(tok))).data.token as string;

    const RUN = makeRun(3, 3); // real WebM parts, reused by every scenario that assembles
    const rnd = () => crypto.randomBytes(1500);

    // ── S5: clamp a wrong agent clock ──────────────────────
    console.log('S5  startedAt outside [now-30d, now+1d] is clamped to receipt time');
    const segNormal = newSeg('s5n'), seg1970 = newSeg('s5a'), seg2099 = newSeg('s5b');
    const rNormal = await register(agentTok, segNormal, new Date());
    track(rNormal.data.sessionId);
    const R = rNormal.data.recordingDate as string;
    const r1970 = await register(agentTok, seg1970, '1970-01-01T00:00:00Z');
    const r2099 = await register(agentTok, seg2099, '2099-01-01T00:00:00Z');
    if (r1970.data.sessionId) track(r1970.data.sessionId);
    if (r2099.data.sessionId) track(r2099.data.sessionId);
    const T = rNormal.data.sessionId as string; // today's session
    const near = async (id: string) => { const s = await segRow(id); return !!s && Math.abs(s.started_at.getTime() - Date.now()) < 120_000; };
    check('S5 startedAt 1970 → recordingDate equals today\'s day', r1970.data.recordingDate === R, `${r1970.status} ${r1970.data.recordingDate} vs ${R}`);
    check('S5 startedAt 1970 → stored started_at within 2 min of now', await near(seg1970));
    check('S5 startedAt 2099 → recordingDate equals today\'s day', r2099.data.recordingDate === R, `${r2099.status} ${r2099.data.recordingDate} vs ${R}`);
    check('S5 startedAt 2099 → stored started_at within 2 min of now', await near(seg2099));

    // ── S1: heal a chunk row lost to a crash ───────────────
    console.log('S1  chunk file stored, DB row missing, same bytes re-sent');
    const seg1 = newSeg('s1');
    await register(agentTok, seg1, new Date());
    const first = await putChunk(agentTok, seg1, 0, RUN[0]);
    await prisma.recordingChunk.deleteMany({ where: { segment_id: seg1, seq: 0 } }); // crash between link and insert
    const again = await putChunk(agentTok, seg1, 0, RUN[0]);
    check('S1 first upload stored (201)', first.status === 201);
    check('S1 re-upload after the row was lost → 2xx', again.status >= 200 && again.status < 300, `${again.status} ${JSON.stringify(again.data)}`);
    const healed = await chunkRow(seg1, 0);
    check('S1 …and the chunk row exists again with the right sha', !!healed && healed.sha256 === sha(RUN[0]), JSON.stringify(again.data));
    check('S1 …manifest lists seq 0', JSON.stringify((await manifest(agentTok, seg1)).data.have) === '[0]');
    const cl1 = await close(agentTok, seg1, 0);
    check('S1 …closing with lastSeq 0 → segment state complete', cl1.data.state === 'complete' && (await segRow(seg1))?.state === 'complete', `${cl1.status} ${JSON.stringify(cl1.data)}`);

    // ── S3: malformed optional headers are never a reason to refuse ──
    console.log('S3  malformed optional headers');
    const seg3 = newSeg('s3');
    await register(agentTok, seg3, new Date());
    const bad: [string, Record<string, string>][] = [
      ['X-Captured-At: not-a-date', { 'X-Captured-At': 'not-a-date' }],
      ['X-Duration-Ms: -5', { 'X-Duration-Ms': '-5' }],
      ['X-Logged-Out: maybe', { 'X-Logged-Out': 'maybe' }],
    ];
    for (let i = 0; i < bad.length; i++) {
      const r = await putChunk(agentTok, seg3, i, RUN[i], bad[i][1]);
      const row = await chunkRow(seg3, i);
      check(`S3 ${bad[i][0]} → 201 and chunk stored (row + file)`, r.status === 201 && !!row && fs.existsSync(row.file_path), `${r.status} ${JSON.stringify(r.data)}`);
    }
    const r3 = [await chunkRow(seg3, 0), await chunkRow(seg3, 1), await chunkRow(seg3, 2)];
    check('S3 malformed metadata stored as null / defaults (captured_at null, duration_ms null, logged_out false)',
      !!r3[0] && r3[0].captured_at === null && !!r3[1] && r3[1].duration_ms === null && !!r3[2] && r3[2].logged_out === false,
      JSON.stringify(r3.map((c) => c && [c.captured_at, c.duration_ms, c.logged_out])));

    // ── S4: a segment left open forever is closed by the sweeper ──
    console.log('S4  abandoned open segment while the session keeps receiving others');
    const when4 = daysAgo(4);
    const segA = newSeg('s4a'), segB = newSeg('s4b');
    const rA = await register(agentTok, segA, when4);
    track(rA.data.sessionId);
    for (let i = 0; i < 3; i++) await putChunk(agentTok, segA, i, RUN[i]);
    await register(agentTok, segB, new Date(when4.getTime() + 60_000));
    await putChunk(agentTok, segB, 0, RUN[0]); // fresh chunk keeps the session itself alive
    const past31 = new Date(Date.now() - 31 * 60_000);
    await prisma.recordingChunk.updateMany({ where: { segment_id: segA }, data: { uploaded_at: past31 } });
    await prisma.recordingSegment.update({ where: { id: segA }, data: { updated_at: past31 } });
    await sweepV2();
    const closedA = await until(async () => { const s = await segRow(segA); return s && ['complete', 'assembled'].includes(s.state) ? s : null; }, 20_000);
    const sa = await segRow(segA);
    // sweepV2 starts the assembly pump in THIS process: let its chain of runs finish before the later scenarios
    // create sessions, or it would assemble them in parallel with the direct assembleSessionV2 calls below.
    for (let quiet = 0, i = 0; quiet < 3 && i < 120; i++) { await sleep(500); quiet = activeAssemblyCount() === 0 ? quiet + 1 : 0; }
    check('S4 segment A (31 min without a chunk) is closed → complete/assembled', !!closedA, `state=${sa?.state}`);
    check('S4 …with last_seq = highest stored seq (2)', sa?.last_seq === 2, `last_seq=${sa?.last_seq}`);
    check('S4 …while segment B (fresh chunk) stays open', (await segRow(segB))?.state === 'open');

    // ── S2: a missing chunk file must not be committed ─────
    console.log('S2  chunk file missing on disk at assembly');
    const segX = newSeg('s2');
    const rX = await register(agentTok, segX, daysAgo(2));
    const X = track(rX.data.sessionId as string);
    for (let i = 0; i < 3; i++) await putChunk(agentTok, segX, i, RUN[i]);
    const row1 = (await chunkRow(segX, 1))!;
    await fs.promises.rm(row1.file_path, { force: true }); // removed while the segment is still open (not yet assemblable)
    const clX = await close(agentTok, segX, 2);
    const genBefore = (await sessionRow(X))!.generation;
    let threw = false;
    try { await assembleSessionV2(X); } catch { threw = true; }
    const sx = await segRow(segX);
    const sxs = await sessionRow(X);
    const xChunks = await prisma.recordingChunk.findMany({ where: { segment_id: segX }, orderBy: { seq: 'asc' } });
    const ctx = `closeState=${clX.data.state} threw=${threw} segState=${sx?.state} gen=${sxs?.generation} err=${sxs?.assembly_error}`;
    check('S2 segment with a missing chunk file is NOT marked assembled', sx?.state !== 'assembled', ctx);
    check('S2 none of its chunk rows has purged_at', xChunks.length === 3 && xChunks.every((c) => c.purged_at === null), JSON.stringify(xChunks.map((c) => c.purged_at)));
    check('S2 session.assembly_error is set', !!sxs?.assembly_error, ctx);
    check('S2 session.generation is unchanged', sxs?.generation === genBefore, `${genBefore} → ${sxs?.generation}`);
    check('S2 the remaining chunk files (0 and 2) are still on disk', fs.existsSync(xChunks[0]?.file_path ?? '') && fs.existsSync(xChunks[2]?.file_path ?? ''));

    // ── S11: failing assembly respects backoff on demand ───
    console.log('S11 on-demand assembly respects the failure backoff');
    const segZ = newSeg('s11');
    const rZ = await register(agentTok, segZ, daysAgo(3));
    const Z = track(rZ.data.sessionId as string);
    for (let i = 0; i < 3; i++) await putChunk(agentTok, segZ, i, RUN[i]);
    // generation 1 whose file is gone: assembly refuses to build over it, deterministically and fast
    const zDir = (await sessionRow(Z))!.dir_path!;
    await prisma.recordingSession.update({ where: { id: Z }, data: { generation: 1, file_path: path.join(zDir, 'recording-g1.webm') } });
    await close(agentTok, segZ, 2);
    try { await assembleSessionV2(Z); } catch { /* expected: failure recorded */ }
    const z1 = (await sessionRow(Z))!;
    await assembleOnDemand(Z); // what every <video> Range request does
    await axios.get(`${API}/recording/sessions/${Z}/file`, { ...bearer(adminTok), responseType: 'arraybuffer' });
    await sleep(3000);
    const z2 = (await sessionRow(Z))!;
    check('S11 assembly keeps failing → immediate on-demand retries do not bump assembly_attempts', z1.assembly_attempts >= 1 && z2.assembly_attempts === z1.assembly_attempts, `attempts ${z1.assembly_attempts} → ${z2.assembly_attempts}`);
    check('S11 …a failure sets assembly_next_at = now + backoff (not derived from updated_at)', !!z1.assembly_next_at && z1.assembly_next_at.getTime() > Date.now() + 5 * 60_000, `next_at=${z1.assembly_next_at?.toISOString()}`);
    check('S11 …and on-demand assembly declines while assembly_next_at is in the future', (await assembleOnDemand(Z)) === false);
    const segZ2 = newSeg('s11b');
    await register(agentTok, segZ2, daysAgo(3));
    await putChunk(agentTok, segZ2, 0, RUN[0]);
    const z3 = (await sessionRow(Z))!;
    check('S11 a new chunk for the session clears assembly_next_at and attempts (new data is worth a fresh try)', z3.assembly_next_at === null && z3.assembly_attempts === 0, `next_at=${z3.assembly_next_at} attempts=${z3.assembly_attempts}`);

    // ── S6: retention keeps what is not safely assembled ───
    console.log('S6  retention skips sessions with unassembled segments / recent chunks');
    const segN = newSeg('s6n'), segC = newSeg('s6c');
    const rN = await register(agentTok, segN, daysAgo(6));
    const rC = await register(agentTok, segC, daysAgo(7));
    const N = track(rN.data.sessionId as string), C = track(rC.data.sessionId as string);
    for (let i = 0; i < 3; i++) { await putChunk(agentTok, segN, i, RUN[i]); await putChunk(agentTok, segC, i, RUN[i]); }
    await close(agentTok, segN, 2);
    await close(agentTok, segC, 2);
    await assembleSessionV2(C); // control: a real, fully assembled generation
    const cRow = (await sessionRow(C))!;
    const week8 = daysAgo(8);
    await prisma.recordingChunk.updateMany({ where: { session_id: C }, data: { uploaded_at: week8 } });
    await prisma.recordingSegment.updateMany({ where: { session_id: C }, data: { updated_at: week8 } });
    await prisma.recordingSession.update({ where: { id: C }, data: { recording_date: dateOnlyUtc(daysAgo(41)), status: 'stopped', last_chunk_at: week8 } });
    await prisma.recordingSession.update({ where: { id: N }, data: { recording_date: dateOnlyUtc(daysAgo(40)), status: 'stopped' } });
    const nDir = (await sessionRow(N))!.dir_path!, cDir = cRow.dir_path!;
    await prisma.appSetting.upsert({ where: { key: 'recording.retention_days' }, create: { key: 'recording.retention_days', value: '30', updated_by: adminRow.id }, update: { value: '30', updated_by: adminRow.id } });
    const ran = await runRetentionOnce({ onlyUserId: empId });
    check('S6 control: assembly of the control session succeeded (generation 1)', cRow.generation === 1, `generation=${cRow.generation} err=${cRow.assembly_error}`);
    check('S6 40-day-old session with an unassembled (complete) segment and fresh chunks is NOT deleted', !!(await sessionRow(N)), `removed=${ran.sessions}`);
    check('S6 …and its folder still exists', fs.existsSync(nDir));
    check('S6 control: 41-day-old, fully assembled, chunks older than 7 days IS deleted (rows)', !(await sessionRow(C)));
    check('S6 control: …and its folder is gone', !fs.existsSync(cDir));

    // ── Session with a file for playback (S8, S13) ─────────
    const segP = newSeg('play');
    const rP = await register(agentTok, segP, daysAgo(1)); // stays open: never assemblable
    const P = track(rP.data.sessionId as string);
    const payload = crypto.randomBytes(4000);
    const pFile = path.join(os.tmpdir(), `edge-e2e-${rid()}.webm`);
    fs.writeFileSync(pFile, payload);
    tmpFiles.push(pFile);
    await prisma.recordingSession.update({ where: { id: P }, data: { file_path: pFile, generation: 1, duration_ms: 1000, status: 'assembled' } });
    const rangeGet = (url: string) => axios.get(url, { ...noThrow, headers: { Range: 'bytes=0-9' }, responseType: 'arraybuffer' });

    // ── S8: tokens are not signed with the public agent secret ──
    console.log('S8  viewer / playback tokens are signed with the session secret');
    const forgedWs = jwt.sign({ sub: adminRow.id, role: 'admin-ws' }, AGENT_SECRET, { expiresIn: '5m' });
    const fv = await connectViewer(forgedWs);
    sockets.push(fv.ws);
    check('S8 /admin-recording-ws with an admin-ws token signed by the agent secret is refused', !fv.ok, 'socket was accepted');
    const forgedPt = jwt.sign({ sub: adminRow.id, sid: P, typ: 'playback' }, AGENT_SECRET, { expiresIn: '5m' });
    check('S8 file?pt= signed by the agent secret → 401', (await rangeGet(`${API}/recording/sessions/${P}/file?pt=${forgedPt}`)).status === 401);
    const goodWs = await connectViewer(await wsToken());
    sockets.push(goodWs.ws);
    check('S8 positive: a viewer token from the real endpoint still connects', goodWs.ok && !!goodWs.connected);
    const ptUrl = (await axios.post(`${API}/recording/sessions/${P}/playback-token`, {}, bearer(adminTok))).data.url as string;
    const pos = await rangeGet(ORIGIN + ptUrl);
    check('S8 positive: pt from /playback-token streams 206 with a Range', pos.status === 206 && pos.data.byteLength === 10, `${pos.status}`);

    // ── S13: download=1 → attachment ───────────────────────
    console.log('S13 ?download=1 → Content-Disposition: attachment');
    const dl = await rangeGet(`${ORIGIN}${ptUrl}&download=1`);
    check('S13 file?pt=…&download=1 → Content-Disposition starts with attachment', /^attachment/i.test(String(dl.headers['content-disposition'] ?? '')), `${dl.status} ${dl.headers['content-disposition']}`);
    const inl = String(pos.headers['content-disposition'] ?? '');
    check('S13 file?pt=… without download → Content-Disposition absent or inline', inl === '' || /^inline/i.test(inl), inl);

    // ── S12 + S7: live viewer socket ───────────────────────
    console.log('S12/S7 live: iceServers in LIVE_SUBSCRIBED, revoked grant');
    const agent = await connectAgent(agentTok);
    sockets.push(agent.ws);
    agent.send({ type: 'STATUS', state: 'recording', loggedIn: true, version: 'e2e-edge' });
    await sleep(500);
    const adm = await connectViewer(await wsToken());
    sockets.push(adm.ws);
    adm.send({ type: 'LIVE_SUBSCRIBE', userId: empId, quality: 'grid' });
    const subd = await adm.waitFor((m) => m.type === 'LIVE_SUBSCRIBED' || m.type === 'LIVE_REJECTED');
    check('S12 LIVE_SUBSCRIBED carries a non-empty iceServers array', subd?.type === 'LIVE_SUBSCRIBED' && Array.isArray(subd.iceServers) && subd.iceServers.length > 0, JSON.stringify(subd));
    if (subd?.streamId) adm.send({ type: 'LIVE_UNSUBSCRIBE', streamId: subd.streamId });

    await prisma.userTabAccess.create({ data: { user_id: other.id, tab_key: 'recording' } });
    const hr = await connectViewer(await wsToken(otherTok));
    sockets.push(hr.ws);
    const hrOk = hr.ok && !!hr.connected;
    await prisma.userTabAccess.deleteMany({ where: { user_id: other.id, tab_key: 'recording' } }); // revoked while the socket is open
    hr.send({ type: 'LIVE_SUBSCRIBE', userId: empId, quality: 'grid' });
    const hrRes = await hr.waitFor((m) => m.type === 'LIVE_SUBSCRIBED' || m.type === 'LIVE_REJECTED');
    check('S7 precondition: HR viewer connected while the grant existed', hrOk);
    check('S7 LIVE_SUBSCRIBE after the grant was revoked → LIVE_REJECTED not_allowed', hrRes?.type === 'LIVE_REJECTED' && hrRes.reason === 'not_allowed', JSON.stringify(hrRes));
    hr.ws.close();
    agent.ws.close();
    adm.ws.close();

    // ── S9: admins and deactivated users cannot upload ─────
    console.log('S9  admin / inactive user agent tokens');
    const adminReg = await register(adminAgentTok, newSeg('s9a'), new Date());
    if (adminReg.data?.sessionId) track(adminReg.data.sessionId);
    check('S9 admin\'s agent token → PUT segment → 403', adminReg.status === 403, `${adminReg.status}`);
    await prisma.user.update({ where: { id: other.id }, data: { status: 'inactive' } });
    const inactiveReg = await register(otherAgentTok, newSeg('s9i'), new Date());
    if (inactiveReg.data?.sessionId) track(inactiveReg.data.sessionId);
    check('S9 inactive user\'s agent token → PUT segment → 403', inactiveReg.status === 403, `${inactiveReg.status}`);
    const inactiveAgent = await connectAgent(otherAgentTok);
    sockets.push(inactiveAgent.ws);
    check('S9 protocol-2 AUTH for an inactive user → CONNECTED.record === false', inactiveAgent.connected?.record === false, JSON.stringify(inactiveAgent.connected));
    inactiveAgent.ws.close();
    await prisma.user.update({ where: { id: other.id }, data: { status: prevOtherStatus } });

    // ── S10: employees list ────────────────────────────────
    console.log('S10 GET /api/employees');
    check('S10 without Authorization → 401', (await axios.get(`${API}/employees`, noThrow)).status === 401);
    const list = await axios.get(`${API}/employees`, bearer(adminTok));
    const leaks = (v: any): boolean => {
      if (Array.isArray(v)) return v.some(leaks);
      if (v && typeof v === 'object') return 'password_hash' in v || Object.values(v).some((x) => x && typeof x === 'object' && leaks(x));
      return false;
    };
    check('S10 with an admin Bearer → 200 and an array', list.status === 200 && Array.isArray(list.data) && list.data.length > 0, `${list.status}`);
    check('S10 no element (nor nested object) has a password_hash key', list.status === 200 && Array.isArray(list.data) && !leaks(list.data));
    const asEmp = await axios.get(`${API}/employees`, bearer(empTok)); // ChatHub / CallsTab / EmployeeDashboard use it as a plain employee
    check('S10 control: a signed-in non-admin employee still gets 200', asEmp.status === 200 && Array.isArray(asEmp.data), `${asEmp.status}`);

    // ── S14: the mutating employee routes need a session too ──
    // Bodies are harmless even on code that accepts them: no username/name (create fails validation),
    // user ids that do not exist (updates / delete fail with "not found").
    console.log('S14 mutating /api/employees routes without a session');
    const ghost = '__nonexistent__';
    const mut: [string, string, any][] = [
      ['POST', '/employees', { role: 'employee' }],
      ['POST', '/employees/update-employee', { user_id: ghost, monthly_salary: 1 }],
      ['POST', '/employees/update-leaves', { user_id: ghost }],
      ['POST', '/employees/update-username', { user_id: ghost, username: `ghost-${rid()}` }],
      ['POST', '/employees/update-status', { user_id: ghost, status: 'active' }],
      ['DELETE', `/employees/${ghost}`, undefined],
    ];
    const usersBefore = await prisma.user.count();
    for (const [m, p, body] of mut) {
      const r = await axios.request({ method: m as any, url: `${API}${p}`, data: body, ...noThrow });
      check(`S14 ${m} ${p.replace(ghost, ':id')} without Authorization → 401`, r.status === 401, `${r.status}`);
    }
    check('S14 harness: no user was created or deleted by those requests', (await prisma.user.count()) === usersBefore);
    const adm14 = await axios.post(`${API}/employees/update-employee`, { user_id: ghost, monthly_salary: 1 }, bearer(adminTok));
    check('S14 control: with an admin Bearer the same route is reachable (not 401/403)', adm14.status !== 401 && adm14.status !== 403, `${adm14.status}`);

    // ── S15: tab-access routes need a session; non-admins cannot read others' tabs ──
    console.log('S15 /api/tab-access');
    const TA = `${API}/tab-access`;
    const hasRow = async (uid: string, key: string) => !!(await prisma.userTabAccess.findUnique({ where: { user_id_tab_key: { user_id: uid, tab_key: key } } }));
    check('S15 GET /hr-employees without Authorization → 401', (await axios.get(`${TA}/hr-employees`, noThrow)).status === 401);
    check('S15 GET /hr-employees with an employee Bearer → 403', (await axios.get(`${TA}/hr-employees`, bearer(empTok))).status === 403);
    const hrAdm = await axios.get(`${TA}/hr-employees`, bearer(adminTok));
    check('S15 GET /hr-employees with an admin Bearer → 200 and an employees array', hrAdm.status === 200 && Array.isArray(hrAdm.data?.employees), `${hrAdm.status}`);
    const myTabsUrl = `${TA}/my-tabs?user_id=${empId}`;
    check('S15 GET /my-tabs without Authorization → 401', (await axios.get(myTabsUrl, noThrow)).status === 401);
    const mineOwn = await axios.get(myTabsUrl, bearer(empTok));
    check('S15 GET /my-tabs for one\'s own user_id → 200 and a tabs array', mineOwn.status === 200 && Array.isArray(mineOwn.data?.tabs), `${mineOwn.status}`);
    check('S15 GET /my-tabs for another user\'s id (employee Bearer) → 403', (await axios.get(myTabsUrl, bearer(otherTok))).status === 403);
    check('S15 GET /my-tabs for another user\'s id (admin Bearer) → 200', (await axios.get(myTabsUrl, bearer(adminTok))).status === 200);
    const badTab = await axios.post(`${TA}/toggle`, { user_id: other.id, tab_key: 'not-a-real-tab', granted: true }, bearer(adminTok));
    check('S15 POST /toggle with an unknown tab_key → 400', badTab.status === 400, `${badTab.status}`);
    check('S15 …and no row was created for the unknown tab', !(await hasRow(other.id, 'not-a-real-tab')));
    await prisma.userTabAccess.deleteMany({ where: { user_id: other.id, tab_key: { in: ['not-a-real-tab', 'holidays'] } } }); // snapshot is restored in finally
    const strGrant = await axios.post(`${TA}/toggle`, { user_id: other.id, tab_key: 'holidays', granted: 'false' }, bearer(adminTok));
    check('S15 POST /toggle with granted:"false" (string) does not create a grant', !(await hasRow(other.id, 'holidays')), `${strGrant.status}`);

    // ── S16: exports need the matching tab grant ───────────
    console.log('S16 /api/export');
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
    const xl: AxiosRequestConfig = { responseType: 'arraybuffer', validateStatus: () => true };
    const xlAs = (t?: string): AxiosRequestConfig => (t ? { ...xl, headers: { Authorization: `Bearer ${t}` } } : xl);
    const isXlsx = (r: any) => r.status === 200 && String(r.headers['content-type'] || '').includes('spreadsheetml');
    await prisma.userTabAccess.deleteMany({ where: { user_id: other.id, tab_key: { in: ['export', 'attendance', 'payroll'] } } });
    for (const [ep, key] of [['attendance', 'export'], ['salary', 'payroll']] as const) {
      const url = `${API}/export/${ep}?start_date=${today}&end_date=${today}`;
      check(`S16 GET /export/${ep} without Authorization → 401`, (await axios.get(url, xlAs())).status === 401);
      check(`S16 GET /export/${ep} for haseeb without an export/attendance/payroll grant → 403`, (await axios.get(url, xlAs(otherTok))).status === 403);
      await prisma.userTabAccess.create({ data: { user_id: other.id, tab_key: key } });
      const granted = await axios.get(url, xlAs(otherTok));
      check(`S16 GET /export/${ep} for haseeb with a '${key}' grant → 200 spreadsheetml`, isXlsx(granted), `${granted.status} ${granted.headers['content-type']}`);
      await prisma.userTabAccess.deleteMany({ where: { user_id: other.id, tab_key: key } });
      const adm = await axios.get(url, xlAs(adminTok));
      check(`S16 GET /export/${ep} for an admin → 200 spreadsheetml`, isXlsx(adm), `${adm.status} ${adm.headers['content-type']}`);
    }

    console.log('S17 late chunk after assembly is re-opened and appended');
    const tail0 = makeRun(2, 1)[0];
    const tail1 = makeRun(2, 1)[0];
    const segT = newSeg('s17');
    const rT = await register(agentTok, segT, daysAgo(6));
    const T17 = track(rT.data.sessionId as string);
    const put0 = await putChunk(agentTok, segT, 0, tail0);
    await close(agentTok, segT, 0);
    await assembleSessionV2(T17);
    const before17 = (await sessionRow(T17))!;
    const beforeDur = durationOf(before17.file_path!);
    const latePut = await putChunk(agentTok, segT, 1, tail1);
    const reopened = await until(async () => { const s = await segRow(segT); return s && s.state !== 'assembled' ? s : null; }, 5000);
    check('S17 late chunk on an assembled segment is accepted', put0.status >= 200 && put0.status < 300 && latePut.status >= 200 && latePut.status < 300, `${put0.status}/${latePut.status}`);
    check('S17 …and re-opens the segment for assembly', !!reopened, `state=${(await segRow(segT))?.state}`);
    await assembleSessionV2(T17);
    const after17 = (await sessionRow(T17))!;
    const tailRow = await chunkRow(segT, 1);
    const tailSeg = await segRow(segT);
    // Stage 1: the late chunk has no WebM header of its own (seq 0 was purged with generation 1), so it cannot be
    // decoded. It must be kept on disk and flagged. Stage 2 grafts a header; then it appends to the video again
    // (generation + 1, duration + ~2 s, chunk purged) and these three checks become the original S17 assertions.
    check('S17 …a late chunk without its segment header is kept (row not purged, file on disk)', !!tailRow && tailRow.purged_at === null && fs.existsSync(tailRow.file_path), `purged=${tailRow?.purged_at}`);
    check('S17 …and flagged: segment unreadable, problem names the missing header', tailSeg?.state === 'unreadable' && /late chunks without their header/.test(tailSeg.problem ?? ''), `state=${tailSeg?.state} problem=${tailSeg?.problem}`);
    check('S17 …and the generation is untouched', after17.generation === before17.generation && durationOf(after17.file_path!) === beforeDur, `gen ${before17.generation}→${after17.generation}`);

    // ── S18–S22: bad media must never block a day, and its bytes must never be purged ──
    const BAD = makeBadMedia();
    const addGood = async (seg: string, startedAt: Date, durHdr: string | null = null) => {
      await register(agentTok, seg, startedAt);
      for (let i = 0; i < RUN.length; i++) await putChunk(agentTok, seg, i, RUN[i], durHdr ? { 'X-Duration-Ms': durHdr } : {});
      await close(agentTok, seg, RUN.length - 1);
    };
    const addBad = async (seg: string, startedAt: Date, parts: Buffer[]) => {
      await register(agentTok, seg, startedAt);
      for (let i = 0; i < parts.length; i++) await putChunk(agentTok, seg, i, parts[i]);
      await close(agentTok, seg, parts.length - 1);
    };
    const kept = async (seg: string) => {
      const rows = await prisma.recordingChunk.findMany({ where: { segment_id: seg } });
      return rows.length > 0 && rows.every((c) => c.purged_at === null && fs.existsSync(c.file_path));
    };
    const purged = async (seg: string) => {
      const rows = await prisma.recordingChunk.findMany({ where: { segment_id: seg } });
      return rows.length > 0 && rows.every((c) => c.purged_at !== null && !fs.existsSync(c.file_path));
    };
    const runOk = async (id: string) => { try { await assembleSessionV2(id); return true; } catch { return false; } };
    const durOf = (r: { file_path: string | null }) => (r.file_path && fs.existsSync(r.file_path) ? durationOf(r.file_path) : -1);

    console.log('S18 a one-chunk segment without a single frame, first in the day, does not block the others');
    const d18 = daysAgo(10);
    const sBad18 = newSeg('s18b'), sG18a = newSeg('s18a'), sG18b = newSeg('s18c');
    const S18 = track((await register(agentTok, sBad18, d18)).data.sessionId as string);
    await putChunk(agentTok, sBad18, 0, BAD.cutCluster);
    await close(agentTok, sBad18, 0);
    await addGood(sG18a, new Date(d18.getTime() + 60_000));
    await addGood(sG18b, new Date(d18.getTime() + 120_000));
    const ok18 = await runOk(S18);
    const row18 = (await sessionRow(S18))!;
    const dur18 = durOf(row18);
    check('S18 assembly does not throw', ok18);
    check('S18 the two good segments are in generation 1 (~6 s)', row18.generation === 1 && dur18 > 5 && dur18 < 7.5, `gen=${row18.generation} dur=${dur18}`);
    const bad18 = await segRow(sBad18);
    check('S18 the frameless segment is unreadable with a reason', bad18?.state === 'unreadable' && /no readable video/.test(bad18.problem ?? ''), `state=${bad18?.state} problem=${bad18?.problem}`);
    check('S18 …its chunk row is not purged and the file is still on disk', await kept(sBad18));
    check('S18 the good segments are assembled and their chunk files purged', (await segRow(sG18a))?.state === 'assembled' && (await segRow(sG18b))?.state === 'assembled' && (await purged(sG18a)) && (await purged(sG18b)));
    check('S18 the session says why (assembly_error names the segment) and nothing is pending', (row18.assembly_error ?? '').includes(sBad18) && (await prisma.recordingSegment.count({ where: { session_id: S18, state: { in: ['complete', 'incomplete'] } } })) === 0, `err=${row18.assembly_error}`);

    console.log('S19 an unreadable segment after good ones is not silently purged');
    const d19 = daysAgo(11);
    const sG19 = newSeg('s19g'), sBad19 = newSeg('s19b');
    const S19 = track((await register(agentTok, sG19, d19)).data.sessionId as string);
    await addGood(sG19, d19);
    await addBad(sBad19, new Date(d19.getTime() + 60_000), [BAD.junk, BAD.junk.subarray(0, 1500)]);
    const ok19 = await runOk(S19);
    const row19 = (await sessionRow(S19))!;
    const dur19 = durOf(row19);
    check('S19 assembly does not throw; generation 1 holds the good segment only (~3 s)', ok19 && row19.generation === 1 && dur19 > 2 && dur19 < 4.5, `ok=${ok19} gen=${row19.generation} dur=${dur19}`);
    check('S19 the junk segment is unreadable and BOTH its chunks stay on disk, unpurged', (await segRow(sBad19))?.state === 'unreadable' && (await kept(sBad19)), `state=${(await segRow(sBad19))?.state}`);
    check('S19 the good segment was purged only after it was in the video', (await segRow(sG19))?.state === 'assembled' && (await purged(sG19)));
    await assembleSessionV2(S19).catch(() => {});
    check('S19 a second run changes nothing (nothing pending, files still kept)', (await sessionRow(S19))!.generation === 1 && (await kept(sBad19)));

    console.log('S20 a keyframe-less segment is unreadable, the rest assembles; a run that adds no video keeps the attempts');
    const d20 = daysAgo(12);
    const sA20 = newSeg('s20a'), sD20 = newSeg('s20d'), sC20 = newSeg('s20c');
    const S20 = track((await register(agentTok, sA20, d20)).data.sessionId as string);
    await addGood(sA20, d20);
    await addBad(sD20, new Date(d20.getTime() + 60_000), [BAD.deltaOnly]);
    await addGood(sC20, new Date(d20.getTime() + 120_000));
    const ok20 = await runOk(S20);
    const row20 = (await sessionRow(S20))!;
    const dur20 = durOf(row20);
    check('S20 the good segments around it are in generation 1 (~6 s)', ok20 && row20.generation === 1 && dur20 > 5 && dur20 < 7.5, `ok=${ok20} gen=${row20.generation} dur=${dur20}`);
    check('S20 the keyframe-less segment is unreadable and kept', (await segRow(sD20))?.state === 'unreadable' && (await kept(sD20)), `state=${(await segRow(sD20))?.state}`);
    const d20b = daysAgo(13);
    const sOnly20 = newSeg('s20o');
    const S20b = track((await register(agentTok, sOnly20, d20b)).data.sessionId as string);
    await addBad(sOnly20, d20b, [BAD.deltaOnly]);
    await prisma.recordingSession.update({ where: { id: S20b }, data: { assembly_attempts: 2, assembly_next_at: new Date(Date.now() - 1000) } });
    const ok20b = await runOk(S20b);
    const row20b = (await sessionRow(S20b))!;
    check('S20 a day with nothing readable: no throw, no generation, no file', ok20b && row20b.generation === 0 && !row20b.file_path, `ok=${ok20b} gen=${row20b.generation} file=${row20b.file_path}`);
    check('S20 …the segment is unreadable, nothing is pending, chunks kept', (await segRow(sOnly20))?.state === 'unreadable' && (await kept(sOnly20)));
    check('S20 …a commit that adds no video does not reset attempts, and the reason stays in assembly_error', row20b.assembly_attempts === 2 && !!row20b.assembly_error, `attempts=${row20b.assembly_attempts} err=${row20b.assembly_error}`);

    console.log('S21 coverage: the video is much shorter than the chunks claim → the files are kept');
    const d21 = daysAgo(14);
    const sShort = newSeg('s21');
    const S21 = track((await register(agentTok, sShort, d21)).data.sessionId as string);
    await addGood(sShort, d21, '60000'); // 3 chunks x 60 s claimed = 3 min, ~3 s readable
    const ok21 = await runOk(S21);
    const row21 = (await sessionRow(S21))!;
    const seg21 = await segRow(sShort);
    const rows21 = await prisma.recordingChunk.findMany({ where: { segment_id: sShort } });
    check('S21 what plays is in generation 1', ok21 && row21.generation === 1 && !!row21.file_path && fs.existsSync(row21.file_path), `ok=${ok21} gen=${row21.generation}`);
    check('S21 the segment is assembled with a problem "only X of Y min readable"', seg21?.state === 'assembled' && /^only [\d.]+ of [\d.]+ min readable$/.test(seg21.problem ?? ''), `state=${seg21?.state} problem=${seg21?.problem}`);
    check('S21 chunk rows are purged (not pending again) but the chunk FILES stay on disk', rows21.length === 3 && rows21.every((c) => c.purged_at !== null && fs.existsSync(c.file_path)));

    console.log('S21b coverage tolerance is tight (max(15 s, 1 %)) and each chunk counts at most 60 s');
    const d21b = daysAgo(22), d21c = daysAgo(23);
    const sTight = newSeg('s21b'), sCap = newSeg('s21c');
    const S21b = track((await register(agentTok, sTight, d21b)).data.sessionId as string);
    await addGood(sTight, d21b, '10000'); // claims 30 s, ~3 s plays: 27 s of video missing (the old 10 % rule let 30 s through)
    const S21c = track((await register(agentTok, sCap, d21c)).data.sessionId as string);
    await addGood(sCap, d21c, '600000'); // claims 3 x 10 min: counted as 3 x 60 s
    await runOk(S21b);
    await runOk(S21c);
    const tight = await segRow(sTight), cap = await segRow(sCap);
    check('S21b 30 s claimed vs ~3 s played is flagged (only X of 0.5 min), files kept', tight?.state === 'assembled' && /^only [\d.]+ of 0\.5 min readable$/.test(tight.problem ?? '') && (await prisma.recordingChunk.findMany({ where: { segment_id: sTight } })).every((c) => fs.existsSync(c.file_path)), `state=${tight?.state} problem=${tight?.problem}`);
    check('S21c a chunk claiming 10 min counts as 60 s (…of 3.0 min), not 30 min', /^only [\d.]+ of 3\.0 min readable$/.test(cap?.problem ?? ''), `problem=${cap?.problem}`);
    check('S21b/c what plays is published in both days', (await sessionRow(S21b))!.generation === 1 && (await sessionRow(S21c))!.generation === 1);

    console.log('S22 a chunk arriving between the snapshot and the commit is never purged unseen');
    const hooks = (v2svc as any).testHooks as { afterSnapshot?: () => Promise<void> } | undefined;
    check('S22 precondition: the service exposes testHooks.afterSnapshot', !!hooks);
    if (hooks) {
      const d22 = daysAgo(15);
      const sRace = newSeg('s22');
      const S22 = track((await register(agentTok, sRace, d22)).data.sessionId as string);
      await addGood(sRace, d22);
      const lateTail = makeRun(2, 1)[0];
      hooks.afterSnapshot = async () => { hooks.afterSnapshot = undefined; await putChunk(agentTok, sRace, 3, lateTail); };
      const ok22 = await runOk(S22);
      hooks.afterSnapshot = undefined;
      const late = await chunkRow(sRace, 3);
      const row22 = (await sessionRow(S22))!;
      check('S22 the snapshot chunks are in generation 1', ok22 && row22.generation === 1, `ok=${ok22} gen=${row22.generation}`);
      check('S22 the chunk that arrived mid-assembly is NOT purged and its file is on disk', !!late && late.purged_at === null && fs.existsSync(late.file_path), `purged=${late?.purged_at}`);
      check('S22 …and its segment is pending again, not assembled-and-forgotten', ['complete', 'incomplete'].includes((await segRow(sRace))?.state ?? ''), `state=${(await segRow(sRace))?.state}`);
      await assembleSessionV2(S22).catch(() => {});
      const late2 = await chunkRow(sRace, 3);
      const seg22 = await segRow(sRace);
      check('S22 a later run keeps it (no header of its own) and flags it instead of purging', !!late2 && late2.purged_at === null && fs.existsSync(late2.file_path) && seg22?.state === 'unreadable' && !!seg22.problem, `state=${seg22?.state} problem=${seg22?.problem}`);
    }

    console.log('S24 two segments that will not join: bisect keeps the rest, a lone culprit gets one re-encode');
    const failJoinHooks = (v2svc as any).testHooks as { failJoin?: (g: { id: string; reencoded: boolean }[]) => boolean } | undefined;
    if (!failJoinHooks) check('S24 precondition: the service exposes testHooks.failJoin', false);
    else {
      const build = async (tag: string, daysBack: number) => {
        const d = daysAgo(daysBack);
        const segs = [0, 1, 2, 3].map((i) => newSeg(`s24${tag}${i}`));
        const sid = track((await register(agentTok, segs[0], d)).data.sessionId as string);
        for (const [i, sg] of segs.entries()) await addGood(sg, new Date(d.getTime() + i * 60_000));
        return { segs, sid };
      };
      const a = await build('a', 19);
      failJoinHooks.failJoin = (g) => g.some((x) => x.id === a.segs[1]); // B never joins, however it is encoded
      const okA = await runOk(a.sid);
      failJoinHooks.failJoin = undefined;
      const rowA = (await sessionRow(a.sid))!;
      check('S24 a culprit that never joins: no throw, generation 1 holds the other three (~9 s)', okA && rowA.generation === 1 && durOf(rowA) > 8 && durOf(rowA) < 10.5, `ok=${okA} gen=${rowA.generation} dur=${durOf(rowA)}`);
      check('S24 …the culprit is unreadable ("could not be joined") and its chunks are kept', (await segRow(a.segs[1]))?.state === 'unreadable' && /could not be joined/.test((await segRow(a.segs[1]))?.problem ?? '') && (await kept(a.segs[1])));
      check('S24 …the other three are assembled and purged', (await Promise.all([0, 2, 3].map(async (i) => (await segRow(a.segs[i]))?.state === 'assembled' && (await purged(a.segs[i]))))).every(Boolean));

      const b = await build('b', 20);
      failJoinHooks.failJoin = (g) => g.some((x) => x.id === b.segs[2] && !x.reencoded); // fine once re-encoded to the generation's codec/size
      const okB = await runOk(b.sid);
      failJoinHooks.failJoin = undefined;
      const rowB = (await sessionRow(b.sid))!;
      check('S24 a culprit that joins after its one re-encode: all four are in generation 1 (~12 s)', okB && rowB.generation === 1 && durOf(rowB) > 11 && durOf(rowB) < 13.5, `ok=${okB} gen=${rowB.generation} dur=${durOf(rowB)}`);
      check('S24 …nothing unreadable, nothing pending, all chunk files purged', (await prisma.recordingSegment.count({ where: { session_id: b.sid, state: { not: 'assembled' } } })) === 0 && (await Promise.all(b.segs.map(purged))).every(Boolean));
    }

    console.log('S25 ffmpeg itself is broken or missing: infrastructure failures never flag a segment');
    const d25 = daysAgo(24);
    const s25 = [newSeg('s25a'), newSeg('s25b')];
    const S25 = track((await register(agentTok, s25[0], d25)).data.sessionId as string);
    await addGood(s25[0], d25);
    await addGood(s25[1], new Date(d25.getTime() + 60_000));
    process.env.RECORDING_FFMPEG_PATH = path.join(os.tmpdir(), `no-such-ffmpeg-${rid()}.exe`);
    const ok25 = await runOk(S25);
    delete process.env.RECORDING_FFMPEG_PATH;
    const row25 = (await sessionRow(S25))!;
    const segs25 = await prisma.recordingSegment.findMany({ where: { session_id: S25 } });
    check('S25 with ffmpeg missing the run fails (throws) instead of judging the media', !ok25 && row25.generation === 0, `ok=${ok25} gen=${row25.generation}`);
    check('S25 …no segment is unreadable, both stay assemblable, all chunk files kept', segs25.length === 2 && segs25.every((s) => ['complete', 'incomplete'].includes(s.state) && s.problem === null) && (await kept(s25[0])) && (await kept(s25[1])), JSON.stringify(segs25.map((s) => [s.state, s.problem])));
    check('S25 …the session backs off (attempts 1, assembly_next_at in the future)', row25.assembly_attempts === 1 && !!row25.assembly_next_at && row25.assembly_next_at.getTime() > Date.now(), `attempts=${row25.assembly_attempts} next_at=${row25.assembly_next_at}`);
    const ok25b = await runOk(S25);
    check('S25 …and once ffmpeg works again the same data assembles (both segments, ~6 s)', ok25b && (await sessionRow(S25))!.generation === 1 && durOf((await sessionRow(S25))!) > 5, `ok=${ok25b}`);

    console.log('S26 new data for an unreadable segment revives it');
    const d26 = daysAgo(25);
    const sJ = newSeg('s26a');
    const S26 = track((await register(agentTok, sJ, d26)).data.sessionId as string);
    await addBad(sJ, d26, [BAD.junk]);
    await runOk(S26);
    check('S26 precondition: the junk segment is unreadable', (await segRow(sJ))?.state === 'unreadable');
    const rev = await putChunk(agentTok, sJ, 1, RUN[1]);
    const revived = await segRow(sJ);
    check('S26 a new chunk (HTTP) puts it back to complete and clears the problem', rev.status === 201 && revived?.state === 'complete' && revived.problem === null, `${rev.status} state=${revived?.state} problem=${revived?.problem}`);
    const d26b = daysAgo(26);
    const sK = newSeg('s26b');
    const S26b = track((await register(agentTok, sK, d26b)).data.sessionId as string);
    await addBad(sK, d26b, [BAD.junk]);
    const racing = (v2svc as any).testHooks as { afterSnapshot?: () => Promise<void> };
    racing.afterSnapshot = async () => { racing.afterSnapshot = undefined; await putChunk(agentTok, sK, 1, RUN[1]); };
    await runOk(S26b);
    racing.afterSnapshot = undefined;
    const rk = await segRow(sK);
    check('S26 a chunk that arrived during the run that flagged the segment revives it (not left unreadable with an unpurged chunk)', ['complete', 'incomplete', 'closed'].includes(rk?.state ?? '') && rk?.problem === null && (await chunkRow(sK, 1))?.purged_at === null, `state=${rk?.state} problem=${rk?.problem}`);

    console.log('S27 join trouble is bounded: at most 3 re-encodes / 3 flagged per run, the rest stays assemblable');
    const hooks27 = (v2svc as any).testHooks as { failJoin?: (g: { id: string; reencoded: boolean }[]) => boolean };
    const d27 = daysAgo(27);
    const s27 = Array.from({ length: 7 }, (_, i) => newSeg(`s27${i}`));
    const S27 = track((await register(agentTok, s27[0], d27)).data.sessionId as string);
    for (const [i, sg] of s27.entries()) await addGood(sg, new Date(d27.getTime() + i * 60_000));
    let reenc27 = 0;
    hooks27.failJoin = (g) => { if (g.some((x) => x.reencoded)) reenc27++; return g.some((x) => x.id !== s27[0]); }; // the first one (the base) is the odd one: nothing joins onto it
    const ok27 = await runOk(S27);
    hooks27.failJoin = undefined;
    const row27 = (await sessionRow(S27))!;
    const st27 = await prisma.recordingSegment.findMany({ where: { session_id: S27 } });
    check('S27 odd base: no more than 3 rescue re-encodes', reenc27 <= 3, `re-encodes=${reenc27}`);
    check('S27 …nothing joins onto the odd base: the longest segment alone is published (generation 1, ~3 s)', row27.generation === 1 && durOf(row27) > 2 && durOf(row27) < 4.5, `gen=${row27.generation} dur=${durOf(row27)}`);
    check('S27 …only that segment is assembled and purged; the other six are still complete, none flagged', st27.filter((s) => s.state === 'assembled').length === 1 && st27.filter((s) => s.state === 'complete').length === 6 && (await purged(s27[0])) && (await Promise.all(s27.slice(1).map(kept))).every(Boolean), JSON.stringify(st27.map((s) => s.state)));
    check('S27 …the session backs off (attempts ≥ 1, assembly_next_at set)', row27.assembly_attempts >= 1 && !!row27.assembly_next_at && row27.assembly_next_at.getTime() > Date.now(), `attempts=${row27.assembly_attempts} next_at=${row27.assembly_next_at} ok=${ok27}`);
    const ok27c = await runOk(S27); // the next run: the six join on top of the published one
    const row27c = (await sessionRow(S27))!;
    check('S27 …the next run tries them on top of it: generation 2 holds all seven (~21 s)', ok27c && row27c.generation === 2 && durOf(row27c) > 19 && durOf(row27c) < 23.5, `ok=${ok27c} gen=${row27c.generation} dur=${durOf(row27c)}`);

    const d27b = daysAgo(28);
    const t27 = Array.from({ length: 7 }, (_, i) => newSeg(`s27b${i}`));
    const S27b = track((await register(agentTok, t27[0], d27b)).data.sessionId as string);
    await addGood(t27[0], d27b);
    await runOk(S27b); // generation 1 = t27[0]
    for (let i = 1; i < 7; i++) await addGood(t27[i], new Date(d27b.getTime() + i * 60_000));
    let reenc27b = 0;
    hooks27.failJoin = (g) => { if (g.some((x) => x.reencoded)) reenc27b++; return g.some((x) => [t27[1], t27[2], t27[3], t27[4], t27[5]].includes(x.id)); };
    await runOk(S27b);
    hooks27.failJoin = undefined;
    const row27b = (await sessionRow(S27b))!;
    const st27b = await Promise.all(t27.map(async (s) => (await segRow(s))?.state));
    check('S27 with a previous generation: the one joinable segment is published (generation 2, ~6 s)', row27b.generation === 2 && durOf(row27b) > 5 && durOf(row27b) < 7.5, `gen=${row27b.generation} dur=${durOf(row27b)}`);
    check('S27 …3 flagged unreadable, the 2 beyond the budget still complete, at most 3 re-encodes', st27b.slice(1, 4).every((s) => s === 'unreadable') && st27b.slice(4, 6).every((s) => s === 'complete') && st27b[6] === 'assembled' && reenc27b <= 3, `${JSON.stringify(st27b)} re-encodes=${reenc27b}`);
    check('S27 …and it backs off for the postponed ones (assembly_next_at set)', !!row27b.assembly_next_at && row27b.assembly_next_at.getTime() > Date.now() && row27b.assembly_attempts >= 1, `attempts=${row27b.assembly_attempts}`);

    console.log('S28 a stale duration_ms in the DB must not break the next generation');
    const d29 = daysAgo(29);
    const s29 = [newSeg('s29a'), newSeg('s29b')];
    const S28 = track((await register(agentTok, s29[0], d29)).data.sessionId as string);
    await addGood(s29[0], d29);
    await runOk(S28);
    await prisma.recordingSession.update({ where: { id: S28 }, data: { duration_ms: 3_600_000 } }); // the DB claims an hour; the file is 3 s
    await addGood(s29[1], new Date(d29.getTime() + 60_000));
    const ok29 = await runOk(S28);
    const row29 = (await sessionRow(S28))!;
    check('S28 generation 2 is built from the measured length of generation 1 (~6 s), segment assembled', ok29 && row29.generation === 2 && (await segRow(s29[1]))?.state === 'assembled' && Math.abs((row29.duration_ms ?? 0) / 1000 - durOf(row29)) < 1.5, `ok=${ok29} gen=${row29.generation} duration_ms=${row29.duration_ms} file=${durOf(row29)}`);

    console.log('S29 ambiguous ffmpeg text (Input/output error) is the segment\'s problem only from the 4th run');
    const hooks30 = (v2svc as any).testHooks as { ffmpegFault?: (args: string[]) => string | null };
    const d30 = daysAgo(8);
    const s30 = [newSeg('s30a'), newSeg('s30b'), newSeg('s30c')];
    const S30 = track((await register(agentTok, s30[0], d30)).data.sessionId as string);
    for (const [i, sg] of s30.entries()) await addGood(sg, new Date(d30.getTime() + i * 60_000));
    hooks30.ffmpegFault = (args) => (args.some((a) => a.includes(s30[1])) ? 'matroska,webm: Input/output error' : null); // as ffmpeg says for truncated EBML of one segment
    const outcomes: boolean[] = [];
    const attemptsSeen: number[] = [];
    for (let i = 0; i < 4; i++) { outcomes.push(await runOk(S30)); attemptsSeen.push((await sessionRow(S30))!.assembly_attempts); }
    hooks30.ffmpegFault = undefined;
    const st30 = await Promise.all(s30.map((s) => segRow(s)));
    check('S29 runs 1–3 throw (back off, attempts 1, 2, 3) and flag nothing', outcomes.slice(0, 3).every((o) => !o) && attemptsSeen.slice(0, 3).join() === '1,2,3', `outcomes=${outcomes} attempts=${attemptsSeen}`);
    check('S29 run 4 gets through: the other two are in generation 1 (~6 s)', outcomes[3] && (await sessionRow(S30))!.generation === 1 && durOf((await sessionRow(S30))!) > 5 && durOf((await sessionRow(S30))!) < 7.5, `outcomes=${outcomes}`);
    check('S29 …the faulty one is unreadable with the text as its problem, chunks kept', st30[1]?.state === 'unreadable' && /Input\/output error/.test(st30[1].problem ?? '') && (await kept(s30[1])), `state=${st30[1]?.state} problem=${st30[1]?.problem}`);
    check('S29 …the others are assembled', st30[0]?.state === 'assembled' && st30[2]?.state === 'assembled');

    console.log('S23 pump: when a run ends the next due session starts at once (one slot)');
    const foreign = await prisma.recordingSegment.count({ where: { state: { in: ['complete', 'incomplete'] }, session: { user_id: { notIn: [empId, other.id, adminRow.id] } } } });
    if (foreign) {
      console.log(`  SKIP  ${foreign} pending segment(s) belong to other users; the pump would touch them`);
    } else if (typeof pumpAssemblies !== 'function') {
      check('S23 precondition: the service exports pumpAssemblies', false);
    } else {
      const ids23: string[] = [];
      for (const [i, d] of [daysAgo(16), daysAgo(17), daysAgo(18)].entries()) {
        const sg = newSeg(`s23${i}`);
        ids23.push(track((await register(agentTok, sg, d)).data.sessionId as string));
        await addGood(sg, d);
      }
      const started = await pumpAssemblies();
      check('S23 one pump starts exactly one run (one slot)', started === 1, `started=${started}`);
      const all3 = await until(async () => { const rows = await prisma.recordingSession.findMany({ where: { id: { in: ids23 } }, select: { generation: true } }); return rows.every((r) => r.generation >= 1) ? rows : null; }, 90_000, 1000);
      check('S23 …and the other two were started by the end of each run, without waiting for another sweep', !!all3, JSON.stringify(await prisma.recordingSession.findMany({ where: { id: { in: ids23 } }, select: { generation: true, assembly_error: true } })));
    }
  } finally {
    for (const s of sockets) { try { s.close(); } catch { /* ignore */ } }
    await sleep(500);
    // restore daood's and haseeb's tab grants exactly as snapshotted at start
    await prisma.userTabAccess.deleteMany({ where: { user_id: { in: [emp.id, other.id] } } });
    if (tabSnapshot.length) await prisma.userTabAccess.createMany({ data: tabSnapshot, skipDuplicates: true });
    await prisma.user.update({ where: { id: other.id }, data: { status: prevOtherStatus } }).catch(() => {});
    await prisma.userTabAccess.deleteMany({ where: { user_id: other.id, tab_key: 'recording' } });
    if (prevSetting) await prisma.appSetting.upsert({ where: { key: prevSetting.key }, create: { key: prevSetting.key, value: prevSetting.value, updated_by: prevSetting.updated_by }, update: { value: prevSetting.value, updated_by: prevSetting.updated_by } });
    else await prisma.appSetting.deleteMany({ where: { key: 'recording.retention_days' } });

    const mine = await prisma.recordingSession.findMany({
      where: { user_id: { in: [empId, other.id, adminRow.id] }, recording_date: { not: null }, created_at: { gte: testStart } },
      select: { id: true },
    });
    const ids = new Set([...sessionIds, ...mine.map((s) => s.id)]);
    const rows = await prisma.recordingSession.findMany({ where: { id: { in: [...ids] } }, select: { id: true, dir_path: true } });
    for (const r of rows) {
      if (r.dir_path && r.dir_path.endsWith(`(${r.id})`)) await fs.promises.rm(r.dir_path, { recursive: true, force: true }).catch(() => {});
    }
    await prisma.recordingSession.deleteMany({ where: { id: { in: [...ids] } } }); // segments + chunks cascade
    await prisma.auditLog.deleteMany({ where: { created_at: { gte: testStart }, OR: [{ action: { contains: '/recording/' } }, { action: { contains: '/employees' } }, { action: { contains: '/tab-access' } }] } });
    for (const f of tmpFiles) await fs.promises.rm(f, { force: true }).catch(() => {});
    console.log(`\nCleanup: removed ${ids.size} test session(s); restored retention setting, haseeb's status and grants`);
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
