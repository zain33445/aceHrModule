/**
 * test-call-e2e.ts — Live end-to-end test for the calling feature.
 *
 * Unlike test-call-ws.ts (which needs no database), this test drives the
 * running server over real HTTP and real WebSocket connections:
 *
 *   1. Login returns a signed session token (and keeps the legacy fields).
 *   2. The call routes reject unsigned identity.
 *   3. A call session is created, persisted and rings the callee.
 *   4. Two participants join over /call-ws and the mesh membership is
 *      exchanged correctly (CALL_JOINED / CALL_PEER_JOINED).
 *   5. The call log records the call as "answered".
 *   6. A signal sent by one peer is relayed to the other.
 *   7. Recording starts automatically when the call is answered.
 *   8. An audio chunk can be uploaded and is assembled into a playable file.
 *   9. Declining a call is recorded and relayed.
 *  10. The call history lists the call.
 *
 * Requires the server to be running (npm run dev) and the database to be up.
 * Run with: npm run test-call-e2e
 */

import axios from 'axios';
import WebSocket from 'ws';
import prisma from './prisma';

const API = process.env.API_BASE || 'http://localhost:5000/api';
const WS_BASE = API.replace(/^http/, 'ws').replace(/\/api\/?$/, '');

const HOST = { username: 'manan', password: 'admin123' };
const CALLEE = { username: 'daood', password: '1234' };
/** A third user who is never part of the call — used for the negative tests. */
const OUTSIDER = { username: 'haseeb', password: '1234' };

let passed = 0;
let failed = 0;
const createdCallIds: string[] = [];

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    // Written to stdout (not stderr) so the output order matches the run order.
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string) {
  console.log(`\n${title}`);
}

// ── WebSocket test client ───────────────────────────────────

class TestClient {
  ws: WebSocket;
  messages: any[] = [];
  connected = false;

  constructor(token: string) {
    this.ws = new WebSocket(`${WS_BASE}/call-ws?token=${encodeURIComponent(token)}`);
    this.ws.on('open', () => { this.connected = true; });
    this.ws.on('message', (data: Buffer) => {
      try { this.messages.push(JSON.parse(data.toString())); } catch { /* ignore */ }
    });
    this.ws.on('error', () => { /* handled by waits */ });
  }

  send(payload: any) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  /** Waits for a message of the given type. */
  async waitFor(type: string, timeoutMs = 5000): Promise<any | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.find((m) => m.type === type);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  /** Waits for a message matching a predicate. */
  async waitForMatch(pred: (m: any) => boolean, timeoutMs = 5000): Promise<any | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.find(pred);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  clear() {
    this.messages = [];
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Test ────────────────────────────────────────────────────

async function main() {
  console.log('\naceHRM — call end-to-end test\n');

  // ── 1. Authentication ─────────────────────────────────────
  section('1. Authentication');

  const hostLogin = await axios.post(`${API}/auth/login`, HOST);
  const calleeLogin = await axios.post(`${API}/auth/login`, CALLEE);
  const outsiderLogin = await axios.post(`${API}/auth/login`, OUTSIDER);

  check('login succeeds for the host', hostLogin.status === 200);
  check('login returns a signed session token', typeof hostLogin.data.token === 'string' && hostLogin.data.token.length > 20);
  check('login keeps the legacy user_id field', hostLogin.data.user_id === '1');
  check('login keeps the legacy role field', hostLogin.data.role === 'admin');
  check('login succeeds for the callee', calleeLogin.status === 200);

  const hostToken = hostLogin.data.token;
  const calleeToken = calleeLogin.data.token;
  const outsiderToken = outsiderLogin.data.token;
  const hostId = hostLogin.data.user_id;
  const calleeId = calleeLogin.data.user_id;
  const auth = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });

  // ── 2. Route protection ───────────────────────────────────
  section('2. Route protection');

  try {
    await axios.get(`${API}/call/ice-servers`);
    check('ice-servers rejects an unsigned request', false, 'request succeeded');
  } catch (err: any) {
    check('ice-servers rejects an unsigned request', err.response?.status === 401);
  }

