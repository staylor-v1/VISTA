#!/usr/bin/env bash
# Test Runner - Backend and/or Frontend
# Usage: ./test/run_tests.sh [--backend|--frontend] [--verbose] [--sequential]
# No suite flag = run both concurrently.
set -euo pipefail

VERBOSE_MODE=false
RUN_BACKEND=false
RUN_FRONTEND=false
SEQUENTIAL_MODE=false

for arg in "$@"; do
  case $arg in
    --backend)
      RUN_BACKEND=true
      ;;
    --frontend)
      RUN_FRONTEND=true
      ;;
    --verbose|-v)
      VERBOSE_MODE=true
      ;;
    --sequential)
      SEQUENTIAL_MODE=true
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Usage: $0 [--backend] [--frontend] [--verbose|-v] [--sequential]"
      echo "  No suite flag = run backend and frontend tests concurrently"
      echo "  --verbose = show detailed output"
      echo "  --sequential = run selected suites one at a time"
      exit 1
      ;;
  esac
done

# `--verbose` changes output detail, not suite selection.
if [ "$RUN_BACKEND" = false ] && [ "$RUN_FRONTEND" = false ]; then
  RUN_BACKEND=true
  RUN_FRONTEND=true
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
BACKEND_RUNNER="$SCRIPT_DIR/backend_tests.sh"
FRONTEND_RUNNER="$SCRIPT_DIR/frontend_tests.sh"
RUNNER_ARGS=()
if [ "$VERBOSE_MODE" = true ]; then
  RUNNER_ARGS+=(--verbose)
fi

if [ "$RUN_BACKEND" = true ] && [ ! -f "$BACKEND_RUNNER" ]; then
  echo "Error: backend_tests.sh not found in $SCRIPT_DIR"
  exit 1
fi
if [ "$RUN_FRONTEND" = true ] && [ ! -f "$FRONTEND_RUNNER" ]; then
  echo "Error: frontend_tests.sh not found in $SCRIPT_DIR"
  exit 1
fi

BACKEND_EXIT_CODE=0
FRONTEND_EXIT_CODE=0
BACKEND_PID=""
FRONTEND_PID=""
BACKEND_HAS_PROCESS_GROUP=false
FRONTEND_HAS_PROCESS_GROUP=false

terminate_process_tree() {
  local pid=$1
  local has_process_group=$2
  local child
  local children

  [ -n "$pid" ] || return 0

  if [ "$has_process_group" = true ]; then
    # The suite was launched with setsid, so its shell and every descendant are
    # isolated from this aggregate runner and can be stopped atomically.
    kill -TERM -- "-$pid" 2>/dev/null || true
    return 0
  fi

  # Portable fallback for hosts without setsid: terminate descendants before
  # their parent so they cannot be orphaned while the tree is being traversed.
  if command -v pgrep >/dev/null 2>&1; then
    children="$(pgrep -P "$pid" 2>/dev/null || true)"
    for child in $children; do
      terminate_process_tree "$child" false
    done
  fi
  kill -TERM "$pid" 2>/dev/null || true
}

cleanup_active_suites() {
  terminate_process_tree "$BACKEND_PID" "$BACKEND_HAS_PROCESS_GROUP"
  terminate_process_tree "$FRONTEND_PID" "$FRONTEND_HAS_PROCESS_GROUP"

  if [ -n "$BACKEND_PID" ]; then
    wait "$BACKEND_PID" 2>/dev/null || true
    BACKEND_PID=""
  fi
  if [ -n "$FRONTEND_PID" ]; then
    wait "$FRONTEND_PID" 2>/dev/null || true
    FRONTEND_PID=""
  fi
}

handle_signal() {
  local exit_code=$1
  trap - EXIT HUP INT TERM
  cleanup_active_suites
  exit "$exit_code"
}

handle_exit() {
  local exit_code=$?
  trap - EXIT HUP INT TERM
  cleanup_active_suites
  exit "$exit_code"
}

trap handle_exit EXIT
trap 'handle_signal 129' HUP
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM

# The aggregate local entrypoint overlaps the independent backend and frontend
# suites by default. CI shards invoke the lane-specific runners directly, where
# nested worker counts are bounded.
if [ "$RUN_BACKEND" = true ] &&
   [ "$RUN_FRONTEND" = true ] &&
   [ "$SEQUENTIAL_MODE" = false ]; then
  echo "Running backend and frontend tests concurrently..."
  if command -v setsid >/dev/null 2>&1; then
    setsid bash "$BACKEND_RUNNER" "${RUNNER_ARGS[@]}" &
    BACKEND_HAS_PROCESS_GROUP=true
  else
    bash "$BACKEND_RUNNER" "${RUNNER_ARGS[@]}" &
  fi
  BACKEND_PID=$!
  if command -v setsid >/dev/null 2>&1; then
    setsid bash "$FRONTEND_RUNNER" "${RUNNER_ARGS[@]}" &
    FRONTEND_HAS_PROCESS_GROUP=true
  else
    bash "$FRONTEND_RUNNER" "${RUNNER_ARGS[@]}" &
  fi
  FRONTEND_PID=$!

  wait "$BACKEND_PID" || BACKEND_EXIT_CODE=$?
  BACKEND_PID=""
  wait "$FRONTEND_PID" || FRONTEND_EXIT_CODE=$?
  FRONTEND_PID=""
else
  if [ "$RUN_BACKEND" = true ]; then
    bash "$BACKEND_RUNNER" "${RUNNER_ARGS[@]}" || BACKEND_EXIT_CODE=$?
  fi
  if [ "$RUN_FRONTEND" = true ]; then
    [ "$RUN_BACKEND" = true ] && echo ""
    bash "$FRONTEND_RUNNER" "${RUNNER_ARGS[@]}" || FRONTEND_EXIT_CODE=$?
  fi
fi

OVERALL_EXIT_CODE=0
if [ "$RUN_BACKEND" = true ] && [ "$BACKEND_EXIT_CODE" -ne 0 ]; then
  OVERALL_EXIT_CODE=1
fi
if [ "$RUN_FRONTEND" = true ] && [ "$FRONTEND_EXIT_CODE" -ne 0 ]; then
  OVERALL_EXIT_CODE=1
fi

echo ""
echo "============================================="
if [ "$OVERALL_EXIT_CODE" -eq 0 ]; then
  echo "OVERALL RESULT: PASSED"
else
  echo "OVERALL RESULT: FAILED"
fi
echo "============================================="

exit "$OVERALL_EXIT_CODE"
