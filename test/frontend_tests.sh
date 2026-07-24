#!/usr/bin/env bash
# Frontend Test Runner
# Usage: ./test/frontend_tests.sh [--verbose] [--jest-only|--custom-only]
#        [--shard-index N --shard-total N]
set -euo pipefail

# Parse arguments
VERBOSE_MODE=false
RUN_JEST=true
RUN_CUSTOM=true
JEST_ONLY_SET=false
CUSTOM_ONLY_SET=false
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
    --jest-only)
      JEST_ONLY_SET=true
      RUN_CUSTOM=false
      shift
      ;;
    --custom-only)
      CUSTOM_ONLY_SET=true
      RUN_JEST=false
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
      echo "Usage: $0 [--verbose|-v] [--jest-only|--custom-only]"
      echo "       [--shard-index N --shard-total N]"
      exit 1
      ;;
  esac
done

if [ "$JEST_ONLY_SET" = true ] && [ "$CUSTOM_ONLY_SET" = true ]; then
  echo "Error: --jest-only and --custom-only are mutually exclusive."
  exit 1
fi
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
  if [ "$JEST_ONLY_SET" != true ]; then
    echo "Error: frontend shards require --jest-only; run custom tests once with --custom-only."
    exit 1
  fi
  SHARDED_MODE=true
fi
if [ -n "${TEST_SHARD_MANIFEST_PATH:-}" ] &&
   [ "$SHARDED_MODE" != true ]; then
  echo "Error: TEST_SHARD_MANIFEST_PATH requires shard options."
  exit 1
fi

if [ "$RUN_JEST" = true ]; then
  if [ "$SHARDED_MODE" = true ]; then
    if [ "${FRONTEND_JEST_WORKERS+x}" = x ] &&
       [ "$FRONTEND_JEST_WORKERS" != "1" ]; then
      echo "Error: FRONTEND_JEST_WORKERS must equal 1 in sharded mode."
      exit 1
    fi
    FRONTEND_JEST_WORKERS=1
  else
    FRONTEND_JEST_WORKERS="${FRONTEND_JEST_WORKERS:-2}"
  fi
  MAX_FRONTEND_JEST_WORKERS=8
  if ! [[ "$FRONTEND_JEST_WORKERS" =~ ^[1-9][0-9]*$ ]] ||
     [ "${#FRONTEND_JEST_WORKERS}" -gt 1 ] ||
     [ "$FRONTEND_JEST_WORKERS" -gt "$MAX_FRONTEND_JEST_WORKERS" ]; then
    echo "Error: FRONTEND_JEST_WORKERS must be an integer from 1 to $MAX_FRONTEND_JEST_WORKERS."
    exit 1
  fi
fi

# Change to project root
cd "$(dirname "$0")/.."

