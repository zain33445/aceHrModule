'use strict';

const os = require('node:os');
const { loadConfig, ensureRuntimeDirectories, paths: defaultPaths } = require('./config');
const { createLogger } = require('./logger');
const {
  getOrCreateIdentity,
  loadCredentials,
  secretStorageMode
} = require('./identity');
const {
  EnrollmentUnavailableError,
  enrollDevice,
  ensureCredentials,
  recoverCredentials,
  reportUserLogin,
  sendHeartbeat
} = require('./enroll');
const { sendInventory } = require('./inventory');
const { PolicyManager } = require('./policy');
const { DeviceWsClient } = require('./ws-client');
const { NamedPipeBridge } = require('./named-pipe');
const { executeDeviceCommand } = require('./commands');

const consoleMode = process.argv.includes('--console');
const shuttingDownFlag = { value: false };

let config = null;
let logger = null;
let identity = null;
let credentials = null;
let wsClient = null;
let pipeBridge = null;
let policyManager = null;
let credentialRetryTimer = null;
let pipeRetryTimer = null;
let authRecovery = null;
let lastAgentStatus = null;
let remoteControlState = { active: false, session_id: null, admin_id: null, started_at: null };

function isShuttingDown() {
  return shuttingDownFlag.value;
}

function stopTimer(timer) {
  if (timer) clearTimeout(timer);
  return null;
}

function getDeviceStatus() {
  return {
    status: 'online',
    phase: 'phase3',
    device_id: credentials?.deviceId || null,
    hostname: identity?.hostname || os.hostname(),
    agent_version: config?.agentVersion || null,
    agent_connected: Boolean(pipeBridge && pipeBridge.clientCount > 0),
    agent_status: lastAgentStatus?.status || null,
    policy_status: policyManager?.getSummary() || null,
    remote_control: remoteControlState
  };
}

function sendDeviceStatus() {
  if (!wsClient) return false;
  return wsClient.send({
    ...getDeviceStatus(),
    type: 'DEVICE_STATUS',
    ts: new Date().toISOString()
  });
}

function scheduleCredentialRetry() {
  if (isShuttingDown() || credentialRetryTimer) return;
  const delay = config.enrollmentRetryMs;

  logger?.info(`Device enrollment retry scheduled in ${Math.round(delay / 1000)}s`);
  credentialRetryTimer = setTimeout(() => {
    credentialRetryTimer = null;
    obtainCredentialsAndConnect();
  }, delay);
}

function schedulePipeRetry() {
  if (isShuttingDown() || pipeRetryTimer) return;

  pipeRetryTimer = setTimeout(() => {
    pipeRetryTimer = null;
    if (isShuttingDown()) return;
    if (pipeBridge) {
      pipeBridge.close();
      pipeBridge = null;
    }
    startNamedPipe();
  }, 5_000);
}

function startNamedPipe() {
  if (isShuttingDown()) return;

  pipeBridge = new NamedPipeBridge({
    pipePath: config.pipePath,
    logger
  });

  pipeBridge.on('client-connected', () => {
    sendDeviceStatus();
  });

  pipeBridge.on('client-disconnected', () => {
    sendDeviceStatus();
  });

  pipeBridge.on('agent:status', (message) => {
    const status = typeof message.status === 'string' ? message.status.slice(0, 64) : 'unknown';
    lastAgentStatus = { status, updated_at: new Date().toISOString() };
    logger?.info(`Agent status received: ${status}`);
    sendDeviceStatus();
  });

  pipeBridge.on('agent:inventory', () => {
    logger?.info('Agent inventory snapshot received (Phase 0 keeps it in memory only)');
  });

  pipeBridge.on('agent:login', (message) => {
    handleUserLogin(message.grant).catch((err) => {
      logger?.warn(`Could not process the user sign-in: ${err.message}`);
    });
  });

  pipeBridge.on('bridge-error', () => {
    schedulePipeRetry();
  });

  try {
    pipeBridge.start();
  } catch (err) {
    logger?.error(`Could not start the agent bridge: ${err.message}`);
    schedulePipeRetry();
  }
}

