/**
 * test-recording-edge-e2e.ts — server edge cases S1–S13 of docs/recording-edge-cases.md (TDD).
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
import { runRetentionOnce, sweepV2, assembleOnDemand, assembleSessionV2 } from './services/recording-v2.service';

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

  console.log(`\nRecording edge-case e2e (S1–S13) against ${API}\n`);
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
  } finally {
    for (const s of sockets) { try { s.close(); } catch { /* ignore */ } }
    await sleep(500);
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
    await prisma.auditLog.deleteMany({ where: { created_at: { gte: testStart }, OR: [{ action: { contains: '/recording/' } }, { action: { contains: '/employees' } }] } });
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
