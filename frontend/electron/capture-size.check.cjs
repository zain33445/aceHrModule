// Run from frontend/: npx electron electron/capture-size.check.cjs        (edge case A20)
// Question: can a recording end up at 320x180 because the 320x180 warm-up capture (recorder-renderer.js) or a live-view
// capture of the same screen is open while the recorder starts? Drives the REAL recorder-renderer.js over its IPC
// contract and measures the real frame size (video element + the first recorded chunk), not only getSettings().
// Uses its own userData folder; never touches %APPDATA%\acehrm. Needs a screen (one monitor is enough).
const { app, BrowserWindow, desktopCapturer, ipcMain } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'acehrm-capture-size-')));
const RECORDER_HTML = path.join(__dirname, 'recorder-renderer', 'recorder.html');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REQ = { w: 1920, h: 1080 };            // the recorder preset under test (1080p: the size the warm-up could shrink)
const REQ_SMALL = { w: 1280, h: 720 };       // default 720p preset
const REQ_480 = { w: 854, h: 480 };          // 480p: not exactly 16:9, does min=max give exactly 854x480?

async function mkWindow() {
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  await win.loadFile(RECORDER_HTML); // file:// is a secure context; this also runs the real recorder-renderer.js
  return win;
}

app.on('window-all-closed', () => { /* stay alive between scenarios */ });
const events = { started: [], stopped: [], chunks: [], errors: [], logs: [] };
ipcMain.on('recording:segment-started', (_e, m) => events.started.push({ ...m, t: Date.now() }));
ipcMain.on('recording:chunk', (e, m) => events.chunks.push({ ...m, bytes: Buffer.from(m.buffer) }));
ipcMain.on('recording:error', (_e, m) => events.errors.push(m));
ipcMain.on('recording:warmup-result', () => { });
ipcMain.on('recording:log', (_e, m) => events.logs.push(m));
ipcMain.on('recording:segment-stopped', (_e, m) => events.stopped.push({ ...m, t: Date.now() }));
ipcMain.on('recording:capture-lost', () => { });
const reset = () => { events.started.length = 0; events.stopped.length = 0; events.chunks.length = 0; events.errors.length = 0; events.logs.length = 0; };

/** Real frame size of the recorder's capture stream (video element) + what getSettings() claims. */
const frameOfRecorderCapture = (win) => win.webContents.executeJavaScript(`(async () => {
  const c = typeof capture !== 'undefined' ? capture : null;
  if (!c) return null;
  const v = document.createElement('video'); v.muted = true; v.srcObject = c.stream; await v.play();
  await new Promise((r) => setTimeout(r, 900));
  const out = { frame: { w: v.videoWidth, h: v.videoHeight }, settings: { w: c.track.getSettings().width, h: c.track.getSettings().height } };
  v.srcObject = null; return out;
})()`);

/** Size of a recorded chunk (base64 of its bytes decoded in a video element). */
async function sizeOfChunk(win, bytes) {
  const r = await decodeSize(win, bytes);
  if (process.env.CAPTURE_SIZE_DUMP && !r.w) fs.writeFileSync(path.join(process.env.CAPTURE_SIZE_DUMP, `undecodable-${Date.now()}.webm`), bytes);
  return r;
}
const decodeSize = (win, bytes) => win.webContents.executeJavaScript(`(async () => {
  const bin = atob(${JSON.stringify(bytes.toString('base64'))}); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  for (let attempt = 0; ; attempt++) { // the decoder occasionally refuses a fresh blob (seen ~1 in 20): ask again
    const v = document.createElement('video'); v.muted = true; const url = URL.createObjectURL(new Blob([u], { type: 'video/webm' })); v.src = url;
    await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 4000); });
    const out = { w: v.videoWidth, h: v.videoHeight };
    v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); // release the decoder: ~40 of these ran in one process before
    if (out.w > 0 || attempt >= 2) return out;
  }
})()`);

const begin = (win, sourceId, req, segmentId) => win.webContents.send('recording:begin', {
  segmentId, sourceId, newCapture: false, timesliceMs: 1000, videoBitsPerSecond: 1_200_000, maxFps: 15, maxWidth: req.w, maxHeight: req.h,
});