if [ -n "${TEST_SHARD_MANIFEST_PATH:-}" ]; then
  case "$TEST_SHARD_MANIFEST_PATH" in
    /*) ;;
    *) TEST_SHARD_MANIFEST_PATH="$(pwd -P)/$TEST_SHARD_MANIFEST_PATH" ;;
  esac
fi

JEST_CACHE_DIRECTORY=""
if [ "$RUN_JEST" = true ]; then
  if [ "${FRONTEND_JEST_CACHE_DIR+x}" = x ] &&
     [ -z "$FRONTEND_JEST_CACHE_DIR" ]; then
    echo "Error: FRONTEND_JEST_CACHE_DIR must not be empty when set."
    exit 1
  fi
  if [ -n "${CI_JOB_ID:-}" ]; then
    if ! [[ "$CI_JOB_ID" =~ ^[1-9][0-9]*$ ]] ||
       [ "${#CI_JOB_ID}" -gt 20 ]; then
      echo "Error: CI_JOB_ID must be a positive integer when set."
      exit 1
    fi
    JEST_CACHE_SCOPE="ci-job-$CI_JOB_ID"
  else
    JEST_CACHE_SCOPE="local"
  fi
  if [ "$SHARDED_MODE" = true ]; then
    JEST_CACHE_SCOPE="$JEST_CACHE_SCOPE-shard-$SHARD_INDEX-of-$SHARD_TOTAL"
  else
    JEST_CACHE_SCOPE="$JEST_CACHE_SCOPE-unsharded"
  fi

  JEST_CACHE_ROOT="${FRONTEND_JEST_CACHE_DIR:-$(pwd -P)/.cache/jest}"
  case "$JEST_CACHE_ROOT" in
    /*) ;;
    *) JEST_CACHE_ROOT="$(pwd -P)/$JEST_CACHE_ROOT" ;;
  esac
  if ! mkdir -p -- "$JEST_CACHE_ROOT"; then
    echo "Error: could not create frontend Jest cache root: $JEST_CACHE_ROOT"
    exit 1
  fi
  if ! JEST_CACHE_ROOT="$(cd "$JEST_CACHE_ROOT" && pwd -P)"; then
    echo "Error: could not resolve frontend Jest cache root."
    exit 1
  fi
  JEST_CACHE_DIRECTORY="$JEST_CACHE_ROOT/$JEST_CACHE_SCOPE"
  if [ -L "$JEST_CACHE_DIRECTORY" ]; then
    echo "Error: refusing symbolic-link frontend Jest cache directory: $JEST_CACHE_DIRECTORY"
    exit 1
  fi
  if ! mkdir -p -- "$JEST_CACHE_DIRECTORY"; then
    echo "Error: could not create frontend Jest cache directory: $JEST_CACHE_DIRECTORY"
    exit 1
  fi
fi

if [ ! -d "frontend" ]; then
  echo "Error: frontend directory not found."
  exit 1
fi

# Check for npm
if ! command -v node >/dev/null 2>&1; then
  echo "Error: node not found. Please install Node.js."
  exit 1
fi
if [ "$RUN_JEST" = true ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "Error: npm not found. Please install Node.js and npm."
    exit 1
  fi
  if [ ! -x "frontend/node_modules/.bin/react-scripts" ]; then
    echo "Error: locked frontend dependencies are missing."
    echo "Run 'cd frontend && npm ci' before starting the test suite."
    exit 1
  fi
fi

# Run tests
cd frontend
echo "Frontend tests:"
echo "============================================="

JEST_TEST_TARGETS=()
if [ "$SHARDED_MODE" = true ]; then
  SHARD_SELECTOR="../scripts/ci/select_test_shard.sh"
  if [ ! -f "$SHARD_SELECTOR" ]; then
    echo "Error: test shard selector not found: $SHARD_SELECTOR"
    exit 1
  fi
  if ! SELECTED_TESTS="$(
    sh "$SHARD_SELECTOR" \
      src \
      "*.test.js,*.test.jsx,*.test.ts,*.test.tsx,*.spec.js,*.spec.jsx,*.spec.ts,*.spec.tsx,__tests__/*.js,__tests__/*.jsx,__tests__/*.ts,__tests__/*.tsx,*/__tests__/*.js,*/__tests__/*.jsx,*/__tests__/*.ts,*/__tests__/*.tsx" \
      "$SHARD_INDEX" \
      "$SHARD_TOTAL"
  )"; then
    echo "Error: failed to select frontend Jest shard."
    exit 1
  fi
  if [ -z "$SELECTED_TESTS" ]; then
    echo "Error: frontend Jest shard $SHARD_INDEX/$SHARD_TOTAL is empty."
    exit 1
  fi
  mapfile -t JEST_TEST_TARGETS <<<"$SELECTED_TESTS"
  echo "Running frontend Jest shard $SHARD_INDEX/$SHARD_TOTAL (${#JEST_TEST_TARGETS[@]} files)"
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
  if ! printf '%s\n' "${JEST_TEST_TARGETS[@]}" >"$MANIFEST_TEMP"; then
    rm -f "$MANIFEST_TEMP"
    echo "Error: could not write frontend shard manifest."
    exit 1
  fi
  if ! mv -f "$MANIFEST_TEMP" "$TEST_SHARD_MANIFEST_PATH"; then
    rm -f "$MANIFEST_TEMP"
    echo "Error: could not publish frontend shard manifest."
    exit 1
  fi
fi

set +e

# Run Jest through the committed package script. npm never downloads a missing
# executable here, unlike npx.
JEST_EXIT_CODE=0
if [ "$RUN_JEST" = true ]; then
  echo "Jest tests:"
  JEST_ARGS=(
    --passWithNoTests
    "--maxWorkers=$FRONTEND_JEST_WORKERS"
    "--cacheDirectory=$JEST_CACHE_DIRECTORY"
  )
  if [ "$VERBOSE_MODE" = true ]; then
    JEST_ARGS+=(--verbose)
  fi
  if [ "$SHARDED_MODE" = true ]; then
    JEST_ARGS+=(--runTestsByPath "${JEST_TEST_TARGETS[@]}")
  fi
  npm run test:unit:ci -- "${JEST_ARGS[@]}"
  JEST_EXIT_CODE=$?
fi

# Run the custom test runner separately
CUSTOM_TEST_EXIT_CODE=0
if [ "$RUN_CUSTOM" = true ]; then
  [ "$RUN_JEST" = true ] && echo ""
  echo "Custom test runner:"
  node src/__tests__/test-runner.cjs
  CUSTOM_TEST_EXIT_CODE=$?
fi

# Frontend passes if both Jest tests and custom tests pass
if [ $JEST_EXIT_CODE -eq 0 ] && [ $CUSTOM_TEST_EXIT_CODE -eq 0 ]; then
  EXIT_CODE=0
else
  EXIT_CODE=1
fi
set -e

echo ""
if [ $EXIT_CODE -eq 0 ]; then
  echo "Frontend tests: PASSED"
else
  echo "Frontend tests: FAILED"
  [ "$VERBOSE_MODE" = false ] && echo "  Run with --verbose for full details"
fi

exit $EXIT_CODE
