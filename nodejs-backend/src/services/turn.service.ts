/**
 * turn.service.ts — ICE server configuration + short-lived TURN credentials.
 *
 * STUN alone is enough for most home networks, but symmetric NAT (common on
 * corporate networks and some mobile carriers) will not produce a working
 * candidate pair without a TURN relay. A hosted TURN provider is therefore
 * required for reliable calling outside the office LAN.
 *
 * Credentials are minted in the standard "TURN REST API" format, which is
 * understood by coturn, Cloudflare Calls, and Metered alike:
 *
 *   username   = "<expiry-epoch-seconds>:<TURN_USERNAME>"
 *   credential = base64(HMAC-SHA1(TURN_SHARED_SECRET, username))
 *
 * Because the credential embeds an expiry, it can be handed to a browser
 * without the long-lived shared secret ever leaving the server.
 *
 * Configuration (nodejs-backend/.env):
 *   STUN_URLS=stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302
 *   TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
 *   TURN_USERNAME=acehrm
 *   TURN_SHARED_SECRET=<shared secret>   # ephemeral credentials (preferred)
 *   TURN_CREDENTIAL=<static credential>  # alternative: static credentials
 *   TURN_CREDENTIAL_TTL_SECONDS=3600
 */

import crypto from 'crypto';

function splitList(value: string | undefined): string[] {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const STUN_URLS = splitList(
  process.env.STUN_URLS || 'stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302'
);

const TURN_URLS = splitList(process.env.TURN_URLS || '');
const TURN_USERNAME = process.env.TURN_USERNAME || 'acehrm';
const TURN_SHARED_SECRET = process.env.TURN_SHARED_SECRET || '';
const TURN_STATIC_CREDENTIAL = process.env.TURN_CREDENTIAL || '';
const TURN_CREDENTIAL_TTL = Math.max(
  60,
  parseInt(process.env.TURN_CREDENTIAL_TTL_SECONDS || '3600', 10)
);

export interface IceServerResponse {
  iceServers: Array<Record<string, unknown>>;
  /** False when no TURN provider is configured — calls will only work on a LAN. */
  turnConfigured: boolean;
}

/** True when a TURN provider is available and credentials can be minted. */
export function isTurnConfigured(): boolean {
  return TURN_URLS.length > 0 && (!!TURN_SHARED_SECRET || !!TURN_STATIC_CREDENTIAL);
}

/**
 * Builds the `iceServers` array handed to `RTCPeerConnection`.
 *
 * When TURN is not configured this degrades to STUN-only rather than failing,
 * so development on the office LAN still works without any credentials.
 */
export function getIceServers(): IceServerResponse {
  const iceServers: Array<Record<string, unknown>> = [];

  if (STUN_URLS.length > 0) {
    iceServers.push({ urls: STUN_URLS });
  }

  if (TURN_URLS.length > 0 && TURN_SHARED_SECRET) {
    const expiresAt = Math.floor(Date.now() / 1000) + TURN_CREDENTIAL_TTL;
    const username = `${expiresAt}:${TURN_USERNAME}`;
    const credential = crypto
      .createHmac('sha1', TURN_SHARED_SECRET)
      .update(username)
      .digest('base64');

    iceServers.push({ urls: TURN_URLS, username, credential });
  } else if (TURN_URLS.length > 0 && TURN_STATIC_CREDENTIAL) {
    iceServers.push({
      urls: TURN_URLS,
      username: TURN_USERNAME,
      credential: TURN_STATIC_CREDENTIAL,
    });
  }

  return { iceServers, turnConfigured: isTurnConfigured() };
}
