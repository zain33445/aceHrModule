/**
 * test-recording-live-e2e.ts — live check of LiveHub + Phase 5 API (docs/recording-v2.md §10, §11, §13).
 *
 * Needs a running backend on API_BASE and its database; set LIVE_MAX_VIEWERS_PER_AGENT identically for
 * the server and this script if you changed it (default 4, must be >= 3). Uses the seeded users
 * manan (admin / viewer), daood (employee, fake protocol-2 agent) and haseeb (employee: protocol-1 agent,
 * then "HR viewer" with a temporary recording grant). Everything it creates is removed at the end.
 *
 *   npm run test-recording-live-e2e
 */
import 'dotenv/config';
import axios, { AxiosRequestConfig } from 'axios';
import WebSocket from 'ws';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import prisma from './prisma';
import { recordingDateFor, ruleForUser } from './services/recording-day';

const API = process.env.API_BASE || 'http://localhost:5000/api';
const ORIGIN = API.replace(/\/api$/, '');
const WS = ORIGIN.replace(/^http/, 'ws');
const V2 = `${API}/recording/v2`;
const CAP = parseInt(process.env.LIVE_MAX_VIEWERS_PER_AGENT || '4', 10) || 4;

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
const rid = () => crypto.randomBytes(4).toString('hex');

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
type Sock = ReturnType<typeof openSocket>;

/** Fake agent. protocol 2 for the live feature; 1 only to see it listed as not live-capable. */
async function connectAgent(token: string, protocol: 1 | 2) {
  const a = openSocket(`${WS}/recording-ws`);
  await a.opened;
  await a.waitFor((m) => m.type === 'AUTH_REQUIRED');
  a.send({ type: 'AUTH', token, ...(protocol === 2 ? { protocol: 2 } : {}), deviceId: 'e2e-live', version: 'e2e-live' });
  const connected = await a.waitFor((m) => m.type === 'CONNECTED');
  return { ...a, connected };
}

async function connectViewer(wsToken: string) {
  const v = openSocket(`${WS}/admin-recording-ws?token=${encodeURIComponent(wsToken)}`);
  const ok = await v.opened;
  const connected = ok ? await v.waitFor((m) => m.type === 'CONNECTED') : null;
  const presence = ok ? await v.waitFor((m) => m.type === 'LIVE_PRESENCE') : null;
  return { ...v, ok, connected, presence };
}

const register = (tok: string, segId: string, startedAt: Date) =>
  axios.put(`${V2}/segments/${segId}`, { startedAt: startedAt.toISOString(), mime: 'video/webm;codecs=vp8', width: 320, height: 240, deviceId: 'e2e-live' }, bearer(tok));

const shiftDay = (day: string, delta: number) => new Date(new Date(`${day}T00:00:00Z`).getTime() + delta * 86_400_000).toISOString().slice(0, 10);

