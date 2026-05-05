#!/usr/bin/env bash
set -euo pipefail

# Launch postgres + minio using podman/docker + compose plugin or legacy compose binaries.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

runtime=""
compose_cmd=()

can_run() { "$@" >/dev/null 2>&1; }

if command -v podman >/dev/null 2>&1 && can_run podman info; then
  runtime="podman"
elif command -v docker >/dev/null 2>&1 && can_run docker info; then
  runtime="docker"
else
  echo "Error: neither podman nor docker is installed and reachable." >&2
  exit 1
fi

if can_run "$runtime" compose version; then
  compose_cmd=("$runtime" compose)
elif command -v "${runtime}-compose" >/dev/null 2>&1 && can_run "${runtime}-compose" version; then
  compose_cmd=("${runtime}-compose")
elif command -v docker-compose >/dev/null 2>&1 && can_run docker-compose version; then
  compose_cmd=(docker-compose)
elif command -v podman-compose >/dev/null 2>&1 && can_run podman-compose version; then
  compose_cmd=(podman-compose)
else
  echo "Error: no working compose implementation detected." >&2
  exit 1
fi

compose() {
  "${compose_cmd[@]}" -f docker-compose.yml "$@"
}

wait_for_health() {
  local service="$1" timeout="${2:-120}" elapsed=0
  echo "Waiting for $service to become healthy..."
  while [[ "$elapsed" -lt "$timeout" ]]; do
    local status
    status="$(compose ps --format json "$service" 2>/dev/null | python -c 'import json,sys
raw=json.load(sys.stdin)
rows=raw if isinstance(raw,list) else ([raw] if isinstance(raw,dict) else [])
row=rows[0] if rows else {}
health=str(row.get("Health") or "").strip().lower()
state=str(row.get("State") or "").strip().lower()
status=str(row.get("Status") or "").strip().lower()
if health: print(health)
elif "healthy" in status: print("healthy")
elif "unhealthy" in status: print("unhealthy")
elif state: print(state)
else: print("unknown")' 2>/dev/null || echo unknown)"

    case "$status" in
      healthy) echo "$service is healthy."; return 0 ;;
      unhealthy)
        echo "Error: $service is unhealthy. Recent logs:" >&2
        compose logs --tail=50 "$service" || true
        return 1
        ;;
    esac
    sleep 2
    elapsed=$((elapsed + 2))
  done

  echo "Error: timed out waiting for $service health." >&2
  compose ps "$service" || true
  compose logs --tail=50 "$service" || true
  return 1
}

echo "Using runtime: $runtime"
echo "Using compose: ${compose_cmd[*]}"
compose up -d postgres minio
wait_for_health postgres 180
wait_for_health minio 180

echo "Postgres and MinIO are up and healthy."
echo "Hard reset: ${compose_cmd[*]} -f docker-compose.yml down -v"
