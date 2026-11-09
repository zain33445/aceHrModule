# Screen recording v2 — Phase 1 (server) + Phase 2 (agent)

Status: implementation spec. Phase 0 (v1.11.4) is live. This document is the
contract between the Electron agent and the backend for recording v2.

Hard rule (product owner): **a recorded chunk is never lost, refused or
overwritten.** When in doubt, keep the bytes on disk.

## 1. Concepts

| Term | Meaning |
|---|---|
| Recording day | One per employee per *work day*. Derived from the employee's shift (night shifts stay in one day). |
| Session | `recording_sessions` row, unique per `(user_id, recording_date)`. Holds the day's final file (current generation). |
| Segment | One continuous MediaRecorder run (one WebM header). Client-generated UUID. Belongs to exactly one session. |
| Chunk | One MediaRecorder timeslice of a segment, `(segment_id, seq)`, seq starts at 0 per segment. |
| Generation | Version N of the day's assembled file. N+1 = N + newly completed segments, swapped in only after verification. |

Legacy (v1) sessions keep `recording_date = NULL` and keep working through the
v1 endpoints (`POST /recording/chunk`, `/recording/chunks/check`) for agents
≤ 1.11.x. Nothing in v2 changes their behaviour.

## 2. Recording day (shift based)

Shift: `users.department → departments.shift → shifts` with `checkin`/`checkout`
"HH:MM" strings (parse with the existing `timeToMinutes` in
`absence.service.ts`, which handles am/pm). All times are Asia/Karachi
(UTC+5, no DST — ponytail: fixed offset, use Intl if that ever changes).

```
S = shift start minutes (checkin), E = shift end minutes (checkout)
gap = (S - E + 1440) % 1440            # off-shift minutes (0 → treat as 1440)
B = (E + floor(gap / 2)) % 1440        # day boundary = middle of the off-shift gap
recordingDate(t) = karachiDate(t - B minutes) + (S < B ? 1 day : 0)
```

- No shift / unparsable times → `S = 0, B = 0` → plain Karachi calendar date.
- Examples: 09:00–18:00 → B = 01:30 (00:30 work belongs to the day before);
  19:00–04:00 → B = 11:30 (02:00 belongs to the shift that started 19:00).
- **The server is authoritative**: it assigns a segment to a day using the
  segment's `startedAt` and the user's current shift. The agent uses the same
  rule (cached from the server) only to decide *when to rotate* segments and to
  name its local folders.
- Implement once on the server as a pure function `recordingDayRule(shift)` →
  `{ boundaryMinutes, shiftStartMinutes }` and
  `recordingDateFor(date, rule)` → `'YYYY-MM-DD'`. The agent gets the rule in
  `CONNECTED` (see §5) and implements `recordingDateFor` identically.

## 3. Database (additive only)

Applied by idempotent SQL in
`nodejs-backend/prisma/migrations/20261110000000_recording_v2/migration.sql`
and executed at backend start by `ensureRecordingSchema()` (statement by
statement, `IF NOT EXISTS` everywhere). Never `prisma db push` (it would drop
`users.leave_bank`). `schema.prisma` is updated to match so `prisma generate`
produces the client.

`recording_sessions` — new columns:
- `recording_date DATE NULL` (NULL = legacy session)
- `dir_path TEXT NULL` — session folder, fixed at creation, never recomputed
- `generation INT NOT NULL DEFAULT 0`
- `duration_ms INT NULL` — duration of the current generation
- `logged_out_ms INT NOT NULL DEFAULT 0`
- `last_chunk_at TIMESTAMP NULL`
- `assembly_error TEXT NULL`, `assembly_attempts INT NOT NULL DEFAULT 0`
- unique index `(user_id, recording_date)` (NULLs allowed for legacy rows)
- index `(user_id, status)`

`recording_segments` (new):
- `id TEXT PK` (agent UUID), `session_id TEXT FK → recording_sessions ON DELETE CASCADE`,
  `user_id TEXT`, `device_id TEXT NULL`
- `started_at TIMESTAMP`, `ended_at TIMESTAMP NULL`
- `last_seq INT NULL` (set on close), `lost_seqs INT[] NOT NULL DEFAULT '{}'`
- `mime TEXT NULL`, `width INT NULL`, `height INT NULL`
- `state TEXT NOT NULL DEFAULT 'open'` — `open | closed | complete | assembled | incomplete`
- `generation INT NULL` (generation that included it)
- `created_at`, `updated_at`; index `(session_id, state)`

`recording_chunks` — new columns:
- `segment_id TEXT NULL FK → recording_segments ON DELETE CASCADE`, `seq INT NULL`
- `sha256 TEXT NULL`, `captured_at TIMESTAMP NULL`, `duration_ms INT NULL`
- `logged_out BOOLEAN NOT NULL DEFAULT false`, `purged_at TIMESTAMP NULL`
- `chunk_index` becomes NULLable (v2 chunks leave it NULL)
- unique index `(segment_id, seq)`

