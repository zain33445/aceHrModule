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
- `screen SMALLINT NULL` — multi-monitor: which screen the segment recorded
  (1 = primary, 2..N = the others left to right; NULL = unknown/old agent).
  Added by an idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` at the end of the migration.
- `created_at`, `updated_at`; index `(session_id, state)`

`recording_chunks` — new columns:
- `segment_id TEXT NULL FK → recording_segments ON DELETE CASCADE`, `seq INT NULL`
- `sha256 TEXT NULL`, `captured_at TIMESTAMP NULL`, `duration_ms INT NULL`
- `logged_out BOOLEAN NOT NULL DEFAULT false`, `purged_at TIMESTAMP NULL`
- `chunk_index` becomes NULLable (v2 chunks leave it NULL)
- unique index `(segment_id, seq)`

`app_settings` (new): `key TEXT PK`, `value TEXT`, `updated_at TIMESTAMP`, `updated_by TEXT NULL`.
- `recording.retention_days`: `'0'` (forever) | `'30'` | `'60'` | `'90'`. **Default 30 days, but only
  when no row exists**; an explicitly saved `'0'` stays forever.
- `recording.quality`: `'480p'` | `'720p'` (default when unset/invalid) | `'1080p'`.

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
   recordingDay: { boundaryMinutes, shiftStartMinutes }, quality: '480p'|'720p'|'1080p', serverTime }`
- `record` is false for admin/superadmin (never recorded).
- `{ type: 'RECORDING_SETTINGS', quality }` is sent to every connected protocol-2
  agent when an admin changes the quality. Agents pin the quality **per recording
  day** and apply a change from their next recording day.
- For protocol-2 agents the server sends **no** `START_RECORDING` /
  `STOP_RECORDING` and does **no** session reconcile/adopt: v2 recording is
  agent-driven and sessions are created by segment registration (§6).
- Close code `4002` = replaced by another agent of the same user → agent waits
  5 minutes before reconnecting (already implemented).
- Agent → server `STATUS` (v2, every 60 s and on change):
  `{ type:'STATUS', state, segmentId, sessionId, loggedIn, backlogChunks,
     backlogBytes, diskFreeBytes, version, screens }` — `screens` = number of
  monitors on the agent (int 1..16; default 1 when missing = old agent). Server keeps the latest per user
  in memory and exposes it at `GET /api/recording/agents-status` (§7).
- WebRTC live-view messages are unchanged in this phase.
- Protocol-1 agents (no `protocol` field) keep the exact Phase 0 behaviour.

## 6. HTTP API v2 (agent; `Authorization: Bearer <agent token>`)

All idempotent. The segment's owner is the token's user; another user → 403.

`PUT /api/recording/v2/segments/:segmentId`
- body `{ startedAt, mime, width, height, deviceId, recordingDate, screen? }`
  (`screen` integer 1..16, anything else is stored as NULL; a re-PUT without a
  valid `screen` never overwrites an existing value)
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
   If a segment's codec or width/height differ from the reference (previous
   generation, or the first segment for generation 0), convert it to the
   reference codec and size (scale+pad) with quality-based args
   (`reencodeArgs`: vp8 crf 10 / 3M, vp9 crf 32, `-deadline good`) before joining.
2. Join `[current generation file (if any), new segment files…]` with the
   ffmpeg concat demuxer (`-c copy`) into `recording-g<N+1>.webm.tmp`;
   last-resort full re-encode with `reencodeArgs(reference codec)` (rare, as segments are normalised first).
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

Settings: `GET /api/recording/settings` (access) → `{ retentionDays, quality }`;
`PUT /api/recording/settings` (admin) body `{ retentionDays?: 0|30|60|90, quality?: '480p'|'720p'|'1080p' }`
(at least one; returns both current values; a quality change triggers `RECORDING_SETTINGS`).
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
- Quality (server setting, pinned per recording day), all **15 fps**, VP9 with VP8
  fallback, keyframe ~5 s, **10 s** timeslice:

  | Preset | Size | Bitrate |
  |---|---|---|
  | 480p | 854×480 | 0.6 Mbps |
  | 720p (default) | 1280×720 | 1.2 Mbps |
  | 1080p | 1920×1080 | 2.0 Mbps |
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