/** Another window opening the same screen like the live view does (its own capture, minWidth=maxWidth). */
async function openLiveCapture(win2, sourceId, w, h) {
  return win2.webContents.executeJavaScript(`(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: ${JSON.stringify(sourceId)}, minWidth: ${w}, maxWidth: ${w}, minHeight: ${h}, maxHeight: ${h}, maxFrameRate: 15 } } });
    window.__live = stream; return stream.getVideoTracks()[0].getSettings();
  })()`);
}
const closeLive = (win2) => win2.webContents.executeJavaScript('(window.__live && window.__live.getTracks().forEach((t) => t.stop()), true)');

/** Measures the recorder after `ms`; returns { settings, frame, chunk0, segmentStarted }. */
/** Bytes of the first chunks (0..3) of segment `id` (any segment when null). A still screen makes MediaRecorder slow: the
 * first chunk can be a single byte, so decoding waits for real data. */
const firstBytes = (id) => Buffer.concat(events.chunks.filter((c) => (id == null || c.segmentId === id) && c.seq <= 3).sort((a, b) => a.seq - b.seq).map((c) => c.bytes));
async function waitFor(fn, ms = 15000) { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await sleep(50); return fn(); }
async function measure(win, ms = 2500) {
  await sleep(ms);
  const cap = await frameOfRecorderCapture(win);
  await waitFor(() => firstBytes().length > 4096, 8000);
  const bytes = firstBytes();
  const chunk0 = bytes.length ? await sizeOfChunk(win, bytes) : null;
  const started = events.started[0] ? { w: events.started[0].width, h: events.started[0].height } : null;
  return { reported: started, settings: cap?.settings ?? null, frame: cap?.frame ?? null, chunk0 };
}

const results = [];
const same = (a, b) => a && b && a.w === b.w && a.h === b.h;
/**
 * expect 'requested': every measure equals the requested size (the warm-up must never shrink a recording).
 * expect 'honest': another window holds the screen at a smaller size, nothing can enlarge it: the recorder must have
 * retried (bounded), still recorded, and report the REAL frame size (not the requested one) in segment-started.
 */
function record(label, req, m, extra, expect = 'requested') {
  const logs = events.logs.filter((l) => /capture size/i.test(l.message));
  let good = same(m.frame, req) && same(m.chunk0, req) && same(m.reported, req);
  const honest = () => !!m.chunk0 && same(m.reported, m.frame) && same(m.chunk0, m.frame) && logs.length >= 1 && logs.length <= 3 && events.errors.length === 0;
  if (expect === 'detect') good = good || honest();
  if (expect === 'honest') good = honest();
  results.push({ label, req, m, good });
  console.log(`${good ? 'ok   ' : 'FAIL '} ${label}: requested ${req.w}x${req.h} | segment-started ${JSON.stringify(m.reported)} | getSettings ${JSON.stringify(m.settings)} | video frame ${JSON.stringify(m.frame)} | first chunk decoded ${JSON.stringify(m.chunk0)}${extra ? ' | ' + extra : ''}${logs.length ? ` | guard logs ${logs.length}` : ''}`);
}

async function scenario(label, req, run) {
  reset();
  const win = await mkWindow();
  const win2 = await mkWindow();
  try { await run(win, win2, req); } catch (err) { results.push({ label, good: false }); console.log(`FAIL  ${label}: ${err.stack || err}`); }
  try { win.webContents.send('recording:stop', { release: true }); } catch { /* gone */ }
  await sleep(700);
  try { await closeLive(win2); } catch { /* none */ }
  await sleep(300);
  for (const w of [win, win2]) if (!w.isDestroyed()) w.destroy();
  await sleep(500);
}

