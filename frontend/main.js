/**
 * main.js — Electron Main Process Entry Point
 * 
 * Integrates:
 * - React app window (existing)
 * - Desktop monitoring (target app detection, screenshot, upload)
 * - Auto-start with Windows
 * - System tray (minimize to tray, show/hide/quit)
 */

import electronPkg from 'electron';
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, dialog, Notification, session, screen } = electronPkg;
import electronUpdaterPkg from 'electron-updater';
const { autoUpdater } = electronUpdaterPkg;
import path from 'path';
import { fileURLToPath } from 'url';

// Monitoring modules
import { startMonitor, stopMonitor, setUserId } from './electron/monitor.js';
import { logger } from './electron/logger.js';

// Recording system modules (NEW)
import { initRecorderMain, getRecordingState } from './electron/recorder-main.js';
import { initWsClient, setWsUserId, shutdownWsClient, getAgentToken } from './electron/ws-client.js';
import { stopScheduler } from './electron/scheduler.js';
import { initNotificationClient, setNotificationUserId, shutdownNotificationClient } from './electron/notification-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ringtones and notification chimes are played by the renderer with the Web
// Audio API. Without this switch Chromium keeps the audio context suspended
// until the page has been clicked, so an incoming call could ring silently.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ─────────────────────────────────────────
// 0. Single Instance Lock
// ─────────────────────────────────────────
// The single-instance lock (and the userData folder that holds the agent
// token, logs and cookies) is keyed on the userData path. Pointing it
// somewhere else lets a development build run alongside an installed copy —
// which is what the automated tests need, because the installed agent
// otherwise grabs the lock and the dev build quits immediately.
if (process.env.ACEHRM_USER_DATA) {
  app.setPath('userData', process.env.ACEHRM_USER_DATA);
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running — quit immediately
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to launch a second instance — focus our window instead
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

let mainWindow = null;
let tray = null;

function showMainWindow(link) {
  const wasCreated = !mainWindow;
  if (wasCreated) createWindow();
  
  const sendNavigate = () => {
    if (link) {
      try {
        const url = String(link);
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        else mainWindow.webContents.send('notification:navigate', url);
      } catch { /* ignore bad links */ }
    }
  };

  const reveal = () => {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    sendNavigate();
  };

  if (wasCreated) {
    // Window was just created — wait for ready-to-show so we don't flash a white screen
    if (mainWindow.webContents.isLoading()) {
      mainWindow.webContents.once('did-finish-load', reveal);
    } else {
      // Already loaded (or ready-to-show already fired) — safe to show immediately
      reveal();
    }
  } else {
    reveal();
  }
}

// ─────────────────────────────────────────
// 0.5 Silent capture permissions (no user-facing prompts)
// ─────────────────────────────────────────
const CAPTURE_PERMISSIONS = new Set([
  'media',
  'display-capture',
  'mediaKeySystem',
  'media-access',
  'fullscreen',
  'pointerLock',
  'keyboardLock',
  'clipboard-read',
  'clipboard-write',
  'clipboard-sanitized-write',
  'notifications',
  'openExternal',
  'storage-access',
  'idle-detection',
  'unknown',
]);

function setupSilentCapturePermissions() {
  // Auto-approve media/screen-capture requests without any Electron/Chromium dialog.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (CAPTURE_PERMISSIONS.has(permission) || permission.startsWith('media')) {
      callback(true);
      return;
    }
    // Deny everything else silently — never surface a prompt to the end user.
    callback(false);
  });

  // Keep permission *checks* green for capture so a check never re-blocks startup.
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    if (CAPTURE_PERMISSIONS.has(permission) || permission.startsWith('media')) {
      return true;
    }
    // Default-deny unknown checks (still no UI)
    return false;
  });

  logger.info('[Permissions] Silent capture permission handlers installed');
}

// ─────────────────────────────────────────
// 1. Window Creation (existing functionality)
// ─────────────────────────────────────────

const isDev = !app.isPackaged;
if (isDev) {
  // Use a separate user data folder for development to avoid cache/lock conflicts
  app.setPath('userData', path.join(app.getPath('appData'), 'acehrm-dev'));
}

// Resolve the correct icon path for both dev and prod
const getIconPath = () => {
  const iconFileName = 'aceLogo.png';
  if (isDev) {
    return path.resolve(__dirname, 'public', iconFileName);
  } else {
    // In production, assets from 'public' are copied to the root of 'dist_build'
    return path.resolve(__dirname, 'dist_build', iconFileName);
  }
};

// Dev server address. Set ACEHRM_DEV_URL when the dev server is served over
// HTTPS (the browser only grants camera/microphone on a secure origin).
const DEV_URL = process.env.ACEHRM_DEV_URL || 'http://localhost:5173';

