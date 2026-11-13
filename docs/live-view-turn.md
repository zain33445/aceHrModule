# TURN relay for live view and calls (coturn on the main server)

Step-by-step setup guide. Everything here was checked against
`nodejs-backend/scripts/setup-coturn.ps1`, `src/services/turn.service.ts`,
`src/gateways/live-hub.ts` and `src/routes/call.routes.ts`. Items marked
**(not verified)** could not be confirmed from the code or a live machine.

## 1. What TURN is for here

Live view (and Voice/Video calls) are WebRTC. Office PCs and the main server share
the LAN, so media goes directly and **no TURN is needed on the office LAN**. A remote
admin on Tailscale reaches signalling through the public domain but has no direct
media path to the office PC, so media is relayed through coturn on the main server.

```
office PC --LAN--> coturn 192.168.18.170:3478 (relay ports 49160-49200/udp)
                         |  one coturn process, relay-ip = LAN address
                   coturn 100.125.119.28:3478 <--Tailscale-- remote admin
```

Why not Tailscale's own relays? DERP servers only forward Tailscale's WireGuard
packets between Tailscale nodes. They cannot hand a browser a TURN allocation, so the
app needs its own TURN server.

The same TURN settings serve live view and calls (`GET /api/call/ice-servers`
and the live hub both call `getIceServers()`).

Plan the setup for a **quiet time**: it needs `wsl --shutdown` and a Docker Desktop
restart, which stops every container on the server. The script itself never does that.

## 2. Prerequisites

- [ ] Windows 11 / Windows 10 22H2+ on the main server. Mirrored networking needs
      WSL 2.0+ on Windows 11 22H2 or later **(version floor from Microsoft docs, not verified here)**.
- [ ] Docker Desktop installed and running, WSL2 backend. Enable host networking:
      Settings > Resources > Network > "Enable host networking" **(menu name not verified)**.
- [ ] `%USERPROFILE%\.wslconfig` of the user running Docker Desktop will contain
      (the script adds it for you):
      ```
      [wsl2]
      networkingMode=mirrored
      ```
- [ ] Tailscale installed and logged in on the main server (`tailscale ip -4` prints
      `100.125.119.28`) and on every remote admin PC, same tailnet.
- [ ] PowerShell **as Administrator** on the main server, repo checked out there.
- [ ] Ports 3478 (UDP+TCP) and 49160-49200 (UDP) not used by anything else.

## 3. Setup with `setup-coturn.ps1`

From the repo root on the main server (elevated PowerShell):

```powershell
.\nodejs-backend\scripts\setup-coturn.ps1
```

Parameters (all optional):

| Parameter | Default | Meaning |
|---|---|---|
| `-LanIp` | `192.168.18.170` | LAN address; coturn listens here and uses it as `relay-ip` |
| `-TsIp` | `tailscale ip -4`, else `100.125.119.28` | Tailscale address; coturn also listens here |
| `-ConfDir` | `C:\coturn` | Folder for `turnserver.conf` |
| `-MinPort` / `-MaxPort` | `49160` / `49200` | UDP relay range (41 ports, roughly one per stream) |
| `-Port` | `3478` | Listening port |
| `-WslConfigPath` | `%USERPROFILE%\.wslconfig` | Use the Docker Desktop user's file if you elevated as a different admin |
| `-Force` | off | Recreate the container even if the config did not change |

What it does, in order:

1. Preflight: must be Administrator, `docker` in PATH and `docker info` working, and
   `LanIp` / `TsIp` must exist on a local interface (else it fails, wrong machine or Tailscale down).
2. Secret: reuses `static-auth-secret` from an existing `C:\coturn\turnserver.conf`,
   otherwise generates 32 random bytes as hex. Writes `turnserver.conf` (UTF-8, no BOM):
   `listening-port`, two `listening-ip` lines, `relay-ip`, `min-port`/`max-port`,
   `use-auth-secret`, `static-auth-secret`, `realm=acehrm`, `fingerprint`, `no-cli`,
   `no-tls`, `no-dtls`, `log-file=stdout`, `simple-log`.
3. Firewall: creates (or updates the port of) inbound allow rules, all profiles:
   `coturn 3478 UDP`, `coturn 3478 TCP`, `coturn relay UDP` (relay range).
4. WSL: ensures `networkingMode=mirrored` under `[wsl2]`, backing up the file to
   `.wslconfig.bak-<timestamp>`. **If it had to change the file it stops with exit code 2**
   and restarts nothing.
5. Container: `docker run -d --name coturn --restart unless-stopped --network host`
   with the conf mounted read-only, image `coturn/coturn`. An existing container is
   recreated only if the config changed or `-Force`, otherwise just started.
6. Verification: waits 5 s, checks the container is running and the log mentions both
   IPs (failure = exit 1, `.env` block still printed). Then a `turnutils_uclient`
   allocation per IP; a failure there is only a warning (no peer, can be a false alarm).
7. Prints the `.env` block (green) and a reminder to restart the backend.

### First run (mirrored networking not yet enabled)

