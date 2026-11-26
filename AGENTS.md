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
- Leaves are ledger-driven: `leave_ledger` is the source of truth, and `leave_bank.leaves_remaining` is a cache maintained by the `leave_ledger_apply_balance` DB trigger (`src/db/ensure-leave-ledger-trigger.ts`). Never write `leaves_remaining` directly — insert a ledger row (`ACCRUAL`, `CONSUMPTION`, `RESERVED`, `REVERSAL`, `ADJUSTMENT`). The trigger is ensured at boot and reconciles once via `OPENING-BALANCE-*` rows (marker `leave_ledger_trigger_v1` in `app_settings`). Pending `RESERVED` holds reduce the available balance. `users.leave_bank` is the static cap.
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

- **Spec and agent↔server contract: `docs/recording-v2.md`.** Hard rule: a recorded chunk is never lost, refused or overwritten.
- v2 (agent ≥ 1.12, WS `protocol: 2`): recording is always-on and agent-driven. One session per user per *shift-based* recording day (`recording-day.ts`), segments = MediaRecorder runs, chunks `(segment_id, seq)` with sha256. Final file = generations (`recording-g<N>.webm`), chunks purged only after a verified generation commit.
- v1 (agents ≤ 1.11.x): legacy `POST /api/recording/chunk` + START/STOP flow, still supported; legacy sessions have `recording_date = NULL`.
- **Schema**: `ensureRecordingSchema()` runs the idempotent, additive `prisma/migrations/20261110000000_recording_v2/migration.sql` at backend start (never `db push`). Deploys must ship that file and run `npx prisma generate` before building. `.gitignore` ignores `*.sql` except migrations.
- **Assembly queue**: `pumpAssemblies()` (sweep + every run end) starts due sessions, fewest `assembly_attempts` first; failures set `assembly_next_at` (backoff). A segment ffmpeg cannot use becomes state `unreadable` (+`problem`), its chunks stay on disk unpurged and the rest of the day still assembles; chunk files are deleted only for segments fully covered by the committed video (coverage tolerance max(15 s, 1 %)). certain ffmpeg infrastructure failures (missing binary, killed, no disk) throw so the session backs off and never flag a segment; ambiguous texts (`Input/output error`, `Cannot allocate memory`, `Permission denied`) throw for the first 3 attempts, then become that segment's `unreadable` problem. See `docs/recording-v2.md` §7.
- **Kept files, late chunks, parts (stage 2)**: `purged_at` means "in the video", not "file gone". Chunk files are deleted only when `keptFilesDeletable` allows it: segment `assembled`, no `problem`, every row purged, and the agent closed it (`agent_closed_at`) with every seq stored or lost, or nobody closed it for 16 days. A late chunk for an assembled segment rebuilds the whole segment from the kept files (it has a part of its own), else it is a tail that borrows a header (`recording_segments.init_data` = stream bytes before the first Cluster, built from chunks 0, 1, 2… because seq 0 can be 1 byte; else a donor segment of the same size/mime, same user first, then any user); a grafted tail keeps its files. A rebuild never replaces its old parts with less video (duration/packets check, else the late chunks go in alone). A session is due when idle >= 30 min, or its day is over AND the last chunk is >= 5 min old (no rebuild per chunk of a backlog upload). The day is rebuilt copy-only from `parts/` in start-time order (`recording_sessions.parts` manifest); parts collapse into the generation after `RECORDING_PARTS_KEEP_DAYS` (4) or below `RECORDING_PARTS_MIN_FREE_GB` (20) free; the sweep (30 min) removes unreferenced parts older than 1 h. Reference size = the size with the most video. `/sessions` never returns `parts`. Tests run in-process with `RECORDING_PARTS_MIN_FREE_GB=0` (set it for the server too).
- Access: `requireRecordingAccess` = admin/superadmin or a `user_tab_access` grant for `recording`. Agent tokens via `/recording/agent-auth` need the user's session token.
- Local agent spool: `<userData>/recordings/v2/<userId>/<segmentId>/` (15 days / 30 GB cap, unsynced data never deleted). Recording pauses below 2 GB free disk (`disk_low`, shown as "Low disk" in the live grid).
- Live view (Phase 4): `src/gateways/live-hub.ts` — presence, one WebRTC stream per (viewer, agent), agent is the offerer, max 4 viewers per agent (`LIVE_MAX_VIEWERS_PER_AGENT`). Agent side runs in its own hidden window (`electron/live-main.js`, `electron/live-renderer/`), separate from the recorder. Remote admins need TURN on the main server: `docs/live-view-turn.md`.
- Admin/HR UI (Phase 5): `RecordingTab` = Live grid (4×4, pages of 16) | Recordings by day (signed playback URL `?pt=`) | Settings (retention, admins only).
- Desktop monitoring logs app names + optional screenshots (3-day retention).

