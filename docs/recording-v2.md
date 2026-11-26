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
- `assembly_next_at TIMESTAMP NULL` — earliest next assembly attempt (failure backoff); NULL = due now
- `parts JSONB NULL` — manifest of the day's part files `{ ref:{w,h,codec}, items:[{file, segmentId|null, firstSeq, startMs, durationMs, packets}] }` (file names relative to the session folder, items in time order; `segmentId` null = a base, an older generation). See §7 "Stage 2"
- unique index `(user_id, recording_date)` (NULLs allowed for legacy rows)
- index `(user_id, status)`

`recording_segments` (new):
- `id TEXT PK` (agent UUID), `session_id TEXT FK → recording_sessions ON DELETE CASCADE`,
  `user_id TEXT`, `device_id TEXT NULL`
- `started_at TIMESTAMP`, `ended_at TIMESTAMP NULL`
- `last_seq INT NULL` (set on close), `lost_seqs INT[] NOT NULL DEFAULT '{}'`
- `mime TEXT NULL`, `width INT NULL`, `height INT NULL`
- `state TEXT NOT NULL DEFAULT 'open'` — `open | closed | complete | assembled | incomplete | unreadable`
  (`unreadable`: assembly could not use the segment's chunks; they stay on disk, unpurged, and the queue ignores it)
- `problem TEXT NULL` — why a segment's chunks are not (fully) in the video (`unreadable`, or `assembled` but short)
- `generation INT NULL` (generation that included it)
- `init_data BYTEA NULL` — the stream's bytes before its first Cluster, taken from chunks 0, 1, 2, … in order (a still screen can make seq 0 a single byte, the header then continues in seq 1; the Cluster id may be cut between two chunks); starts with the EBML magic, at most 64 KB, a known-size Segment is made unknown-size. Stored when a chunk with seq <= 5 is ingested while it is NULL, for older segments at assembly while those chunk files exist
- `agent_closed_at TIMESTAMP NULL` — when the agent closed the segment (set by every close, also one that arrives after assembly)
- `screen SMALLINT NULL` — multi-monitor: which screen the segment recorded
  (1 = primary, 2..N = the others left to right; NULL = unknown/old agent).
  Added by an idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS` at the end of the migration
  (so are `problem`, `init_data`, `agent_closed_at` and `recording_sessions.assembly_next_at` / `parts`).
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
    parts/<segmentId|base>-<firstSeq>-g<N>.webm   the pieces the day is built from (§7 Stage 2; removed after RECORDING_PARTS_KEEP_DAYS)
    segments/<segmentId>/<seq>.webm     chunks until assembled and the segment is closed and complete (§7 Stage 2)
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

Assembly (per session, existing per-session lock). **A chunk file is deleted only after its frames are verified
inside a committed video; a bad segment never fails the day.**
1. Take segments in `complete`/`incomplete` state not yet assembled, ordered by `started_at`. A segment whose chunk
   *file* is missing on disk is skipped for this run (transient: the session backs off, see below).
2. Prepare each segment on its own (`prepareSegment`), returning a file or a problem, never throwing for bad media:
   - first unpurged chunk is not seq 0 and does not start with its own EBML header → a header is borrowed (§7 Stage 2); none fits → `late chunks: no header fits`;
   - concat the chunks → `ffmpeg -c copy`. Failure or **zero video packets** → one retry with
     `-fflags +genpts+discardcorrupt -err_detect ignore_err`; still nothing → `no readable video`. Raw bytes are never
     used as a fallback. If the first remux plays less than the chunks claim, the tolerant remux is tried too and the
     longer file is kept;
   - coverage: expected = Σ chunk `duration_ms` (null = 10 s, each chunk capped at 60 s so a PC sleep is no false
     alarm). Playing less than `expected − max(15 s, 1 %)` → the segment is still included, but its chunk **files are
     kept** and `problem = only X of Y min readable` (measured on 15 real segments: worst 6 s short of an hour);
   - codec or width/height differ from the reference (previous generation, else the first usable segment) → re-encode
     **that one segment** (scale+pad, `reencodeArgs`). A re-encode that is more than 5 s shorter than its source, or
     fails → `re-encode … failed`.
   A problem sets the segment `unreadable` (+`problem`), chunks untouched, and the others carry on.
3. Join `[current generation file (if any), usable segment files…]` with the concat demuxer (`-c copy`) and verify
   with one demux pass (`probeFile`, `-v verbose`): exit 0, duration ≥ base + Σ new − 2 s (concat adds ~0.07 s per
   segment, so duration alone hides losses) **and** video packets muxed ≥ Σ of the inputs' packets (ffmpeg can skip an
   input and exit 0; an unparsable count falls back to the duration check and is logged). The base duration is the
   *measured* length of the current generation, never `duration_ms` from the DB. If the whole list will not join it is
   split in halves and joined recursively on top of the last good file (copy only) to find the culprit; a lone culprit
   gets one per-segment re-encode and one more try, else it is `unreadable` (`could not be joined`). At most 3 such
   culprits (= 3 re-encodes) are handled per run; beyond that the remaining segments are left assemblable, the good
   part is published and the session backs off. With no previous generation, if nothing joins onto the first segment
   (it is the odd one), the LONGEST segment is published alone (normal commit, only its own chunks marked / purged)
   and the others are not flagged: they stay assemblable, the run ends in a backoff, and the next run joins them on
   top of it. There is no
   full-session or whole-tail re-encode any more. An unreadable previous generation aborts the run (never build over it).
4. fsync + rename to `recording-g<N+1>.webm`; one DB transaction sets `generation`, `file_path`, `duration_ms`,
   `logged_out_ms`, marks `assembled` only the segments actually joined, `unreadable` the rest, and sets `purged_at`
   only on the chunk rows that were joined (the snapshot taken at the start; a chunk that arrived meanwhile stays
   unpurged and its segment is re-opened).
5. After commit: delete the chunk files of segments that `keptFilesDeletable` allows (§7 Stage 2, not the short or grafted ones)
   and the previous generation file / replaced parts (ignore EBUSY; a cleanup pass retries).
A run in which nothing could be used commits no generation and does not touch `generation`, `duration_ms`,
`assembly_attempts` or `assembly_next_at`; `assembly_error` keeps the reasons. A new chunk for an `unreadable`
segment puts it back to `closed` (and recomputes `complete`/`incomplete`), clearing `problem`.
Failure of the run itself (missing chunk file, previous generation missing/unreadable, an infrastructure failure of
ffmpeg, a join that timed out or whose culprits exceeded the budget) never flags a segment as unreadable and
changes nothing else: `assembly_error` is set, `assembly_attempts + 1`, `assembly_next_at = now + backoff(attempts)`
(`2^attempts × 5 min`, cap 6 h). `assembly_attempts`/`assembly_next_at` reset only when a generation containing new video
is committed, or when any new chunk of the session arrives. Segments that arrive out of order are appended in arrival
order (logged).
ffmpeg runs with `-nostdin`; copy/probe calls time out after 20 min, a one-segment re-encode after
`max(10 min, 6 × duration)` (cap 3 h), and any other `runFfmpeg` call (legacy v1) after 3 h, so a hung process cannot
hold the single slot forever. **Certain infrastructure failures always throw** (the session backs off, no segment is
flagged): spawn error / binary missing (code -1 other than a timeout), killed process (code null, Windows 0xC000013A),
`No space left`. **Ambiguous** texts — `Cannot allocate memory`, `Input/output error`, `Permission denied` — are printed by
ffmpeg for corrupt media too (truncated EBML, bogus sizes): they throw while the session's `assembly_attempts` < 3, and from
the 4th run they are that segment's problem (`unreadable`, `problem = ffmpeg: <text>`, chunks kept) so the rest of the day
gets through. For the previous generation's probe and for joins they always throw. A timeout counts as a failure of that input.
`RECORDING_FFMPEG_PATH` overrides the bundled ffmpeg binary (the e2e test points it at a bogus path).

### Stage 4 — retry and repair

- `POST /api/recording/sessions/:id/retry-assembly` (**admin/superadmin only**, an HR grant is not enough) puts every `unreadable`
  segment that still has unpurged chunk rows back through `reviveSegment` (state `closed`, problem cleared, then recomputed to
  `complete`/`incomplete`), sets the session's `assembly_attempts` 0, `assembly_next_at` and `assembly_error` NULL, and starts the
  build in the background (`requestAssembly`). `202 { revived, pending }` (`pending` = segments now waiting). `404` for an unknown or
  legacy session, `409 { error: 'already_assembling' }` while a run is going (nothing is changed then). No chunk is touched.
- `npm run repair-recordings -- [--dry-run] [--apply --yes] [--session <id>] [--user <id>]` (`src/repair-recordings.ts`). **Dry run is
  the default.** `--apply` is refused unless `--yes` is given too; both modes first print the database host and `RECORDINGS_DIR` it
  will use. For every v2 session: (a) the same revive as the retry (without starting ffmpeg: the running server's queue builds it);
  (b) a chunk file `segments/<segmentId>/<seq>.webm` without a chunk row, for a segment the session knows, gets its row (sha256 and size
  of the file; the file is never touched) — unless it was modified in the last 10 minutes (the running server may be between the file and its row; it is only counted) and the segment is re-evaluated like after a stored chunk (`complete`, revived or re-opened);
  folders of unknown segments are only reported; (c) reported, never changed: collision files, a generation file that is missing, and a
  day whose `duration_ms` is more than 2 min shorter than the chunks of its assembled segments (each capped at 60 s) — "shorter than
  recorded, cannot be repaired from the server". One line per session with something to say, then a `Total:` line. **Nothing is deleted.**
  Always pass `--session`/`--user` first when trying it on a real database.

### Stage 2 — kept files, late chunks, parts, time order, size

**Chunk files are kept while the segment may still grow.** `purged_at` now means "this chunk is in the video", no longer "its file is
gone". At commit the rows get `purged_at`, but the files are deleted only when `keptFilesDeletable` says so: the segment is
`assembled`, has no `problem`, every row is purged (a chunk that arrived meanwhile keeps all of them), and either
`agent_closed_at` is set and every seq `0..last_seq` is stored or declared lost, or the agent never closed it and its last chunk is
older than 16 days (the agent keeps its spool 15 days). `closeSegment` always records `agent_closed_at`; on an already assembled
(or unreadable) segment it changes nothing else but a larger `last_seq` and more lost seqs. The sweep (every 30 min, first pass 30 min
after boot) deletes the kept files of segments whose close arrived later, found by listing `segments/` of the last 45 days'
sessions (only segments whose folder still exists have kept files). Short and grafted segments keep their files (their `problem` is set).

**Late chunk for an assembled segment** (re-opened as before). At assembly: if the segment has a part of its own in the manifest
(`firstSeq 0`) and *all* its earlier chunk files are still on disk, every row of the segment is used and the whole segment is rebuilt;
its parts are replaced and the day is concatenated again. (The brief sets `purged_at = NULL` on the rows at ingest; the decision is
taken at assembly instead, so a chunk arriving while the files are being deleted can never leave a half-deleted segment.) Otherwise
the late chunks alone are a tail: if the first one starts with an EBML header it is used as it is; else the segment's `init_data`, then
the headers of up to 5 different donor segments (same width and height, same mime or none; nearest `started_at` first; in this order: the same user's with `init_data`, the same user's whose first chunk files are on disk (contiguous from seq 0), then both kinds of any other user, 8 per side of the tail for each query: a header holds no picture data and a graft is only accepted as below) are put
in front of the tail, which is first cut at its own first Cluster id (it may start inside the header, e.g. at seq 1, or mid-cluster; no Cluster at all = no graft), the remux is accepted only if it plays and its first 3 s decode without a single error. Frames before the tail's first keyframe
are dropped by the remux, so coverage allows 15 s more and the tail's chunk files are KEPT (`problem` = "late chunks joined onto their
own header / a donor header; frames before their first keyframe are not in the video"). A tail starts at segment start + the durations of
the chunks before it (a missing one counts 10 s). If a whole-segment rebuild cannot be read, or plays less than the parts it would replace (`rebuildKeepsVideo`: duration >= sum of the replaced parts - 2 s, and packets >= their sum when both are known: rotten kept files), the old parts stay and the late chunks alone are tried.

**Parts and time order.** After a commit each included segment's final file is moved to `parts/<segmentId>-<firstSeq>-g<N>.webm` (the
generation is in the name so a replaced part never overwrites a file the committed manifest still names) and `sessions.parts` is
committed with the generation. The day is built from the parts copy-only: when every new piece starts after everything already in the day
the pieces are appended to the current generation (stage-1 join with bisect); when a piece starts before something already there, or a
rebuilt segment replaces its part, ALL parts are concatenated in `startMs` order and verified like any join. If that ordered join does not
verify, the pieces are appended to the current generation (a rebuilt segment then brings only its late chunks), the manifest collapses
to the generation alone and the part files are deleted after the commit. A session with a generation but no manifest (stage 1) is
treated as one base item (the generation file, `startMs` = its earliest segment); when a base item has to stay, the old generation file
is hard-linked into `parts/base-0-g<N-1>.webm` before the commit. New parts are moved and their mtime set to now *before* the commit;
the old files are deleted *after* it. A crash in between leaves unreferenced files in `parts/`, which the sweep removes when no manifest
names them and they are older than 1 h. Parts collapse into the generation (manifest = one base item, part files deleted) when the
recording day is older than `RECORDING_PARTS_KEEP_DAYS` (default 4) or free disk is below `RECORDING_PARTS_MIN_FREE_GB` (default 20);
below that threshold no parts are created at all. The `parts` manifest is not returned by `/sessions` or `/sessions/:id`.

**Reference size.** At the first generation every segment is remuxed first, then the size with the largest total duration wins (tie:
larger area; sizes under 640 wide only when there is nothing else); only then are the others re-encoded (one segment per ffmpeg call).
With a base: the base's size, except a base under 640 wide that is shorter than the new material of a proper size: the new majority size
wins and the base's pieces are re-encoded once (if that fails the new material is scaled to the base as before; if the ordered join
fails after the base was re-encoded the run throws and changes nothing).

**Boot.** Once per process start (first sweep) segments with `problem` starting "late chunks without their header" (stage 1) are made
assemblable again (their session's backoff is cleared); so are those the first stage-2 release flagged "late chunks without a usable header" (its donor search was too narrow). A graft that fails now says "late chunks: no header fits", which is not revived at boot (the search already ran; the admin Retry still tries again).

Queue (`pickAssemblies` / `pumpAssemblies`): the 5-min sweep only calls `pumpAssemblies()` and never waits for a run.
A session is *due* when it has an assemblable segment, is idle ≥ 30 min, or its recording day is over (+ 30 min) and its last chunk is at least 5 min old (`assemblyDue`: a finished day that is still receiving a backlog is not rebuilt chunk by chunk),
`assembly_next_at` is null or past, and is not running. Due sessions are ordered by `assembly_attempts` ascending,
then `last_chunk_at` ascending, so an untried day always beats a failing one; up to
`RECORDING_MAX_CONCURRENT_ASSEMBLIES` (default 1) runs are active, and when a run ends the pump runs again at once.
`GET /sessions/:id/file` (`assembleOnDemand`) honours `assembly_next_at` too.

Session status for v2 sessions (keeps the existing admin UI working):
`recording` (a chunk in the last 10 min) → `stopped` (idle, waiting for
assembly) → `assembled` (generation covers every closed segment).

Assembly triggers: session idle ≥ 30 min with unassembled complete segments;
recording day over (boundary passed + 30 min) and quiet for 5 min; `GET /sessions/:id/file` when
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
- `npm run test-recording-queue` (no DB): queue order, backoff, starvation simulation, ffmpeg timeout.
- `npm run test-recording-edge-e2e` S17–S41: bad media never blocks a day or loses bytes; late chunks, grafts, parts, order, size, crash safety (see `recording-edge-cases.md`). Start the server and run the test with the same `RECORDINGS_DIR` and `RECORDING_PARTS_MIN_FREE_GB=0` (this PC has less than 20 GB free).
- S39 (retry endpoint: auth, 404, 409, rebuild), S40 (`/days` problem fields, legacy rows) and S41 (`repair-recordings`: dry run, `--yes`, apply, `--session`) are in the same file.
- `npm run test-recording-assembly` also grafts a header onto a MediaRecorder-like tail (VP9, live, 1 s clusters, cut at arbitrary bytes).
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
  screens, incompleteSegments, openSegments, assembling, lastChunkAt, hasFile,
  assemblyRunning, chunksNotInVideo, chunksWaiting, problems, problemCount,
  assemblyError, assemblyAttempts, nextAttemptAt }`
  (`screens` = distinct non-null segment screens; 0/1 = single screen;
  `assembling` is true whenever a segment waits, `assemblyRunning` only while a build really runs;
  `chunksNotInVideo` = unpurged chunk rows in `unreadable` segments, `chunksWaiting` = unpurged rows in `complete`/`incomplete` ones,
  `problems` = up to 10 `{ segmentId, startedAt, state, problem, chunks }` of segments with a `problem` (oldest first, `chunks` =
  all its chunk rows), `problemCount` = how many there are, `assemblyError`/`assemblyAttempts`/`nextAttemptAt` = the session's
  `assembly_error`/`assembly_attempts`/`assembly_next_at`; the counts come from one grouped query per page; legacy rows: zeros,
  empty, null),
  newest first. Legacy sessions: `legacy:true`, `recordingDate:null`, filtered
  by `created_at`.
- `POST /api/recording/sessions/:id/playback-token` (recording access) →
  `{ url }` = `/api/recording/sessions/:id/file?pt=<jwt>` (relative to the API
  base), valid 10 minutes, so a `<video src>` can stream with Range without an
  Authorization header. `pt` is accepted only by the file route and only for
  that session.
- `POST /api/recording/sessions/:id/retry-assembly` (admin only) — see "Stage 4" in section 7. `GET /sessions/:id` segments also carry `problem`.
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
   `Assembling` (a build is running), `Waiting`, `Retrying` + "next try HH:MM" (a failed build backs off), `Ready`, `Incomplete`), **Play** (in-app `<video>` with the
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
A day with `chunksNotInVideo > 0`, an `assemblyError` or `problemCount > 0` shows an amber button (same expand mechanism, `aria-expanded`): "N chunks not in video", else "Build problem", else "N notes" (segments that are in the video but short or grafted). The
expanded row lists the flagged segments (time, reason in plain words, chunks), the last assembly error, "Next try HH:MM" while the
backoff is ahead, and — for admins/superadmins only, when chunks are missing or a build error is set (not for notes only) — a **Retry** button (`POST …/retry-assembly`; disabled while sending; "Retry
started" / "Already being built" / the error text inline; the list reloads). Older backends without these fields show none of it.

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