```powershell
.\nodejs-backend\scripts\setup-coturn.ps1      # exits with code 2
wsl --shutdown                                   # QUIET TIME ONLY
# restart Docker Desktop, wait until your containers are back
.\nodejs-backend\scripts\setup-coturn.ps1      # starts coturn, verifies, prints .env block
```

Expected end of output:

```
coturn is up. Paste this into nodejs-backend\.env on the server, then restart the backend:

TURN_SHARED_SECRET=<64 hex chars>
TURN_LAN_HOST=192.168.18.170
TURN_TS_HOST=100.125.119.28
```
(`TURN_PORT=<n>` is also printed if `-Port` is not 3478.)

## 4. Backend `.env`

Paste into `nodejs-backend/.env` and **restart the backend** (values are read once at start):

```
TURN_SHARED_SECRET=<secret>
TURN_LAN_HOST=192.168.18.170
TURN_TS_HOST=100.125.119.28
# TURN_PORT=3478                 only if you changed -Port
# TURN_URLS=...                  optional, overrides the host-built URLs (see 6.4)
# TURN_USERNAME=acehrm           default
# TURN_CREDENTIAL_TTL_SECONDS=3600   default; minimum 60
```

After restart the server sends clients an `iceServers` list:
STUN (`STUN_URLS`, default Cloudflare + Google) plus one TURN entry with URLs
`turn:<LAN>:3478?transport=udp`, `...tcp`, then the same for the Tailscale host
(`TURN_TS_HOST` defaults to `100.125.119.28` even if unset; `TURN_LAN_HOST` has no
default). The credential is minted per request:

- `username = "<expiry-epoch-seconds>:acehrm"`, expiry = now + TTL (default 1 h)
- `credential = base64(HMAC-SHA1(TURN_SHARED_SECRET, username))`

Where it is delivered: `GET /api/call/ice-servers` (calls), and the live hub in
`CONNECTED`, `LIVE_START` (to the agent) and `LIVE_SUBSCRIBED` (to the viewer, fresh
credentials per stream). Without `TURN_SHARED_SECRET` (or `TURN_CREDENTIAL`) no TURN
entry is sent: STUN only, LAN works, remote does not.

## 5. Firewall

The script creates the rules. By hand (elevated):

```powershell
New-NetFirewallRule -DisplayName "coturn 3478 UDP"   -Direction Inbound -Protocol UDP -LocalPort 3478 -Action Allow
New-NetFirewallRule -DisplayName "coturn 3478 TCP"   -Direction Inbound -Protocol TCP -LocalPort 3478 -Action Allow
New-NetFirewallRule -DisplayName "coturn relay UDP"  -Direction Inbound -Protocol UDP -LocalPort 49160-49200 -Action Allow
```

The script does **not** open 49160-49200/TCP: coturn relays media over UDP; TCP only
carries the client-to-coturn leg on 3478. If a Tailscale network profile is "Public",
the rules still apply (created with `-Profile Any`).

Tailscale ACLs: if your tailnet uses ACLs, allow remote admins to reach the main
server on `tcp:3478` and `udp:3478` (and `udp:49160-49200`, since relayed media is
sent to the relay address). Default "allow all" tailnets need nothing **(ACL syntax depends on your policy file, not verified)**.

## 6. Verification

1. Config without a server (no DB):
   ```powershell
   cd nodejs-backend
   npx ts-node src/test-turn-config.ts      # prints: test-turn-config ok
   ```
   (There is no npm script for it. It tests URL building only, not credentials.)

2. What the running server hands out:
   ```powershell
   $t = (Invoke-RestMethod -Method Post http://localhost:5000/api/auth/login `
         -ContentType application/json -Body (@{ username='<you>'; password='<pw>' } | ConvertTo-Json)).token
   Invoke-RestMethod http://localhost:5000/api/call/ice-servers -Headers @{ Authorization = "Bearer $t" } | ConvertTo-Json -Depth 5
   ```
   Expect `turnConfigured: true` and four `turn:` URLs. curl equivalent:
   `curl -H "Authorization: Bearer <token>" http://localhost:5000/api/call/ice-servers`

3. Trickle ICE, with temporary credentials made from the shared secret (valid 1 h):
   ```powershell
   node -e "const c=require('crypto');const s=process.argv[1];const u=(Math.floor(Date.now()/1000)+3600)+':acehrm';console.log('username:',u);console.log('credential:',c.createHmac('sha1',s).update(u).digest('base64'))" <SECRET>
   ```
   On a **remote admin PC on Tailscale** open
   https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/ , remove the
   default server, add `turn:100.125.119.28:3478` with that username/credential, click
   "Gather candidates". A candidate of type **relay** must appear. Repeat from an
   office PC with `turn:192.168.18.170:3478`. Also try `?transport=tcp`.

4. Real test: a remote admin opens Recording > Live and a tile of an online office
   user must go live. `docker logs coturn` shows allocation lines while it streams.

