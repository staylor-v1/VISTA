#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ENV_FILE="$SCRIPT_DIR/.env"

# Source .env if present
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' "$ENV_FILE" | awk 'NF' | cut -d= -f1)
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

# Positional args override env if provided
PROJECT_ID=${1:-${PROJECT_ID:-}}
API_BASE=${2:-${API_BASE:-http://localhost:8000}}
API_KEY=${3:-${API_KEY:-}}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<EOF
Usage: $0 [project_id] [api_base] [api_key]
If omitted, values are loaded from .env in this directory.

Environment (.env) variables:
  PROJECT_ID= (required if not passed as arg)
  API_BASE=  (default http://localhost:8000)
  API_KEY=   (optional)
  MODEL_NAME_BASE= (optional)
  NO_HEATMAP=0|1 (optional)
EOF
  exit 0
fi

if [[ -z "${PROJECT_ID}" ]]; then
  echo "ERROR: PROJECT_ID not set (provide arg or set in .env)" >&2
  exit 1
fi

PYTHON=${PYTHON:-python3}

CMD=("$PYTHON" "$SCRIPT_DIR/generate_and_upload_ml.py" --project "$PROJECT_ID" --api-base "$API_BASE")
[[ -n "$API_KEY" ]] && CMD+=(--api-key "$API_KEY")
if [[ "${NO_HEATMAP:-0}" == "1" ]]; then
  CMD+=(--no-heatmap)
fi
if [[ -n "${MODEL_NAME_BASE:-}" ]]; then
  CMD+=(--model-name-base "${MODEL_NAME_BASE}")
fi

echo "[mock-ml] Running: ${CMD[*]}"
exec "${CMD[@]}"
