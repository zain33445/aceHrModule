import assert from 'node:assert/strict';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

const name = `acehrm-test-${process.pid}-${Date.now()}`;
process.env.ACEHRM_DEVICE_PIPE = process.platform === 'win32' ? '\\\\.\\pipe\\' + name : `${process.env.TEMP || '/tmp'}/${name}.sock`;
const { startDevicePipe, stopDevicePipe } = await import('../electron/device-pipe.js');

let written = '';
const server = net.createServer((s) => {
  s.on('data', (d) => { written += d.toString('utf8'); });
  s.once('data', async () => {
    const line = Buffer.from(JSON.stringify({ type: 'REMOTE_CONTROL_START', text: 'Zürich ✓' }) + '\n', 'utf8');
    const cut = line.indexOf(Buffer.from('ü')) + 1; // middle of the 2-byte char
    s.write(line.subarray(0, cut));
    await sleep(50);
    s.write(line.subarray(cut));
  });
});
await new Promise((r) => server.listen(process.env.ACEHRM_DEVICE_PIPE, r));

let connected = false;
const msg = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout: handler never received message')), 3000);
  startDevicePipe({
    onConnected: () => { connected = true; },
    onRemoteControlStart: (m) => { clearTimeout(t); resolve(m); },
  });
});
assert.equal(msg.text, 'Zürich ✓');
assert.ok(written.includes('"type":"agent:status"'), 'agent:status written');
assert.ok(connected, 'onConnected fired');
stopDevicePipe();
server.close();
console.log('device-pipe: ok');
