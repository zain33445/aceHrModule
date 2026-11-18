'use strict';

// Self-check for the device socket handshake against a local fake gateway. Needs `npm install`.
const assert = require('node:assert');
const { WebSocketServer } = require('ws');
const { DeviceWsClient } = require('../src/ws-client');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(replyToAuth) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));

  server.on('connection', (ws) => {
    // The real gateway prompts as soon as a socket opens (device.gateway.ts).
    ws.send(JSON.stringify({ type: 'AUTH_REQUIRED' }));
    ws.on('message', (data) => {
      if (JSON.parse(data.toString()).type === 'AUTH') ws.send(JSON.stringify(replyToAuth));
    });
  });

  const client = new DeviceWsClient({
    url: `ws://127.0.0.1:${server.address().port}/device-ws`,
    getToken: () => 'token'
  });
  const seen = { connected: 0, expired: 0 };
  client.on('connected', () => { seen.connected += 1; });
  client.on('auth-expired', () => { seen.expired += 1; });

  client.start();
  await sleep(300);
  const stillConnected = client.isConnected();
  client.stop();
  server.close();
  return { ...seen, stillConnected };
}

(async () => {
  const accepted = await run({ type: 'CONNECTED', deviceId: 'd1' });
  assert.deepStrictEqual(
    accepted,
    { connected: 1, expired: 0, stillConnected: true },
    'the AUTH_REQUIRED prompt must not end a valid session'
  );

  const rejected = await run({ type: 'AUTH_FAILED' });
  assert.deepStrictEqual(
    rejected,
    { connected: 0, expired: 1, stillConnected: false },
    'a real rejection must still trigger credential recovery'
  );

  console.log('ws client self-check passed');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