5. UI hints: when the hub is connected but the ICE list contains no `turn:`/`turns:` URL
   (secret not set / backend not restarted), the Live grid shows "Remote viewing
   (outside the office) needs the TURN relay". A tile showing the amber badge
   "Can't reach relay — retrying" means the WebRTC connection failed or timed out
   and it is retrying (see table below).

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Trickle ICE shows no `relay` candidate | Firewall rules missing; mirrored networking not active (wsl --shutdown + Docker restart skipped after exit 2); coturn not listening on that IP | `docker logs coturn` should mention both IPs; recheck rules; re-run the script |
| Grid hint "needs the TURN relay" | `TURN_SHARED_SECRET` unset or backend not restarted | Set `.env`, restart backend, reload the page |
| Badge "Can't reach relay — retrying" | Remote PC cannot reach 3478 or the relay range; wrong/expired credentials; Tailscale down | Test with Trickle ICE; check Tailscale status and ACLs; check coturn log |
| Works on LAN, not remote | No TURN, or `TURN_TS_HOST` wrong, or coturn not bound to the Tailscale IP | `tailscale ip -4` on the server, set `TURN_TS_HOST`, re-run script with `-TsIp` |
| Docker host networking does nothing | Docker Desktop host networking off, or mirrored mode not active; container sees VM addresses | Enable host networking and mirrored mode; else use Fallback A |
| coturn log "401 Unauthorized" | Secret in `turnserver.conf` differs from `.env`, or clock skew (expiry is in the username) | Make secrets identical; sync clocks on server and clients (w32tm /resync) |
| Container exits, "address already in use" | Another process on 3478 (old coturn, WSL service, other TURN) | `netstat -ano \| findstr 3478`, stop it, `-Force` re-run |
| Allocation test warning from script | No peer; often a false alarm | Confirm with Trickle ICE |
| Only TCP gets through (UDP blocked network) | Firewall blocks UDP | The `transport=tcp` URLs are already sent; media over TCP relay still uses the 3478 TCP leg |
| Cannot bind the Tailscale IP | Mirrored mode does not expose the Tailscale adapter | Fallback B |
| Relay allocations fail under load | 41 relay ports exhausted | Widen `-MinPort`/`-MaxPort`, re-run script (updates firewall rule) |

### Fallback A: native coturn in WSL Ubuntu

Use if the container verification fails. Mirrored networking is still required.

```bash
# inside WSL Ubuntu, as root
apt update && apt install -y coturn
# put the same turnserver.conf content (same secret) in /etc/turnserver.conf
sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
service coturn start
```

Run `docker rm -f coturn` first so 3478 is free. WSL does not start services at boot;
add a startup task (elevated PowerShell):

```powershell
$a = New-ScheduledTaskAction -Execute wsl.exe -Argument '-d Ubuntu -u root service coturn start'
Register-ScheduledTask -TaskName coturn-wsl -Action $a -Trigger (New-ScheduledTaskTrigger -AtStartup) -User SYSTEM -RunLevel Highest
```

Firewall rules and `.env` are unchanged. (Whether this survives reboots reliably: not verified.)

### Fallback B: TCP port proxy for the Tailscale side

If coturn cannot listen on the Tailscale address, remote admins can still use TCP:

1. Remove the Tailscale `listening-ip` line from `turnserver.conf` (coturn on the LAN IP only).
2. Elevated:
   ```powershell
   netsh interface portproxy add v4tov4 listenaddress=100.125.119.28 listenport=3478 connectaddress=192.168.18.170 connectport=3478
   New-NetFirewallRule -DisplayName "coturn 3478 TCP Tailscale" -Direction Inbound -Protocol TCP -LocalPort 3478 -LocalAddress 100.125.119.28 -Action Allow
   ```
3. Set `TURN_URLS` in `.env` (overrides the host-built list):
   `TURN_URLS=turn:192.168.18.170:3478?transport=udp,turn:192.168.18.170:3478?transport=tcp,turn:100.125.119.28:3478?transport=tcp`

Note: re-running the script rewrites `turnserver.conf` with both `listening-ip` lines;
re-edit afterwards and `docker restart coturn`.

## 8. Maintenance

- **Logs**: `docker logs -f coturn` (config sends logs to stdout).
- **Rotate the secret**: delete `C:\coturn\turnserver.conf` and re-run the script. It
  generates a new secret, recreates the container and prints the new block; update
  `TURN_SHARED_SECRET` in `.env` and restart the backend. Live streams already open
  keep working until their credentials expire (TTL), new ones need the new secret.
- **Re-run any time**: the script is idempotent; use `-Force` to recreate the container.
- **Update coturn**: `docker pull coturn/coturn`, then re-run the script with `-Force`.
- **Uninstall**:
  ```powershell
  docker rm -f coturn
  Remove-NetFirewallRule -DisplayName "coturn 3478 UDP","coturn 3478 TCP","coturn relay UDP"
  Remove-Item -Recurse C:\coturn
  ```
  Remove the `TURN_*` lines from `.env` and restart the backend. `.wslconfig` is left
  as is (restore from `.wslconfig.bak-*` if wanted, needs `wsl --shutdown` at a quiet time).
  If Fallback A/B was used: `Unregister-ScheduledTask coturn-wsl`, `netsh interface portproxy delete v4tov4 listenaddress=100.125.119.28 listenport=3478`.
