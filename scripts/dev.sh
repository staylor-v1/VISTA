#!/usr/bin/env bash
# VISTA development environment launcher (Linux/macOS/Git-Bash on Windows)
#
# Design goals:
# 1) Environment sensing first (desktop app + runtime CLI + compose mode).
# 2) Container lifecycle second (up/down/restart/logs/etc.).
# 3) Runtime verification third (health checks + inter-service + host reachability).
#
# Usage: ./scripts/dev.sh [up|down|logs|restart|test|shell|migrate|build|ps|verify]

set -euo pipefail

# =========================
# Configurable settings
# =========================
# Keep environment-dependent knobs near the top for easy customization in proxy/mirror-heavy environments.
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.dev.yml}"
LOG_DIR_REL="${LOG_DIR_REL:-logs}"
HEALTH_POLL_SECONDS="${HEALTH_POLL_SECONDS:-3}"
POSTGRES_HEALTH_TIMEOUT="${POSTGRES_HEALTH_TIMEOUT:-180}"
MINIO_HEALTH_TIMEOUT="${MINIO_HEALTH_TIMEOUT:-180}"
BACKEND_HEALTH_TIMEOUT="${BACKEND_HEALTH_TIMEOUT:-300}"
FRONTEND_HEALTH_TIMEOUT="${FRONTEND_HEALTH_TIMEOUT:-240}"

# Service-specific probe URLs (override if port mappings differ in your environment)
HOST_FRONTEND_URL="${HOST_FRONTEND_URL:-http://localhost:3000}"
HOST_BACKEND_HEALTH_URL="${HOST_BACKEND_HEALTH_URL:-http://localhost:8000/api/health}"
HOST_MINIO_LIVE_URL="${HOST_MINIO_LIVE_URL:-http://localhost:9000/minio/health/live}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOG_DIR="$PROJECT_ROOT/$LOG_DIR_REL"
PID_FILE="$LOG_DIR/.log_pids"

cd "$PROJECT_ROOT"

RUNTIME_CMD=""
COMPOSE_MODE=""
COMPOSE_BIN=()

# =========================
# Environment sensing
# =========================
platform_name() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Linux*) echo "linux" ;;
    Darwin*) echo "macos" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows-shell" ;;
    *) echo "unknown" ;;
  esac
}

detect_windows_desktop_engine() {
  # Best-effort detection for Windows Desktop engines.
  # Works in Git-Bash/MSYS when tasklist is present.
  if ! command -v tasklist >/dev/null 2>&1; then
    echo "unknown"
    return
  fi

  local tasks
  tasks="$(tasklist 2>/dev/null || true)"
  if echo "$tasks" | grep -qi "Docker Desktop.exe"; then
    echo "docker-desktop"
  elif echo "$tasks" | grep -qi "Podman Desktop.exe"; then
    echo "podman-desktop"
  else
    echo "none"
  fi
}

can_run() {
  "$@" >/dev/null 2>&1
}

sense_container_engine() {
  local docker_ok=0 podman_ok=0
  if command -v docker >/dev/null 2>&1 && can_run docker info; then docker_ok=1; fi
  if command -v podman >/dev/null 2>&1 && can_run podman info; then podman_ok=1; fi

  if [[ "$podman_ok" -eq 1 && "$docker_ok" -eq 1 ]]; then
    # Prefer podman when both work for rootless dev.
    RUNTIME_CMD="podman"
  elif [[ "$podman_ok" -eq 1 ]]; then
    RUNTIME_CMD="podman"
  elif [[ "$docker_ok" -eq 1 ]]; then
    RUNTIME_CMD="docker"
  else
    echo "Error: neither docker nor podman CLI is installed and reachable." >&2
    exit 1
  fi
}

sense_compose_mode() {
  # Prefer integrated compose plugin (docker/podman compose), then legacy binaries.
  if can_run "$RUNTIME_CMD" compose version; then
    COMPOSE_MODE="plugin"
    COMPOSE_BIN=("$RUNTIME_CMD" "compose")
  elif command -v "${RUNTIME_CMD}-compose" >/dev/null 2>&1; then
    COMPOSE_MODE="legacy"
    COMPOSE_BIN=("${RUNTIME_CMD}-compose")
  elif command -v docker-compose >/dev/null 2>&1 && can_run docker-compose version; then
    COMPOSE_MODE="legacy"
    COMPOSE_BIN=("docker-compose")
  elif command -v podman-compose >/dev/null 2>&1 && can_run podman-compose version; then
    COMPOSE_MODE="legacy"
    COMPOSE_BIN=("podman-compose")
  else
    echo "Error: no working compose implementation detected." >&2
    exit 1
  fi
}

compose() {
  "${COMPOSE_BIN[@]}" -f "$COMPOSE_FILE" "$@"
}

print_environment_summary() {
  local platform desktop
  platform="$(platform_name)"
  desktop="unknown"
  if [[ "$platform" == "windows-shell" ]]; then
    desktop="$(detect_windows_desktop_engine)"
  fi

  echo "Environment detection:"
  echo "  Platform:              $platform"
  echo "  Windows desktop app:   $desktop"
  echo "  Runtime CLI:           $RUNTIME_CMD"
  echo "  Compose mode:          $COMPOSE_MODE (${COMPOSE_BIN[*]})"
  echo "  Compose file:          $COMPOSE_FILE"
}