app.whenReady().then(async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const src = sources[0];
  console.log(`source ${src.id}, ${sources.length} screen(s), userData ${app.getPath('userData')}`);
  const warmup = (win) => win.webContents.send('recording:warmup', { sourceId: src.id });

  for (const req of process.env.CAPTURE_SIZE_ROTATION_ONLY ? [] : [REQ, REQ_SMALL, REQ_480]) { // env: run only the rotation scenarios
    await scenario(`control: recorder alone (${req.w}x${req.h})`, req, async (win) => {
      begin(win, src.id, req, 'seg-control'); record(`control ${req.w}x${req.h}`, req, await measure(win));
    });
    await scenario(`warm-up message immediately followed by begin (${req.w}x${req.h})`, req, async (win) => {
      warmup(win); begin(win, src.id, req, 'seg-w0'); record(`begin right after warm-up message ${req.w}x${req.h}`, req, await measure(win));
    });
    await scenario(`begin while the warm-up capture is open (${req.w}x${req.h})`, req, async (win) => {
      warmup(win); await sleep(150); begin(win, src.id, req, 'seg-w150'); record(`begin 150 ms after warm-up ${req.w}x${req.h}`, req, await measure(win));
    });
    await scenario(`begin just before the warm-up (${req.w}x${req.h})`, req, async (win) => {
      begin(win, src.id, req, 'seg-b0'); await sleep(50); warmup(win); record(`warm-up 50 ms after begin ${req.w}x${req.h}`, req, await measure(win));
    });
    await scenario(`warm-up while the recorder runs (${req.w}x${req.h})`, req, async (win) => {
      begin(win, src.id, req, 'seg-run'); await sleep(1500); warmup(win); await sleep(100);
      record(`warm-up while recording ${req.w}x${req.h}`, req, await measure(win, 1500));
    });
    await scenario(`live capture 640x360 opened BEFORE the recorder (${req.w}x${req.h})`, req, async (win, win2) => {
      const s = await openLiveCapture(win2, src.id, 640, 360); await sleep(500);
      begin(win, src.id, req, 'seg-live-small'); record(`live 640x360 first, recorder ${req.w}x${req.h}`, req, await measure(win, 4500), `live getSettings ${s.width}x${s.height}`, 'honest');
    });
    // live boxes (nativeCaptureSize): 1920x1080 / 2560x1440 / 3840x2160 must leave every preset intact. 1366x768 (the old size of a
    // small screen) and 1920x1200 (the old size of a 16:10 screen) are evidence: they may or may not shrink the recorder, and when
    // they do it must be detected, retried (bounded) and recorded honestly.
    for (const [lw, lh] of [[1366, 768], [1920, 1080], [1920, 1200], [2560, 1440], [3840, 2160]]) {
      await scenario(`live capture ${lw}x${lh} opened BEFORE the recorder (${req.w}x${req.h})`, req, async (win, win2) => {
        const s = await openLiveCapture(win2, src.id, lw, lh); await sleep(500);
        begin(win, src.id, req, 'seg-live-sweep');
        const box = lw * 9 === lh * 16 && lw >= req.w && lh >= req.h; // a 16:9 box at least as big as the preset
        record(`live ${lw}x${lh} first, recorder ${req.w}x${req.h}`, req, await measure(win, box ? 2500 : 4500), `live getSettings ${s.width}x${s.height}`, box ? 'requested' : 'detect');
      });
    }
    await scenario(`live capture opened WHILE the recorder runs (${req.w}x${req.h})`, req, async (win, win2) => {
      begin(win, src.id, req, 'seg-live-after'); await sleep(1500);
      const s = await openLiveCapture(win2, src.id, 640, 360); await sleep(200);
      record(`live 640x360 while recording ${req.w}x${req.h}`, req, await measure(win, 1500), `live getSettings ${s.width}x${s.height}`);
    });
  }

  // ---- rotation: a wrong capture size must not last for hours, and the retries must not open a long gap ----
  const T = () => Date.now();
  const startedOf = (id) => events.started.find((m) => m.segmentId === id);
  const stoppedOf = (id) => events.stopped.find((m) => m.segmentId === id);
  /** Decoded size of segment `id`'s first chunks. */
  const sizeOfSeg = async (win, id) => {
    await waitFor(() => firstBytes(id).length > 4096, 8000);
    const all = firstBytes(id);
    return all.length ? sizeOfChunk(win, all) : null;
  };
  /** Gap between the old segment's last data (its stop) and the new segment's recorder start; negative = overlap. */
  const gapMs = (oldId, newId) => (startedOf(newId)?.t ?? NaN) - (stoppedOf(oldId)?.t ?? NaN);
  const GAP_LIMIT_MS = 1000; // a retry at rotation (wrong size already present) may cost about 1 s in total
  const req0 = REQ;
  const rot = (label, ok, detail) => { results.push({ label, good: ok }); console.log(`${ok ? 'ok   ' : 'FAIL '} ${label} | ${detail}`); };

  await scenario('rotation with the right size', req0, async (win) => {
    begin(win, src.id, req0, 'rot-a'); await waitFor(() => startedOf('rot-a')); await sleep(2500);
    begin(win, src.id, req0, 'rot-b'); await waitFor(() => stoppedOf('rot-a'));
    const gap = gapMs('rot-a', 'rot-b'); await sleep(2500);
    const sz = await sizeOfSeg(win, 'rot-b');
    rot('rotation, size right: no gap, same capture', gap < 300 && same(sz, req0), `gap ${gap} ms (negative = overlap), new segment ${JSON.stringify(sz)}`);
  });
  await scenario('rotation after a wrong-size segment, the cause is gone', req0, async (win, win2) => {
    await openLiveCapture(win2, src.id, 640, 360); await sleep(500);
    begin(win, src.id, req0, 'rot-a'); await waitFor(() => startedOf('rot-a'), 20000); await sleep(2500);
    const first = await sizeOfSeg(win, 'rot-a');
    await closeLive(win2); await sleep(800);
    begin(win, src.id, req0, 'rot-b'); await waitFor(() => stoppedOf('rot-a')); await waitFor(() => startedOf('rot-b'), 20000);
    const gap = gapMs('rot-a', 'rot-b'); await sleep(2500);
    const sz = await sizeOfSeg(win, 'rot-b');
    rot('rotation retries a wrong-size capture and gets the preset', !same(first, req0) && same(sz, req0) && same({ w: startedOf('rot-b').width, h: startedOf('rot-b').height }, req0), `first segment ${JSON.stringify(first)}, next ${JSON.stringify(sz)}, gap ${gap} ms`);
    rot('  ... and the gap stays short', gap < GAP_LIMIT_MS, `gap ${gap} ms (limit ${GAP_LIMIT_MS})`);
  });
  await scenario('rotation while all 3 tries fail', req0, async (win, win2) => {
    await openLiveCapture(win2, src.id, 640, 360); await sleep(500);
    begin(win, src.id, req0, 'rot-a'); await waitFor(() => startedOf('rot-a'), 20000); await sleep(2500);
    begin(win, src.id, req0, 'rot-b'); await waitFor(() => stoppedOf('rot-a')); await waitFor(() => startedOf('rot-b'), 20000);
    const gap = gapMs('rot-a', 'rot-b'); await sleep(2500);
    const sz = await sizeOfSeg(win, 'rot-b');
    rot('rotation with 3 failing tries: still records, gap short', !!sz && gap < GAP_LIMIT_MS, `gap ${gap} ms (limit ${GAP_LIMIT_MS}), new segment ${JSON.stringify(sz)}`);
  });
  await scenario('screen switch / preset change', req0, async (win) => {
    begin(win, src.id, req0, 'rot-a'); await waitFor(() => startedOf('rot-a')); await sleep(2500);
    begin(win, src.id, REQ_SMALL, 'rot-b'); await waitFor(() => stoppedOf('rot-a')); await waitFor(() => startedOf('rot-b'));
    const gap = gapMs('rot-a', 'rot-b'); await sleep(2500);
    const sz = await sizeOfSeg(win, 'rot-b');
    rot('preset change: gap short, new size right', gap < GAP_LIMIT_MS && same(sz, REQ_SMALL), `gap ${gap} ms, new segment ${JSON.stringify(sz)}`);
  });

  const bad = results.filter((r) => !r.good);
  console.log(`capture-size: ${results.length - bad.length}/${results.length} scenarios behaved as required`);
  app.exit(bad.length ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(2); });