## New system: Voice & Video Calling

- **Mesh topology** (no SFU). Max **4 participants** per call; each participant holds N-1 `RTCPeerConnection`s.
- Signalling: `nodejs-backend/src/gateways/call.gateway.ts` on `/call-ws`. The server owns the participant list and assigns a `peer_id` per participant — it never touches media.
- **Critical**: `recording.gateway.ts` destroys unknown upgrade paths. A `/call-ws` yield branch must exist in it or the call socket is killed. Covered by `npm run test-call-ws`.
| `npm run test-device-ws` | `nodejs-backend/` | Test device/admin WebSocket routing and tokens (no DB) |
| `npm run test-device-e2e` | `nodejs-backend/` | Live device REST/WS test; use an isolated DB |
| `npm run check` | `windows-service/` | Syntax-check all Windows service files |
| `npm run test-policy` | `windows-service/` | Offline policy decision self-check (no PowerShell) |
| `npm run test-software` | `windows-service/` | Offline software install self-check (runs no installers) |
| `npm run test-sandbox` | `windows-service/` | Live test in Windows Sandbox as SYSTEM (policy PowerShell, signer trust, service install/uninstall); needs `wsb` and a fresh `dist-service/` (`npm run build-payload`) |
| `npm run test-ws-client` | `windows-service/` | Device socket handshake check against a local fake gateway (the real client, which the e2e test does not use) |
| `npm run build-payload` | `windows-service/` | Stage `dist-service/` (node.exe, src, node_modules, install/uninstall .cmd) for the Windows installer; Windows only |
| `npm run test-install` | `windows-service/` | Offline install helper self-check (registers nothing) |
- Auth: `requireUser` (`src/middleware/requireUser.ts`) verifies a signed JWT. `POST /api/auth/login` returns a `token` alongside the legacy fields. The call routes do **not** accept the unsigned `X-User-Id` trust model.
- TURN: `src/services/turn.service.ts` mints short-lived HMAC credentials. Configure `TURN_URLS` + `TURN_SHARED_SECRET` in `nodejs-backend/.env` — without them calls only work on the office LAN.
- Frontend: `src/context/CallContext.jsx` (shared state), `src/lib/callMesh.js` (WebRTC, perfect negotiation), `src/components/calls/` (overlay + history). The floating Electron chat window deliberately does **not** open a call socket; its 1:1 Call button delegates the request over IPC (`call:start`) to the main window, which owns the call.
- Chat integration: `src/components/chat/ChatHub.jsx` shows a Call button in the thread header next to the conversation name (1:1 first; group calls also supported in the main window).
- Recording: audio-only, **starts automatically when the call is answered**, with a visible in-call indicator (no per-call consent prompt; participants can stop it and the host can restart it). Each participant records its own mix; the server mixes on playback. 90-day retention.
- Screen sharing is 1:1 only in v1.

## New system: Device Control (Phases 1–2)

- Windows service (`windows-service/`) is separate from the Electron agent and is installed by the Windows NSIS installer: `npm run dist` builds the payload first via `windows-service` `npm run build-payload` (`dist-service/`, bundled as `extraResources` under `build.win`). It runs as LocalSystem when installed, owns device identity, and connects to `/device-ws`.
- The renderer re-requests a login grant whenever the device pipe connects (`device:pipe-connected`), because grants expire in 5 minutes and the service may start after sign-in.
- **Enrollment is login-based.** After sign-in the app gets a signed 5-minute grant from `POST /api/device/login-grant` and sends it over the pipe as `agent:login`. The service enrolls with it (`assigned_user_id` + `last_user_id`) or, once enrolled, reports it to `POST /api/device/user-login` (`last_user_id` only). Admin enrollment tokens remain optional. The pipe is writable by all local users, so never act on pipe input without backend verification, and never let the app change the service's `apiBase`.
- Admin APIs: `/api/devices` (list/detail/PATCH group), `/api/devices/groups` (CRUD + counts), `/api/devices/enrollment-tokens`, `/api/devices/audit`, `/api/devices/admin-ws-token`; admin sockets use `/device-admin-ws` with a short-lived signed ticket.
- Device routes use `requireUser` + `requireRole` (signed JWT), not the legacy unsigned `X-Admin-Id` model. Production requires `JWT_SECRET`, `AGENT_JWT_SECRET`, and `DEVICE_JWT_SECRET`.
- **Critical**: `recording.gateway.ts` destroys unknown WebSocket upgrade paths. `/device-ws` and `/device-admin-ws` must stay yielded there. Covered by `npm run test-device-ws`.
- Device commands are acknowledged with `DEVICE_COMMAND_ACK`; the gateway also accepts legacy `ACK`. Remote screen/input control is deliberately not implemented.
- Phase 3: the Windows service now executes `lock`, `restart`, and `shutdown` commands locally and acknowledges them as `completed`/`failed` (see `windows-service/src/commands.js`). Remote screen/input control remains Phase 4.

