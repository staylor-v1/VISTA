#!/usr/bin/env bash
set -euo pipefail

# Launch postgres + minio using podman-compose, docker compose, or docker-compose.
# Auto-detects which compose tool is available.

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Detect compose command (prefer podman-compose for rootless podman)
if command -v podman-compose >/dev/null 2>&1; then
	COMPOSE_CMD="podman-compose"
elif command -v docker-compose >/dev/null 2>&1; then
	COMPOSE_CMD="docker-compose"
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
	COMPOSE_CMD="docker compose"
else
	echo "Error: No compose tool found. Install podman-compose, docker-compose, or docker compose."
	exit 1
fi

echo "Using ${COMPOSE_CMD}..."
${COMPOSE_CMD} -f docker-compose.yml up -d postgres minio

# To totally kill the containers and volumes for a hard reset, run:
#   ${COMPOSE_CMD} -f docker-compose.yml down -v