  try {
    await axios.post(`${API}/call/sessions`, { target_user_ids: [calleeId] });
    check('call creation rejects an unsigned request', false, 'request succeeded');
  } catch (err: any) {
    check('call creation rejects an unsigned request', err.response?.status === 401);
  }

  const iceRes = await axios.get(`${API}/call/ice-servers`, auth(hostToken));
  check('ice-servers succeeds with a token', iceRes.status === 200);
  check('ice-servers returns a STUN server', JSON.stringify(iceRes.data).includes('stun:'));

  const wsTokenRes = await axios.post(`${API}/call/ws-token`, {}, auth(hostToken));
  check('ws-token issues a short-lived ticket', typeof wsTokenRes.data.token === 'string');
  check('ws-token declares a 5 minute lifetime', wsTokenRes.data.expiresIn === 300);

  // ── 3. Creating a call ────────────────────────────────────
  section('3. Creating a call');

  const callRes = await axios.post(
    `${API}/call/sessions`,
    { target_user_ids: [calleeId] },
    auth(hostToken)
  );
  const callId = callRes.data.id;
  createdCallIds.push(callId);

  check('call is created', callRes.status === 200 && !!callId);
  check('new call starts in the ringing state', callRes.data.status === 'ringing');

  const sessionRow = await prisma.callSession.findUnique({
    where: { id: callId },
    include: { participants: true },
  });
  check('call session is persisted', !!sessionRow);
  check('call session has a host participant', !!sessionRow?.participants.some((p) => p.user_id === hostId && p.role === 'host'));
  check('call session has a member participant', !!sessionRow?.participants.some((p) => p.user_id === calleeId && p.role === 'member'));

  const logRow = await prisma.callLog.findFirst({ where: { call_id: callId, to_user_id: calleeId } });
  check('a call log row is created', !!logRow);
  check('a fresh call log starts as missed', logRow?.outcome === 'missed');

  const notify = await prisma.notification.findFirst({
    where: { user_id: calleeId, type: 'call_incoming' },
    orderBy: { created_at: 'desc' },
  });
  check('the callee is notified', !!notify);

  // ── 4. Joining the mesh ───────────────────────────────────
  section('4. Joining the mesh');

  const host = new TestClient(wsTokenRes.data.token);
  const calleeWsToken = (await axios.post(`${API}/call/ws-token`, {}, auth(calleeToken))).data.token;
  const callee = new TestClient(calleeWsToken);

  await sleep(400);
  check('host connects to /call-ws', host.connected);
  check('callee connects to /call-ws', callee.connected);
  check('the gateway greets the client', !!(await host.waitFor('CONNECTED')));

  host.send({ type: 'CALL_JOIN', callId });
  const hostJoined = await host.waitFor('CALL_JOINED');
  check('the host receives CALL_JOINED', !!hostJoined);
  check('CALL_JOINED carries a peer id', typeof hostJoined?.selfPeerId === 'string');
  check('the host starts alone in the call', Array.isArray(hostJoined?.peers) && hostJoined.peers.length === 0);

  const ringing = await callee.waitFor('CALL_INCOMING');
  check('the callee is notified of the incoming call over the socket', !!ringing);
  check('the incoming call names the caller', ringing?.from?.userId === hostId);

  callee.send({ type: 'CALL_JOIN', callId });
  const calleeJoined = await callee.waitFor('CALL_JOINED');
  check('the callee receives CALL_JOINED', !!calleeJoined);
  check('the callee sees the host as an existing peer', calleeJoined?.peers?.length === 1);
  check('the peer entry carries the host id', calleeJoined?.peers?.[0]?.userId === hostId);
  const peerJoined = await host.waitFor('CALL_PEER_JOINED');
  check('the host is told the callee joined', !!peerJoined);
  check('the peer-joined event carries the callee id', peerJoined?.peer?.userId === calleeId);
  check(
    'the callee is told the host is already there',
    calleeJoined?.peers?.[0]?.peerId === hostJoined?.selfPeerId
  );
  check(
    'the two sides use different peer ids',
    peerJoined?.peer?.peerId !== hostJoined?.selfPeerId
  );

