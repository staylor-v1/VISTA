#!/usr/bin/env bash
# Test Runner - Backend and/or Frontend
# Usage: ./test/run_tests.sh [--backend|--frontend] [--verbose]
# No suite flag = run both, sequentially.
set -euo pipefail

VERBOSE_MODE=false
RUN_BACKEND=false
RUN_FRONTEND=false

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
    *)
      echo "Unknown argument: $arg"
      echo "Usage: $0 [--backend] [--frontend] [--verbose|-v]"
      echo "  No suite flag = run both backend and frontend tests"
      echo "  --verbose = show detailed output"
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

# Run sequentially so the suites cannot compete for CPU, memory, database
# fixtures, or shared process-level state.
if [ "$RUN_BACKEND" = true ]; then
  bash "$BACKEND_RUNNER" "${RUNNER_ARGS[@]}" || BACKEND_EXIT_CODE=$?
fi
if [ "$RUN_FRONTEND" = true ]; then
  [ "$RUN_BACKEND" = true ] && echo ""
  bash "$FRONTEND_RUNNER" "${RUNNER_ARGS[@]}" || FRONTEND_EXIT_CODE=$?
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