async function main() {
  const testStart = new Date();
  const sockets: WebSocket[] = [];
  const tmpFiles: string[] = [];

  console.log(`\nRecording live e2e against ${API} (viewer cap ${CAP})\n`);
  const emp = (await prisma.user.findUnique({ where: { username: EMPLOYEE.username } }))!;
  const other = (await prisma.user.findUnique({ where: { username: OTHER.username } }))!;
  const adminRow = (await prisma.user.findUnique({ where: { username: ADMIN.username } }))!;
  const empId = emp.id;
  if (CAP < 3) throw new Error("LIVE_MAX_VIEWERS_PER_AGENT must be >= 3 for this test");
  if (await prisma.userTabAccess.findUnique({ where: { user_id_tab_key: { user_id: other.id, tab_key: 'recording' } } })) {
    throw new Error(`${OTHER.username} already holds the recording tab — refusing to run`);
  }
  if (await prisma.recordingSession.count({ where: { user_id: empId, recording_date: { not: null } } })) {
    throw new Error(`${EMPLOYEE.username} already has v2 recording sessions — refusing to run`);
  }

  try {
    const adminTok = (await axios.post(`${API}/auth/login`, ADMIN)).data.token as string;
    const empTok = (await axios.post(`${API}/auth/login`, EMPLOYEE)).data.token as string;
    const otherTok = (await axios.post(`${API}/auth/login`, OTHER)).data.token as string;
    const agentTok = (await axios.post(`${API}/recording/agent-auth`, {}, bearer(empTok))).data.token as string;
    const otherAgentTok = (await axios.post(`${API}/recording/agent-auth`, {}, bearer(otherTok))).data.token as string;
    const adminAgentTok = (await axios.post(`${API}/recording/agent-auth`, {}, bearer(adminTok))).data.token as string;
    const wsToken = async () => (await axios.post(`${API}/recording/admin-ws-token`, {}, bearer(adminTok))).data.token as string;

    // ── Viewers ────────────────────────────────────────────
    console.log('Viewer sockets');
    const A = await connectViewer(await wsToken());
    const B = await connectViewer(await wsToken());
    sockets.push(A.ws, B.ws);
    check('two viewer sockets of the same admin are both accepted', A.ok && B.ok);
    check('CONNECTED carries viewerId and iceServers', typeof A.connected?.viewerId === 'string' && Array.isArray(A.connected?.iceServers) && A.connected.iceServers.length > 0, JSON.stringify(A.connected));
    check('every socket gets its own viewerId', !!A.connected && !!B.connected && A.connected.viewerId !== B.connected.viewerId);
    check('LIVE_PRESENCE follows CONNECTED with an agents array', Array.isArray(A.presence?.agents));

    // ── Presence ───────────────────────────────────────────
    console.log('Presence');
    const agent = await connectAgent(agentTok, 2);
    sockets.push(agent.ws);
    check('protocol-2 agent connected', !!agent.connected && agent.connected.protocol === 2);
    agent.send({ type: 'STATUS', state: 'recording', loggedIn: false, version: 'e2e-live' });
    const up1 = await A.waitFor((m) => m.type === 'LIVE_PRESENCE_UPDATE' && m.agent?.userId === empId && m.agent.loggedIn === false && m.agent.state === 'recording');
    const ag = up1?.agent;
    check('LIVE_PRESENCE_UPDATE after STATUS: live-capable, recording, loggedIn=false', !!ag && ag.connected === true && ag.liveCapable === true && ag.recording === true && ag.loggedIn === false, JSON.stringify(ag));
    check('presence carries name, department key, viewers, version', !!ag && ag.name === emp.name && 'department' in ag && ag.viewers === 0 && typeof ag.version === 'string', JSON.stringify(ag));

    const adminAgent = await connectAgent(adminAgentTok, 2);
    sockets.push(adminAgent.ws);
    adminAgent.send({ type: 'STATUS', state: 'recording', loggedIn: true });
    await sleep(800);
    check('admin agent never appears in updates', !A.msgs.some((m) => m.type === 'LIVE_PRESENCE_UPDATE' && m.agent?.userId === adminRow.id));
    const C = await connectViewer(await wsToken()); // late joiner sees the snapshot
    sockets.push(C.ws);
    const snap = (C.presence?.agents ?? []) as any[];
    check('late viewer snapshot lists the employee agent as liveCapable', snap.some((a) => a.userId === empId && a.liveCapable === true && a.connected === true));
    check('…and not the admin agent', !snap.some((a) => a.userId === adminRow.id));
    C.ws.close();
    const rest = await axios.get(`${API}/recording/live-presence`, bearer(adminTok));
    check('GET /live-presence → same Agent[] (employee yes, admin no)', rest.status === 200 && Array.isArray(rest.data) && rest.data.some((a: any) => a.userId === empId) && !rest.data.some((a: any) => a.userId === adminRow.id));
    check('GET /live-presence without a token → 401', (await axios.get(`${API}/recording/live-presence`, noThrow)).status === 401);
    adminAgent.ws.close();

    agent.send({ type: 'STATUS', state: 'recording', loggedIn: true, version: 'e2e-live' });
    check('LIVE_PRESENCE_UPDATE when loggedIn changes', !!(await A.waitFor((m) => m.type === 'LIVE_PRESENCE_UPDATE' && m.agent?.userId === empId && m.agent.loggedIn === true)));
    check('…the other viewer gets it too', !!(await B.waitFor((m) => m.type === 'LIVE_PRESENCE_UPDATE' && m.agent?.userId === empId && m.agent.loggedIn === true)));

    // ── Subscribe + signalling ─────────────────────────────
    console.log('Streams');
    A.send({ type: 'LIVE_SUBSCRIBE', userId: empId, quality: 'grid' });
    const start1 = await agent.waitFor((m) => m.type === 'LIVE_START');
    const sub1 = await A.waitFor((m) => m.type === 'LIVE_SUBSCRIBED');
    check('agent gets LIVE_START with streamId, quality and iceServers', !!start1 && typeof start1.streamId === 'string' && start1.quality === 'grid' && Array.isArray(start1.iceServers), JSON.stringify(start1));
    check('viewer gets LIVE_SUBSCRIBED with the same streamId', !!sub1 && sub1.streamId === start1?.streamId && sub1.userId === empId && sub1.quality === 'grid');
    const s1 = start1?.streamId as string;
    check('presence update shows viewers=1', !!(await B.waitFor((m) => m.type === 'LIVE_PRESENCE_UPDATE' && m.agent?.userId === empId && m.agent.viewers === 1)));

    A.send({ type: 'LIVE_SIGNAL', streamId: s1, candidate: { candidate: 'candidate:e2e', sdpMid: '0', sdpMLineIndex: 0 } });
    const sigA = await agent.waitFor((m) => m.type === 'LIVE_SIGNAL' && m.streamId === s1);
    check('viewer LIVE_SIGNAL reaches the agent with the streamId', !!sigA && sigA.candidate?.candidate === 'candidate:e2e');
    agent.send({ type: 'LIVE_SIGNAL', streamId: s1, description: { type: 'offer', sdp: 'v=0' } });
    const sigB = await A.waitFor((m) => m.type === 'LIVE_SIGNAL' && m.streamId === s1);
    check('agent LIVE_SIGNAL reaches the owning viewer', !!sigB && sigB.description?.type === 'offer');
    check('…and not the other viewer', !B.msgs.some((m) => m.type === 'LIVE_SIGNAL'));
    agent.send({ type: 'LIVE_STATE', streamId: s1, state: 'connected' });
    check('agent LIVE_STATE reaches the owning viewer', !!(await A.waitFor((m) => m.type === 'LIVE_STATE' && m.streamId === s1 && m.state === 'connected')));

    B.send({ type: 'LIVE_SUBSCRIBE', userId: empId, quality: 'focus' });
    const startB = await agent.waitFor((m) => m.type === 'LIVE_START' && m.streamId !== s1);
    check('second viewer gets its own stream', !!startB && startB.quality === 'focus');
    const sB = startB?.streamId as string;
    const sigsBefore = agent.msgs.filter((m) => m.type === 'LIVE_SIGNAL').length;
    B.send({ type: 'LIVE_SIGNAL', streamId: s1, candidate: { candidate: 'candidate:intruder' } });
    B.send({ type: 'LIVE_QUALITY', streamId: s1, quality: 'focus' });
    B.send({ type: 'LIVE_UNSUBSCRIBE', streamId: s1 });
    await sleep(600);
    check('foreign streamId: LIVE_SIGNAL / LIVE_QUALITY / LIVE_UNSUBSCRIBE are dropped', agent.msgs.filter((m) => m.type === 'LIVE_SIGNAL').length === sigsBefore && !agent.msgs.some((m) => m.type === 'LIVE_QUALITY') && !agent.msgs.some((m) => m.type === 'LIVE_STOP'));
    agent.send({ type: 'LIVE_SIGNAL', streamId: 'not-a-stream', description: { type: 'offer', sdp: 'x' } });
    await sleep(300);
    check('agent signal for an unknown stream goes nowhere', !A.msgs.some((m) => m.streamId === 'not-a-stream') && !B.msgs.some((m) => m.streamId === 'not-a-stream'));

    // ── Cap ────────────────────────────────────────────────
    console.log('Viewer cap');
    const extra: string[] = []; // streams of A beyond the first, to unsubscribe later
    for (let i = 2; i < CAP; i++) {
      const before = A.msgs.filter((m) => m.type === 'LIVE_SUBSCRIBED').length;
      A.send({ type: 'LIVE_SUBSCRIBE', userId: empId, quality: 'grid' });
      const m = await A.waitFor((x) => x.type === 'LIVE_SUBSCRIBED' && A.msgs.filter((y) => y.type === 'LIVE_SUBSCRIBED').length > before && x.streamId !== s1 && !extra.includes(x.streamId));
      if (m) extra.push(m.streamId);
    }
    check(`${CAP} concurrent streams are accepted`, extra.length === CAP - 2, `${extra.length}`);
    B.send({ type: 'LIVE_SUBSCRIBE', userId: empId, quality: 'grid' });
    const rej = await B.waitFor((m) => m.type === 'LIVE_REJECTED' && m.userId === empId);
    check(`stream ${CAP + 1} → LIVE_REJECTED viewer_limit`, rej?.reason === 'viewer_limit', JSON.stringify(rej));
    check('…and the agent was not asked to start it', agent.msgs.filter((m) => m.type === 'LIVE_START').length === CAP);

    // ── Quality / unsubscribe ──────────────────────────────
    console.log('Quality, unsubscribe, viewer close');
    A.send({ type: 'LIVE_QUALITY', streamId: s1, quality: 'focus' });
    const q = await agent.waitFor((m) => m.type === 'LIVE_QUALITY' && m.streamId === s1);
    check('LIVE_QUALITY forwarded to the agent', q?.quality === 'focus');
    A.send({ type: 'LIVE_QUALITY', streamId: s1, quality: 'ultra' });
    await sleep(300);
    check('invalid quality is dropped', agent.msgs.filter((m) => m.type === 'LIVE_QUALITY').length === 1);
    B.send({ type: 'LIVE_SUBSCRIBE', userId: empId, quality: 'bogus' });
    await sleep(300);
    check('LIVE_SUBSCRIBE with invalid quality is dropped', agent.msgs.filter((m) => m.type === 'LIVE_START').length === CAP);

    if (extra.length) {
      A.send({ type: 'LIVE_UNSUBSCRIBE', streamId: extra[0] });
      check('LIVE_UNSUBSCRIBE → LIVE_STOP to the agent', !!(await agent.waitFor((m) => m.type === 'LIVE_STOP' && m.streamId === extra[0])));
    }
    B.send({ type: 'LIVE_SUBSCRIBE', userId: empId, quality: 'grid' });
    check('a freed slot can be taken again', !!(await B.waitFor((m) => m.type === 'LIVE_SUBSCRIBED' && m.streamId !== sB)));
    const bStreams = B.msgs.filter((m) => m.type === 'LIVE_SUBSCRIBED').map((m) => m.streamId as string);
    B.ws.close();
    const stops = await Promise.all(bStreams.map((id) => agent.waitFor((m) => m.type === 'LIVE_STOP' && m.streamId === id)));
    check('viewer socket close → LIVE_STOP for each of its streams', stops.length === 2 && stops.every(Boolean));

    // ── Recordings API (days, playback token) ──────────────
    console.log('Days and playback');
    const rule = await ruleForUser(empId);
    const now = new Date();
    const today = recordingDateFor(now, rule);
    const oldDate = new Date(Date.now() - 40 * 86_400_000);
    const oldDay = recordingDateFor(oldDate, rule);
    const segS = `e2e-live-${rid()}`, segO = `e2e-live-${rid()}`;
    const rS = await register(agentTok, segS, now);
    const rO = await register(agentTok, segO, oldDate);
    const S = rS.data.sessionId as string, O = rO.data.sessionId as string;
    check('test sessions registered', rS.status === 201 && rO.status === 201, `${rS.status}/${rO.status}`);
    const payload = crypto.randomBytes(2000);
    const file = path.join(os.tmpdir(), `live-e2e-${rid()}.webm`);
    fs.writeFileSync(file, payload);
    tmpFiles.push(file);
    await prisma.recordingSession.update({ where: { id: S }, data: { file_path: file, generation: 1, duration_ms: 123000, logged_out_ms: 4000, status: 'assembled' } });

    const days = (q: string, tok = adminTok) => axios.get(`${API}/recording/days?${q}`, bearer(tok));
    const wide = await days(`from=${shiftDay(today, -60)}&to=${shiftDay(today, 1)}&userId=${empId}`);
    const item = (wide.data.items as any[] | undefined)?.find((i) => i.sessionId === S);
    check('GET /days → 200 with items/total/page/pageSize', wide.status === 200 && Array.isArray(wide.data.items) && wide.data.total >= 2 && wide.data.page === 1 && wide.data.pageSize === 50, JSON.stringify(wide.data).slice(0, 200));
    check('Day fields: identity, date, legacy=false, status, generation', !!item && item.userId === empId && item.name === emp.name && item.recordingDate === today && item.legacy === false && item.status === 'assembled' && item.generation === 1, JSON.stringify(item));
    check('Day fields: durationMs / loggedOutMs / segments / hasFile', !!item && item.durationMs === 123000 && item.loggedOutMs === 4000 && item.segments === 1 && item.openSegments === 1 && item.incompleteSegments === 0 && item.assembling === false && item.hasFile === true && 'department' in item && 'lastChunkAt' in item && 'createdAt' in item, JSON.stringify(item));
    const oldItem = (wide.data.items as any[]).find((i) => i.sessionId === O);
    check('older session listed, hasFile=false, durationMs null', !!oldItem && oldItem.hasFile === false && oldItem.durationMs === null && oldItem.recordingDate === oldDay);
    check('newest first', (wide.data.items as any[]).findIndex((i) => i.sessionId === S) < (wide.data.items as any[]).findIndex((i) => i.sessionId === O));
    const only = await days(`from=${today}&to=${today}&userId=${empId}`);
    check('date range is inclusive on both ends', (only.data.items as any[]).some((i) => i.sessionId === S) && !(only.data.items as any[]).some((i) => i.sessionId === O));
    const before = await days(`from=${shiftDay(today, -10)}&to=${shiftDay(today, -1)}&userId=${empId}`);
    check('range ending the day before excludes the session', !(before.data.items as any[]).some((i) => i.sessionId === S));
    const p1 = await days(`from=${shiftDay(today, -60)}&to=${shiftDay(today, 1)}&userId=${empId}&pageSize=1&page=1`);
    const p2 = await days(`from=${shiftDay(today, -60)}&to=${shiftDay(today, 1)}&userId=${empId}&pageSize=1&page=2`);
    check('pagination', p1.data.items.length === 1 && p2.data.items.length === 1 && p1.data.items[0].sessionId !== p2.data.items[0].sessionId && p1.data.total === wide.data.total);
    check('bad date → 400', (await days('from=2026-13-40&to=2026-01-01')).status === 400 && (await days('from=2026-01-01')).status === 400);
    check('pageSize 201 → 400', (await days(`from=${today}&to=${today}&pageSize=201`)).status === 400);
    check('/days: no token → 401, no grant → 403', (await axios.get(`${API}/recording/days?from=${today}&to=${today}`, noThrow)).status === 401 && (await days(`from=${today}&to=${today}`, otherTok)).status === 403);

    const ptRes = await axios.post(`${API}/recording/sessions/${S}/playback-token`, {}, bearer(adminTok));
    const url = ptRes.data.url as string;
    check('playback-token → { url } for that session', ptRes.status === 200 && typeof url === 'string' && url.startsWith(`/api/recording/sessions/${S}/file?pt=`), JSON.stringify(ptRes.data).slice(0, 120));
    check('playback-token: no grant → 403, unknown session → 404', (await axios.post(`${API}/recording/sessions/${S}/playback-token`, {}, bearer(otherTok))).status === 403 && (await axios.post(`${API}/recording/sessions/${crypto.randomUUID()}/playback-token`, {}, bearer(adminTok))).status === 404);
    const pt = new URL(ORIGIN + url).searchParams.get('pt')!;
    const ranged = await axios.get(ORIGIN + url, { ...noThrow, headers: { Range: 'bytes=0-9' }, responseType: 'arraybuffer' });
    check('file via ?pt= with Range → 206 and the right bytes (no Authorization header)', ranged.status === 206 && ranged.data.byteLength === 10 && Buffer.from(ranged.data).equals(payload.subarray(0, 10)), `${ranged.status}`);
    const fullPt = await axios.get(ORIGIN + url, { ...noThrow, responseType: 'arraybuffer' });
    check('file via ?pt= without Range → 200 full size', fullPt.status === 200 && fullPt.data.byteLength === payload.length);
    const bearerFile = await axios.get(`${API}/recording/sessions/${S}/file`, { ...bearer(adminTok, { Range: 'bytes=0-4' }), responseType: 'arraybuffer' });
    check('Bearer download unchanged (206)', bearerFile.status === 206 && bearerFile.data.byteLength === 5);
    check('pt of another session → 401', (await axios.get(`${API}/recording/sessions/${O}/file?pt=${pt}`, noThrow)).status === 401);
    check('pt rejected on the sessions list (401)', (await axios.get(`${API}/recording/sessions?pt=${pt}`, noThrow)).status === 401);
    check('pt rejected on session detail (401)', (await axios.get(`${API}/recording/sessions/${S}?pt=${pt}`, noThrow)).status === 401);
    check('pt rejected on /days (401)', (await axios.get(`${API}/recording/days?from=${today}&to=${today}&pt=${pt}`, noThrow)).status === 401);
    check('garbage pt → 401', (await axios.get(`${API}/recording/sessions/${S}/file?pt=abc.def.ghi`, noThrow)).status === 401);
    check('an admin-ws token is not a playback token (401)', (await axios.get(`${API}/recording/sessions/${S}/file?pt=${await wsToken()}`, noThrow)).status === 401);

    // ── Agent closes ───────────────────────────────────────
    console.log('Agent disconnect');
    const aStreams = A.msgs.filter((m) => m.type === 'LIVE_SUBSCRIBED').map((m) => m.streamId as string).filter((id) => id !== extra[0]);
    agent.ws.close();
    const ended = await Promise.all(aStreams.map((id) => A.waitFor((m) => m.type === 'LIVE_ENDED' && m.streamId === id && m.reason === 'agent_disconnected')));
    check('agent close → LIVE_ENDED agent_disconnected for each stream', aStreams.length >= 1 && ended.every(Boolean), `${aStreams.length} streams`);
    const gone = await A.waitFor((m) => m.type === 'LIVE_PRESENCE_UPDATE' && m.agent?.userId === empId && m.agent.connected === false);
    check('presence update: connected=false, viewers=0 (kept for 60 s)', !!gone && gone.agent.viewers === 0, JSON.stringify(gone?.agent));
    A.send({ type: 'LIVE_SUBSCRIBE', userId: empId, quality: 'grid' });
    check('subscribe to an offline agent → LIVE_REJECTED offline', (await A.waitFor((m) => m.type === 'LIVE_REJECTED' && m.reason === 'offline'))?.reason === 'offline');

    // ── Replacement ────────────────────────────────────────
    const r1 = await connectAgent(agentTok, 2);
    sockets.push(r1.ws);
    A.send({ type: 'LIVE_SUBSCRIBE', userId: empId, quality: 'grid' });
    const rs = await A.waitFor((m) => m.type === 'LIVE_SUBSCRIBED' && !aStreams.includes(m.streamId) && m.streamId !== extra[0] && !bStreams.includes(m.streamId));
    const r1Closed = new Promise<number>((res) => r1.ws.once('close', (code) => res(code)));
    const r2 = await connectAgent(agentTok, 2);
    sockets.push(r2.ws);
    check('replaced agent is closed with 4002', (await r1Closed) === 4002);
    check('replacement ends the old agent\'s streams (LIVE_ENDED agent_disconnected)', !!rs && !!(await A.waitFor((m) => m.type === 'LIVE_ENDED' && m.streamId === rs.streamId && m.reason === 'agent_disconnected')));
    r2.ws.close();

    // ── Protocol 1 ─────────────────────────────────────────
    console.log('Protocol-1 agent');
    const p1a = await connectAgent(otherAgentTok, 1); // closed within 5 s: no reconcile, no legacy session
    sockets.push(p1a.ws);
    const p1up = await A.waitFor((m) => m.type === 'LIVE_PRESENCE_UPDATE' && m.agent?.userId === other.id && m.agent.connected === true);
    check('protocol-1 agent listed with liveCapable=false and loggedIn=null', !!p1up && p1up.agent.liveCapable === false && p1up.agent.loggedIn === null, JSON.stringify(p1up?.agent));
    A.send({ type: 'LIVE_SUBSCRIBE', userId: other.id, quality: 'grid' });
    check('subscribe to a protocol-1 agent → LIVE_REJECTED not_live_capable', (await A.waitFor((m) => m.type === 'LIVE_REJECTED' && m.userId === other.id))?.reason === 'not_live_capable');
    p1a.ws.close();

    // ── Access control for HR ──────────────────────────────
    console.log('HR access');
    check('HR without grant: admin-ws-token → 403', (await axios.post(`${API}/recording/admin-ws-token`, {}, bearer(otherTok))).status === 403);
    const noGrantSock = openSocket(`${WS}/admin-recording-ws?token=${encodeURIComponent('not-a-token')}`);
    check('viewer socket with a bad token is refused', !(await noGrantSock.opened));
    await prisma.userTabAccess.create({ data: { user_id: other.id, tab_key: 'recording' } });
    const hrTok = await axios.post(`${API}/recording/admin-ws-token`, {}, bearer(otherTok));
    check('HR with grant: admin-ws-token → 200', hrTok.status === 200 && typeof hrTok.data.token === 'string');
    const H = await connectViewer(hrTok.data.token);
    sockets.push(H.ws);
    check('HR viewer socket connects and gets CONNECTED + LIVE_PRESENCE', H.ok && typeof H.connected?.viewerId === 'string' && Array.isArray(H.presence?.agents));
    check('HR with grant: /live-presence and /days → 200', (await axios.get(`${API}/recording/live-presence`, bearer(otherTok))).status === 200 && (await days(`from=${today}&to=${today}`, otherTok)).status === 200);
    const hrPt = (await axios.post(`${API}/recording/sessions/${S}/playback-token`, {}, bearer(otherTok))).data.url as string;
    check('HR playback token works while the grant exists', (await axios.get(ORIGIN + hrPt, { ...noThrow, headers: { Range: 'bytes=0-1' }, responseType: 'arraybuffer' })).status === 206);
    await prisma.userTabAccess.deleteMany({ where: { user_id: other.id, tab_key: 'recording' } });
    check('…and stops working once the grant is removed (403)', (await axios.get(ORIGIN + hrPt, noThrow)).status === 403);
  } finally {
    for (const s of sockets) { try { s.close(); } catch { /* ignore */ } }
    await sleep(500);
    await prisma.userTabAccess.deleteMany({ where: { user_id: other.id, tab_key: 'recording' } });
    const mine = await prisma.recordingSession.findMany({ where: { user_id: empId, created_at: { gte: testStart } }, select: { id: true, dir_path: true } });
    for (const r of mine) {
      if (r.dir_path && r.dir_path.endsWith(`(${r.id})`)) await fs.promises.rm(r.dir_path, { recursive: true, force: true }).catch(() => {});
    }
    await prisma.recordingSession.deleteMany({ where: { id: { in: mine.map((m) => m.id) } } });
    // protocol-1 connect may have touched agent_tokens.last_seen only; audit rows from our POSTs:
    await prisma.auditLog.deleteMany({
      where: { created_at: { gte: testStart }, OR: [{ action: { contains: '/recording/' } }] },
    });
    for (const f of tmpFiles) await fs.promises.rm(f, { force: true }).catch(() => {});
    console.log(`\nCleanup: removed ${mine.length} test session(s), temporary grant and files`);
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
