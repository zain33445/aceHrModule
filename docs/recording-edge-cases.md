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
| — | Late chunk for an already-assembled segment (kept on disk, not in the video) | DEFER — rare; bytes are kept; needs append-into-generation design |
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
| — | Backoff jitter, backdrop text-selection close, StrictMode double subscribe (dev only) | DEFER |
