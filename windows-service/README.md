# aceHRM Windows Device Service (Phases 1–2)

This directory contains the Windows device service. It is **not installed, started, or packaged** by the repository build. It owns the machine-level device identity, inventory, and security-baseline policy enforcement that later remote-control work will build on.

The service does **not** capture the screen, inject input, or execute remote-control commands. `DEVICE_COMMAND` messages are acknowledged as failed. Phase 2 adds read-only policy checks plus opt-in enforcement of BitLocker, firewall, screen lock, USB storage, local administrator, password, and Windows Update settings, plus admin rights removal, browser website blocking, `.msi` install blocking, and flagged software reporting.

## Architecture

```
Backend API + /device-ws
        ^ HTTPS / WSS
        |
windows-service (runs as LocalSystem after install)
  - device identity + token refresh
  - heartbeat + inventory upload
  - device WebSocket client
  - local named pipe \\.\pipe\acehrm-device-service
        ^
        | newline-delimited JSON (local only)
        |
Electron agent (per-user session, frontend/main.js)
```

The service and the Electron agent are separate processes. The service owns the machine device identity; the Electron agent can connect to the local pipe to report its status and, later, receive remote-control commands. The existing Electron agent (`frontend/main.js`, `frontend/electron/ws-client.js`) is unchanged in Phase 1 and does not connect to the pipe yet.

## Files

| File | Purpose |
|---|---|
| `src/service.js` | Entrypoint, startup/shutdown, logging, orchestration |
| `src/config.js` | Environment + `C:\ProgramData\aceHRM\device-service.json` configuration, paths, service metadata |
| `src/identity.js` | Stable `device_key`, MachineGuid lookup, OS identity, ACL-protected credential storage, optional DPAPI |
| `src/enroll.js` | Enrollment, token refresh, heartbeat, 401 recovery |
| `src/ws-client.js` | `/device-ws` client, AUTH, reconnect with backoff + jitter, heartbeat/inventory scheduling |
| `src/inventory.js` | Bounded Windows inventory collection + upload |
| `src/policy.js` | Security-baseline collection, evaluation, enforcement, and compliance reporting |
| `src/named-pipe.js` | Local named-pipe bridge for the Electron agent |
| `src/install.js` | Registers the service directly with the bundled WinSW (LocalSystem, restart on failure); uninstall restores policy settings first |
| `src/http.js` | JSON/fetch helpers with timeouts and HTTP error status |
| `src/logger.js` | Install-safe file logging with fallback |
| `scripts/check.js` | `node --check` over every service JS file |

## Requirements

- Windows 10/11 or Windows Server
- Node.js 20 or newer (this scaffold was checked with Node 24)
- No .NET SDK is required. MachineGuid is read with built-in PowerShell.
- `npm install` in `windows-service/` before running locally or installing the service. Runtime dependencies are `ws` and `node-windows`.
- Only the WinSW executable bundled in `node-windows` is used, not its install code, whose elevation helper hangs when there is no desktop to answer it. WinSW needs the built-in .NET Framework runtime (not the .NET SDK) on the target machine. Normal Windows 10/11 and Windows Server installations include it.

## Configuration

Primary config file:

```
C:\ProgramData\aceHRM\device-service.json
```

Example:

```json
{
  "apiBase": "https://api.theaceservices.site/api",
  "enrollmentToken": "one-time-enrollment-token",
  "heartbeatIntervalMs": 60000,
  "inventoryIntervalMs": 900000,
  "logLevel": "info",
  "pipeName": "acehrm-device-service"
}
```

Environment overrides (highest priority):