function createWindow() {
  const iconPath = getIconPath();
  logger.info(`Resolved icon path: ${iconPath}`);
  
  // Create a high-quality icon object and ensure it's resized for Windows
  const icon = nativeImage.createFromPath(iconPath);
  const taskbarIcon = icon.resize({ width: 256, height: 256, quality: 'best' });

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'aceHRM',
    icon: taskbarIcon,
    show: false, // Don't show until icon and content are ready
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'electron', 'preload.js'),
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.setIcon(taskbarIcon);
    mainWindow.show();
  });

if (isDev) {
  // Dev server during development
  mainWindow.loadURL(DEV_URL);
} else {
  // Production: load from ASAR
  const indexPath = path.join(__dirname, 'dist_build', 'index.html'); 
  mainWindow.loadFile(indexPath);
}

  // Minimize to tray instead of closing
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      logger.info('Window hidden to tray');
    }
  });

  // Floating chat bubble while minimized or closed to tray
  mainWindow.on('minimize', showBubble);
  mainWindow.on('hide', showBubble);
  mainWindow.on('restore', hideBubble);
  mainWindow.on('show', hideBubble);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // mainWindow.webContents.openDevTools(); // optional for debugging
}

// Load the renderer bundle with a hash to pick a view (#chat)
function loadApp(win, hash) {
  if (isDev) win.loadURL(`${DEV_URL}/#${hash}`);
  else win.loadFile(path.join(__dirname, 'dist_build', 'index.html'), { hash });
}

let bubbleWindow = null;
let chatWindow = null;
let activeCallNotification = null;
/** Call requested from the floating chat window, awaiting the main renderer. */
let pendingChatCallStart = null;

/** Relay an Accept / Decline choice back to the renderer that owns the call. */
function sendCallAction(action, callId) {
  const payload = { action, callId };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('call:action', payload);
  }
}

/**
 * Ask the renderer(s) to play the notification chime. The sound is synthesised
 * in the renderer, so it works for notifications raised by the main process
 * (notification WS, attendance monitor) as well as by the UI itself.
 */
function sendNotificationSound() {
  // Play the chime in exactly one renderer. Both the main window and the
  // floating chat window can be open, and playing it in both would double it.
  const target =
    mainWindow && !mainWindow.isDestroyed()
      ? mainWindow
      : BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
  if (target) target.webContents.send('notification:sound');
}

/**
 * Places a call requested from the floating chat window in the main window.
 * The request is kept until the main renderer consumes it, in case the main
 * window was still loading — otherwise the click would be silently lost.
 */
function delegateCallStart(payload) {
  if (!payload || !Array.isArray(payload.userIds) || payload.userIds.length === 0) return;
  const request = {
    userIds: payload.userIds.map(String),
    conversationId: payload.conversationId ? String(payload.conversationId) : null,
    requestedAt: Date.now(),
  };
  pendingChatCallStart = request;
  showMainWindow(null);

  const deliver = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('call:start', request);
    }
  };
  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once('did-finish-load', deliver);
  } else {
    deliver();
  }
}

/**
 * Raise a native OS notification for an incoming call.
 * Electron notification actions are honoured on Windows and macOS; on Linux
 * the notification is still shown and clicking it focuses the app.
 */
function showIncomingCallNotification({ callId, fromName }) {
  if (!Notification.isSupported()) return;

  // When the app is already in front of the user the in-app dialog is the
  // better prompt — a second OS popup would just be noise.
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    mainWindow.isVisible() &&
    mainWindow.isFocused()
  ) {
    return;
  }

  if (activeCallNotification) {
    try { activeCallNotification.close(); } catch { /* already gone */ }
    activeCallNotification = null;
  }

  const iconPath = path.join(__dirname, app.isPackaged ? 'dist' : 'public', 'aceLogo.png');

  const n = new Notification({
    title: 'Incoming call',
    body: `${fromName || 'Someone'} is calling you`,
    icon: iconPath,
    timeoutType: 'never',
    // The renderer plays the ringtone; a second OS sound would double it.
    silent: true,
    actions: [
      { type: 'button', text: 'Decline' },
      { type: 'button', text: 'Accept' },
    ],
  });

  n.on('action', (_event, index) => {
    const action = index === 0 ? 'decline' : 'accept';
    showMainWindow(null);
    sendCallAction(action, callId);
    try { n.close(); } catch { /* already gone */ }
    activeCallNotification = null;
  });

  // Clicking the notification opens the app and shows the Accept / Decline
  // dialog. It deliberately does not answer the call on the user's behalf.
  n.on('click', () => {
    showMainWindow(null);
    sendCallAction('prompt', callId);
    try { n.close(); } catch { /* already gone */ }
    activeCallNotification = null;
  });

  n.on('close', () => { activeCallNotification = null; });

  n.show();
  activeCallNotification = n;
}

