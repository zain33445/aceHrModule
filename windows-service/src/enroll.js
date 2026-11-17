'use strict';

const { requestJson } = require('./http');
const { loadCredentials, saveCredentials } = require('./identity');

class EnrollmentUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EnrollmentUnavailableError';
  }
}

function expiresAtFromResponse(payload) {
  const expiresIn = Number(payload?.expires_in);
  const seconds = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3_600;
  return Date.now() + seconds * 1_000;
}

function enrollmentPayload(config, identity, loginGrant) {
  return {
    ...(loginGrant ? { login_grant: loginGrant } : { token: config.enrollmentToken }),
    device_key: identity.device_key,
    hostname: identity.hostname,
    machine_guid: identity.machine_guid || null,
    os_name: identity.os_name,
    os_version: identity.os_version,
    agent_version: config.agentVersion
  };
}

async function enrollDevice(options) {
  const { config, identity, logger, loginGrant } = options;

  if (!loginGrant && !config.enrollmentToken) {
    throw new EnrollmentUnavailableError('Waiting for a user to sign in to aceHRM on this PC.');
  }

  logger?.info(`Enrolling ${identity.hostname} with ${config.apiBase}`);

  const payload = await requestJson(`${config.apiBase}/device/enroll`, {
    method: 'POST',
    body: enrollmentPayload(config, identity, loginGrant),
    timeoutMs: config.httpTimeoutMs
  });

  if (!payload?.device_id || typeof payload.device_token !== 'string' || !payload.device_token) {
    throw new Error('Enrollment response did not include device_id and device_token');
  }

  const credentials = saveCredentials(
    {
      deviceId: payload.device_id,
      deviceToken: payload.device_token,
      expiresAt: expiresAtFromResponse(payload)
    },
    { logger }
  );

  logger?.info(`Enrollment succeeded (device_id=${payload.device_id})`);
  return credentials;
}

async function refreshDeviceToken(options) {
  const { config, credentials, logger } = options;

  if (!credentials?.deviceToken) {
    throw new EnrollmentUnavailableError('Cannot refresh a device token without stored credentials');
  }

  const payload = await requestJson(`${config.apiBase}/device/token/refresh`, {
    method: 'POST',
    token: credentials.deviceToken,
    body: {},
    timeoutMs: config.httpTimeoutMs
  });

  const deviceToken = payload?.device_token || payload?.token;
  if (typeof deviceToken !== 'string' || !deviceToken) {
    throw new Error('Token refresh response did not include a device token');
  }

  const next = saveCredentials(
    {
      deviceId: payload.device_id || credentials.deviceId,
      deviceToken,
      expiresAt: expiresAtFromResponse(payload)
    },
    { logger }
  );

  logger?.info(`Device token refreshed (device_id=${next.deviceId})`);
  return next;
}

async function ensureCredentials(options) {
  const { config, identity, logger, leewayMs = 300_000 } = options;
  const current = loadCredentials({ logger });

  if (current && current.expiresAt - Date.now() > leewayMs) {
    return current;
  }

  if (current) {
    try {
      return await refreshDeviceToken({ config, credentials: current, logger });
    } catch (err) {
      if (err.status === 401) {
        logger?.warn('Device token was rejected; attempting re-enrollment');
        if (config.enrollmentToken) return enrollDevice({ config, identity, logger });
        throw new EnrollmentUnavailableError(
          'Device token was rejected and no enrollment token is configured'
        );
      }

      if (current.expiresAt > Date.now()) {
        logger?.warn(`Token refresh failed; continuing with the current token: ${err.message}`);
        return current;
      }

      throw err;
    }
  }

  return enrollDevice({ config, identity, logger });
}

async function recoverCredentials(options) {
  const { config, identity, logger, reason } = options;
  const current = loadCredentials({ logger });

  if (current) {
    try {
      return await refreshDeviceToken({ config, credentials: current, logger });
    } catch (err) {
      if (err.status !== 401) throw err;
      logger?.warn(`Device token refresh was rejected (${reason}); re-enrolling`);
    }
  }

  if (!config.enrollmentToken) {
    throw new EnrollmentUnavailableError(
      'Device credentials are no longer valid and no enrollment token is configured'
    );
  }

  return enrollDevice({ config, identity, logger });
}

async function reportUserLogin(options) {
  const { config, credentials, loginGrant } = options;
  await requestJson(`${config.apiBase}/device/user-login`, {
    method: 'POST',
    token: credentials.deviceToken,
    body: { login_grant: loginGrant },
    timeoutMs: config.httpTimeoutMs
  });
}

async function sendHeartbeat(options) {
  const { config, credentials, logger } = options;

  if (!credentials?.deviceToken) {
    throw new EnrollmentUnavailableError('Cannot send a heartbeat without a device token');
  }

  const payload = await requestJson(`${config.apiBase}/device/heartbeat`, {
    method: 'POST',
    token: credentials.deviceToken,
    body: {},
    timeoutMs: config.httpTimeoutMs
  });

  logger?.debug(`Heartbeat acknowledged (device_id=${credentials.deviceId})`);
  return payload;
}

module.exports = {
  EnrollmentUnavailableError,
  enrollDevice,
  ensureCredentials,
  recoverCredentials,
  refreshDeviceToken,
  reportUserLogin,
  sendHeartbeat
};
