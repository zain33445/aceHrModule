# aceHRM — Agent Guide

## Repository structure

```
frontend/               React + Vite + Electron app
nodejs-backend/         Express.js + TypeScript + Prisma API server
python-microservice/    Flask service for ZKTeco biometric device sync
```

No CI workflows, no tests (root `npm test` is stub).

## Entrypoints

| Package | Dev command | Production | Entry file |
|---|---|---|---|
| `nodejs-backend/` | `npm run dev` (nodemon + ts-node) | `npm start` (`node dist/index.js`) | `src/index.ts` |
| `frontend/` | `npm run dev` (Vite, port 5173) | `npm run dist` (build + electron-builder) | `src/main.jsx` (React), `main.js` (Electron) |
| `python-microservice/` | `.\venv\Scripts\python.exe fetcher.py` or `start_fetcher.bat` | same | `fetcher.py` |

## Environment

**Backend** (`nodejs-backend/.env`): `DATABASE_URL` (PostgreSQL), `PORT` (5000), `JWT_SECRET`, `NODE_ENV`.

**Frontend** (`frontend/.env`): `VITE_API_BASE` defaults to `http://localhost:5000/api`. Production override: `.env.production` → `https://api.theaceservices.site/api`.

**Python** (`fetcher.py`): Hardcoded ZKTeco device IP `192.168.18.101:4370`, webhook URL `http://localhost:5000/api/webhooks/attendance`.

## Database (Prisma + PostgreSQL)

- Schema: `nodejs-backend/prisma/schema.prisma` — all tables use `@@map` (snake_case in DB, PascalCase in Prisma).
- Migrations: `nodejs-backend/prisma/migrations/`.
- Seed: `npx prisma db seed` (runs `ts-node ./src/seed.ts`).
- Commands: `npx prisma generate`, `npx prisma migrate dev`.

## API conventions

- Express v5 (route param syntax `:id` still works, but middleware API differs from v4).
- Port 5000. Body limit: `50mb` for JSON/urlencoded; raw binary uploads at `POST /api/recording/chunk`.
- Recording routes require admin header `X-Admin-Id` or agent Bearer JWT.
- Leave request statuses are **uppercase Prisma enums**: `PENDING`, `APPROVED`, `REJECTED`, `CANCELLED`.
- Audit logging auto-creates records for `POST/PUT/DELETE` (excludes `/auth/login`, `/webhooks`).

## In-process cron jobs (server `src/index.ts`)

- **5-min**: Absence processing (Karachi timezone via `toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" })`).
- **8-hour**: Holiday processing.
- **Hourly**: Monitoring log cleanup (3-day retention).
- **10-sec**: Outbox event processing.
- **5-min**: Stuck event recovery.

## Pricing / leave logic

- Salary: `daily_rate = monthly_salary / 30` — deductions are `unpaid_absences × daily_rate`.
- Leaves tracked via `leave_bank.leaves_remaining` (remaining balance) and `users.leave_bank` (static cap).
- Attendance processing compares check-in/check-out against shift `latetiming` and `halfday` thresholds (HH:MM format).

## Frontend conventions

- JSX only (no TypeScript). Tailwind CSS v4 (PostCSS plugin). Vite with React plugin.
- Electron main process: `main.js`, preload: `electron/preload.js`.
- Recording state exposed to renderer via `window.electronAPI.recording`.

## Python microservice quirks

- Flask on port 8000, venv-required (`venv/Scripts/python.exe`).
- Background thread polls ZKTeco device every 300s, posts attendance logs to Node.js webhook.
- Device clock assumed 6 days ahead; `corrected_time = log.timestamp` (no offset subtraction despite comment).
- `/create-user` and `/sync-users` endpoints connect to ZK device directly.

## New system: Screen Recording & Monitoring

- Electron agent (frontend) connects via WebSocket gateway (`nodejs-backend/src/gateways/recording.gateway.ts`).
- Admin starts/stop sessions via REST; agent streams chunks as raw binary (`Content-Type: application/octet-stream`).
- Session assembly produces WebM files on server disk.
- Desktop monitoring logs app names + optional screenshots (3-day retention).

## New system: Voice & Video Calling