## New system: Device Control (Phase 4) — remote control (in progress)

- Windows service handles `REMOTE_CONTROL_START`/`REMOTE_CONTROL_STOP` from the backend, forwards them to the connected Electron agent over the named pipe, and acknowledges the underlying command. Screen capture/input injection on the agent side is the remaining piece; the Electron agent now connects to the named pipe and reports `screen_capture` capability.
- Backend already provides remote-control sessions + WebRTC signalling (`WEBRTC_OFFER/ANSWER/ICE_CANDIDATE`) over `/device-ws` and `/device-admin-ws`.
- Frontend DevicesTab marks remote control as available in Phase 4.
- Inventory includes hardware, OS build/arch, volumes, adapters, and up to 300 installed apps. Group changes and assignments are audited.
- `npm run test-device-e2e` is a live test and writes to its configured database. Use an isolated database, never the real `ace_attendance` DB, because server cron jobs also run.
- Group names are unique; deleting a group sets member `group_id` to null. `PATCH /api/devices/:id` currently accepts `group_id`.
- Phase 2 adds `security_baseline` policies. Admin routes: `/api/devices/policies` (CRUD), `/policies/:id/assignments` (group or device), `/policies/:id/statuses`; agent routes are `/api/device/policy` and `/api/device/policy/status`.
- Effective policy: only `active` policies; lowest `priority` wins; a device assignment beats a group assignment at the same priority. Config is normalized server-side before storage/delivery and hashed for the agent.
- `device_policy_statuses` is written up only per `[device_id, policy_id]`. The `20261028_device_policy_status` migration was applied manually and marked with `prisma migrate resolve`; do not run `prisma migrate dev` because of pre-existing `users.leave_bank` drift.
- Windows `src/policy.js` fetches `/device/policy` after each heartbeat, evaluates read-only PowerShell state, applies in `enforce` mode, and reports back. Enforcement needs LocalSystem/TPM; validate on a disposable Windows VM, not the dev machine.
- Policy enforcement rechecks every 15 minutes and re-applies drift. Original values are kept in `state/policy-ledger.json`: a setting turned off in an `enforce` policy, or every setting when the device has no policy, is restored. `audit` mode changes nothing. BitLocker is never reverted.
- A setting whose original value cannot be read is not enforced (and not recorded) until it can be, so the ledger never stores enforced values as originals.
- BitLocker: the service creates a recovery password protector and uploads it to `POST /api/device/recovery-key` **before** encrypting; a failed upload blocks encryption. Keys are AES-256-GCM encrypted in `device_recovery_keys` with `DEVICE_RECOVERY_KEY_SECRET` (required in production; losing it makes stored keys unreadable). Admins read them at `GET /api/devices/:id/recovery-keys`, which is audited. The request audit middleware must keep skipping `/device/recovery-key` because it stores request bodies.
- Restrictions in `security_baseline` (all off by default): `local_admin.remove_other_admins` + `allowed_admins`, `web_filter.blocked_domains` (Chrome, Edge, Brave, Firefox policy keys), `software_install` (Windows Installer `DisableMSI=2`, `DisableUserInstalls=1`; `DisableMSI=1` would not stop admins. It blocks everyone, including `.msi`-based app updates, and the service lifts it only during console-pushed installs. Does not stop `.exe` installers), `software_watch.flagged_names` (report only). `adminPlan` in `policy.js` refuses to remove anyone unless an approved account stays a usable admin; never weaken that guard. `firewall_notifications` (GPO `DisableNotifications=1` on the Domain/Standard(=Private)/Public `WindowsFirewall` profile keys: the "firewall has blocked this app" prompts are hidden, blocked apps stay blocked).
- Software deployment: admins upload `.msi`/`.exe` to `/api/devices/software` (stored in `uploads/device-software/`, 2 GB cap) and queue `software_install` commands. The service downloads only while it has a pending command, verifies SHA-256, runs without a shell from its private state folder, one at a time, never restarts the PC, and deletes the file. The result also goes to `POST /api/device/commands/:id/result` because sockets can drop during long installs. Covered by `npm run test-software` in `windows-service/`. Before running, the service adds a validly signed installer's signer to `LocalMachine\TrustedPublisher` (best-effort, left in place) so drivers from that publisher install without a prompt; drivers signed by a different publisher may still prompt.
- UAC prompts are deliberately NOT suppressed. Pushed installs run as SYSTEM and never need UAC; a prompt means the installer starts something on the user's desktop. Fix it with the vendor's silent/MSI options (e.g. Tailscale MSI `TS_NOLAUNCH=1`).
- The HTTP heartbeat must not claim queued commands: the service only runs commands from its socket, so a claimed command would be lost.
- `src/install.js` registers the service directly with the bundled `winsw.exe`. Do not go back to `node-windows` `Service.install()`: its elevation helper hangs with no desktop to answer it (logon scripts, SYSTEM, deployment tools). The service name is exactly `aceHRMDeviceService`. There is no wrapper process: Windows restarts on failure, and `service.js` exits if its parent dies so no second copy is left running. `install.js uninstall` stops the service and restores the policy ledger before removing it. Requiring `install.js` must stay side-effect free.
- **Installer traps** (`frontend/build/`): `electron-builder` always drops a `node_modules` at the root of an `extraResources` `from`, so it needs its own entry (see `SERVICE-INSTALL.md`). Its uninstaller kills every process under the install folder, which makes Windows restart the service mid-removal, so `installer.nsh` removes the service first in `customCheckAppRunning`.
- The `lock` command runs through a throwaway task as the interactive user and confirms `LogonUI` appeared: `LockWorkStation` from SYSTEM does nothing but still succeeds.
- **Registry trap**: `New-Item -Force` on an existing registry key wipes its values and subkeys. Use `Ensure-RegKey` in `policy.js`. Covered by `npm run test-policy` in `windows-service/`.
- Phase 1/2 live coverage: `npm run test-device-e2e` is now 41 checks (groups, inventory, policies, assignments, status, commands, audit, disabled-device paths).

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
| `npm run test-chat-groups-e2e` | `nodejs-backend/` | Live custom chat groups test (create/add/remove/leave, WS events, privacy) against a running server + DB; `API_BASE` overrides the URL |
| `npm run test-recording-assembly` | `nodejs-backend/` | Recording assembly (run splitting + ffmpeg join) and a header graft onto a MediaRecorder-like tail (VP9, live, 1 s clusters, cut at arbitrary bytes, 1-byte seq 0), no DB needed |
| `npm run test-recording-queue` | `nodejs-backend/` | Assembly queue order, backoff, starvation simulation, coverage tolerance, join/packet verification, infrastructure-failure rule, the ffmpeg timeout and the stage 2 helpers (init bytes at every split offset, kept-file rule, reference size, manifest, due rule, rebuild-keeps-video rule) (94 checks), no DB needed |
| `npm run test-recording-e2e` | `nodejs-backend/` | Live screen-recording test against a running server + DB (45 checks). Start the server with `RECORDINGS_DIR` set to a scratch folder |
| `npm run test-recording-v2-e2e` | `nodejs-backend/` | Live recording v2 test (146 checks); run with the server's `RECORDINGS_DIR` |
| `npm run test-recording-day` | `nodejs-backend/` | Shift-based recording-day rule, no DB needed |
| `npm run test-recording-live-e2e` | `nodejs-backend/` | Live view hub test (81 checks): presence, streams, caps, HR access, playback tokens |
| `npm run repair-recordings` | `nodejs-backend/` | One-off repair of stuck v2 sessions: `-- --dry-run` (default) / `-- --apply --yes`, `--session <id>` / `--user <id>` limit it. Revives unreadable segments, adds missing chunk rows for chunk files on disk, reports collisions / missing generation files / videos shorter than recorded. Prints the database host and `RECORDINGS_DIR`; never deletes anything. The admin screen's Retry (`POST /api/recording/sessions/:id/retry-assembly`, admins only) does the revive for one day |
| `npm run test-recording-edge-e2e` | `nodejs-backend/` | Edge cases S1–S41 from `docs/recording-edge-cases.md` (S17–S41: bad media, late chunks, grafts, parts, order, size, crash safety, queue, join limits, retry, `/days` problem fields, repair script; start the server ~40 s before it, the server's own sweeper also assembles old test days); run with the server's `RECORDINGS_DIR` and `RECORDING_PARTS_MIN_FREE_GB=0` for both |
| `node electron/<name>.check.mjs` | `frontend/` | Agent edge cases A1–A14: `spool-reliability`, `sync-v2`, `token-store`, `agent-policy`, `live-registry` |
| `node electron/local-retention.check.mjs` | `frontend/` | Local chunk retention never deletes un-uploaded chunks |
| `node electron/recording-day.check.mjs` / `spool-v2.check.mjs` | `frontend/` | Agent day rule, spool and v2 retention checks |
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

