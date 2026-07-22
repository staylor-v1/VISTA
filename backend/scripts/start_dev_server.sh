#!/usr/bin/env bash
set -euo pipefail

# Docker named volumes are initially owned by root. Repair only the configured
# cache directories before starting the application as the unprivileged user;
# cached multi-gigabyte payloads never need a recursive ownership rewrite.
if [ "$(id -u)" -eq 0 ]; then
  cache_root="${CACHE_DIR:-/app/.cache}"
  volume_cache_root="${VOLUME_CACHE_DIR:-${cache_root}/volume-files}"
  mkdir -p "$cache_root" "$volume_cache_root"
  chown appuser:appuser "$cache_root" "$volume_cache_root"
  chmod 0700 "$volume_cache_root"
  exec runuser -u appuser -- bash "$0"
fi

cd /app/backend
echo 'Running database migrations...'
python /app/backend/scripts/run_migrations.py
echo 'Starting backend server with hot reload...'
exec uvicorn main:app --host 0.0.0.0 --port 8000 --reload
