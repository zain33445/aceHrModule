// Run from frontend/: npx electron electron/letterbox.check.cjs
// Question: does desktop capture with min=max W x H give a FIXED frame size (letterboxed) on any monitor?
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  await win.loadFile(require('path').join(__dirname, 'recorder-renderer', 'recorder.html')); // file:// is a secure context (about:blank has no mediaDevices)
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const prim = String(screen.getPrimaryDisplay().id);
  const src = sources.find((s) => String(s.display_id) === prim) || sources[0];
  const out = await win.webContents.executeJavaScript(`(async () => {
    const grab = async (constraints, label) => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: ${JSON.stringify(src.id)}, ...constraints } } });
      const track = stream.getVideoTracks()[0];
      const settings = track.getSettings();
      const v = document.createElement('video'); v.muted = true; v.srcObject = stream; await v.play();
      await new Promise((r) => setTimeout(r, 2000));
      const frame = { w: v.videoWidth, h: v.videoHeight };
      // also record ~2 s to be sure the encoded stream has the same size
      const rec = new MediaRecorder(stream, { mimeType: 'video/webm; codecs=vp8' }); const parts = []; rec.ondataavailable = (e) => parts.push(e.data);
      rec.start(); await new Promise((r) => setTimeout(r, 2000)); rec.stop(); await new Promise((r) => (rec.onstop = r));
      const url = URL.createObjectURL(new Blob(parts, { type: 'video/webm' }));
      const pv = document.createElement('video'); pv.muted = true; pv.src = url;
      await new Promise((r) => (pv.onloadedmetadata = r));
      stream.getTracks().forEach((t) => t.stop());
      return { label, requested: constraints, settings: { width: settings.width, height: settings.height }, frame, recorded: { w: pv.videoWidth, h: pv.videoHeight } };
    };
    return [
      await grab({ minWidth: 1280, maxWidth: 1280, minHeight: 720, maxHeight: 720, maxFrameRate: 15 }, 'min=max 1280x720'),
      await grab({ minWidth: 1000, maxWidth: 1000, minHeight: 1000, maxHeight: 1000, maxFrameRate: 15 }, 'min=max 1000x1000 (aspect mismatch)'),
      await grab({ maxWidth: 1000, maxHeight: 1000, maxFrameRate: 15 }, 'max only 1000x1000 (control)'),
    ];
  })()`);
  const d = screen.getPrimaryDisplay();
  console.log(`primary display ${d.size.width}x${d.size.height} @${d.scaleFactor}x`);
  let ok = true;
  for (const r of out) {
    console.log(JSON.stringify(r));
    if (r.label.includes('control')) continue;
    const w = r.requested.maxWidth, h = r.requested.maxHeight;
    const good = r.settings.width === w && r.settings.height === h && r.frame.w === w && r.frame.h === h && r.recorded.w === w && r.recorded.h === h;
    console.log(`${good ? 'ok   ' : 'FAIL '} ${r.label}: frame/recorded size equals requested ${w}x${h}`);
    ok = ok && good;
  }
  console.log(ok ? 'RESULT: Chromium letterboxes to the fixed size' : 'RESULT: Chromium does NOT produce a fixed size');
  app.exit(ok ? 0 : 1);
}).catch((e) => { console.error(e); app.exit(2); });