---

# Phase 4 — Live view (LiveHub)

Goal: an admin (or an HR user with the `recording` grant) opens the Recording
panel and live feeds appear by themselves; there is no "start live" action.
Live view and recording are separate failure domains on the agent.

## 10. Topology

- WebRTC peer-to-peer per (viewer, agent). **The agent is the offerer**; the
  viewer only receives. Signalling uses the existing gateway sockets
  (`/recording-ws` for agents, `/admin-recording-ws` for viewers).
- ICE servers come from `getIceServers()` (`turn.service.ts`: STUN plus
  short-lived TURN credentials from `TURN_URLS` / `TURN_SHARED_SECRET`). The
  server sends them in `CONNECTED` (viewer) and `LIVE_START` (agent).
  Production runs a TURN server on the main server (§15) so a remote admin on
  Tailscale can reach office PCs.
- Viewer cap: **4 concurrent streams per agent** (`LIVE_MAX_VIEWERS_PER_AGENT`,
  default 4). Extra subscribers get `LIVE_REJECTED reason:'viewer_limit'`.
- Quality profiles, applied by the agent with `RTCRtpSender.setParameters` (no
  renegotiation); `scaleResolutionDownBy = max(1, trackWidth / target)`:

  | quality | target width | fps | maxBitrate | used for |
  |---|---|---|---|---|
  | `grid2` | 1280 px | 10 | 1.5 Mbps | grid, 2 columns (default) |
  | `grid3` | 960 px | 10 | 1.0 Mbps | grid, 3 columns |
  | `grid` | 640 px | 10 | 600 kbps | grid, 4 columns (old agents treat any non-`focus` value as this) |
  | `focus` | native | 15 | 4 Mbps | focus view |

  Every level uses degradationPreference `maintain-resolution` (under load drop
  frames, keep text sharp), and the capture track gets `contentHint = 'text'`.
- Protocol-1 (old) agents cannot do LIVE_*. They are listed in presence with
  `liveCapable:false` (UI: "Update app for live view"). The legacy
  WEBRTC_OFFER/ANSWER relay stays in the gateway for old admin UIs.

## 11. Messages (JSON)

Viewer socket: `/admin-recording-ws?token=…` (token from
`POST /api/recording/admin-ws-token`, which requires recording access). One
viewer socket may hold many streams (the grid).

Server → viewer:
- `CONNECTED { viewerId, iceServers }` — `viewerId` is unique per socket.
- `LIVE_PRESENCE { agents: Agent[] }` — full snapshot right after CONNECTED.
- `LIVE_PRESENCE_UPDATE { agent: Agent }` — on any change (connect, disconnect,
  STATUS change). `Agent = { userId, name, department, connected, liveCapable,
  recording, loggedIn, state, viewers, version, screens }`; `screens` = monitors
  on the agent (from STATUS, default 1); `recording` = agent state is
  `recording`; `liveCapable` = protocol 2 and recording allowed; `viewers` =
  current stream count. Admin/superadmin agents are not listed.
- `LIVE_SUBSCRIBED { streamId, userId, quality, screen }`
- `LIVE_REJECTED { userId, reason }` — `viewer_limit | offline | not_live_capable | not_allowed`
- `LIVE_SIGNAL { streamId, description?, candidate? }` (from the agent)
- `LIVE_STATE { streamId, state, error? }` (agent: `connecting | connected | failed | closed`)
- `LIVE_ENDED { streamId, reason }` — `agent_disconnected | agent_stopped | unsubscribed`
- `PING` every 30 s; the viewer answers `PONG`; 2 missed → server closes.

