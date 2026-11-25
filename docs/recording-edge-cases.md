# Recording — edge-case test plan (TDD)

Source: three read-only audits (server, agent, UI) of Phases 1–5, reviewed
against the code. Every item marked **FIX** gets a failing test first (RED),
then the smallest change that makes it pass (GREEN). Items marked **DEFER**
are known, low impact, and recorded here on purpose.

Hard rule: a recorded chunk is never lost, refused or overwritten.

**Status (2026-11-10):** every FIX item is implemented. Server: 31 checks were
red before the fixes, `test-recording-edge-e2e` is now 51/51 (plus S14:
all `/api/employees` routes require a session, `password_hash` never returned).
Agent: 36 checks were red, all 9 `electron/*.check.mjs` now pass. UI: verified
in the browser (playback token refresh resumes at the same position,
streamed download, retention confirm, revoked-access terminal state with no
background retries). Design change during GREEN: S5 clamps only dates more
than 365 days in the past (old offline backlog keeps its real day).

## Server (`nodejs-backend/src/test-recording-edge-e2e.ts`, live server + DB)

| ID | Edge case | Expected behaviour | |
|---|---|---|---|
| S1 | Chunk file stored but DB row missing (crash between link and insert), agent re-sends same bytes | Row is healed (inserted), segment state recomputed — not a bare "duplicate" | FIX |
| S2 | A stored chunk's file is missing on disk when assembling | Segment is NOT committed/purged; session gets `assembly_error`; previous generation untouched | FIX |
| S3 | Malformed optional headers (`X-Captured-At`, `X-Duration-Ms`, `X-Logged-Out`) | Chunk stored (201) with null/default metadata, warning logged — never refused | FIX |
| S4 | Segment left `open` forever (agent crashed, never closed) while the session keeps receiving other segments | After 30 min without a chunk for *that segment*, it is closed with `lastSeq` = highest stored seq (gaps → `lost_seqs`) and becomes assemblable | FIX |
| S5 | Agent clock wrong: `startedAt` in 1970 / 2099 | Clamped to server receipt time when outside [now − 30 days, now + 1 day]; logged | FIX |
| S6 | Retention would delete a session that still has unassembled segments or chunks received in the last 7 days | Not deleted (skipped and logged) | FIX |
| S7 | HR viewer's grant revoked (or account deactivated) while the viewer socket is open | Next `LIVE_SUBSCRIBE` → `LIVE_REJECTED not_allowed`; access re-checked every 5 min and the socket closed (4003) when gone | FIX |
| S8 | Viewer (`admin-ws`) and playback (`pt`) tokens signed with the public default agent secret | Both are signed/verified with `JWT_SECRET` (session secret); tokens signed with the agent default secret are rejected | FIX |
| S9 | Deactivated user or admin uploads with a still-valid agent token | Segment registration → 403 (agent parks it, bytes stay on the PC); `CONNECTED.record` false for inactive users | FIX |
| S10 | `GET /api/employees` is unauthenticated and returns `password_hash` | Requires a signed session; `password_hash` never returned by any employee route | FIX |
| S11 | Assembly keeps failing; every `<video>` Range request re-runs ffmpeg | On-demand assembly respects the same backoff as the sweeper | FIX |
| S12 | Viewer needs fresh TURN credentials after 1 h | `LIVE_SUBSCRIBED` carries fresh `iceServers` | FIX |
| S13 | Download of a whole day as a blob (≈2 GB in browser memory) | `GET …/file?pt=…&download=1` → `Content-Disposition: attachment` so the browser streams to disk | FIX |
| S17 | Late chunk for an already-assembled segment (its seq 0 header was purged with the generation) | Accepted and re-opens the segment. A tail that starts with its own WebM header is used as it is; one that does not gets the segment's own `init_data` (bytes of seq 0 before its first Cluster), else a donor's, and is remuxed (frames before its first keyframe are dropped). The late chunk is in the video, in time order (generation + 1), its row is purged | FIX |
| S18 | A one-chunk segment without a single frame is the first of the day | The others assemble (generation 1); the frameless segment is `unreadable` (`no readable video`), its chunk row and file are kept; `assembly_error` names it | FIX |
| S19 | An unreadable segment (not WebM at all) comes after good ones | Good ones assemble and are purged only after they are in the video; the junk is `unreadable` with all chunks kept; a second run changes nothing | FIX |
| S20 | A keyframe-less segment (header + delta cluster) in the middle; a day where nothing is readable | Zero video packets = unreadable, the rest assembles. A run that commits no video does not throw, does not create a generation and does not reset `assembly_attempts` | FIX |
| S21 | The video plays far less than the chunks' `duration_ms` add up to | What plays is in the generation; the segment is `assembled` with `problem = only X of Y min readable`; chunk rows get `purged_at` but the chunk files stay on disk | FIX |
| S22 | A chunk arrives between the assembly snapshot and its commit | It is never purged unseen: its row stays unpurged, its file stays (and, because a chunk is pending, so do the segment's earlier chunk files), its segment is pending again; the next run rebuilds the whole segment, so the chunk ends up in the video | FIX |
| S23 | Several due sessions, one assembly slot; a finished day that is still receiving a backlog | One pump starts one run; every run end starts the next without waiting for the 5-min sweep. Failing sessions back off (`assembly_next_at`) and untried ones go first (`pickAssemblies`). A session is due when idle >= 30 min, or its day is over (+30 min) AND its last chunk is >= 5 min old (`assemblyDue`), so a backlog upload is not rebuilt per chunk (31 whole-day generations on the live server before) | FIX |
| S24 | Segments that are readable but will not join | The list is split in halves on top of the last good file; the rest still joins; a lone culprit gets one re-encode and one more try, else it is `unreadable` (`could not be joined`) with its chunks kept | FIX |
| S21b | Chunks claim 30 s, 3 s plays; a chunk claiming 10 min | Flagged `only X of 0.5 min readable` (tolerance is max(15 s, 1 %), the old 10 % hid 6 min of an hour); a chunk counts at most 60 s (`of 3.0 min`, not 30) | FIX |
| S25 | ffmpeg missing / killed / disk full (certain infrastructure) | The run throws (backoff); no segment becomes `unreadable`; once ffmpeg works the same data assembles | FIX |
| S29 | One segment makes ffmpeg print `Input/output error` / `Cannot allocate memory` / `Permission denied` (also printed for corrupt media) | Runs 1–3 throw (attempts 1–3, nothing flagged); from the 4th run that segment is `unreadable` (`ffmpeg: …`, chunks kept) and the rest of the day is published | FIX |
| S26 | New chunk for an `unreadable` segment (HTTP, or arriving during the run that flagged it) | Segment back to `complete`/`closed`, `problem` cleared | FIX |
| S27 | Joins keep failing (odd first segment; many culprits) | At most 3 re-encodes / 3 flagged per run; the rest stays `complete` and the session backs off. With no previous generation and nothing joining onto the first segment, the longest segment is published alone and the next run joins the others on top of it | FIX |
| S28 | `duration_ms` in the DB is far above the real file | Next generation uses the measured length and succeeds | FIX |
| S11b | A failure used `updated_at` for the backoff, so unrelated updates moved it | `assembly_next_at` = now + backoff(attempts); a new chunk for the session clears it and the attempts | FIX |
| S30 | A segment is abandoned early (30 min without a chunk), assembled, then the rest arrives and the agent closes it | The abandoned run keeps the chunk FILES (not agent-closed). When the rest arrives, all earlier files are still on disk and the segment has a part of its own: the whole segment is rebuilt (its part is replaced, no header problem, no duplicate frames), then the files are deleted | FIX |
| S30c | The kept chunk files of a segment rot (or are partly unreadable) and a late chunk triggers its rebuild | A rebuilt segment never replaces its old parts with less video (duration >= sum - 2 s, packets >= sum): the old part stays in the manifest and on disk, the late chunk alone is appended as a tail, no chunk file is deleted | FIX |
| S31 | Late chunks after the segment's files were deleted (agent-closed, complete, covered) | Grafted onto the segment's own `init_data`: the tail part is in the video in time order, its rows are purged but its files KEPT (frames before its first keyframe are not in the video); `problem` says it used its own header | FIX |
| S31b | A still screen: MediaRecorder's seq 0 is ONE byte and the WebM header continues in seq 1 (or later); the Cluster id can be cut between two chunks | `init_data` is built from chunks 0, 1, 2, … (contiguous, at most 64 KB) up to the first Cluster, tried again at every ingest of seq <= 5 while it is NULL (and at assembly for older segments); donors use their first chunk files the same way; a tail whose first stored chunk lies inside the header is cut at its first Cluster id before the header is put in front (unit-tested at every byte offset around the Cluster id, in `test-recording-queue`) | FIX |
| S32 | The same, but the segment has no `init_data` (older than this release) | Header borrowed from a donor: same user, mime, width, height, nearest start, `init_data` or a seq-0 file on disk; accepted only if the remux plays and 3 s decode without errors; `problem` says donor | FIX |
| S33 | A segment that started before the others arrives after them | The day is concatenated again from its parts in start order (verified: colours at 1 s / 3 s / 5 s, manifest order). If that ordered join fails (S33b), the segment is appended to the generation, the parts collapse and nothing is lost | FIX |
| S33c | The ordered join of the parts fails while a rebuilt segment is part of it | The rebuilt segment is reduced to its late chunks, appended to the generation, the manifest collapses to the generation and the old part files go after the commit; nothing is lost and nothing is duplicated | FIX |
| S34 | The first segment of the day is tiny (320x180) and most of the day is 640x360 | Reference size = the size with the largest total duration (sizes under 640 wide only when nothing else); a day already generated under 640 wide is re-encoded once when clearly more material of a proper size arrives (S34b); otherwise the base's size | FIX |
| S34c | The earlier (under 640 wide) video cannot be re-encoded to the new majority size | The new material is scaled to the base's size instead (generation keeps 320x180, everything assembled, nothing flagged) | FIX |
| S35 | Parts of old days / low disk | Parts older than `RECORDING_PARTS_KEEP_DAYS` (4) collapse into the generation file (manifest = one base item, part files deleted, generation untouched); below `RECORDING_PARTS_MIN_FREE_GB` (20) no parts are created and existing ones collapse. A new segment on a collapsed day keeps the old generation as a base part (hard link) | FIX |
| S36 | The server dies after the new parts were moved but before the DB commit | The committed manifest and every file it names are untouched; new parts sit unreferenced in `parts/` and are removed by the sweep once older than 1 h (never before, never a referenced file); chunks are not purged; the retry succeeds | FIX |
| S37 | Kept chunk files | Deleted when the agent has closed the segment and everything is in the video and complete (also when the close arrives after assembly, by the sweep), or 16 days after the last chunk of a segment nobody closed. A segment with a `problem` (short coverage, grafted tail) keeps its files | FIX |
| S38 | Segments stage 1 flagged `late chunks without their header` | Once per boot they are made assemblable again and now graft | FIX |
| S39 | Admin presses Retry on a day with unreadable segments (`POST /sessions/:id/retry-assembly`) | Admins only (no token 401, employee 403, HR grant 403); unknown/legacy session 404; while a run is going 409 `already_assembling` and nothing changes; otherwise 202 `{ revived, pending }`, the unreadable segments with unpurged chunks go back into the queue, attempts/backoff/error are cleared and the day is rebuilt in the background. No chunk is touched | FIX |
| S40 | The days list must say why a day is incomplete | `GET /days` adds `chunksNotInVideo`, `chunksWaiting`, `problems` (max 10), `problemCount`, `assemblyError`, `assemblyAttempts`, `nextAttemptAt`, `assemblyRunning` from one grouped query per page; legacy rows get zeros/null; every old field is unchanged; `GET /sessions/:id` segments carry `problem` | FIX |
| S41 | Sessions stuck from the old code, or a chunk file whose row was lost | `npm run repair-recordings`: dry run by default; `--apply` needs `--yes` and prints the database host and `RECORDINGS_DIR`; revives unreadable segments, adds the missing chunk row of a file on disk (file untouched) and re-evaluates the segment (files modified in the last 10 min are skipped: the server may be between file and row); unknown segment folders, collision files, a missing generation file and a video shorter than recorded are only reported; `--session`/`--user` limit it; nothing is deleted | FIX |
| — | Legacy (v1) edge cases #24–26, `/days` unbounded range, file-route stat race, admin `stop` on v2 sessions, duplicate subscribe dedupe, gateway status listing admins | DEFER — low impact |

## Agent (`frontend/electron/*.check.mjs`, node, real fs + local fake HTTP server)

| ID | Edge case | Expected behaviour | |
|---|---|---|---|
| A1 | Chunk write fails (ENOSPC / EPERM from an AV lock) | Bytes kept in memory and retried with backoff (bounded memory); ENOSPC → `disk_low`; watchdog not fooled | FIX |
| A2 | Chunk arrives after its segment was closed / for a segment no longer in memory | Written into the segment's own folder (found on disk), `lastSeq` raised, close re-sent; never an invisible `_orphan` folder | FIX |
| A3 | Segment owner's token missing (user switched, token cleared) | Segment parked; NEVER uploaded with another user's token; other segments keep flowing | FIX |
| A4 | Persistent 4xx (409/413/422) or 400 with a matching sha on one segment | That segment parked; the lane continues with later segments | FIX |
| A5 | 2xx response without a JSON `{ok:true}` body (captive portal / proxy) | Chunk NOT marked uploaded | FIX |
| A6 | `segment.json` corrupt/unreadable | Rebuilt from the folder (segmentId, userId) and chunk metadata; logged; uploads continue | FIX |
| A7 | `agent-token.json` corrupt | Atomic writes + `.bak`; a file that failed to parse is never overwritten; tokens/policies recovered from `.bak` | FIX |
| A8 | Sync reads a chunk while its `<seq>.json` is still being written | Fresh chunk without metadata skipped this pass (no fake `loggedOut:false`) | FIX |
| A9 | User switches to someone never seen / token unobtainable | Recording paused for the new user (not attributed to the previous user); session token set before user id | FIX |
| A10 | `LIVE_STOP` arrives while the live capture is starting | No leaked peer/capture; stream reported closed | FIX |
| A11 | `CONNECTED` without `recordingDay` | Previous cached rule kept | FIX |
| A12 | PC clock skewed | `startedAt` corrected with the `serverTime` offset | FIX |
| A13 | Capture keeps failing (permission denied) → empty segments | Zero-chunk closed segments are not registered; folder removed | FIX |
| A14 | Multi-monitor: `sources[0]` not the primary display | Source chosen by `display_id` = primary display, fallback `sources[0]` | FIX |
| A15 | One segment keeps failing while others are fine (chunk / register / close answering 500, or 404 other than `segment_not_registered`, 3× in a row) | That segment is parked 5 min (counter resets on any success); the other segments continue. Server-wide trouble (network, 408, 429, 502-504, 520-530) never parks: the whole lane keeps today's backoff. 400 on close parks 30 min | FIX |
| A16 | 401 on a segment whose owner is not the signed-in user (or whose refresh failed) | `refresh(userId)` is called; if `tokenFor(userId)` is still the same token the segment is parked (`auth`) until the token differs (checked every scan; retried anyway after 30 min), the others continue. A refresh that produced a new token retries at once | FIX |
| A17 | A chunk is stored while the segment is being uploaded or closed (the scan lists the folder before it reads `segment.json`) | Before the close the folder and `segment.json` are re-read: an unsent `.webm` means no close, the segment is picked up again. `closed.ok` is written (inside the spool lock) only if no unsent `.webm` exists; `writeChunk` removes `closed.ok` whenever it stores a chunk | FIX |
| A18 | `closed.ok` next to a chunk that was never uploaded (left by the old race) | Once at start the folder loses `closed.ok` (logged) and the chunk is uploaded, then the close is repeated | FIX |
| A19 | The A13 cleanup meets a folder with a `.webm.tmp` or a pending chunk write | Folder is not removed (also not while `writeChunkReliable` holds bytes or a spool operation is queued) | FIX |
| A20 | Recording at 320x180 / 640x360 / 1366x768 / 1728x1080: the 320x180 warm-up capture, or the live-view capture of the same screen, is open while the recorder starts, so Chromium hands the recorder that open capture's size (smaller, or another aspect ratio) while `getSettings()` still says the preset | Warm-up is queued with begin/stop and skipped once a capture exists. The live capture is always a 16:9 box (1920x1080 / 2560x1440 / 3840x2160, the smallest containing the screen; `nativeCaptureSize`), which leaves the 1080p, 720p and 480p presets intact; other aspect ratios are letterboxed in live view. After every capture is acquired one real frame is measured; a different size releases and re-acquires (3 tries, 0.4 s·n apart, logged `Capture size …`), then records anyway; segment width/height are the real frame size. A capture that stayed at a wrong size is retried at the next rotation (2 tries, about 0.5 s gap at most); with the right size rotation stays gapless. Verified with real Electron: `npx electron electron/capture-size.check.cjs` (warm-up and live-box scenarios for 3 presets, rotation gaps) | FIX |
| — | Quit flush budget 4 s, restart-delay reset, rotation up to 10 s late, duplicate live answer | DEFER — low impact |

## UI (no React test harness in the repo → verified in the browser pane)

| ID | Edge case | Expected behaviour | |
|---|---|---|---|
| U1 | Playback open > 10 min then seek | Fresh playback token on error; resume at the same position | FIX |
| U2 | Download as blob (memory, token refresh not applied to blobs) | Use the `download=1` playback URL (browser streams to disk) | FIX |
| U3 | Viewer without access (403) | Terminal "no access" state, no reconnect loop | FIX |
| U4 | Half-open viewer socket | No PING for 65 s → reconnect | FIX |
| U5 | ICE credentials stale | Use `iceServers` from `LIVE_SUBSCRIBED` | FIX |
| U6 | Late playback response after closing the modal; department filter stuck on a vanished department; retention change without confirmation; default dates in browser time vs Asia/Karachi; from > to; stale error banner; `offline` rejection never retried | Each handled (request id guard, reset filter, confirm dialog with cut-off date, Karachi dates, input clamp, clear error, retry `offline` after 10 s) | FIX |
| U7 | A day has chunks that are not in its video, a build error, or notes on segments; or its build is waiting / backing off | Amber button ("N chunks not in video" / "Build problem" / "N notes") expands the row: flagged segments (time, plain reason, chunks), last error, "Next try HH:MM"; status `Waiting` (nothing building) / `Retrying` + next time instead of a false `Assembling`; **Retry** only for admins/superadmins and only with missing chunks or an error (disabled while sending, inline success/error, 409 "Already being built", list reloads); an older backend without the new fields shows none of it | FIX |
| — | Backoff jitter, backdrop text-selection close, StrictMode double subscribe (dev only) | DEFER |
