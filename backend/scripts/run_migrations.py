#!/usr/bin/env python3
"""Run Alembic migrations with resilience for startup race conditions."""

from __future__ import annotations

import os
import subprocess
import sys
import time
from typing import Sequence

DEFAULT_ATTEMPTS = 15
DEFAULT_DELAY_SECONDS = 2.0


def _run_alembic_command(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["alembic", *args],
        check=False,
        capture_output=True,
        text=True,
    )


def _run_alembic_upgrade(target: str) -> subprocess.CompletedProcess[str]:
    return _run_alembic_command("upgrade", target)


def _run_alembic_heads() -> subprocess.CompletedProcess[str]:
    return _run_alembic_command("heads")


def _run_alembic_merge(heads: Sequence[str]) -> subprocess.CompletedProcess[str]:
    return _run_alembic_command(
        "merge",
        "-m",
        "auto-merge concurrent heads",
        *heads,
    )


def _parse_head_revisions(heads_stdout: str) -> list[str]:
    revisions: list[str] = []
    for line in heads_stdout.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        revision = stripped.split(" ", 1)[0]
        revisions.append(revision)
    return revisions


def _is_connection_error(stderr: str) -> bool:
    needle_set = {
        "connection refused",
        "could not connect to server",
        "connection to server",
        "temporary failure in name resolution",
        "timeout expired",
    }
    lowered = stderr.lower()
    return any(needle in lowered for needle in needle_set)


def run() -> int:
    attempts = int(os.getenv("MIGRATION_RETRY_ATTEMPTS", str(DEFAULT_ATTEMPTS)))
    delay_seconds = float(os.getenv("MIGRATION_RETRY_DELAY_SECONDS", str(DEFAULT_DELAY_SECONDS)))

    for attempt in range(1, attempts + 1):
        heads_result = _run_alembic_heads()
        if heads_result.returncode != 0:
            result = heads_result
        else:
            heads = _parse_head_revisions(heads_result.stdout)
            if len(heads) > 1:
                merge_result = _run_alembic_merge(heads)
                if merge_result.returncode != 0:
                    result = merge_result
                else:
                    result = _run_alembic_upgrade("head")
            else:
                result = _run_alembic_upgrade("head")

        if result.returncode == 0:
            print("Database migrations applied successfully.")
            return 0

        stderr = result.stderr.strip()
        if attempt < attempts and _is_connection_error(stderr):
            print(
                f"Migration attempt {attempt}/{attempts} failed due to database connectivity; retrying in {delay_seconds:.1f}s...",
                file=sys.stderr,
            )
            time.sleep(delay_seconds)
            continue

        print("Migration failed and cannot be retried automatically.", file=sys.stderr)
        if result.stdout:
            print(result.stdout, file=sys.stderr)
        if stderr:
            print(stderr, file=sys.stderr)
        return result.returncode

    return 1


if __name__ == "__main__":
    raise SystemExit(run())