Viewer → server:
- `LIVE_SUBSCRIBE { userId, quality, screen? }` (`quality` = `grid | grid2 | grid3 | focus`; `screen` integer 0..16, default 0;
  0 = Follow the cursor, N = fixed screen N; invalid → dropped) → server allocates `streamId` (uuid),
  checks presence and cap, sends `LIVE_START` to the agent and
  `LIVE_SUBSCRIBED` to the viewer.
- `LIVE_QUALITY { streamId, quality }` → forwarded to the agent.
- `LIVE_SCREEN { streamId, screen }` → validated like `LIVE_QUALITY` (own stream
  only, `screen` integer 0..16) and forwarded to the agent as `LIVE_SCREEN`.
- `LIVE_UNSUBSCRIBE { streamId }` → `LIVE_STOP` to the agent.
- `LIVE_SIGNAL { streamId, description?, candidate? }` → relayed to the agent.
- `PONG`.
The server checks that every `streamId` belongs to the sender (viewer or
agent); anything else is dropped and logged.

Server → agent: `LIVE_START { streamId, quality, iceServers, screen }`,
`LIVE_QUALITY { streamId, quality }`, `LIVE_SCREEN { streamId, screen }`, `LIVE_STOP { streamId }`,
`LIVE_SIGNAL { streamId, description?, candidate? }` (from the viewer).

Agent → server: `LIVE_SIGNAL { streamId, description?, candidate? }`,
`LIVE_STATE { streamId, state, error? }`; v2 `STATUS` gains `liveViewers`.

Lifecycle:
- Viewer socket closes → server sends `LIVE_STOP` for all its streams.
- Agent socket closes or is replaced → server sends `LIVE_ENDED
  agent_disconnected` to those viewers and forgets the streams.
- Recovery is viewer-driven: on `failed`, `LIVE_ENDED`, or no `connected`
  within 15 s, the viewer unsubscribes and resubscribes with backoff (2 s, 4 s,
  8 s … max 30 s) while the agent is present and live-capable.
- Agent: `iceConnectionState` `failed` → one `restartIce()` + new offer; still
  failing after 10 s → `LIVE_STATE failed` and close the peer.

## 12. Agent live engine (separate process)

- A second hidden BrowserWindow (`electron/live-renderer/`) owns live view,
  independent of the recorder window: its own desktop `getUserMedia` (15 fps at the screen's own
  physical size, fixed via min=max constraints and capped to 3840×2160 — main computes it from the display's bounds × scaleFactor and sends it
  with `live:start`/`live:source`; without fixed min the capturer follows the encoder's downscale and focus got stuck at 1280×720), started on the first `LIVE_START`, released 30 s after
  the last stream closes. A crash of either window never affects the other;
  main recreates the live window on `render-process-gone`.
- One `RTCPeerConnection` per streamId; the agent creates the offer, sends
  `LIVE_SIGNAL {description}`, trickles candidates (copy `candidate`, `sdpMid`,
  `sdpMLineIndex` explicitly — IPC drops RTCIceCandidate fields), applies the
  viewer's answer and candidates (queue candidates until the remote
  description is set).
- `LIVE_QUALITY` → `sender.setParameters` per §10.
- The legacy recorder-window WebRTC answerer stays for old admin UIs.

# Phase 5 — Admin / HR screens

## 13. API additions (server)

- `GET /api/recording/days?from=YYYY-MM-DD&to=YYYY-MM-DD&userId=&page=1&pageSize=50`
  (recording access) → `{ items: Day[], total, page, pageSize }`,
  `Day = { sessionId, userId, name, department, recordingDate, createdAt,
  legacy, status, generation, durationMs, loggedOutMs, segments,
  screens, incompleteSegments, openSegments, assembling, lastChunkAt, hasFile }`
  (`screens` = distinct non-null segment screens; 0/1 = single screen),
  newest first. Legacy sessions: `legacy:true`, `recordingDate:null`, filtered
  by `created_at`.
