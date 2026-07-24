#!/usr/bin/env bash
# Backend Test Runner
# Usage: ./test/backend_tests.sh [--verbose] [--shard-index N --shard-total N]
# Set BACKEND_TEST_MAXFAIL=0 to disable the default failure cap.
set -euo pipefail

# Parse arguments
VERBOSE_MODE=false
SHARD_INDEX=""
SHARD_TOTAL=""
SHARD_INDEX_SET=false
SHARD_TOTAL_SET=false
while [ "$#" -gt 0 ]; do
  case $1 in
    --verbose|-v)
      VERBOSE_MODE=true
      shift
      ;;
    --shard-index)
      if [ "$#" -lt 2 ]; then
        echo "Error: --shard-index requires a value."
        exit 1
      fi
      SHARD_INDEX="$2"
      SHARD_INDEX_SET=true
      shift 2
      ;;
    --shard-index=*)
      SHARD_INDEX="${1#*=}"
      SHARD_INDEX_SET=true
      shift
      ;;
    --shard-total)
      if [ "$#" -lt 2 ]; then
        echo "Error: --shard-total requires a value."
        exit 1
      fi
      SHARD_TOTAL="$2"
      SHARD_TOTAL_SET=true
      shift 2
      ;;
    --shard-total=*)
      SHARD_TOTAL="${1#*=}"
      SHARD_TOTAL_SET=true
      shift
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: $0 [--verbose|-v] [--shard-index N --shard-total N]"
      echo "  BACKEND_TEST_MAXFAIL=0 disables the default failure cap"
      exit 1
      ;;
  esac
done

if [ "$SHARD_INDEX_SET" != "$SHARD_TOTAL_SET" ]; then
  echo "Error: --shard-index and --shard-total must be provided together."
  exit 1
fi

SHARDED_MODE=false
MAX_TEST_SHARDS=64
if [ "$SHARD_INDEX_SET" = true ]; then
  if ! [[ "$SHARD_INDEX" =~ ^[1-9][0-9]*$ ]] ||
     ! [[ "$SHARD_TOTAL" =~ ^[1-9][0-9]*$ ]] ||
     [ "${#SHARD_INDEX}" -gt 2 ] ||
     [ "${#SHARD_TOTAL}" -gt 2 ] ||
     [ "$SHARD_TOTAL" -gt "$MAX_TEST_SHARDS" ] ||
     [ "$SHARD_INDEX" -gt "$SHARD_TOTAL" ]; then
    echo "Error: shard values must be positive integers with index <= total <= $MAX_TEST_SHARDS."
    exit 1
  fi
  SHARDED_MODE=true
fi
if [ -n "${TEST_SHARD_MANIFEST_PATH:-}" ] &&
   [ "$SHARDED_MODE" != true ]; then
  echo "Error: TEST_SHARD_MANIFEST_PATH requires shard options."
  exit 1
fi

MAX_PYTEST_XDIST_WORKERS=16
if [ "$SHARDED_MODE" = true ]; then
  if [ "${PYTEST_XDIST_WORKERS+x}" = x ] &&
     [ "$PYTEST_XDIST_WORKERS" != "1" ]; then
    echo "Error: PYTEST_XDIST_WORKERS must equal 1 in sharded mode."
    exit 1
  fi
  PYTEST_XDIST_WORKERS=1
else
  PYTEST_XDIST_WORKERS="${PYTEST_XDIST_WORKERS:-4}"
fi
if ! [[ "$PYTEST_XDIST_WORKERS" =~ ^[1-9][0-9]*$ ]] ||
   [ "${#PYTEST_XDIST_WORKERS}" -gt 2 ] ||
   [ "$PYTEST_XDIST_WORKERS" -gt "$MAX_PYTEST_XDIST_WORKERS" ]; then
  echo "Error: PYTEST_XDIST_WORKERS must be an integer from 1 to $MAX_PYTEST_XDIST_WORKERS."
  exit 1
fi

# Change to project root
cd "$(dirname "$0")/.."

