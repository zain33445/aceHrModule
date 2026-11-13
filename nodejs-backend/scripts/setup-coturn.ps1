<#
.SYNOPSIS
  Sets up the coturn TURN relay (Docker, host networking) on the aceHRM main server.
.DESCRIPTION
  Run as Administrator ON THE MAIN SERVER. Re-runnable. See docs/live-view-turn.md.
  Never restarts WSL or Docker: if mirrored networking had to be enabled it stops
  with exit code 2 so you can restart them at a quiet time.
#>
param(
    [string]$LanIp = '192.168.18.170',
    [string]$TsIp = $(
        $ts = Get-Command tailscale -ErrorAction SilentlyContinue
        if (-not $ts -and (Test-Path 'C:\Program Files\Tailscale\tailscale.exe')) { $ts = 'C:\Program Files\Tailscale\tailscale.exe' }
        $ip = $null
        if ($ts) { $ip = (& $ts ip -4 | Select-Object -First 1) }
        if ($ip) { "$ip".Trim() } else { '100.125.119.28' }
    ),
    [string]$ConfDir = 'C:\coturn',
    [int]$MinPort = 49160,
    [int]$MaxPort = 49200,
    [int]$Port = 3478,
    # Must be the .wslconfig of the user who runs Docker Desktop (differs if elevated as another admin).
    [string]$WslConfigPath = (Join-Path $env:USERPROFILE '.wslconfig'),
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Realm = 'acehrm'
$ConfFile = Join-Path $ConfDir 'turnserver.conf'

function Fail($msg) { Write-Host "ERROR: $msg" -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }

# Run docker with stderr merged (cmd avoids PS 5.1 NativeCommandError); output as one string.
function Docker([string]$cmdArgs) {
    $out = cmd /c "docker $cmdArgs 2>&1"
    return @{ Code = $LASTEXITCODE; Out = ($out -join "`n") }
}

function Show-EnvBlock([string]$heading, $color) {
    Write-Host "`n$heading`n" -ForegroundColor $color
    Write-Host "TURN_SHARED_SECRET=$secret"
    Write-Host "TURN_LAN_HOST=$LanIp"
    Write-Host "TURN_TS_HOST=$TsIp"
    if ($Port -ne 3478) { Write-Host "TURN_PORT=$Port" }
}

function Set-WslMirrored {
    # Returns $true if .wslconfig was changed.
    $path = $WslConfigPath
    Write-Host "Checking $path"
    $lines = @()
    if (Test-Path $path) { $lines = @(Get-Content $path) }
    if ($lines -match '^\s*networkingMode\s*=\s*mirrored\s*$') { return $false }
    if (Test-Path $path) {
        $bak = "$path.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
        Copy-Item $path $bak
        Write-Host "Backed up $path to $bak"
    }
    $out = New-Object System.Collections.Generic.List[string]
    $inWsl2 = $false; $done = $false
    foreach ($l in $lines) {
        if ($l -match '^\s*\[(.+)\]\s*$') {
            if ($inWsl2 -and -not $done) { $out.Add('networkingMode=mirrored'); $done = $true }
            $inWsl2 = ($Matches[1].Trim() -eq 'wsl2')
            $out.Add($l)
        } elseif ($inWsl2 -and $l -match '^\s*networkingMode\s*=') {
            $out.Add('networkingMode=mirrored'); $done = $true
        } else { $out.Add($l) }
    }
    if (-not $done) {
        if ($inWsl2) { $out.Add('networkingMode=mirrored') }
        else { $out.Add('[wsl2]'); $out.Add('networkingMode=mirrored') }
    }
    [IO.File]::WriteAllText($path, (($out -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding($false)))
    return $true
}

# ---- 1. Preflight ---------------------------------------------------------
Step 'Preflight'
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail 'Run this script from an elevated (Administrator) PowerShell.' }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'docker was not found in PATH. Install/start Docker Desktop.' }
if ((Docker 'info').Code -ne 0) { Fail 'Docker is installed but not running. Start Docker Desktop and re-run.' }

foreach ($ip in @($LanIp, $TsIp)) {
    if (-not (Get-NetIPAddress -IPAddress $ip -ErrorAction SilentlyContinue)) {
        Fail "$ip is not assigned to any interface on this machine. Run this on the main server (check -LanIp / -TsIp, is Tailscale up?)."
    }
}
Write-Host "LAN $LanIp, Tailscale $TsIp"

# ---- 2. Secret + config ---------------------------------------------------
Step "Writing $ConfFile"
$secret = $null
if (Test-Path $ConfFile) {
    $m = Select-String -Path $ConfFile -Pattern '^\s*static-auth-secret=(\S+)' | Select-Object -First 1
    if ($m) { $secret = $m.Matches[0].Groups[1].Value; Write-Host 'Reusing existing secret.' }
}
if (-not $secret) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes); $rng.Dispose()
    $secret = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
    Write-Host 'Generated a new secret.'
}

$conf = @(
    "listening-port=$Port",
    "listening-ip=$LanIp",
    "listening-ip=$TsIp",
    "relay-ip=$LanIp",
    "min-port=$MinPort",
    "max-port=$MaxPort",
    'use-auth-secret',
    "static-auth-secret=$secret",
    "realm=$Realm",
    'fingerprint',
    'no-cli',
    'no-tls',
    'no-dtls',
    'log-file=stdout',
    'simple-log'
) -join "`n"
$conf += "`n"

