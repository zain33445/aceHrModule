/**
 * test-call-ws.ts — Smoke test for the call signalling gateway.
 *
 * The riskiest part of the calling feature is the WebSocket upgrade-path
 * arbitration: three gateways each register their own 'upgrade' listener on
 * the same HTTP server, and the recording gateway *destroys* any path it does
 * not recognise. If the /call-ws path is not explicitly yielded by both the
 * recording and the chat gateway, the call socket is killed before the call
 * gateway ever sees it — and the symptom is an indistinguishable "network
 * error" in the client.
 *
 * This test boots the three gateways against a throwaway HTTP server and
 * checks:
 *   1. /call-ws accepts a valid signed ticket and greets the client.
 *   2. /call-ws rejects an invalid ticket with HTTP 401.
 *   3. /recording-ws still works (the yield did not break the agent path).
 *   4. An unknown path is still destroyed (the yield is selective).
 *   5. Token sign/verify and the TURN credential minting behave correctly.
 *
 * It needs no database. Run with: npm run test-call-ws
 */

import { createServer } from 'http';
import WebSocket from 'ws';
import { initGateway } from './gateways/recording.gateway';
import { initChatGateway } from './gateways/chat.gateway';
import { initCallGateway } from './gateways/call.gateway';
import { signCallToken, verifyUserToken } from './middleware/requireUser';
import { getIceServers, isTurnConfigured } from './services/turn.service';

const PORT = 5099;
const BASE = `ws://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Opens a socket and resolves with the first message the server sends. */
function firstMessage(url: string, timeoutMs = 3000): Promise<{ ok: boolean; message?: any; status?: number }> {
  return new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket(url);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve({ ok: false });
    }, timeoutMs);

    ws.on('unexpected-response', (_req, res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, status: res.statusCode });
    });

    ws.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false });
    });

    ws.on('message', (data: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let message: any;
      try { message = JSON.parse(data.toString()); } catch { message = null; }
      resolve({ ok: true, message });
      try { ws.close(); } catch { /* ignore */ }
    });
  });
}

/** Resolves with true when the socket is closed without a message. */
function closedWithoutMessage(url: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket(url);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve(false);
    }, timeoutMs);

    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };

    ws.on('close', done);
    ws.on('error', done);
  });
}

async function main() {
  console.log('\naceHRM — call signalling smoke test\n');

  // ── Token helpers ──────────────────────────────────────────
  console.log('Auth tokens');
  const token = signCallToken({ id: '42', name: 'Test User', role: 'employee' });
  check('call token is issued', typeof token === 'string' && token.length > 20);

  const decoded = verifyUserToken(token);
  check('call token verifies', !!decoded && decoded.userId === '42');
  check('call token is typed as a call ticket', decoded?.typ === 'call');
  check('garbage token is rejected', verifyUserToken('not-a-jwt') === null);

  // ── TURN configuration ─────────────────────────────────────
  console.log('\nICE / TURN configuration');
  const ice = getIceServers();
  check('at least one ice server is returned', ice.iceServers.length > 0);
  check(
    'a STUN server is present',
    ice.iceServers.some((s: any) => JSON.stringify(s.urls).includes('stun:')),
    JSON.stringify(ice.iceServers)
  );
  if (isTurnConfigured()) {
    const turn = ice.iceServers.find((s: any) => s.username && s.credential);
    check('TURN credentials are minted', !!turn);
    check(
      'TURN username carries an expiry',
      !!(turn as any)?.username && String((turn as any).username).includes(':')
    );
  } else {
    console.log('  SKIP  TURN credential test (no TURN provider configured)');
  }

  // ── Gateway upgrade arbitration ────────────────────────────
  const server = createServer((_req, res) => {
    res.statusCode = 200;
    res.end('ok');
  });

  initGateway(server);
  initChatGateway(server);
  initCallGateway(server);

  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  console.log('\nWebSocket upgrade routing');

  // 1. A valid ticket must be accepted by the call gateway.
  const accepted = await firstMessage(`${BASE}/call-ws?token=${encodeURIComponent(token)}`);
  check(
    '/call-ws accepts a valid ticket and sends CONNECTED',
    accepted.ok && accepted.message?.type === 'CONNECTED',
    JSON.stringify(accepted)
  );

  // 2. An invalid ticket must be rejected with HTTP 401.
  const rejected = await firstMessage(`${BASE}/call-ws?token=garbage`);
  check(
    '/call-ws rejects an invalid ticket',
    !rejected.ok && rejected.status === 401,
    JSON.stringify(rejected)
  );

  // 3. The agent path must still work — the yield did not break it.
  const agent = await firstMessage(`${BASE}/recording-ws`);
  check(
    '/recording-ws still greets the agent with AUTH_REQUIRED',
    agent.ok && agent.message?.type === 'AUTH_REQUIRED',
    JSON.stringify(agent)
  );

  // 4. An unknown path must still be destroyed (the yield is selective).
  const unknown = await closedWithoutMessage(`${BASE}/not-a-real-path`);
  check('an unknown path is still rejected', unknown);

  server.close();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