if [ -n "${TEST_SHARD_MANIFEST_PATH:-}" ]; then
  case "$TEST_SHARD_MANIFEST_PATH" in
    /*) ;;
    *) TEST_SHARD_MANIFEST_PATH="$(pwd -P)/$TEST_SHARD_MANIFEST_PATH" ;;
  esac
fi

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

# Shards use pytest's default Python filename forms recursively. The postgres
# and load directories remain separate opt-in lanes instead of being collected
# by every shard.
TEST_TARGETS=(tests/)
if [ "$SHARDED_MODE" = true ]; then
  SHARD_SELECTOR="../scripts/ci/select_test_shard.sh"
  if [ ! -f "$SHARD_SELECTOR" ]; then
    echo "Error: test shard selector not found: $SHARD_SELECTOR"
    exit 1
  fi
  if ! SELECTED_TESTS="$(
    sh "$SHARD_SELECTOR" \
      tests \
      "test_*.py,*_test.py,*/test_*.py,*/*_test.py" \
      "$SHARD_INDEX" \
      "$SHARD_TOTAL" \
      "postgres,load"
  )"; then
    echo "Error: failed to select backend test shard."
    exit 1
  fi
  if [ -z "$SELECTED_TESTS" ]; then
    echo "Error: backend test shard $SHARD_INDEX/$SHARD_TOTAL is empty."
    exit 1
  fi
  mapfile -t TEST_TARGETS <<<"$SELECTED_TESTS"
  echo "Running backend shard $SHARD_INDEX/$SHARD_TOTAL (${#TEST_TARGETS[@]} files)"
fi

if [ -n "${TEST_SHARD_MANIFEST_PATH:-}" ]; then
  MANIFEST_DIRECTORY="$(dirname -- "$TEST_SHARD_MANIFEST_PATH")"
  mkdir -p "$MANIFEST_DIRECTORY"
  if ! MANIFEST_TEMP="$(
    mktemp "$MANIFEST_DIRECTORY/.vista-test-shard-manifest.XXXXXX"
  )"; then
    echo "Error: could not create temporary shard manifest."
    exit 1
  fi
  if ! printf '%s\n' "${TEST_TARGETS[@]}" >"$MANIFEST_TEMP"; then
    rm -f "$MANIFEST_TEMP"
    echo "Error: could not write backend shard manifest."
    exit 1
  fi
  if ! mv -f "$MANIFEST_TEMP" "$TEST_SHARD_MANIFEST_PATH"; then
    rm -f "$MANIFEST_TEMP"
    echo "Error: could not publish backend shard manifest."
    exit 1
  fi
fi

# Suppress SQLAlchemy logging to reduce noise
export SQLALCHEMY_WARN_20=0

# Keep the shared selection deterministic and exclude opt-in lanes. Output
# detail is added below so --verbose can provide complete diagnostics without
# making the default CI/local logs noisy.
PYTEST_ARGS=(
  -n "$PYTEST_XDIST_WORKERS"
  -m "not postgres and not load"
  --no-header
)
if [ "$VERBOSE_MODE" = true ]; then
  PYTEST_ARGS+=(--show-capture=all)
else
  PYTEST_ARGS+=(--disable-warnings --show-capture=no)
fi
if [ -n "${JUNIT_XML_PATH:-}" ]; then
  mkdir -p "$(dirname "$JUNIT_XML_PATH")"
  PYTEST_ARGS+=("--junitxml=$JUNIT_XML_PATH")
fi

# Local runs stop after a bounded number of failures by default. CI always
# collects the complete failure inventory unless an explicit override is
# supplied, preventing iterative "fix one, reveal the next" diagnostics.
if [ -n "${BACKEND_TEST_MAXFAIL+x}" ]; then
  :
elif [ "${CI:-}" = "true" ]; then
  BACKEND_TEST_MAXFAIL=0
else
  BACKEND_TEST_MAXFAIL=10
fi
if ! [[ "$BACKEND_TEST_MAXFAIL" =~ ^(0|[1-9][0-9]*)$ ]]; then
  echo "Error: BACKEND_TEST_MAXFAIL must be 0 or a positive integer."
  exit 1
fi
if [ "$BACKEND_TEST_MAXFAIL" != "0" ]; then
  PYTEST_ARGS+=("--maxfail=$BACKEND_TEST_MAXFAIL")
fi

set +e
if [ "$VERBOSE_MODE" = true ]; then
  "${PY_BIN}" -m pytest -v --tb=long "${PYTEST_ARGS[@]}" "${TEST_TARGETS[@]}"
else
  "${PY_BIN}" -m pytest -q --tb=line "${PYTEST_ARGS[@]}" "${TEST_TARGETS[@]}"
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
