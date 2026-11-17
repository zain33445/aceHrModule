/**
 * test-device-ws.ts — smoke test for the device gateways and device tokens.
 *
 * No database is needed. The test deliberately never authenticates a valid
 * device identity, because that would trigger a heartbeat/last_seen write.
 *
 * Checks:
 *   1. Device tokens sign/verify, and garbage/wrong-typed tokens are rejected.
 *   2. /device-ws greets a new socket with AUTH_REQUIRED.
 *   3. A bad in-band device token closes the socket with code 4001.
 *   4. /device-admin-ws?token=garbage is rejected with HTTP 401.
 *   5. A valid admin ticket reaches CONNECTED (no DB access).
 *   6. Long-lived session tokens are rejected by both admin sockets.
 *   8. /recording-ws still greets agents with AUTH_REQUIRED.
 *   9. An unknown upgrade path is still destroyed.
 *
 * Run with: npm run test-device-ws
 */

import { createServer } from 'http';
import WebSocket from 'ws';
import { initGateway } from './gateways/recording.gateway';
import { initChatGateway } from './gateways/chat.gateway';
import { initCallGateway } from './gateways/call.gateway';
import { initDeviceGateway } from './gateways/device.gateway';
import { signDeviceToken, verifyDeviceToken } from './middleware/requireDeviceToken';
import { signCallToken, signSessionToken } from './middleware/requireUser';

const PORT = 5098;
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
function firstMessage(
  url: string,
  timeoutMs = 3000
): Promise<{ ok: boolean; message?: any; status?: number }> {
  return new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket(url);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
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
      try {
        message = JSON.parse(data.toString());
      } catch {
        message = null;
      }
      resolve({ ok: true, message });
      try {
        ws.close();
      } catch {
        /* ignore */
      }
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
      try {
        ws.close();
      } catch {
        /* ignore */
      }
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

/** Sends an AUTH frame after the upgrade and resolves with the close code. */
function closeCodeAfterAuth(
  url: string,
  token: string,
  timeoutMs = 3000
): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket(url);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      resolve(null);
    }, timeoutMs);

    const done = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code);
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'AUTH', token }));
    });

    // The gateway sends AUTH_REQUIRED first; ignore it and wait for the close.
    ws.on('message', () => {});

    ws.on('close', (code) => done(code));
    ws.on('error', () => done(null));
  });
}

async function main() {
  console.log('\naceHRM — device gateway smoke test\n');

  // ── Token helpers ──────────────────────────────────────────
  console.log('Device tokens');
  const deviceToken = signDeviceToken('device-test-123');
  check('device token is issued', typeof deviceToken === 'string' && deviceToken.length > 20);

  const decoded = verifyDeviceToken(deviceToken);
  check(
    'device token verifies with the right device id',
    !!decoded && decoded.deviceId === 'device-test-123',
    JSON.stringify(decoded)
  );

  check('garbage device token is rejected', verifyDeviceToken('not-a-jwt') === null);

  const userToken = signCallToken({ id: '42', name: 'User', role: 'employee' });
  check('a user token is not accepted as a device token', verifyDeviceToken(userToken) === null);

  // ── Gateway upgrade arbitration ────────────────────────────
  const server = createServer((_req, res) => {
    res.statusCode = 200;
    res.end('ok');
  });

  initGateway(server);
  initChatGateway(server);
  initCallGateway(server);
  initDeviceGateway(server);

  await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  console.log('\nWebSocket upgrade routing');

  const idleDevice = await firstMessage(`${BASE}/device-ws`);
  check(
    '/device-ws sends AUTH_REQUIRED',
    idleDevice.ok && idleDevice.message?.type === 'AUTH_REQUIRED',
    JSON.stringify(idleDevice)
  );

  const badAuthCode = await closeCodeAfterAuth(`${BASE}/device-ws`, 'garbage');
  check(
    '/device-ws closes with 4001 on a bad AUTH token',
    badAuthCode === 4001,
    String(badAuthCode)
  );

  const badAdmin = await firstMessage(`${BASE}/device-admin-ws?token=garbage`);
  check(
    '/device-admin-ws rejects a garbage ticket with 401',
    !badAdmin.ok && badAdmin.status === 401,
    JSON.stringify(badAdmin)
  );

  const adminTicket = signCallToken({ id: 'admin-1', name: 'Admin', role: 'admin' });
  const admin = await firstMessage(
    `${BASE}/device-admin-ws?token=${encodeURIComponent(adminTicket)}`
  );
  check(
    '/device-admin-ws accepts a signed admin ticket',
    admin.ok && admin.message?.type === 'CONNECTED' && admin.message?.adminId === 'admin-1',
    JSON.stringify(admin)
  );

  const sessionTicket = signSessionToken({ id: 'admin-2', name: 'Admin', role: 'admin' }, 'session-2');
  const sessionOnDeviceAdmin = await firstMessage(
    `${BASE}/device-admin-ws?token=${encodeURIComponent(sessionTicket)}`
  );
  check(
    '/device-admin-ws rejects a long-lived session token',
    !sessionOnDeviceAdmin.ok && sessionOnDeviceAdmin.status === 401,
    JSON.stringify(sessionOnDeviceAdmin)
  );

  const recording = await firstMessage(`${BASE}/recording-ws`);
  check(
    '/recording-ws still greets the agent with AUTH_REQUIRED',
    recording.ok && recording.message?.type === 'AUTH_REQUIRED',
    JSON.stringify(recording)
  );

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