- **Mesh topology** (no SFU). Max **4 participants** per call; each participant holds N-1 `RTCPeerConnection`s.
- Signalling: `nodejs-backend/src/gateways/call.gateway.ts` on `/call-ws`. The server owns the participant list and assigns a `peer_id` per participant — it never touches media.
- **Critical**: `recording.gateway.ts` destroys unknown upgrade paths. A `/call-ws` yield branch must exist in it or the call socket is killed. Covered by `npm run test-call-ws`.
- Auth: `requireUser` (`src/middleware/requireUser.ts`) verifies a signed JWT. `POST /api/auth/login` returns a `token` alongside the legacy fields. The call routes do **not** accept the unsigned `X-User-Id` trust model.
- TURN: `src/services/turn.service.ts` mints short-lived HMAC credentials. Configure `TURN_URLS` + `TURN_SHARED_SECRET` in `nodejs-backend/.env` — without them calls only work on the office LAN.
- Frontend: `src/context/CallContext.jsx` (shared state), `src/lib/callMesh.js` (WebRTC, perfect negotiation), `src/components/calls/` (overlay + history). The floating Electron chat window deliberately does **not** open a call socket; its 1:1 Call button delegates the request over IPC (`call:start`) to the main window, which owns the call.
- Chat integration: `src/components/chat/ChatHub.jsx` shows a Call button in the thread header next to the conversation name (1:1 first; group calls also supported in the main window).
- Recording: audio-only, **starts automatically when the call is answered**, with a visible in-call indicator (no per-call consent prompt; participants can stop it and the host can restart it). Each participant records its own mix; the server mixes on playback. 90-day retention.
- Screen sharing is 1:1 only in v1.

## Useful scripts

| Command | Location | Description |
|---|---|---|
| `npm run lint` | `frontend/` | ESLint check (JS/JSX only) |
| `npm run build` | `frontend/` | Vite build → `dist_build/` |
| `npm run dev` | `frontend/` | Vite dev server on http://localhost:5173 |
| `npm run dev:lan` | `frontend/` | Vite on https://0.0.0.0:5173 (LAN access, see below) |
| `npm run build` | `nodejs-backend/` | `tsc` → `dist/` |
| `npm run test-absence` | `nodejs-backend/` | Test absence processing logic |
| `npm run test-call-ws` | `nodejs-backend/` | Test call gateway upgrade routing (no DB needed) |
| `npm run test-call-e2e` | `nodejs-backend/` | Live call test against a running server + DB (66 checks) |
| `python test_call_browser.py` | `nodejs-backend/` | Two-browser WebRTC call test (needs the Playwright venv + vite) |
| `python test_call_recording.py` | `nodejs-backend/` | Browser test for the recording pipeline |
| `python test_electron_call.py` | `nodejs-backend/` | Electron agent test (needs Electron started with `--remote-debugging-port=9222`) |
| `npm run electron` | `frontend/` | Launch Electron wrapper |
| `npm run dist` | `frontend/` | Vite build + electron-builder → `release_build/` |

## Dev server, LAN access and media

- **Camera/microphone require a secure origin.** `http://localhost` counts as
  secure; a LAN address such as `http://192.168.18.65:5173` does **not**, and
  Chrome then does not expose `navigator.mediaDevices` at all — the call
  connects but carries no audio and no video. Use `npm run dev:lan`, which
  serves HTTPS with a self-signed certificate (accept the browser warning
  once). The app now says this explicitly instead of failing silently.
- The dev server proxies `/api` and the WebSocket gateways to the backend, so
  the browser only ever talks to its own origin (a secure page may not call a
  plain-HTTP API). `frontend/src/services/endpoints.js` picks the base:
  relative when `VITE_USE_PROXY=1`, absolute otherwise.
- The Electron **main** process talks to the backend directly and reads
  `VITE_API_BASE` itself (`frontend/electron/config.js`).
- `ACEHRM_USER_DATA` points Electron at a different profile, so a dev build
  can run alongside an installed copy (they otherwise fight over the
  single-instance lock and the `userData` folder).
- `ACEHRM_ENABLE_TEST_HOOKS=1` enables the `call:simulate-action` IPC channel
  used by the automated Electron test. It is absent in normal builds.

## Project-wide traps (these have already caused bugs)

- **Tailwind spacing is overridden.** `src/index.css` redefines `--spacing-md: 1rem`,
  `--spacing-sm: 0.5rem`, etc. So `max-w-md` resolves to **16px**, not 28rem, and
  `max-w-sm` to 8px. Use explicit arbitrary values (`max-w-[28rem]`) for any
  max-width you care about. The same applies to `min-w-*` / `max-h-*`.
- **The migration chain does not apply to a fresh database.**
  `20260317174933_add_deduction_table` references `disputes.category`, which is
  only added by a later migration, so `prisma migrate deploy` fails on an empty
  database. Existing databases were created with `prisma db push`. Also note
  `prisma db push` wants to drop `users.leave_bank` (present in the DB, missing
  from the schema) — do not let it.