| Variable | Purpose |
|---|---|
| `ACEHRM_API_BASE` | Backend API base, e.g. `https://api.theaceservices.site/api` |
| `ACEHRM_WS_URL` | Optional explicit device WebSocket URL (otherwise derived from the API base) |
| `ACEHRM_ENROLLMENT_TOKEN` | Enrollment token, used only when enrollment is required |
| `ACEHRM_DEVICE_DATA_DIR` | Override the ProgramData root (useful for local tests) |
| `ACEHRM_HEARTBEAT_INTERVAL_MS` | Heartbeat interval |
| `ACEHRM_INVENTORY_INTERVAL_MS` | Inventory interval |
| `ACEHRM_ENROLLMENT_RETRY_MS` | Retry interval after enrollment failure |
| `ACEHRM_HTTP_TIMEOUT_MS` | HTTP request timeout |
| `ACEHRM_LOG_LEVEL` | `debug`, `info`, `warn`, or `error` |

The default API base is `https://api.theaceservices.site/api`. Derived WebSocket URL is `wss://api.theaceservices.site/device-ws`. Set `wsUrl` in the config file (or `ACEHRM_WS_URL`) to override the derivation when the API and WebSocket hosts do not share the default `/api` layout.

Runtime paths:

```
C:\ProgramData\aceHRM\device-service.json      configuration (admin-managed)
C:\ProgramData\aceHRM\state\identity.json      device_key + machine identity
C:\ProgramData\aceHRM\state\credentials.json   device_id + device token
C:\ProgramData\aceHRM\logs\device-service.log  service log (rotated at 5 MB)
```

If ProgramData logging is unavailable, the logger falls back to `windows-service/logs`, then the system temp directory. The config file contains the enrollment token; restrict it to Administrators/SYSTEM.

## Enrollment and device identity

A PC enrolls when a user signs in to the aceHRM app on it, and is assigned to that user:

1. On first start the service loads or creates `identity.json` with a random stable `device_key` (UUID), reads `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` through PowerShell, and waits.
2. When a user signs in, the app gets a signed login grant from `POST /api/device/login-grant` (5-minute lifetime) with their session, and passes it to the service over the local pipe as `agent:login`.
3. The service calls `POST {apiBase}/device/enroll` with `login_grant`, `device_key`, `hostname`, `machine_guid`, `os_name`, `os_version`, and `agent_version`. The backend verifies the grant and sets both `assigned_user_id` and `last_user_id`.
4. The service persists `device_id` and `device_token` in `credentials.json`, and uses the token for `/device/heartbeat`, `/device/inventory`, `/device/policy`, `/device/policy/status`, `/device/token/refresh`, and the `/device-ws` AUTH message.
5. Each later sign-in sends a new grant to `POST /device/user-login`, which updates `last_user_id`. The first user stays assigned.

The pipe is writable by every local user, because the app runs as a normal user and the service as SYSTEM. Nothing sent over it is trusted: only the backend can verify a grant, and the app can't change which server the service uses. The service only learns its server from `apiBase`.

An admin `enrollmentToken` in the config file still works, for enrolling before anyone signs in; the first sign-in then assigns the user. On a 401 the service refreshes the device token. If that is rejected, it re-enrolls at the next sign-in, or straight away if a token is configured. Tokens and grants are never logged.

MachineGuid is stored raw in `identity.json`; the backend is responsible for hashing it if desired.

## Run in console mode

```powershell
cd D:\ACE-HRM-dev\windows-service
npm install
$env:ACEHRM_ENROLLMENT_TOKEN = '...'
npm start
```

`npm start` passes `--console`, so logs also go to stdout. `npm run start:service` runs the service entrypoint without console output. Neither command installs or starts a Windows service.

## Install / uninstall as a Windows service

Run an elevated PowerShell in `windows-service/` after `npm install`:

```powershell
npm run install-service
```

This registers the `aceHRMDeviceService` service (display name: `aceHRM Device Service`) running as **LocalSystem** with automatic start, and writes its WinSW files to `windows-service/daemon/`. Windows restarts it about 10 seconds after a failure, whether the node process or the service host died; if the host is killed, node exits within 5 seconds so no second copy is left running. Without an elevated prompt the command fails with an error. The service reads configuration from ProgramData, not from the command line. Only `ACEHRM_API_BASE` and `ACEHRM_DEVICE_DATA_DIR` are passed through from the install environment; put the enrollment token and other settings in the ProgramData config file rather than in the service wrapper metadata.

