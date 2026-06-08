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
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, dialog } = electronPkg;
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────
// 0. Single Instance Lock
// ─────────────────────────────────────────
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
  mainWindow.loadURL('http://localhost:5173');
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

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // mainWindow.webContents.openDevTools(); // optional for debugging
}

// ─────────────────────────────────────────
// 2. System Tray Setup
// ─────────────────────────────────────────
function createTray() {
  // Load the logo for the tray icon using the centralized path logic
  const iconPath = getIconPath();
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });

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
function setupAutoStart() {
  app.setLoginItemSettings({
    openAtLogin: true,
    path: process.execPath,
  });
  logger.info('Auto-start with Windows enabled');
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

  // Start the WebSocket client (connects when userId is set)
  initWsClient(null).catch((err) => logger.error(`[Main] WS client init error: ${err.message}`));

  // Listen for the frontend sending the user's ID
  ipcMain.on('set-user-id', (event, userId) => {
    setUserId(userId);
    setWsUserId(userId); // Also update the recording WS client
    logger.info(`Main process received userId from frontend: ${userId}`);
  });

  // Recording state query from renderer (transparency layer)
  ipcMain.handle('recording:get-state', () => getRecordingState());

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
  stopScheduler();
  logger.info('=== ACE HR Electron App Shutting Down ===');
});