wait_for_service_health() {
  local service="$1" timeout_seconds="${2:-180}" elapsed=0
  printf " ✔ Container %-20s Waiting                                    0.0s\n" "$service"

  while [[ "$elapsed" -lt "$timeout_seconds" ]]; do
    local status
    status="$(compose ps --format json "$service" 2>/dev/null | python -c "import json,sys,re
raw=json.load(sys.stdin)
rows=raw if isinstance(raw,list) else ([raw] if isinstance(raw,dict) else [])
row=rows[0] if rows else {}
health=(str(row.get('Health') or '')).strip().lower()
state=(str(row.get('State') or '')).strip().lower()
status=(str(row.get('Status') or '')).strip().lower()
if health:
    print(health)
elif 'healthy' in status or '(healthy)' in status:
    print('healthy')
elif 'unhealthy' in status or '(unhealthy)' in status:
    print('unhealthy')
elif state:
    print(state)
else:
    print('unknown')" 2>/dev/null || echo unknown)"
    case "$status" in
      healthy) printf " ✔ Container %-20s Healthy                                    %ss\n" "$service" "$elapsed"; return 0 ;;
      unhealthy)
        echo "  ✗ $service is unhealthy. Recent logs:"
        compose logs --tail=50 "$service" || true
        return 1
        ;;
      *) sleep "$HEALTH_POLL_SECONDS"; elapsed=$((elapsed + HEALTH_POLL_SECONDS)) ;;
    esac
  done

  echo "Timed out waiting for $service to become healthy."
  compose ps "$service" || true
  compose logs --tail=50 "$service" || true
  return 1
}

run_connectivity_checks() {
  echo ""
  echo "Running cross-service connectivity checks..."
  compose exec -T backend-dev bash -c "
set -e
cd /app/backend
python - <<'PY'
import asyncio
import asyncpg
import urllib.request

async def verify_postgres():
    conn = await asyncpg.connect('postgresql://postgres:postgres@postgres:5432/postgres')
    try:
        value = await conn.fetchval('SELECT 1')
        assert value == 1
        print('✓ backend-dev -> postgres connectivity OK (SELECT 1)')
    finally:
        await conn.close()

asyncio.run(verify_postgres())
urllib.request.urlopen('http://minio:9000/minio/health/live', timeout=5).read()
print('✓ backend-dev -> minio connectivity OK (/minio/health/live)')
PY
  "
  compose exec -T frontend-dev sh -c "wget -qO- http://backend-dev:8000/api/health >/dev/null && echo '✓ frontend-dev -> backend-dev connectivity OK (/api/health)'"

  # Host-to-container connectivity checks
  curl -fsS "$HOST_BACKEND_HEALTH_URL" >/dev/null && echo "✓ host -> backend-dev connectivity OK ($HOST_BACKEND_HEALTH_URL)"
  curl -fsS "$HOST_MINIO_LIVE_URL" >/dev/null && echo "✓ host -> minio connectivity OK ($HOST_MINIO_LIVE_URL)"
  curl -fsS "$HOST_FRONTEND_URL" >/dev/null && echo "✓ host -> frontend-dev connectivity OK ($HOST_FRONTEND_URL)"
}

start_log_collectors() {
  mkdir -p "$LOG_DIR"
  compose logs -f --no-color postgres > "$LOG_DIR/postgres.log" 2>&1 &
  compose logs -f --no-color minio > "$LOG_DIR/minio.log" 2>&1 &
  compose logs -f --no-color backend-dev > "$LOG_DIR/backend-dev.log" 2>&1 &
  compose logs -f --no-color frontend-dev > "$LOG_DIR/frontend-dev.log" 2>&1 &
  jobs -p > "$PID_FILE"
}

stop_log_collectors() {
  if [[ -f "$PID_FILE" ]]; then
    while read -r pid; do kill "$pid" 2>/dev/null || true; done < "$PID_FILE"
    rm -f "$PID_FILE"
  fi
}

sense_container_engine
sense_compose_mode

case "${1:-up}" in
  up)
    print_environment_summary
    compose up -d
    wait_for_service_health postgres "$POSTGRES_HEALTH_TIMEOUT"
    wait_for_service_health minio "$MINIO_HEALTH_TIMEOUT"
    wait_for_service_health backend-dev "$BACKEND_HEALTH_TIMEOUT"
    wait_for_service_health frontend-dev "$FRONTEND_HEALTH_TIMEOUT"
    run_connectivity_checks
    start_log_collectors
    ;;
  verify)
    print_environment_summary
    wait_for_service_health postgres 120
    wait_for_service_health minio 120
    wait_for_service_health backend-dev 180
    wait_for_service_health frontend-dev 120
    run_connectivity_checks
    ;;
  down) stop_log_collectors; compose down ;;
  restart) compose restart "${2:-}" ;;
  logs) if [[ -n "${2:-}" ]]; then compose logs -f "$2"; else compose logs -f; fi ;;
  test) compose exec backend-dev bash -c "cd /app/backend && pytest tests/"; compose exec frontend-dev npm test -- --watchAll=false ;;
  shell) compose exec "${2:-backend-dev}" bash ;;
  migrate) compose exec backend-dev bash -c "cd /app/backend && alembic upgrade head" ;;
  build) compose build "${2:-}" ;;
  ps) compose ps ;;
  *) echo "Usage: $0 {up|down|restart|logs|test|shell|migrate|build|ps|verify}"; exit 1 ;;
esac
