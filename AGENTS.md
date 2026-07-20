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

## Useful scripts

| Command | Location | Description |
|---|---|---|
| `npm run lint` | `frontend/` | ESLint check (JS/JSX only) |
| `npm run build` | `frontend/` | Vite build → `dist_build/` |
| `npm run build` | `nodejs-backend/` | `tsc` → `dist/` |
| `npm run test-absence` | `nodejs-backend/` | Test absence processing logic |
| `npm run electron` | `frontend/` | Launch Electron wrapper |
| `npm run dist` | `frontend/` | Vite build + electron-builder → `release_build/` |