- `POST /api/recording/sessions/:id/playback-token` (recording access) →
  `{ url }` = `/api/recording/sessions/:id/file?pt=<jwt>` (relative to the API
  base), valid 10 minutes, so a `<video src>` can stream with Range without an
  Authorization header. `pt` is accepted only by the file route and only for
  that session.
- `GET /api/recording/live-presence` (recording access) → `Agent[]` as in
  `LIVE_PRESENCE` (first paint and polling fallback).
- Existing: `GET/PUT /api/recording/settings`, `GET /agents-status`.

## 14. UI (frontend/src)

`RecordingTab` becomes three tabs:
1. **Live** — 4×4 grid (16 cells), one cell per unique user, pages of 16
   sorted by name, department filter and name search. Only users on the
   visible page are subscribed (`grid2`/`grid3`/`grid` quality chosen by the 2/3/4-column switch; a column change re-applies it live); changing page or filter
   unsubscribes the rest. One viewer socket for the whole tab (hook
   `useLiveHub`) with reconnect/backoff and PONG. A cell shows the name,
   department, a badge (`Live`, `Connecting`, `Reconnecting`, `Not recording`,
   `Offline`, `Busy`, `Update app`), and the subtext **"currently logged
   out"** when `loggedIn === false`. A disconnected user stays 60 s as
   `Reconnecting`, then leaves the grid. Clicking a cell opens a focus view
   (same stream switched to `focus`; back to the tile's current grid level on close). Empty state when
   nobody is live.
2. **Recordings** — table from `GET /days`: employee, day, duration,
   "includes Xh Ym logged out" when `loggedOutMs > 0`, status (`Recording`,
   `Assembling`, `Ready`, `Incomplete`), **Play** (in-app `<video>` with the
   playback-token URL, seekable) and **Download** (authenticated blob as in
   Phase 0). Filters: date range (default last 7 days), employee. Legacy
   sessions carry a "legacy" tag.
3. **Settings** (admins only) — retention (Forever / 30 / 60 / 90 days, default 30) and recording quality (480p / 720p / 1080p).

**Multi-monitor.** Screen numbers: 1 = primary display, 2..N = the others left
to right, 0 = Follow (live only). The recorder follows the monitor under the
mouse cursor (polled every 2 s; it switches once the cursor has stayed on another
screen for 10 s; the segment is cut when the screen changes;
the output is letterboxed to the preset size) and each segment records its
`screen`. In the Live grid, an agent with `screens > 1` shows a "Follow · 1 · 2 …"
switch on tile hover/focus (`role=group`, `aria-label="Screen"`, `aria-pressed`);
the choice lives in the tile's state, survives resubscribes, and the focus view
shows the same switch bound to the tile's stream. In Recordings, a day with
`screens > 1` shows an "N screens" badge that expands the segment list
(`GET /sessions/:id`: time range, duration, "Screen N" or "—").

The old Start/Stop buttons and LivePlayer modal are removed (recording is
always-on). HR users with the `recording` grant get the same tab (Live +
Recordings, no Settings) through `EmployeeDashboardNew`'s granted-tab map.
Tailwind spacing trap (AGENTS.md): use arbitrary values for max/min widths.

## 15. TURN on the main server (deployment)

Remote admins reach the main server only over Tailscale; office PCs reach it on
the LAN. One TURN server on the main server serves both: coturn (Docker or WSL
on Windows) listening on the LAN and Tailscale addresses with
`relay-ip=<LAN IP>` (relay candidates reachable by office PCs),
`use-auth-secret`, `static-auth-secret=<TURN_SHARED_SECRET>`, `realm=acehrm`,
3478 udp+tcp and a relay port range. Backend `.env`:
`TURN_URLS=turn:<LAN IP>:3478?transport=udp,turn:<LAN IP>:3478?transport=tcp,turn:<Tailscale IP>:3478?transport=udp,turn:<Tailscale IP>:3478?transport=tcp`
and `TURN_SHARED_SECRET`. Step-by-step: `docs/live-view-turn.md`.