/** A user signed in to the app: enroll this PC with their grant, or just report them. */
async function handleUserLogin(grant) {
  if (typeof grant !== 'string' || !grant || grant.length > 2000) return;
  if (isShuttingDown() || !identity) return;

  if (credentials?.deviceToken) {
    try {
      await reportUserLogin({ config, credentials, loginGrant: grant });
      logger?.info('User sign-in reported');
      return;
    } catch (err) {
      // Only a rejected device token falls through; a bad grant stops here.
      if (err.status !== 401) throw err;
      logger?.warn('Device token was rejected at sign-in; re-enrolling');
    }
  }

  credentials = await enrollDevice({ config, identity, logger, loginGrant: grant });
  credentialRetryTimer = stopTimer(credentialRetryTimer);
  if (wsClient) wsClient.restart('enrolled-at-login');
  else createWsClient();
}

async function runAuthenticatedTask(task) {
  if (!credentials?.deviceToken) throw new Error('No device credentials are loaded');

  try {
    if (task === 'heartbeat') {
      await sendHeartbeat({ config, credentials, logger });
      await policyManager?.syncFromServer();
      return;
    }
    if (task === 'inventory') {
      await sendInventory({ config, credentials, logger });
      return;
    }
    throw new Error(`Unknown authenticated task: ${task}`);
  } catch (err) {
    if (err.status === 401) {
      await handleAuthFailure(`${task}_unauthorized`);
      return;
    }
    throw err;
  }
}

function handleAuthFailure(reason) {
  if (isShuttingDown()) return Promise.resolve();
  if (authRecovery) return authRecovery;

  authRecovery = (async () => {
    try {
      logger?.warn(`Device authentication failed (${reason}); refreshing credentials`);
      credentials = await recoverCredentials({
        config,
        identity,
        logger,
        reason
      });
      logger?.info(`Device credentials restored (device_id=${credentials.deviceId})`);

      if (isShuttingDown()) return;

      if (wsClient) {
        wsClient.restart('credentials-restored');
      } else {
        createWsClient();
      }
    } catch (err) {
      logger?.error(`Could not restore device credentials: ${err.message}`);
      if (wsClient) {
        wsClient.stop();
        wsClient = null;
      }
      scheduleCredentialRetry();
    } finally {
      authRecovery = null;
    }
  })();

  return authRecovery;
}

function createWsClient() {
  if (isShuttingDown() || wsClient) return;

  wsClient = new DeviceWsClient({
    url: config.wsUrl,
    logger,
    getToken: () => credentials?.deviceToken || null,
    getStatus: getDeviceStatus,
    onHeartbeat: () => runAuthenticatedTask('heartbeat'),
    onInventory: () => runAuthenticatedTask('inventory'),
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    inventoryIntervalMs: config.inventoryIntervalMs,
    reconnectBaseMs: config.reconnectBaseMs,
    reconnectMaxMs: config.reconnectMaxMs
  });

  wsClient.on('connected', () => {
    logger?.info('Device WebSocket authenticated; DEVICE_STATUS sent');
  });

  wsClient.on('disconnected', ({ code }) => {
    logger?.warn(`Device WebSocket disconnected (code ${code})`);
  });

  wsClient.on('auth-expired', ({ reason }) => {
    handleAuthFailure(reason);
  });

  wsClient.on('device-command', ({ commandId, type }) => {
    logger?.info(`Device command ${commandId ?? '(no id)'} (${type || 'unknown'}) received for execution`);
  });

  wsClient.on('remote-control-start', ({ sessionId, commandId, adminId, reason }) => {
    remoteControlState = {
      active: true,
      session_id: sessionId || null,
      admin_id: adminId || null,
      started_at: new Date().toISOString(),
      reason: reason || null
    };
    logger?.info(`Remote control session started (session=${sessionId ?? '(none)'})`);
    if (pipeBridge) {
      try {
        pipeBridge.sendToAgent({
          type: 'REMOTE_CONTROL_START',
          sessionId,
          commandId,
          adminId,
          reason: reason || null
        });
      } catch (err) {
        logger?.warn(`Could not forward remote-control start to agent: ${err.message}`);
      }
    }
    sendDeviceStatus();
  });

  wsClient.on('remote-control-stop', ({ commandId, adminId }) => {
    remoteControlState = { active: false, session_id: null, admin_id: null, started_at: null };
    logger?.info('Remote control session stopped');
    if (pipeBridge) {
      try {
        pipeBridge.sendToAgent({ type: 'REMOTE_CONTROL_STOP', commandId, adminId });
      } catch (err) {
        logger?.warn(`Could not forward remote-control stop to agent: ${err.message}`);
      }
    }
    sendDeviceStatus();
  });

  wsClient.on('task-error', ({ task, message, status }) => {
    logger?.warn(`${task} failed${status ? ` (HTTP ${status})` : ''}: ${message}`);
  });

  wsClient._commandExecutor = (type, payload, commandId) =>
    executeDeviceCommand(type, payload, {
      commandId,
      config,
      logger,
      getCredentials: () => credentials
    });

  wsClient.start();
}