`app_settings` (new): `key TEXT PK`, `value TEXT`, `updated_at TIMESTAMP`, `updated_by TEXT NULL`.
- `recording.retention_days`: `'0'` (forever, default) | `'30'` | `'60'` | `'90'`.

## 4. Server storage layout (v2)

`RECORDINGS_DIR` (prod default `I:\hrApp_data\recordings`):

```
<RECORDINGS_DIR>/<recording_date>/<userId>-<safeName>_(<sessionId>)/
    recording-g<N>.webm                 current generation (only one kept)
    segments/<segmentId>/<seq>.webm     chunks until assembled (then deleted)
    collisions/...                      conflicting duplicate uploads (kept)
```

`safeName` = user name with anything outside `[A-Za-z0-9 _-]` removed, spaces
→ `-`, max 40 chars. The full path is stored in `dir_path` at session creation.

## 5. WebSocket protocol v2 (`/recording-ws`)

Agent → server first message:
`{ type: 'AUTH', token, protocol: 2, deviceId, version }`

Server → agent:
`{ type: 'CONNECTED', userId, protocol: 2, record: boolean,
   recordingDay: { boundaryMinutes, shiftStartMinutes }, serverTime }`
- `record` is false for admin/superadmin (never recorded).
- For protocol-2 agents the server sends **no** `START_RECORDING` /
  `STOP_RECORDING` and does **no** session reconcile/adopt: v2 recording is
  agent-driven and sessions are created by segment registration (§6).
- Close code `4002` = replaced by another agent of the same user → agent waits
  5 minutes before reconnecting (already implemented).
- Agent → server `STATUS` (v2, every 60 s and on change):
  `{ type:'STATUS', state, segmentId, sessionId, loggedIn, backlogChunks,
     backlogBytes, diskFreeBytes, version }` — server keeps the latest per user
  in memory and exposes it at `GET /api/recording/agents-status` (§7).
- WebRTC live-view messages are unchanged in this phase.
- Protocol-1 agents (no `protocol` field) keep the exact Phase 0 behaviour.

## 6. HTTP API v2 (agent; `Authorization: Bearer <agent token>`)

All idempotent. The segment's owner is the token's user; another user → 403.

