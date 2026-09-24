#!/usr/bin/env bash
# One-click deploy: docker + docker compose is the only requirement on the new machine.
# python-microservice needs this laptop to be on the same LAN as the ZKTeco device.
set -euo pipefail
cd "$(dirname "$0")"

command -v docker >/dev/null || { echo "Docker is not installed: https://docs.docker.com/get-docker/"; exit 1; }

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — fill in the real secrets, device IP and Cloudflare tunnel token, then re-run this script."
  exit 1
fi

docker compose up -d --build
echo "Up. Check status: docker compose ps    Logs: docker compose logs -f"
