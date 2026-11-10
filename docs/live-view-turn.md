# TURN server for live view (coturn on the Windows main server)

Live view is WebRTC peer-to-peer. Office PCs reach the main server over the LAN;
a remote admin reaches it only over Tailscale, so the two sides cannot connect
directly and need a TURN relay on the main server. Everything in `<ANGLE>` is a
placeholder you must replace. Not tested by the author on your machine: follow
the verification section at the end.

| Placeholder | Meaning | Example |
|---|---|---|
| `<LAN_IP>` | main server LAN address | `192.168.18.65` |
| `<TS_IP>` | main server Tailscale address (`tailscale ip -4`) | `100.101.102.103` |
| `<SECRET>` | long random string, same in coturn and backend `.env` | `openssl rand -hex 32` |

## 1. Networking mode (important)

coturn must see the real source addresses of office PCs and must own the LAN and
Tailscale addresses. Docker Desktop's default bridge network hides source IPs
(NAT) and does not have `<LAN_IP>` inside the container, so relayed media is
silently dropped. Use the WSL2 **mirrored** network instead (Windows 11 22H2+):

```
# C:\Users\<YOU>\.wslconfig
[wsl2]
networkingMode=mirrored
```
Then `wsl --shutdown` and start Docker Desktop (WSL2 backend) again. In mirrored
mode a container started with `--network host` shares the Windows addresses.
(Alternative with the same result: install coturn directly inside a WSL2
distro and run `turnserver -c /etc/turnserver.conf`.)

## 2. turnserver.conf

Save as `C:\coturn\turnserver.conf`:

```
listening-port=3478
listening-ip=<LAN_IP>
listening-ip=<TS_IP>
relay-ip=<LAN_IP>
# external-ip is not needed: office PCs reach <LAN_IP> directly
min-port=49160
max-port=49200
use-auth-secret
static-auth-secret=<SECRET>
realm=acehrm
fingerprint
no-cli
no-tls
no-dtls
log-file=stdout
simple-log
```

The relay range is 41 UDP ports; each live stream uses one, and the viewer cap is
4 streams per agent, so widen it if you watch many users at once.

## 3. Run coturn

```powershell
docker run -d --name coturn --restart unless-stopped --network host `
  -v C:\coturn\turnserver.conf:/etc/coturn/turnserver.conf:ro `
  coturn/coturn -c /etc/coturn/turnserver.conf
```
With `--network host`, `-p` is ignored; the ports in use are 3478 (UDP and TCP)
and UDP 49160-49200. Logs: `docker logs -f coturn`.

## 4. Windows Firewall (elevated PowerShell)

```powershell
New-NetFirewallRule -DisplayName "coturn 3478 UDP" -Direction Inbound -Protocol UDP -LocalPort 3478 -Action Allow
New-NetFirewallRule -DisplayName "coturn 3478 TCP" -Direction Inbound -Protocol TCP -LocalPort 3478 -Action Allow
New-NetFirewallRule -DisplayName "coturn relay UDP" -Direction Inbound -Protocol UDP -LocalPort 49160-49200 -Action Allow
```
Tailscale traffic arrives on the Tailscale interface; if the rules are scoped to
the Private profile, make sure the Tailscale network is not "Public".

## 5. Backend .env (`nodejs-backend/.env`), then restart the backend

```
TURN_URLS=turn:<LAN_IP>:3478?transport=udp,turn:<LAN_IP>:3478?transport=tcp,turn:<TS_IP>:3478?transport=udp,turn:<TS_IP>:3478?transport=tcp
TURN_SHARED_SECRET=<SECRET>
# optional: TURN_USERNAME=acehrm (default), TURN_CREDENTIAL_TTL_SECONDS=3600 (default)
```
The backend mints short-lived HMAC credentials (`<expiry>:acehrm`); the secret
never leaves the server. Agents and viewers receive them in `LIVE_START` and
`CONNECTED`.

## 6. Verify

1. `GET /api/call/ice-servers` (with a login token) returns `"turnConfigured": true`
   and a `turn:` entry with `username`/`credential`.
2. On the **remote admin machine** (on Tailscale), open
   https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/ ,
   remove the default server, add one with the `turn:<TS_IP>:3478` URL and the
   `username` / `credential` from step 1 (they expire after an hour; fetch fresh
   ones), click "Gather candidates". You must see a candidate of type **relay**.
   No relay candidate means coturn is unreachable (firewall, wrong address) or
   the secret differs between coturn and `.env`.
3. Repeat from an office PC with the `<LAN_IP>` URL.
4. In the admin UI, open the Live tab for a user on the office LAN. `docker logs
   coturn` shows `allocation` lines while a stream is open.

Troubleshooting: `401 Unauthorized` in the coturn log = secret mismatch or clock
skew between the PCs and the server (credentials carry an expiry timestamp).