New-Item -ItemType Directory -Force -Path $ConfDir | Out-Null
$confChanged = $true
if (Test-Path $ConfFile) { $confChanged = ([IO.File]::ReadAllText($ConfFile) -ne $conf) }
if ($confChanged) {
    [IO.File]::WriteAllText($ConfFile, $conf, (New-Object Text.UTF8Encoding($false)))
    Write-Host 'Config written.'
} else { Write-Host 'Config unchanged.' }

# ---- 3. Firewall ----------------------------------------------------------
Step 'Firewall rules'
$rules = @(
    @{ Name = "coturn $Port UDP";   Proto = 'UDP'; Ports = "$Port" },
    @{ Name = "coturn $Port TCP";   Proto = 'TCP'; Ports = "$Port" },
    @{ Name = 'coturn relay UDP';   Proto = 'UDP'; Ports = "$MinPort-$MaxPort" }
)
foreach ($r in $rules) {
    $existing = Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
    if ($existing) {
        # Keep the rule's port range current if -MinPort/-MaxPort/-Port changed.
        $existing | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -LocalPort $r.Ports
        Write-Host "Rule '$($r.Name)' exists."
    } else {
        New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Protocol $r.Proto `
            -LocalPort $r.Ports -Action Allow -Profile Any | Out-Null
        Write-Host "Created rule '$($r.Name)'."
    }
}

# ---- 4. WSL mirrored networking ------------------------------------------
Step 'WSL mirrored networking'
if (Set-WslMirrored) {
    Write-Host 'Mirrored networking was enabled. At a quiet time run `wsl --shutdown`, restart Docker Desktop, then run this script again.' -ForegroundColor Yellow
    Write-Host 'Nothing was restarted (other containers on this server are untouched).'
    exit 2
}
Write-Host 'networkingMode=mirrored is set in .wslconfig.'

# ---- 5. Container ---------------------------------------------------------
Step 'coturn container'
$exists = (Docker 'ps -a --filter "name=^coturn$" --format "{{.Names}}"').Out -match 'coturn'
if ($exists -and ($confChanged -or $Force)) {
    Write-Host 'Recreating container (config changed or -Force).'
    $null = Docker 'rm -f coturn'
    $exists = $false
}
if ($exists) {
    $null = Docker 'start coturn'   # no-op if already running
    Write-Host 'Container already exists; ensured running.'
} else {
    $r = Docker "run -d --name coturn --restart unless-stopped --network host -v `"$ConfFile`:/etc/coturn/turnserver.conf:ro`" coturn/coturn -c /etc/coturn/turnserver.conf"
    if ($r.Code -ne 0) { Fail "docker run failed:`n$($r.Out)" }
    Write-Host 'Container started.'
}

# ---- 6. Verify ------------------------------------------------------------
Step 'Verification'
Start-Sleep -Seconds 5
$problems = @()
$running = (Docker 'inspect -f "{{.State.Running}}" coturn').Out.Trim()
$logs = (Docker 'logs coturn').Out
if ($running -ne 'true') { $problems += 'container is not running (it exited)' }
foreach ($ip in @($LanIp, $TsIp)) {
    if ($logs -notmatch [regex]::Escape($ip)) { $problems += "coturn log shows no listener on $ip" }
}

# Allocation test is advisory: without a peer, turnutils_uclient may report errors even when TURN works.
$allocWarn = @()
if ((Docker 'exec coturn which turnutils_uclient').Code -ne 0) {
    Write-Host 'WARNING: turnutils_uclient not found in the image; skipping allocation test.' -ForegroundColor Yellow
} else {
    $expiry = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() + 600
    $user = "${expiry}:$Realm"
    $hmac = New-Object Security.Cryptography.HMACSHA1(, [Text.Encoding]::UTF8.GetBytes($secret))
    $pass = [Convert]::ToBase64String($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($user)))
    foreach ($ip in @($LanIp, $TsIp)) {
        $t = Docker "exec coturn turnutils_uclient -u $user -w $pass -p $Port -m 1 -n 1 -l 20 $ip"
        if ($t.Code -ne 0 -or $t.Out -match '401|Cannot complete Allocation|allocate error') {
            $allocWarn += $ip
        } else { Write-Host "Allocation test OK on $ip" }
    }
}

if ($problems.Count -gt 0) {
    Write-Host "`nVerification FAILED:" -ForegroundColor Red
    $problems | ForEach-Object { Write-Host " - $_" -ForegroundColor Red }
    Write-Host 'Check: docker logs coturn'
    Write-Host 'Docker Desktop may not honour mirrored/host networking for UDP. See "Fallback: native coturn in WSL Ubuntu" in docs/live-view-turn.md.'
    Write-Host 'If only the Tailscale address cannot be bound, see "Fallback B: TCP port proxy for the Tailscale side" there.'
    Show-EnvBlock 'After you fix the relay, these go in nodejs-backend\.env:' 'Yellow'
    exit 1
}

# ---- 7. Result ------------------------------------------------------------
if ($allocWarn.Count -gt 0) {
    Write-Host "`nWARNING: allocation test did not pass on $($allocWarn -join ', '). This can be a false alarm (no peer running); confirm with the trickle-ICE test in docs/live-view-turn.md." -ForegroundColor Yellow
}
Show-EnvBlock 'coturn is up. Paste this into nodejs-backend\.env on the server, then restart the backend:' 'Green'
Write-Host "`nRemember: restart the backend so it picks up the new settings."
