# One-click deploy: docker + docker compose is the only requirement on the new machine.
# python-microservice needs this laptop to be on the same LAN as the ZKTeco device.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Error "Docker is not installed: https://docs.docker.com/get-docker/"
    exit 1
}

if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
    Write-Host "Created .env from .env.example - fill in the real secrets, device IP and Cloudflare tunnel token, then re-run this script."
    exit 1
}

docker compose up -d --build
Write-Host "Up. Check status: docker compose ps    Logs: docker compose logs -f"
