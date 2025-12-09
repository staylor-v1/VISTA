#!/usr/bin/env bash
# Development environment launcher for VISTA
# Usage: ./scripts/dev.sh [up|down|logs|restart|test|shell|migrate]

set -euo pipefail

COMPOSE_FILE="docker-compose.dev.yml"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

case "${1:-up}" in
  up)
    echo "Starting VISTA development environment..."
    docker compose -f "$COMPOSE_FILE" up -d

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
    echo "Usage: $0 {up|down|restart|logs|test|shell|migrate|build|ps}"
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
    exit 1
    ;;
esac