function showBubble() {
  if (!bubbleWindow) {
    const { workArea } = screen.getPrimaryDisplay();
    bubbleWindow = new BrowserWindow({
      width: 72, height: 72,
      x: workArea.x + workArea.width - 96, y: workArea.y + workArea.height - 96,
      frame: false, transparent: true, resizable: false, alwaysOnTop: true,
      skipTaskbar: true, focusable: false, show: false,
      webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'electron', 'preload.js') },
    });
    bubbleWindow.setAlwaysOnTop(true, 'screen-saver');
    bubbleWindow.loadFile(path.join(__dirname, 'electron', 'bubble.html'));
    bubbleWindow.once('ready-to-show', () => bubbleWindow?.showInactive());
    bubbleWindow.on('closed', () => { bubbleWindow = null; });
  } else {
    bubbleWindow.showInactive();
  }
}

// Close (not hide) so the extra renderer processes free their RAM while restored
function hideBubble() {
  bubbleWindow?.close();
  chatWindow?.close();
}

function toggleChatWindow() {
  if (chatWindow) {
    if (chatWindow.isVisible()) chatWindow.hide();
    else { chatWindow.show(); chatWindow.focus(); }
    return;
  }
  const { workArea } = screen.getPrimaryDisplay();
  const width = 760, height = 560;
  chatWindow = new BrowserWindow({
    width, height,
    x: workArea.x + workArea.width - width - 24, y: workArea.y + workArea.height - height - 110,
    title: 'aceHRM Chat', icon: getIconPath(), alwaysOnTop: true, skipTaskbar: true,
    autoHideMenuBar: true, show: false,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'electron', 'preload.js') },
  });
  loadApp(chatWindow, 'chat');
  chatWindow.once('ready-to-show', () => chatWindow?.show());
  chatWindow.on('closed', () => { chatWindow = null; });
}