async function obtainCredentialsAndConnect() {
  if (isShuttingDown()) return;

  try {
    credentials = await ensureCredentials({ config, identity, logger });
    credentialRetryTimer = stopTimer(credentialRetryTimer);
    logger?.info(
      `Device credentials ready (device_id=${credentials.deviceId}, expires_at=${
        credentials.expiresAt ? new Date(credentials.expiresAt).toISOString() : 'unknown'
      })`
    );

    if (shuttingDownFlag.value) return;
    if (wsClient) wsClient.restart('credentials-loaded');
    else createWsClient();
  } catch (err) {
    // Waiting for a sign-in is the normal first state, not an error.
    if (err instanceof EnrollmentUnavailableError) logger?.info(err.message);
    else logger?.error(`Device enrollment is not ready: ${err.message}`);
    scheduleCredentialRetry();
  }
}

async function shutdown(signal, exitCode = 0) {
  if (isShuttingDown()) return;
  shuttingDownFlag.value = true;
  logger?.info(`Shutting down (${signal})`);

  credentialRetryTimer = stopTimer(credentialRetryTimer);
  pipeRetryTimer = stopTimer(pipeRetryTimer);

  if (wsClient) {
    wsClient.stop();
    wsClient = null;
  }

  if (pipeBridge) {
    pipeBridge.close();
    pipeBridge = null;
  }

  logger?.info('Shutdown complete');
  process.exitCode = exitCode;

  setTimeout(() => process.exit(exitCode), 100);
}

function installProcessHandlers() {
  process.on('SIGINT', () => { shutdown('SIGINT'); });
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });

  process.on('uncaughtException', (err) => {
    logger?.error(`Uncaught exception: ${err.stack || err.message}`);
    shutdown('uncaughtException', 1);
  });

  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
    logger?.error(`Unhandled rejection: ${message}`);
    shutdown('unhandledRejection', 1);
  });
}

/** If the service host is killed, exit too: Windows restarts it, and a leftover copy would fight the new one. */
function exitWithParent() {
  if (consoleMode) return;
  const parent = process.ppid;
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch (err) {
      if (err.code === 'ESRCH') shutdown('parent exited');
    }
  }, 5_000).unref();
}

function main() {
  exitWithParent();

  try {
    config = loadConfig();
  } catch (err) {
    logger = createLogger({
      logDir: defaultPaths.logsDir,
      console: consoleMode,
      level: 'error'
    });
    logger.error(`Invalid configuration: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  logger = createLogger({
    logDir: config.paths.logsDir,
    console: consoleMode,
    level: config.logLevel
  });

  policyManager = new PolicyManager({
    config,
    logger,
    getCredentials: () => credentials
  });

  installProcessHandlers();

  logger.info(
    `Starting ${config.serviceDisplayName} v${config.agentVersion} in ${consoleMode ? 'console' : 'service'} mode`
  );
  logger.info(`API base: ${config.apiBase}`);
  logger.info(`Data directory: ${config.paths.dataDir}`);
  logger.info(`Agent bridge: ${config.pipePath}`);
  logger.info(`Log file: ${logger.logFile || '(console only)'}`);

  if (config.configFileError) {
    logger.warn(`Configuration problem: ${config.configFileError}`);
  }

  try {
    ensureRuntimeDirectories(config);
  } catch (err) {
    logger.error(`Could not prepare runtime directories: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  try {
    identity = getOrCreateIdentity({ logger });
  } catch (err) {
    logger.error(`Could not load the device identity: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const cachedCredentials = loadCredentials({ logger });
  if (cachedCredentials) credentials = cachedCredentials;

  logger.info(
    `Identity loaded (hostname=${identity.hostname}, machine_guid=${
      identity.machine_guid ? 'present' : 'unavailable'
    }, secret_storage=${secretStorageMode()})`
  );

  startNamedPipe();
  obtainCredentialsAndConnect();
}

main();
