#!/usr/bin/env bash
# Frontend Test Runner
# Usage: ./test/frontend_tests.sh [--verbose]
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
      exit 1
      ;;
  esac
done

# Change to project root
cd "$(dirname "$0")/.."

if [ ! -d "frontend" ]; then
  echo "Error: frontend directory not found."
  exit 1
fi

# Check for npm
if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm not found. Please install Node.js and npm."
  exit 1
fi
if [ ! -x "frontend/node_modules/.bin/react-scripts" ]; then
  echo "Error: locked frontend dependencies are missing."
  echo "Run 'cd frontend && npm ci' before starting the test suite."
  exit 1
fi

# Run tests
cd frontend
echo "Frontend tests:"
echo "============================================="

set +e

# Run Jest through the committed package script. npm never downloads a missing
# executable here, unlike npx.
echo "Jest tests:"
JEST_ARGS=(--passWithNoTests)
if [ "$VERBOSE_MODE" = true ]; then
  JEST_ARGS+=(--verbose)
fi
npm run test:unit:ci -- "${JEST_ARGS[@]}"
JEST_EXIT_CODE=$?

# Run the custom test runner separately
echo ""
echo "Custom test runner:"
if [ "$VERBOSE_MODE" = true ]; then
  node src/__tests__/test-runner.cjs
else
  node src/__tests__/test-runner.cjs
fi
CUSTOM_TEST_EXIT_CODE=$?

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