To remove it:

```powershell
npm run uninstall-service
```

Uninstall stops the service, restores every setting in `state/policy-ledger.json` (BitLocker is never reverted), then removes the service. A setting that can't be restored is reported, keeps its ledger entry, and makes the command exit non-zero. It leaves the device identity and credentials in place.

These commands are intentionally not executed by this scaffold. The installer packaging path is documented in [`../frontend/build/SERVICE-INSTALL.md`](../frontend/build/SERVICE-INSTALL.md).

## Device WebSocket protocol (Phase 1)

- On open the service sends `{ "type": "AUTH", "token": "<device_token>" }`.
- On `CONNECTED` it sends `DEVICE_STATUS` with `status`, `phase`, `device_id`, `hostname`, `agent_version`, `agent_connected`, and the last agent status.
- `PING` is answered with `PONG`.
- `DEVICE_COMMAND` for `lock`, `restart`, and `shutdown` is executed locally and answered with `DEVICE_COMMAND_ACK` status `completed` or `failed`. Other command types remain unsupported until Phase 4 (remote control).
- Reconnects use exponential backoff (2 s to 60 s) with 20% jitter.
- Heartbeat and inventory run on scheduled timers while authenticated. A 401 triggers token refresh and a WebSocket restart.

## Security-baseline policy (Phase 2)

After each authenticated heartbeat, the service calls `GET /api/device/policy`. The backend resolves the effective policy for the device (lowest priority wins; a device assignment beats a group assignment at the same priority) and returns only `active` security-baseline policies.

The service then:

1. Collects local state with read-only PowerShell: BitLocker, firewall profiles, `InactivityTimeoutSecs`, removable-storage `Deny_All`, the built-in Administrator account, local Administrators, password policy, Windows Update policy/service state, the `web_filter` browser policy keys, the `software_install` Windows Installer policy, the `firewall_notifications` profile values, and the installed-software list (names and versions, up to 300 apps, sent with the inventory).
2. Evaluates the policy and, in `enforce` mode, applies the failing settings.
3. Re-collects state and posts `compliant`, `non_compliant`, `applied`, or `failed` to `POST /api/device/policy/status` with per-check results.

`audit` mode never changes a device. A failed check is retried no more often than every five minutes. The same policy is not re-applied while its hash and compliant/applied status are unchanged.

Enforcement is intentionally limited to LocalSystem-capable, idempotent settings:

- BitLocker system-drive protection (TPM protector; `UsedSpaceOnly`)
- Windows Firewall profile enablement
- Machine inactivity limit
- Removable-storage `Deny_All`
- Built-in Administrator disablement
- Local password length/age/lockout via `net accounts`
- Windows Update policy keys and the `wuauserv` service
- Website blocklist through Chrome, Edge, Brave, and Firefox policy keys (`web_filter`)
- Windows Installer `.msi` blocking for everyone, lifted only during console-pushed installs (`software_install`)
- Hiding the "Windows Firewall has blocked this app" notifications with `DisableNotifications=1` on the three WindowsFirewall policy profile keys; blocked apps stay blocked (`firewall_notifications`)

Console-pushed software installs first add a validly signed installer's signer to `LocalMachine\TrustedPublisher` (best-effort, left in place) so that publisher's drivers install without a prompt. UAC is not suppressed: installs run as SYSTEM, so a UAC prompt means the installer launches something on the desktop and needs the vendor's silent options.

## Device command execution (Phase 3)

Phase 3 turns the queued `lock`, `restart`, and `shutdown` commands into real
actions on the managed workstation:

- `lock` runs `rundll32.exe user32.dll,LockWorkStation` as the signed-in user through a throwaway scheduled task, because the call does nothing from SYSTEM's session 0. It reports `failed` if nobody is signed in or `LogonUI` doesn't appear.
- `restart` runs `shutdown.exe /r /t 0 /f`.
- `shutdown` runs `shutdown.exe /s /t 0 /f`.

