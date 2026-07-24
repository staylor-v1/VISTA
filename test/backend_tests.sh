#!/usr/bin/env bash
# Backend Test Runner
# Usage: ./test/backend_tests.sh [--verbose]
# Set BACKEND_TEST_MAXFAIL=0 to disable the default failure cap.
set -euo pipefail

# Parse arguments
VERBOSE_MODE=false
for arg in "$@"; do
  case $arg in
    --verbose|-v)
      VERBOSE_MODE=true
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: $0 [--verbose|-v]"
      echo "  BACKEND_TEST_MAXFAIL=0 disables the default failure cap"
      exit 1
      ;;
  esac
done

PYTEST_XDIST_WORKERS="${PYTEST_XDIST_WORKERS:-4}"
MAX_PYTEST_XDIST_WORKERS=16
if ! [[ "$PYTEST_XDIST_WORKERS" =~ ^[1-9][0-9]*$ ]] ||
   [ "${#PYTEST_XDIST_WORKERS}" -gt 2 ] ||
   [ "$PYTEST_XDIST_WORKERS" -gt "$MAX_PYTEST_XDIST_WORKERS" ]; then
  echo "Error: PYTEST_XDIST_WORKERS must be an integer from 1 to $MAX_PYTEST_XDIST_WORKERS."
  exit 1
fi

# Change to project root
cd "$(dirname "$0")/.."

if [ ! -d "backend" ]; then
  echo "Error: backend directory not found."
  exit 1
fi

# Find and activate virtual environment
if [ -n "${VIRTUAL_ENV:-}" ] && [ -f "$VIRTUAL_ENV/bin/activate" ]; then
  [ "$VERBOSE_MODE" = true ] && echo "Using active virtual environment..."
  # shellcheck disable=SC1091
  source "$VIRTUAL_ENV/bin/activate"
elif [ -f "/opt/venv/bin/activate" ]; then
  [ "$VERBOSE_MODE" = true ] && echo "Activating Docker virtual environment..."
  # shellcheck disable=SC1091
  source /opt/venv/bin/activate
elif [ -f "backend/.venv/bin/activate" ]; then
  [ "$VERBOSE_MODE" = true ] && echo "Activating backend virtual environment..."
  # shellcheck disable=SC1091
  source backend/.venv/bin/activate
elif [ -f ".venv/bin/activate" ]; then
  [ "$VERBOSE_MODE" = true ] && echo "Activating local virtual environment..."
  # shellcheck disable=SC1091
  source .venv/bin/activate
else
  echo "Error: Virtual environment not found"
  echo "Expected: /opt/venv or backend/.venv or .venv"
  exit 1
fi

# Ensure we have a python executable post-activate
PY_BIN="$(command -v python3 || command -v python || true)"
if [ -z "${PY_BIN}" ]; then
  echo "Error: python not found in the active environment."
  exit 1
fi

# Test execution must not install packages or access the network.
if ! "${PY_BIN}" -c "import pytest, pytest_asyncio, xdist" >/dev/null 2>&1; then
  echo "Error: locked backend test dependencies are missing from the active environment."
  echo "Run 'uv sync --frozen --group dev' before starting the test suite."
  exit 1
fi

# Run tests
cd backend
echo "Backend tests:"
echo "============================================="

# Suppress SQLAlchemy logging to reduce noise
export SQLALCHEMY_WARN_20=0

# Keep default console output compact so CI logs stay below platform limits,
# while retaining deterministic parallelism and excluding opt-in lanes.
PYTEST_ARGS=(
  -n "$PYTEST_XDIST_WORKERS"
  -m "not postgres and not load"
  --no-header
  --disable-warnings
  --show-capture=no
)
if [ -n "${JUNIT_XML_PATH:-}" ]; then
  mkdir -p "$(dirname "$JUNIT_XML_PATH")"
  PYTEST_ARGS+=("--junitxml=$JUNIT_XML_PATH")
fi

# Stop after a bounded number of failures by default; JUnit still records the
# collected failures that occurred before the stop. Override with
# BACKEND_TEST_MAXFAIL=0 to run the full suite after diagnosing the first batch.
BACKEND_TEST_MAXFAIL="${BACKEND_TEST_MAXFAIL:-10}"
if [ "$BACKEND_TEST_MAXFAIL" != "0" ]; then
  PYTEST_ARGS+=("--maxfail=$BACKEND_TEST_MAXFAIL")
fi

set +e
if [ "$VERBOSE_MODE" = true ]; then
  "${PY_BIN}" -m pytest -v --tb=short "${PYTEST_ARGS[@]}" tests/
else
  "${PY_BIN}" -m pytest -q --tb=line "${PYTEST_ARGS[@]}" tests/
fi
EXIT_CODE=$?
set -e

echo ""
if [ $EXIT_CODE -eq 0 ]; then
  echo "Backend tests: PASSED"
else
  echo "Backend tests: FAILED"
  [ "$VERBOSE_MODE" = false ] && echo "  Run with --verbose for full tracebacks"
fi

exit $EXIT_CODE