`PUT /api/recording/v2/segments/:segmentId`
- body `{ startedAt, mime, width, height, deviceId, recordingDate }`
  (`recordingDate` is the agent's view, informational/logged only)
- creates or returns the segment; finds/creates the session for
  `(user, recordingDateFor(startedAt, user's rule))` with an upsert (no
  duplicates under concurrency); if the session was `assembled` it is reopened.
- 200/201 `{ segmentId, sessionId, recordingDate, state }`
- `segmentId` must match `/^[A-Za-z0-9_-]{8,64}$/`.

`PUT /api/recording/v2/segments/:segmentId/chunks/:seq`
- raw body (`application/octet-stream`), headers:
  `X-Chunk-Sha256` (required, hex), `X-Captured-At` (ISO), `X-Duration-Ms`,
  `X-Logged-Out` (`1`|`0`)
- 400 if the body's sha256 ≠ header (corrupt in transit — agent re-reads, retries)
- 404 `{ error:'segment_not_registered' }` → agent registers, then retries
- durable write (tmp + fsync + link/rename) to `segments/<segmentId>/<seq>.webm`
  then DB row; same `(segment, seq)` + same sha → 200 `{ ok:true, duplicate:true }`;
  different sha → bytes kept under `collisions/`, 201 `{ ok:true, conflict:true }`;
  already purged after assembly + same sha → 200 duplicate.
- updates `session.last_chunk_at`, reopens the session if needed.

`POST /api/recording/v2/segments/:segmentId/close`
- body `{ lastSeq, endedAt, lostSeqs: number[] }` (lostSeqs = chunks the agent
  no longer has locally) → segment `closed`; becomes `complete` when every seq
  `0..lastSeq` not in lostSeqs is stored, `incomplete` if lostSeqs non-empty.
- idempotent; 200 `{ state }`.

`GET /api/recording/v2/segments/:segmentId/manifest`
- 200 `{ state, lastSeq, have: number[] }` — for reconciliation.

## 7. Server — assembly, sweeper, access, retention

Assembly (per session, existing per-session lock):
1. Take segments in `complete`/`incomplete` state not yet assembled, ordered
   by `started_at`. Remux each (stream chunks in seq order → `ffmpeg -c copy`).
   If a segment's width/height differ from the current generation, re-encode it
   to the generation's size (scale+pad, libvpx) before joining.
2. Join `[current generation file (if any), new segment files…]` with the
   ffmpeg concat demuxer (`-c copy`) into `recording-g<N+1>.webm.tmp`;
   fallback re-encode as in Phase 0.
3. Verify: ffmpeg exits 0 on a demux pass and duration ≥
   previous generation duration + Σ new segment durations − 2 s.
4. fsync + rename to `recording-g<N+1>.webm`; one DB transaction sets
   `generation`, `file_path`, `duration_ms`, `logged_out_ms`, segment states →
   `assembled` (+`generation`), chunk `purged_at`.
5. After commit: delete chunk files of those segments and the previous
   generation file (ignore EBUSY; a cleanup pass retries).
Failure anywhere before step 4 changes nothing; `assembly_error` +
`assembly_attempts` recorded; retried by the sweeper with backoff.
Segments that arrive out of order are appended in arrival order (logged).
ponytail: append-only generations; full rebuild if exact ordering ever matters.

Session status for v2 sessions (keeps the existing admin UI working):
`recording` (a chunk in the last 10 min) → `stopped` (idle, waiting for
assembly) → `assembled` (generation covers every closed segment).

Assembly triggers: session idle ≥ 30 min with unassembled complete segments;
recording day over (boundary passed + 30 min); `GET /sessions/:id/file` when
there is unassembled data (assemble in background, serve last good generation).
The Phase 0 sweeper (every 5 min) drives this; legacy sessions keep Phase 0 rules.

Access:
- New middleware `requireRecordingAccess`: Bearer session token; admin/superadmin,
  or a user with `user_tab_access (user_id, 'recording')`. Used by read routes:
  sessions list/detail/file/stream, status, agents, agents-status,
  admin-ws-token (WS token carries the viewer id). Admin-only stays on
  start/stop (legacy) and settings PUT.
- `POST /api/tab-access/toggle` becomes admin-only (today anyone can grant
  themselves any tab).

Retention: `GET /api/recording/settings` (access) → `{ retentionDays }`;
`PUT /api/recording/settings` (admin) body `{ retentionDays: 0|30|60|90 }`.
A daily job deletes sessions (v2 and legacy) whose `recording_date`
(legacy: `created_at`) is older than the setting — files first, then rows —
and logs what it deleted. `0` = forever (default) deletes nothing.

## 8. Agent (Phase 2)

Spool layout (new, alongside the legacy `recordings/<sessionId>/` folders which
keep the Phase 0 upload path):

```
<userData>/recordings/v2/<userId>/<segmentId>/
    segment.json        { segmentId, userId, recordingDate, startedAt, mime,
                          width, height, deviceId, closed, lastSeq, endedAt }
    <seq>.webm          chunk (tmp + fsync + rename)
    <seq>.json          { capturedAt, durationMs, loggedOut, sha256 }
    <seq>.webm.ok       server confirmed
    registered          server knows the segment (contains sessionId)
    closed.ok           server confirmed the close
```

Recording control (always-on):
- Record when authenticated as a user whose cached `record` flag is true. The
  flag and `recordingDay` rule come from `CONNECTED` and are cached per user in
  the token file, so the agent records from boot even when the server is
  unreachable. A user never seen by the server → don't record.
- New segment on: start, every 60 min, day boundary (from the cached rule),
  user switch, watchdog restart, capture source change. Rotation starts the new
  MediaRecorder on the same stream before stopping the old one (no gap). The
  capture stream is owned separately from recorders.
- Watchdog: no chunk for 3 timeslices while recording → restart capture (new
  segment). `render-process-gone` / hidden window closed → recreate and restart.
  Video track `ended` → re-acquire the screen source, new segment.
- Quality: 1280×720 max, **5 fps**, VP8 ~600 kbps, **10 s** timeslice.
- Logged-in state: renderer calls `electronAPI.setLoggedIn(false)` on logout;
  `set-user-id` means logged in. Each chunk records `loggedOut`. STATUS reports it.

Sync worker (single lane, oldest segment first, never drops):
register (if no `registered`) → PUT every chunk without `.ok` (sha from
`<seq>.json`) → when `segment.json.closed` and no `closed.ok`: POST close with
`lostSeqs` = seqs ≤ lastSeq whose file is missing. Errors: timeout 60 s,
exponential backoff 2 s→60 s with jitter, 401 → refresh token, 404
`segment_not_registered` → delete `registered`, re-register, 403 → park the
segment 30 min, 400 sha mismatch → recompute sha from the file and retry.
Chunks of a segment upload with the token of `segment.json.userId`.

Local retention (sweep at start and every 10 min):
- A segment folder may be deleted only if every chunk has `.ok`, `closed.ok`
  exists, and either its `recordingDate` is older than 15 days or the spool is
  over the **30 GB** cap (then oldest fully synced segments first).
- Never delete unsynced data. If free disk < 2 GB: pause recording (state
  `disk_low`, reported in STATUS) and resume when space returns.

## 9. Tests to keep green

- `npm run test-recording-e2e` (v1/legacy, 45 checks)
- new `npm run test-recording-v2-e2e` (live server + DB): segment registration
  and same-day session reuse, chunk sha/duplicate/conflict/corrupt, manifest,
  close/complete/incomplete, generation 1 → generation 2 = gen1 + new segment
  (duration check), chunk files purged after assembly, retention setting,
  `requireRecordingAccess` (admin / HR with grant / HR without grant),
  tab-access toggle admin-only, protocol-2 CONNECTED payload and no
  START_RECORDING for v2 agents.
- new `nodejs-backend/src/test-recording-day.ts`: `recordingDateFor` cases.
- new `frontend/electron/recording-day.check.mjs` + spool retention checks.