// ─────────────────────────────────────────
// 2. System Tray Setup
// ─────────────────────────────────────────
function createTray() {
  // Load the logo for the tray icon using the centralized path logic
  const iconPath = getIconPath();
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  // macOS menu bar only renders template (monochrome) images cleanly
  if (process.platform === 'darwin') icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('aceHRM Monitor');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show aceHRM',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: 'Hide aceHRM',
      click: () => {
        if (mainWindow) mainWindow.hide();
      },
    },
    { type: 'separator' },
    {
      label: 'Open Log File',
      click: () => {
        shell.openPath(logger.getLogPath());
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        stopMonitor();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  // Double-click tray icon to show window
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  logger.info('System tray created');
}

// ─────────────────────────────────────────
// 3. Auto-Start with Windows
// ─────────────────────────────────────────
/**
 * Register the app to launch on user login.
 * macOS ignores `path` (it registers a Login Item), so only send it elsewhere.
 */
function setupAutoStart() {
  const settings = { openAtLogin: true };
  if (process.platform !== 'darwin') {
    settings.path = process.execPath;
  }
  app.setLoginItemSettings(settings);
  logger.info(`Auto-start enabled (${process.platform})`);
}

// ─────────────────────────────────────────
// 3.5. Auto-Updater Setup
// ─────────────────────────────────────────
function setupAutoUpdater() {
  autoUpdater.requestHeaders = {
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    logger.info('Checking for updates...');
  });

  autoUpdater.on('update-available', (info) => {
    logger.info(`Update available: v${info.version}`);
  });

  autoUpdater.on('update-not-available', (info) => {
    logger.info(`App is up-to-date (v${info.version})`);
  });

  autoUpdater.on('download-progress', (progress) => {
    logger.info(`Download progress: ${Math.round(progress.percent)}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    logger.info(`Update downloaded: v${info.version}`);
    // Show a notification to the user
    if (mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Ready',
        message: `A new version (v${info.version}) has been downloaded. It will be installed when you restart the app.`,
        buttons: ['Restart Now', 'Later'],
      }).then((result) => {
        if (result.response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
    }
  });

  autoUpdater.on('error', (err) => {
    logger.error(`Auto-update error: ${err.message}`);
  });

  // Check for updates now, then every 30 minutes
  autoUpdater.checkForUpdatesAndNotify();
  setInterval(() => {
    autoUpdater.checkForUpdatesAndNotify();
  }, 30 * 60 * 1000);

  logger.info('Auto-updater initialized');
}

// ─────────────────────────────────────────
// 4. App Lifecycle
// ─────────────────────────────────────────
app.whenReady().then(() => {
  // Set the AppUserModelId for Windows taskbar icon grouping
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.ace.app');
  }

  logger.info('=== aceHRM Electron App Starting ===');

  // Install silent media/screen-capture permission handlers BEFORE any window loads
  setupSilentCapturePermissions();

  // Create the main window
  createWindow();

  // Set up system tray
  createTray();

  // Enable auto-start with Windows
  setupAutoStart();

  // Set up auto-updater (only in production)
  if (app.isPackaged) {
    setupAutoUpdater();
  }

  // Start the desktop monitoring system
  startMonitor();

  // Initialize the recording engine (hidden window + IPC listeners)
  initRecorderMain(
    getAgentToken,
    (state, sessionId) => {
      // Push recording state to main window for transparency banner
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('recording:state-update', { state, sessionId });
      }
      logger.info(`[Main] Recording state broadcast to UI: ${state}`);
    }
  );

  // Preflight: warm up desktop capture once so first live session has no cold prompt
  setTimeout(() => {
    import('./electron/recorder-main.js')
      .then((m) => m.warmupCapture?.())
      .catch((err) => logger.warn(`[Main] Capture warm-up skipped: ${err.message}`));
  }, 3000);

  // Start the WebSocket client (connects when userId is set)
  initWsClient(null).catch((err) => logger.error(`[Main] WS client init error: ${err.message}`));

  // Listen for the frontend sending the user's ID
  ipcMain.on('set-user-id', (event, userId) => {
    setUserId(userId);
    setWsUserId(userId); // Also update the recording WS client
    setNotificationUserId(userId); // Connect notification WS
    logger.info(`Main process received userId from frontend: ${userId}`);
  });

  ipcMain.on('chat-bubble:click', toggleChatWindow);
  ipcMain.on('chat-bubble:move', (_event, dx, dy) => {
    if (!bubbleWindow) return;
    const [x, y] = bubbleWindow.getPosition();
    bubbleWindow.setPosition(Math.round(x + dx), Math.round(y + dy));
  });

  // Recording state query from renderer (transparency layer)
  ipcMain.handle('recording:get-state', () => getRecordingState());

  // Push notifications — show native OS notification
  ipcMain.on('notification:show', (_event, title, body, link) => {
    if (!Notification.isSupported()) return;
    const iconPath = path.join(__dirname, app.isPackaged ? 'dist' : 'public', 'aceLogo.png');
    const n = new Notification({ title, body, icon: iconPath, silent: true });
    n.on('click', () => showMainWindow(link));
    n.show();
    // The renderer synthesises the chime so it matches every other sound.
    sendNotificationSound();
  });

  // ── Voice & video calls ───────────────────────────────────
  // The renderer detects an incoming call over the call WebSocket and reports
  // it here; the main process raises a native OS notification with
  // Accept / Decline buttons and relays the choice back to the renderer.
  ipcMain.on('call:incoming', (_event, payload) => {
    showIncomingCallNotification(payload || {});
  });

  ipcMain.on('call:ended', () => {
    if (activeCallNotification) {
      try { activeCallNotification.close(); } catch { /* already gone */ }
      activeCallNotification = null;
    }
  });

  // The floating chat window has no call socket of its own. Its Call button
  // delegates the request here: the main window is focused and its CallProvider
  // places the call, so a user never ends up as two peers in the same call.
  ipcMain.on('call:start', (_event, payload) => {
    delegateCallStart(payload);
  });

  // Whatever the main renderer has not picked up yet (for example the window
  // was still loading when the request arrived). Consuming it is atomic, so a
  // request can never start twice.
  ipcMain.handle('call:consume-pending-start', () => {
    const request = pendingChatCallStart;
    pendingChatCallStart = null;
    // Do not surprise the user with a call they asked for minutes ago (the
    // main window may have been on the login screen when it arrived).
    if (!request || Date.now() - request.requestedAt > 20_000) return null;
    return request;
  });

  ipcMain.on('call:start-consumed', () => {
    pendingChatCallStart = null;
  });

  // Test hook: lets the automated Electron test exercise the main→renderer
  // direction of the call IPC without a human clicking the OS notification.
  // Only registered when explicitly enabled, so it is absent in normal builds.
  if (process.env.ACEHRM_ENABLE_TEST_HOOKS) {
    ipcMain.on('call:simulate-action', (_event, payload) => {
      sendCallAction(payload?.action || 'accept', payload?.callId);
    });
    logger.info('[Call] Test hooks enabled');
  }

  // Open window when notification-client fires a click
  process.on('notification-click', (link) => showMainWindow(link));

  // A notification arrived while the app was minimised/hidden: let the
  // renderer play the chime (it keeps running in the background).
  process.on('notification-sound', () => sendNotificationSound());

  logger.info('All systems initialized');
});

// Keep the app running when all windows are closed (tray mode)
app.on('window-all-closed', () => {
  // Do NOT quit — the monitor and WS client keep running in the background
  // The user can quit via the tray menu
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Graceful shutdown
app.on('before-quit', () => {
  app.isQuitting = true;
  stopMonitor();
  shutdownWsClient();
  shutdownNotificationClient();
  stopScheduler();
  logger.info('=== ACE HR Electron App Shutting Down ===');
});
