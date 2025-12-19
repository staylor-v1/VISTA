#!/usr/bin/env bash
# Run tests inside Docker containers
# Usage: ./scripts/test-docker.sh [--backend|--frontend] [--verbose]

set -euo pipefail

COMPOSE_FILE="docker-compose.test.yml"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

VERBOSE=false
RUN_BACKEND=false
RUN_FRONTEND=false

# Parse arguments
for arg in "$@"; do
  case $arg in
    --backend) RUN_BACKEND=true ;;
    --frontend) RUN_FRONTEND=true ;;
    --verbose|-v) VERBOSE=true ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: $0 [--backend] [--frontend] [--verbose|-v]"
      exit 1
      ;;
  esac
done

# If no test type specified, run both
if [ "$RUN_BACKEND" = false ] && [ "$RUN_FRONTEND" = false ]; then
  RUN_BACKEND=true
  RUN_FRONTEND=true
fi

EXIT_CODE=0

# Run backend tests
if [ "$RUN_BACKEND" = true ]; then
  echo ""
  echo "Running backend tests..."
  if [ "$VERBOSE" = true ]; then
    docker compose -f "$COMPOSE_FILE" run --rm backend-test || EXIT_CODE=$?
  else
    docker compose -f "$COMPOSE_FILE" run --rm backend-test 2>&1 | grep -E "(PASSED|FAILED|ERROR|test session|collected)" || EXIT_CODE=$?
  fi
fi

# Run frontend tests
if [ "$RUN_FRONTEND" = true ]; then
  echo ""
  echo "Running frontend tests..."
  if [ "$VERBOSE" = true ]; then
    docker compose -f "$COMPOSE_FILE" run --rm frontend-test || EXIT_CODE=$?
  else
    docker compose -f "$COMPOSE_FILE" run --rm frontend-test 2>&1 | grep -E "(PASS|FAIL|Test Suites)" || EXIT_CODE=$?
  fi
fi

# Cleanup
echo ""
echo "Cleaning up test environment..."
docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true

if [ $EXIT_CODE -eq 0 ]; then
  echo ""
  echo "All tests passed."
else
  echo ""
  echo "Tests failed. Run with --verbose for detailed output."
fi

exit $EXIT_CODE
