from __future__ import annotations

import os
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
PUBLISH_SCRIPT = REPO_ROOT / "scripts" / "ci" / "publish_latest_image.sh"


def _fake_podman(tmp_path: Path) -> tuple[Path, Path]:
    tmp_path.mkdir(parents=True, exist_ok=True)
    log = tmp_path / "podman.log"
    executable = tmp_path / "podman"
    executable.write_text(
        """#!/bin/sh
set -eu
printf '%s\\n' "$*" >>"$PODMAN_LOG"

case "$1 $2" in
  "pull source:sha")
    exit 0
    ;;
  "pull repository:latest")
    case "${LATEST_PULL_RESULT:-present}" in
      present) exit 0 ;;
      missing) echo "manifest unknown" >&2; exit 1 ;;
      error) echo "registry connection failed" >&2; exit 1 ;;
      ambiguous) echo "proxy returned 404 not found" >&2; exit 1 ;;
    esac
    ;;
  "image inspect")
    image=$5
    if [ "$image" = "source:sha" ]; then
      printf '%s\\n' "${SOURCE_PIPELINE_IID:-42}"
    else
      printf '%s\\n' "${LATEST_PIPELINE_IID:-41}"
    fi
    ;;
  "tag source:sha"|"push repository:latest")
    exit 0
    ;;
esac
""",
        encoding="utf-8",
    )
    executable.chmod(0o755)
    return executable, log


def _run_publisher(
    tmp_path: Path,
    **overrides: str,
) -> tuple[subprocess.CompletedProcess[str], list[str]]:
    fake_podman, log = _fake_podman(tmp_path)
    environment = os.environ.copy()
    environment.update(
        {
            "CI_PIPELINE_IID": "42",
            "LATEST_IMAGE": "repository:latest",
            "PODMAN_BIN": str(fake_podman),
            "PODMAN_LOG": str(log),
            "SHA_IMAGE": "source:sha",
        }
    )
    environment.update(overrides)

    result = subprocess.run(
        ["sh", str(PUBLISH_SCRIPT)],
        cwd=REPO_ROOT,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )
    calls = log.read_text(encoding="utf-8").splitlines() if log.exists() else []
    return result, calls


def test_publisher_promotes_the_first_current_image(tmp_path: Path) -> None:
    result, calls = _run_publisher(tmp_path, LATEST_PULL_RESULT="missing")

    assert result.returncode == 0, result.stdout + result.stderr
    assert "tag source:sha repository:latest" in calls
    assert "push repository:latest" in calls


def test_publisher_refuses_to_move_latest_backwards(tmp_path: Path) -> None:
    result, calls = _run_publisher(tmp_path, LATEST_PIPELINE_IID="43")

    assert result.returncode == 0, result.stdout + result.stderr
    assert "Skipping stale publication" in result.stdout
    assert not any(call.startswith(("tag ", "push ")) for call in calls)


def test_publisher_fails_closed_on_identity_or_registry_errors(
    tmp_path: Path,
) -> None:
    wrong_source, wrong_calls = _run_publisher(
        tmp_path / "wrong-source",
        SOURCE_PIPELINE_IID="41",
    )
    assert wrong_source.returncode != 0
    assert "source image pipeline IID does not match" in wrong_source.stderr
    assert not any(call.startswith("push ") for call in wrong_calls)

    registry_error, registry_calls = _run_publisher(
        tmp_path / "registry-error",
        LATEST_PULL_RESULT="error",
    )
    assert registry_error.returncode != 0
    assert "could not read existing latest image" in registry_error.stderr
    assert not any(call.startswith("push ") for call in registry_calls)

    ambiguous_error, ambiguous_calls = _run_publisher(
        tmp_path / "ambiguous-error",
        LATEST_PULL_RESULT="ambiguous",
    )
    assert ambiguous_error.returncode != 0
    assert "could not read existing latest image" in ambiguous_error.stderr
    assert not any(call.startswith("push ") for call in ambiguous_calls)


def test_publisher_rejects_unbounded_pipeline_ids(tmp_path: Path) -> None:
    result, calls = _run_publisher(
        tmp_path,
        CI_PIPELINE_IID="999999999999999999999999999999",
        SOURCE_PIPELINE_IID="999999999999999999999999999999",
    )

    assert result.returncode != 0
    assert "at most 18 digits" in result.stderr
    assert not any(call.startswith("pull ") for call in calls)