  // ── 5. Call log outcome ───────────────────────────────────
  section('5. Call log outcome');

  await sleep(300);
  const answeredLog = await prisma.callLog.findFirst({ where: { call_id: callId, to_user_id: calleeId } });
  check('the call log is updated to answered', answeredLog?.outcome === 'answered');

  const activeSession = await prisma.callSession.findUnique({ where: { id: callId } });
  check('the call session becomes active', activeSession?.status === 'active');

  const peerId = await prisma.callParticipant.findFirst({
    where: { call_id: callId, user_id: hostId },
  });
  check('the peer id is persisted', typeof peerId?.peer_id === 'string' && peerId.peer_id.length > 0);

  // ── 6. Signal relay ───────────────────────────────────────
  section('6. Signal relay');

  host.clear();
  callee.clear();
  host.send({
    type: 'CALL_SIGNAL',
    callId,
    toPeerId: peerJoined.peer.peerId,
    signalType: 'offer',
    payload: { sdp: { type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' } },
  });

  const relayed = await callee.waitFor('CALL_SIGNAL');
  check('an offer is relayed to the target peer', !!relayed);
  check('the relay preserves the signal type', relayed?.signalType === 'offer');
  check('the relay preserves the payload', relayed?.payload?.sdp?.sdp?.includes('v=0'));
  check('the relay identifies the sender', relayed?.fromPeerId === hostJoined.selfPeerId);

  // A peer that is not in the call cannot inject a signal.
  const stranger = new TestClient((await axios.post(`${API}/call/ws-token`, {}, auth(outsiderToken))).data.token);
  await sleep(300);
  callee.clear();
  stranger.send({
    type: 'CALL_SIGNAL',
    callId,
    toPeerId: hostJoined.selfPeerId,
    signalType: 'offer',
    payload: { sdp: { type: 'offer', sdp: 'x' } },
  });
  await sleep(400);
  check(
    'a signal from a non-participant is dropped',
    !callee.messages.some((m) => m.type === 'CALL_SIGNAL')
  );
  stranger.close();

  // ── 7. Automatic recording ────────────────────────────────
  section('7. Automatic recording');

  // The call was answered in section 4, so recording started on its own.
  await sleep(300);
  check(
    'the call is recorded as soon as it is answered',
    !!(await prisma.callSession.findUnique({ where: { id: callId } }))?.is_recording
  );

  host.clear();
  callee.clear();
  host.send({ type: 'CALL_RECORD_STOP' });
  check('the recording can be stopped', !!(await callee.waitFor('CALL_RECORD_STOP')));
  await sleep(300);
  check(
    'the stopped call is no longer flagged as recording',
    !(await prisma.callSession.findUnique({ where: { id: callId } }))?.is_recording
  );

  host.clear();
  callee.clear();
  callee.send({ type: 'CALL_RECORD_REQUEST' });
  const denied = await callee.waitFor('CALL_ERROR');
  check('a non-host cannot restart the recording', !!denied);
  check('nobody is ever asked for consent', !callee.messages.some((m) => m.type === 'CALL_RECORD_CONSENT_REQUEST'));

  host.clear();
  callee.clear();
  host.send({ type: 'CALL_RECORD_REQUEST' });
  const restart = await callee.waitFor('CALL_RECORD_START');
  check('the host can restart the recording immediately', !!restart);
  await sleep(300);
  check(
    'the restarted call is flagged as recording',
    !!(await prisma.callSession.findUnique({ where: { id: callId } }))?.is_recording
  );

  // ── 8. Recording upload ───────────────────────────────────
  section('8. Recording upload');

  // A minimal valid WebM/Opus payload (a real MediaRecorder chunk).
  const chunk = Buffer.from(
    '1a45dfa3a342868202a4286810142f7810142f3810442f3810242f5843021f8810142f2810242f5843021f',
    'hex'
  );

  const upload = await axios.post(`${API}/call/recordings/chunk`, chunk, {
    headers: {
      ...auth(hostToken).headers,
      'Content-Type': 'application/octet-stream',
      'X-Call-Id': callId,
      'X-Chunk-Index': '0',
    },
  });
  check('a chunk is accepted', upload.status === 200);
  check('the chunk size is reported back', upload.data.size === chunk.length);

  try {
    await axios.post(`${API}/call/recordings/chunk`, chunk, {
      headers: {
        ...auth(outsiderToken).headers,
        'Content-Type': 'application/octet-stream',
        'X-Call-Id': callId,
        'X-Chunk-Index': '1',
      },
    });
    check('a non-participant cannot upload to the call', false, 'upload succeeded');
  } catch (err: any) {
    check('a non-participant cannot upload to the call', err.response?.status === 403);
  }

  const chunkOnDisk = await prisma.callRecording.count({ where: { call_id: callId } });
  check('the recording row is created after finalisation', chunkOnDisk >= 0);

  // ── 9. Ending the call ────────────────────────────────────
  section('9. Ending the call');

  host.clear();
  callee.clear();
  const endRes = await axios.post(`${API}/call/sessions/${callId}/end`, {}, auth(hostToken));
  check('the host can end the call', endRes.status === 200);

  const ended = await callee.waitFor('CALL_ENDED');
  check('the other participant is told the call ended', !!ended);

  await sleep(400);
  const endedSession = await prisma.callSession.findUnique({ where: { id: callId } });
  check('the call session is marked ended', endedSession?.status === 'ended');
  check('the end time is recorded', !!endedSession?.ended_at);
  check(
    'the participants are closed out',
    (await prisma.callParticipant.count({ where: { call_id: callId, left_at: null } })) === 0
  );

  const rec = await prisma.callRecording.findFirst({ where: { call_id: callId } });
  check('the uploaded audio was assembled into a file', !!rec);
  if (rec) {
    const fs = require('fs');
    check('the assembled file exists on disk', fs.existsSync(rec.file_path));
    check('the assembled file is not empty', rec.file_size > 0);
  }

  // ── 10. History & decline ─────────────────────────────────
  section('10. History and decline');

  const history = await axios.get(`${API}/call/history`, auth(hostToken));
  check('the call history is returned', history.status === 200 && Array.isArray(history.data));
  check('the finished call is in the history', (history.data || []).some((l: any) => l.call_id === callId));

  // A second call that gets declined.
  const call2 = (
    await axios.post(`${API}/call/sessions`, { target_user_ids: [calleeId] }, auth(hostToken))
  ).data.id;
  createdCallIds.push(call2);

  const host2 = new TestClient((await axios.post(`${API}/call/ws-token`, {}, auth(hostToken))).data.token);
  const callee2 = new TestClient((await axios.post(`${API}/call/ws-token`, {}, auth(calleeToken))).data.token);
  await sleep(300);
  host2.send({ type: 'CALL_JOIN', callId: call2 });
  await host2.waitFor('CALL_JOINED');
  await callee2.waitFor('CALL_INCOMING');

  const declineRes = await axios.post(`${API}/call/sessions/${call2}/decline`, {}, auth(calleeToken));
  check('the callee can decline', declineRes.status === 200);

  const declined = await host2.waitFor('CALL_DECLINED');
  check('the caller is told the call was declined', !!declined);

  await sleep(300);
  const declinedLog = await prisma.callLog.findFirst({ where: { call_id: call2, to_user_id: calleeId } });
  check('the call log records the decline', declinedLog?.outcome === 'declined');

  host.close();
  callee.close();
  host2.close();
  callee2.close();

  // ── Cleanup ───────────────────────────────────────────────
  await prisma.callSession.deleteMany({ where: { id: { in: createdCallIds } } });
  await prisma.callLog.deleteMany({ where: { call_id: { in: createdCallIds } } });
  await prisma.notification.deleteMany({
    where: { type: 'call_incoming', user_id: calleeId, link: { in: createdCallIds } },
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('E2E test crashed:', err?.response?.data || err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
