#!/usr/bin/env bash
# Development environment launcher for VISTA
# Usage: ./scripts/dev.sh [up|down|logs|restart|test|shell|migrate]

set -euo pipefail

COMPOSE_FILE="docker-compose.dev.yml"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

wait_for_service_health() {
  local service="$1"
  local timeout_seconds="${2:-180}"
  local elapsed=0

  echo "Waiting for '$service' health status to be 'healthy' (timeout: ${timeout_seconds}s)..."
  while [ "$elapsed" -lt "$timeout_seconds" ]; do
    local status
    status="$(docker compose -f "$COMPOSE_FILE" ps --format json "$service" 2>/dev/null | python -c "import json,sys; data=json.load(sys.stdin); print((data[0].get('Health') if data else 'unknown'))" 2>/dev/null || echo "unknown")"
    case "$status" in
      healthy)
        echo "  ✓ $service is healthy."
        return 0
        ;;
      unhealthy)
        echo "  ✗ $service is unhealthy. Recent logs:"
        docker compose -f "$COMPOSE_FILE" logs --tail=50 "$service" || true
        return 1
        ;;
      *)
        printf "."
        sleep 3
        elapsed=$((elapsed + 3))
        ;;
    esac
  done

  echo ""
  echo "Timed out waiting for $service to become healthy."
  docker compose -f "$COMPOSE_FILE" ps "$service" || true
  docker compose -f "$COMPOSE_FILE" logs --tail=50 "$service" || true
  return 1
}

run_connectivity_checks() {
  echo ""
  echo "Running cross-service connectivity checks..."
  docker compose -f "$COMPOSE_FILE" exec -T backend-dev bash -c "
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
  docker compose -f "$COMPOSE_FILE" exec -T frontend-dev sh -c "wget -qO- http://backend-dev:8000/api/health >/dev/null && echo '✓ frontend-dev -> backend-dev connectivity OK (/api/health)'"
}

case "${1:-up}" in
  up)
    echo "Starting VISTA development environment..."
    docker compose -f "$COMPOSE_FILE" up -d

    wait_for_service_health postgres 180
    wait_for_service_health minio 180
    wait_for_service_health backend-dev 300
    wait_for_service_health frontend-dev 240
    run_connectivity_checks

    # Create logs directory
    mkdir -p "$PROJECT_ROOT/logs"

    # Start log collection in background
    echo "Starting log collection..."
    docker compose -f "$COMPOSE_FILE" logs -f --no-color postgres > "$PROJECT_ROOT/logs/postgres.log" 2>&1 &
    docker compose -f "$COMPOSE_FILE" logs -f --no-color minio > "$PROJECT_ROOT/logs/minio.log" 2>&1 &
    docker compose -f "$COMPOSE_FILE" logs -f --no-color backend-dev > "$PROJECT_ROOT/logs/backend-dev.log" 2>&1 &
    docker compose -f "$COMPOSE_FILE" logs -f --no-color frontend-dev > "$PROJECT_ROOT/logs/frontend-dev.log" 2>&1 &

    # Save process IDs to a file for cleanup
    jobs -p > "$PROJECT_ROOT/logs/.log_pids"

    echo ""
    echo "Development environment started."
    echo ""
    echo "Access points:"
    echo "  Frontend:      http://localhost:3000"
    echo "  Backend API:   http://localhost:8000"
    echo "  API Docs:      http://localhost:8000/docs"
    echo "  MinIO Console: http://localhost:9001"
    echo "  pgAdmin:       http://localhost:8080"
    echo ""
    echo "Logs are being written to:"
    echo "  logs/frontend-dev.log"
    echo "  logs/backend-dev.log"
    echo "  logs/postgres.log"
    echo "  logs/minio.log"
    echo ""
    echo "Useful commands:"
    echo "  View logs:     tail -f logs/frontend-dev.log"
    echo "  Stop services: ./scripts/dev.sh down"
    echo "  Run tests:     ./scripts/test-docker.sh"
    echo "  Verify links:  ./scripts/dev.sh verify"
    ;;

  verify)
    wait_for_service_health postgres 120
    wait_for_service_health minio 120
    wait_for_service_health backend-dev 180
    wait_for_service_health frontend-dev 120
    run_connectivity_checks
    echo "All health and connectivity checks passed."
    ;;

  down)
    echo "Stopping development environment..."

    # Stop log collection processes
    if [ -f "$PROJECT_ROOT/logs/.log_pids" ]; then
      echo "Stopping log collection..."
      while read pid; do
        kill "$pid" 2>/dev/null || true
      done < "$PROJECT_ROOT/logs/.log_pids"
      rm -f "$PROJECT_ROOT/logs/.log_pids"
    fi

    docker compose -f "$COMPOSE_FILE" down
    echo "Development environment stopped."
    ;;

  restart)
    echo "Restarting development environment..."
    docker compose -f "$COMPOSE_FILE" restart "${2:-}"
    echo "Development environment restarted."
    ;;

  logs)
    if [ -n "${2:-}" ]; then
      docker compose -f "$COMPOSE_FILE" logs -f "$2"
    else
      docker compose -f "$COMPOSE_FILE" logs -f
    fi
    ;;

  test)
    # Check if containers are running
    if ! docker compose -f "$COMPOSE_FILE" ps | grep -q "Up"; then
      echo "Error: Development containers are not running."
      echo ""
      echo "Please start the development environment first:"
      echo "  ./scripts/dev.sh up"
      echo ""
      echo "Or use the standalone test runner:"
      echo "  ./scripts/test-docker.sh"
      exit 1
    fi

    echo "Running tests in containers..."
    echo ""
    echo "Backend tests:"
    docker compose -f "$COMPOSE_FILE" exec backend-dev bash -c "cd /app/backend && pytest tests/"
    echo ""
    echo "Frontend tests:"
    docker compose -f "$COMPOSE_FILE" exec frontend-dev npm test -- --watchAll=false
    ;;

  shell)
    SERVICE="${2:-backend-dev}"
    echo "Opening shell in $SERVICE..."
    docker compose -f "$COMPOSE_FILE" exec "$SERVICE" bash
    ;;

  migrate)
    echo "Running database migrations..."
    docker compose -f "$COMPOSE_FILE" exec backend-dev bash -c "cd /app/backend && alembic upgrade head"
    echo "Migrations completed."
    ;;

  build)
    echo "Building containers..."
    docker compose -f "$COMPOSE_FILE" build "${2:-}"
    echo "Build completed."
    ;;

  ps)
    docker compose -f "$COMPOSE_FILE" ps
    ;;

  *)
    echo "Usage: $0 {up|down|restart|logs|test|shell|migrate|build|ps|verify}"
    echo ""
    echo "Commands:"
    echo "  up       - Start all services"
    echo "  down     - Stop all services"
    echo "  restart  - Restart services"
    echo "  logs     - View logs (all or specific service)"
    echo "  test     - Run tests in containers"
    echo "  shell    - Open shell in container (default: backend-dev)"
    echo "  migrate  - Run database migrations"
    echo "  build    - Build or rebuild containers"
    echo "  ps       - Show container status"
    echo "  verify   - Run health and inter-service connectivity checks"
    exit 1
    ;;
esac
