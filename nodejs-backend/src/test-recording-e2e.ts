/**
 * test-recording-e2e.ts — live check of the screen-recording pipeline (Phase 0).
 *
 * Needs a running backend (npm run dev) on API_BASE and its database. Uses the
 * same seeded users as test-call-e2e.ts. Every session it creates is deleted at
 * the end. Start the server with RECORDINGS_DIR pointing at a scratch folder.
 *
 *   npm run test-recording-e2e
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
import { chunkFingerprint } from './services/recording.service';

const API = process.env.API_BASE || 'http://localhost:5000/api';
const WS = API.replace(/^http/, 'ws').replace(/\/api$/, '');

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

/** A tiny real WebM split into byte chunks, like MediaRecorder timeslices. */
function makeRun(seconds: number, parts: number): Buffer[] {
  const ff: string = require('ffmpeg-static');
  const out = path.join(os.tmpdir(), `rec-e2e-${crypto.randomBytes(4).toString('hex')}.webm`);
  const r = spawnSync(ff, ['-y', '-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=320x240:rate=10`, '-c:v', 'libvpx', '-b:v', '200k', out]);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr?.toString().slice(-300)}`);
  const buf = fs.readFileSync(out);
  fs.unlinkSync(out);
  const size = Math.ceil(buf.length / parts);
  return Array.from({ length: parts }, (_, i) => buf.subarray(i * size, (i + 1) * size));
}

function durationOf(file: string): number {
  const ff: string = require('ffmpeg-static');
  const r = spawnSync(ff, ['-i', file]);
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(r.stderr.toString());
  return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : -1;
}

/** WebSocket that records every JSON message it receives. */
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

async function connectAgent(token: string) {
  const a = openSocket(`${WS}/recording-ws`);
  await a.opened;
  await a.waitFor((m) => m.type === 'AUTH_REQUIRED');
  a.ws.send(JSON.stringify({ type: 'AUTH', token }));
  const connected = await a.waitFor((m) => m.type === 'CONNECTED');
  return { ...a, connected: !!connected };
}

const upload = (token: string, sessionId: string, idx: number, body: Buffer) =>
  axios.post(`${API}/recording/chunk?sessionId=${encodeURIComponent(sessionId)}&chunkIndex=${idx}`, body, {
    ...noThrow,
    headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${token}` },
    maxBodyLength: Infinity,
  });

const sessionRow = (id: string) => prisma.recordingSession.findUnique({ where: { id } });

async function main() {
  const testStart = new Date();
  const createdSessionIds = new Set<string>();
  const sockets: WebSocket[] = [];

  console.log(`\nRecording pipeline e2e against ${API}\n`);
  const empId = (await prisma.user.findUnique({ where: { username: EMPLOYEE.username } }))!.id;
  const preExisting = await prisma.recordingSession.count({ where: { user_id: empId, status: { in: ['pending', 'recording'] } } });
  if (preExisting) throw new Error(`${EMPLOYEE.username} already has an active recording session — refusing to run`);

  try {
    // ── Auth ────────────────────────────────────────────────
    const adminTok = (await axios.post(`${API}/auth/login`, ADMIN)).data.token as string;
    const empTok = (await axios.post(`${API}/auth/login`, EMPLOYEE)).data.token as string;
    const otherTok = (await axios.post(`${API}/auth/login`, OTHER)).data.token as string;

    console.log('Agent token issuance');
    check('agent-auth without a session token is refused', (await axios.post(`${API}/recording/agent-auth`, { user_id: empId }, noThrow)).status === 401);
    check('agent-auth for another user is refused', (await axios.post(`${API}/recording/agent-auth`, { user_id: '999999' }, bearer(empTok))).status === 403);
    const agentRes = await axios.post(`${API}/recording/agent-auth`, { user_id: empId }, bearer(empTok));
    check('agent-auth with the user\'s session token succeeds', agentRes.status === 200 && typeof agentRes.data.token === 'string');
    const agentTok = agentRes.data.token as string;
    const otherAgentTok = (await axios.post(`${API}/recording/agent-auth`, {}, bearer(otherTok))).data.token as string;

    console.log('Admin route auth');
    check('admin route without a token → 401', (await axios.get(`${API}/recording/agents`, noThrow)).status === 401);
    check('X-Admin-Id header alone is no longer accepted', (await axios.get(`${API}/recording/agents`, { ...noThrow, headers: { 'X-Admin-Id': '1' } })).status === 401);
    check('employee token on admin route → 403', (await axios.get(`${API}/recording/agents`, bearer(empTok))).status === 403);
    check('admin token on admin route → 200', (await axios.get(`${API}/recording/agents`, bearer(adminTok))).status === 200);
    check('monitoring logs without a token → 401', (await axios.get(`${API}/monitoring/logs`, noThrow)).status === 401);
    check('monitoring logs tolerate startDate=undefined', (await axios.get(`${API}/monitoring/logs?startDate=undefined&endDate=undefined&limit=1`, bearer(adminTok))).status === 200);

    // ── Agent connects idle → server starts a session ─────────
    console.log('Agent session reconcile');
    const agent1 = await connectAgent(agentTok);
    sockets.push(agent1.ws);
    check('agent authenticates on /recording-ws', agent1.connected);
    agent1.ws.send(JSON.stringify({ type: 'STATUS', state: 'idle' }));
    const start1 = await agent1.waitFor((m) => m.type === 'START_RECORDING');
    check('idle agent is told to START_RECORDING', !!start1?.sessionId);
    const S1: string = start1?.sessionId;
    if (S1) createdSessionIds.add(S1);

    const agentsList = (await axios.get(`${API}/recording/agents`, bearer(adminTok))).data.connectedAgents as string[];
    check('admin sees the connected agent', agentsList.includes(empId));

    // ── Chunk ingest ────────────────────────────────────────
    console.log('Chunk ingest');
    const runA = makeRun(3, 3);
    for (let i = 0; i < runA.length; i++) {
      const r = await upload(agentTok, S1, i, runA[i]);
      check(`chunk ${i} stored (201)`, r.status === 201, `status ${r.status} ${JSON.stringify(r.data)}`);
    }
    check('session moved to recording', (await sessionRow(S1))?.status === 'recording');

    const dup = await upload(agentTok, S1, 1, runA[1]);
    check('identical re-upload is acknowledged as duplicate', dup.status === 201 && dup.data.duplicate === true);
    const conflict = await upload(agentTok, S1, 1, crypto.randomBytes(2048));
    check('different bytes for an existing index are kept aside (conflict)', conflict.status === 201 && conflict.data.conflict === true);
    const chunk1 = await prisma.recordingChunk.findUnique({ where: { session_id_chunk_index: { session_id: S1, chunk_index: 1 } } });
    const onDisk = chunk1 ? fs.readFileSync(chunk1.file_path) : Buffer.alloc(0);
    check('original chunk 1 was not overwritten', onDisk.equals(runA[1]));
    const collDir = chunk1 ? path.join(path.dirname(chunk1.file_path), 'collisions') : '';
    check('conflicting bytes saved in collisions/', !!collDir && fs.existsSync(collDir) && fs.readdirSync(collDir).length === 1);

    // Backlog check: fingerprints computed exactly like the agent does.
    const fpOf = async (b: Buffer) => {
      const f = path.join(os.tmpdir(), `rec-e2e-fp-${crypto.randomBytes(4).toString('hex')}`);
      fs.writeFileSync(f, b);
      try { return await chunkFingerprint(f); } finally { fs.unlinkSync(f); }
    };
    const fps = await Promise.all(runA.map(fpOf));
    const checkBody = { sessionId: S1, chunks: [...fps.map((f, i) => ({ index: i, ...f })), { index: 8, ...fps[0] }, { index: 2, size: fps[2].size, fp: 'f'.repeat(64) }] };
    const chk = await axios.post(`${API}/recording/chunks/check`, checkBody, bearer(agentTok));
    check('backlog check reports chunks the server already holds', chk.status === 200 && chk.data.owned === true && [0, 1, 2].every((i) => chk.data.have.includes(i)));
    check('backlog check does not claim missing or different chunks', !chk.data.have.includes(8) && chk.data.have.filter((i: number) => i === 2).length === 1);
    const chkOther = await axios.post(`${API}/recording/chunks/check`, checkBody, bearer(otherAgentTok));
    check('backlog check tells another user\'s agent it does not own the session', chkOther.status === 200 && chkOther.data.owned === false && chkOther.data.have.length === 0);

    check('another user\'s agent cannot upload into this session (403)', (await upload(otherAgentTok, S1, 9, runA[0])).status === 403);
    check('path-like session id rejected (400)', (await upload(agentTok, '..\\evil', 0, runA[0])).status === 400);
    check('chunk without a token rejected (401)', (await axios.post(`${API}/recording/chunk?sessionId=${S1}&chunkIndex=7`, runA[0], { ...noThrow, headers: { 'Content-Type': 'application/octet-stream' } })).status === 401);

    const unknownId = `e2e-unknown-${Date.now()}`;
    createdSessionIds.add(unknownId);
    const unk = await upload(agentTok, unknownId, 0, runA[0]);
    const unkRow = await sessionRow(unknownId);
    check('chunk for an unknown session id creates that session (no 404)', unk.status === 201 && unkRow?.user_id === empId && unkRow?.status === 'recording');

    // ── Admin "Start" must not split a running recording ──────
    console.log('Start/stop/reopen');
    agent1.msgs.length = 0;
    const startRes = await axios.post(`${API}/recording/session/start`, { user_id: empId }, bearer(adminTok));
    check('admin Start reuses the active session', startRes.status === 201 && [S1, unknownId].includes(startRes.data.sessionId), JSON.stringify(startRes.data));

    // Stop S1, then keep sending: a second recorder run (new WebM header).
    await axios.post(`${API}/recording/session/stop`, { session_id: S1 }, bearer(adminTok));
    check('admin stop marks session stopped', (await sessionRow(S1))?.status === 'stopped');
    const runB = makeRun(3, 3);
    const late = await upload(agentTok, S1, 3, runB[0]);
    check('late chunk after stop is accepted, not refused', late.status === 201);
    check('late chunk reopens the session', (await sessionRow(S1))?.status === 'recording');
    for (let i = 1; i < runB.length; i++) await upload(agentTok, S1, 3 + i, runB[i]);

    await axios.post(`${API}/recording/session/stop`, { session_id: S1 }, bearer(adminTok));
    console.log('  …waiting for assembly (stop schedules it after 15s)');
    let row = await sessionRow(S1);
    for (let t = 0; t < 90 && row?.status !== 'assembled'; t++) { await sleep(1000); row = await sessionRow(S1); }
    check('session assembled', row?.status === 'assembled', `status ${row?.status}`);
    // Both stops scheduled an assembly; the per-session lock runs the second one
    // right after the first. Wait until file_path stops changing.
    for (let t = 0; t < 30; t++) {
      await sleep(2000);
      const next = await sessionRow(S1);
      if (next?.file_path === row?.file_path) break;
      row = next;
    }
    const file = row?.file_path ?? '';
    const dur = file && fs.existsSync(file) ? durationOf(file) : -1;
    check('assembled file joins both recorder runs (~6s)', dur > 5 && dur < 7, `duration ${dur}s`);
    const gens = file ? fs.readdirSync(path.dirname(file)).filter((f) => /^recording-\d+\.webm$/.test(f)) : [];
    check('previous generation file removed (one recording-*.webm)', gens.length === 1, gens.join(','));

    // ── Download with Range ─────────────────────────────────
    console.log('Download');
    check('download without a token → 401', (await axios.get(`${API}/recording/sessions/${S1}/file`, noThrow)).status === 401);
    const ranged = await axios.get(`${API}/recording/sessions/${S1}/file`, { ...bearer(adminTok), headers: { Authorization: `Bearer ${adminTok}`, Range: 'bytes=0-99' }, responseType: 'arraybuffer' });
    check('Range request returns 206 with 100 bytes', ranged.status === 206 && ranged.data.byteLength === 100);
    const full = await axios.get(`${API}/recording/sessions/${S1}/file`, { ...bearer(adminTok), responseType: 'arraybuffer' });
    check('full download matches file size', full.status === 200 && full.data.byteLength === fs.statSync(file).size);

    // ── Chunk for an already-assembled session ───────────────
    const veryLate = await upload(agentTok, S1, 6, runB[2]);
    check('chunk for an assembled session is accepted and reopens it', veryLate.status === 201 && (await sessionRow(S1))?.status === 'recording');

    // ── Reconnect: server adopts the session the agent records into ──
    console.log('Session adoption on reconnect');
    const adoptId = `e2e-adopt-${Date.now()}`;
    createdSessionIds.add(adoptId);
    const agent2 = await connectAgent(agentTok);
    sockets.push(agent2.ws);
    check('reconnecting agent replaces the old socket', agent2.connected);
    agent2.ws.send(JSON.stringify({ type: 'STATUS', state: 'recording', sessionId: adoptId }));
    await sleep(2000);
    check('server adopts the agent\'s session', (await sessionRow(adoptId))?.status === 'recording');
    // Stopped sessions with chunks are assembled right away, so either state is correct.
    const closedOk = (s?: string) => s === 'stopped' || s === 'assembled';
    const [uS, s1S] = [(await sessionRow(unknownId))?.status, (await sessionRow(S1))?.status];
    check('other active sessions of the user are closed', closedOk(uS) && closedOk(s1S), `unknown=${uS} S1=${s1S}`);
    check('no START_RECORDING sent to an agent that is already recording', !agent2.msgs.some((m) => m.type === 'START_RECORDING'));

    // ── Admin live sockets ──────────────────────────────────
    console.log('Admin live socket');
    const legacy = openSocket(`${WS}/admin-recording-ws?adminId=1`);
    check('legacy ?adminId= admin socket refused', !(await legacy.opened));
    const t1 = (await axios.post(`${API}/recording/admin-ws-token`, {}, bearer(adminTok))).data.token;
    const t2 = (await axios.post(`${API}/recording/admin-ws-token`, {}, bearer(adminTok))).data.token;
    const admin1 = openSocket(`${WS}/admin-recording-ws?token=${encodeURIComponent(t1)}`);
    await admin1.opened;
    await admin1.waitFor((m) => m.type === 'CONNECTED');
    const admin2 = openSocket(`${WS}/admin-recording-ws?token=${encodeURIComponent(t2)}`);
    sockets.push(admin1.ws, admin2.ws);
    await admin2.opened;
    await admin2.waitFor((m) => m.type === 'CONNECTED');
    await sleep(500); // let admin1's replacement close land on the server
    agent2.ws.send(JSON.stringify({ type: 'WEBRTC_ANSWER', adminId: '1', answer: { type: 'answer', sdp: 'x' } }));
    check('answer reaches the admin after the socket was replaced (B8 fix)', !!(await admin2.waitFor((m) => m.type === 'WEBRTC_ANSWER', 3000)));
  } finally {
    for (const s of sockets) { try { s.close(); } catch { /* ignore */ } }
    await sleep(10_000); // let the gateway's 8s disconnect handling run before cleanup
    const ids = [...createdSessionIds];
    const extra = await prisma.recordingSession.findMany({ where: { user_id: empId, created_at: { gte: testStart } }, select: { id: true } });
    extra.forEach((s) => ids.push(s.id));
    const files = await prisma.recordingSession.findMany({ where: { id: { in: ids } }, select: { file_path: true } });
    await prisma.recordingSession.deleteMany({ where: { id: { in: ids } } });
    await prisma.auditLog.deleteMany({
      where: { created_at: { gte: testStart }, OR: [{ action: { contains: '/recording/' } }, { action: { contains: '/monitoring/' } }] },
    });
    console.log(`\nCleanup: removed ${new Set(ids).size} test session(s) (files left in RECORDINGS_DIR: ${files.filter((f) => f.file_path).length} assembled)`);
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
