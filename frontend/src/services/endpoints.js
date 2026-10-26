/**
 * endpoints.js — single source of truth for the backend addresses.
 *
 * The browser app and the Electron agent reach the backend in two different
 * ways:
 *
 *   - VITE_USE_PROXY=1 (development): the Vite dev server proxies /api and
 *     the WebSocket paths to the backend, so the browser only ever talks to
 *     its own origin. This matters when the dev server is served over HTTPS
 *     (required for camera/microphone on a LAN address) because a secure
 *     page may not call a plain-HTTP API.
 *
 *   - Otherwise: the absolute address from VITE_API_BASE is used directly.
 *
 * The Electron *main* process does not use this module — it talks to the
 * backend directly and reads VITE_API_BASE itself (see electron/config.js).
 */

const rawBase = import.meta.env.VITE_API_BASE || 'http://localhost:5000/api';

// The proxy only exists on the Vite dev server. Never take this branch in a
// production build: the packaged renderer is loaded from `file://`, so a
// relative `/api` would resolve to `file:///C:/api`.
export const USE_PROXY =
  import.meta.env.DEV && import.meta.env.VITE_USE_PROXY === '1';

/** Base for REST calls. Relative when the dev server proxies the API. */
export const API_BASE = USE_PROXY ? '/api' : rawBase;

/**
 * Base for WebSocket connections.
 *
 * Empty when the dev server proxies the gateways, which makes the socket
 * URLs relative and therefore same-origin — required on an HTTPS page, where
 * the browser refuses to open an insecure `ws://` connection.
 */
export const WS_BASE = USE_PROXY
  ? ''
  : rawBase.replace(/^http/, 'ws').replace(/\/api\/?$/, '');

export default API_BASE;