Commands arrive over `/device-ws` as `DEVICE_COMMAND`, are executed by the
service (which runs as LocalSystem), and acknowledged with
`DEVICE_COMMAND_ACK` carrying `completed` or `failed` plus a result message.
Unsupported command types are acknowledged as `failed` with
`UNSUPPORTED_COMMAND`.

## Local named-pipe protocol

The service listens only on `\\.\pipe\acehrm-device-service`. It is not a TCP listener.

Newline-delimited JSON, one object per line. On connect the service sends:

```json
{ "type": "bridge:hello", "pipe": "acehrm-device-service", "protocol": 1 }
```

Accepted from the Electron agent:

- `{ "type": "agent:status", "status": "..." }`
- `{ "type": "agent:inventory", ... }`
- `{ "type": "ping" }`

Responses:

- `{ "type": "bridge:ack", "received": "agent:status" }`
- `{ "type": "pong" }`
- `{ "type": "bridge:error", "error": "invalid_json" | "invalid_message" | "unsupported_type" }`

`NamedPipeBridge.sendToAgent(message)` broadcasts to connected agent clients for future remote control. Phase 1 does not call it from command handling.

## Security limitations (Phases 1–2)

- **Token storage:** `credentials.json` is ACL-restricted to SYSTEM, Administrators, and the account that created it. If the optional native `win-dpapi` module is present (`npm install win-dpapi`), the token is additionally protected with **machine-scope** DPAPI; otherwise it remains plaintext inside the ACL-protected file. Machine scope is deliberate so the LocalSystem service can decrypt a token enrolled interactively (and vice versa), but any local account that can read the file can also decrypt it; the ACL remains the primary boundary. DPAPI is not a dependency because native module builds can fail.
- **Named-pipe ACL:** Node cannot apply a custom security descriptor to a named pipe at creation. The pipe inherits the creator's default DACL; when the service runs as LocalSystem, a normal-user Electron process may be unable to open it. Running `npm start` in the same user context works for local testing. Production access requires a pipe-security follow-up (native helper, broker, or authenticated ACL setup).
- **Service account:** LocalSystem is highly privileged. A later phase should evaluate a dedicated low-privilege service account or a scoped helper.
- **Service stop:** WinSW controls service stop/restart. The SIGINT/SIGTERM graceful-shutdown path is exercised in console mode, but Windows service stop may terminate the process before those handlers run. Validate shutdown behavior on a test machine before relying on it for durability.
- **Installer/signing:** the code-signing certificate is not available yet. Local installer builds must continue to work unsigned. Never enable `forceCodeSigning` for local builds.
- **Network:** HTTPS/WSS relies on the OS certificate store; there is no certificate pinning.
- **Policy enforcement:** the service must run elevated (LocalSystem) to read BitLocker/security policy and apply changes. Enforcement has only been validated read-only in the development environment; test on a disposable Windows VM before production. BitLocker requires a TPM and may start encryption; password and Windows Update changes affect the whole machine.
- **Policy reporting:** compliance is reported from the device's own local state. The backend trusts the device token and does not independently verify the checks.
- **Scope:** no screen capture, input injection, process control, file transfer, or remote command execution.

## What remains for remote control

- Electron-agent pipe client integration (the existing agent is deliberately untouched in Phase 1).
- Authenticated Electron-agent connection to the named pipe under a restricted DACL.
- End-to-end command routing: backend `DEVICE_COMMAND` -> service -> pipe -> Electron agent -> ACK result.
- Screen capture / input injection implementation.
- Agent presence and capability reporting in inventory.
- Signed service binaries and per-machine installer integration.
- Service account hardening, pipe ACL tests, and audit logging.
- Policy enforcement validation on a disposable Windows VM with TPM/BitLocker and a LocalSystem service install.

## Verification commands

```powershell
cd D:\ACE-HRM-dev\windows-service
npm run check
node -e "require('./src/config')"
node -e "require('./src/identity')"
```

`npm run check` runs `node --check` on every service JavaScript file. It does not require `npm install`; running the service does.
