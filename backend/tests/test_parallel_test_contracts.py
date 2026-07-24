from __future__ import annotations

import os
import shutil
import subprocess
import tomllib
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
AGGREGATE_RUNNER = REPO_ROOT / "test" / "run_tests.sh"
BACKEND_RUNNER = REPO_ROOT / "test" / "backend_tests.sh"

SUITE_STUB = """\
#!/usr/bin/env bash
set -eu

case "$(basename "$0")" in
  backend_tests.sh)
    suite=backend
    delay="${BACKEND_DELAY:-0}"
    result="${BACKEND_RESULT:-0}"
    ;;
  frontend_tests.sh)
    suite=frontend
    delay="${FRONTEND_DELAY:-0}"
    result="${FRONTEND_RESULT:-0}"
    ;;
esac

printf '%s|%s\\n' "$suite" "$*" >>"$INVOCATION_LOG"
touch "$STATE_DIRECTORY/$suite.started"

if [ "$suite" = "frontend" ] && [ "${REQUIRE_BACKEND_FINISHED:-0}" = "1" ]; then
  [ -f "$STATE_DIRECTORY/backend.finished" ] || exit 90
fi

sleep "$delay"
touch "$STATE_DIRECTORY/$suite.finished"
exit "$result"
"""

FAKE_PYTHON = """\
#!/usr/bin/env bash
set -eu

printf '%s\\n' "$*" >>"$PYTHON_LOG"
if [ "${1:-}" = "-c" ]; then
  if [ "${IMPORTS_PRESENT:-1}" = "1" ]; then
    exit 0
  fi
  exit 1
fi

exit "${PYTEST_RESULT:-0}"
"""

FAKE_UV = """\
#!/usr/bin/env bash
set -eu

printf '%s\\n' "$*" >>"$UV_LOG"
touch "$SYNC_MARKER"
"""


def _write_executable(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)


def _aggregate_harness(tmp_path: Path) -> tuple[Path, dict[str, str], Path]:
    test_directory = tmp_path / "aggregate-repo" / "test"
    test_directory.mkdir(parents=True)
    runner = test_directory / "run_tests.sh"
    shutil.copy2(AGGREGATE_RUNNER, runner)
    _write_executable(test_directory / "backend_tests.sh", SUITE_STUB)
    _write_executable(test_directory / "frontend_tests.sh", SUITE_STUB)

    state_directory = tmp_path / "aggregate-state"
    temp_directory = tmp_path / "aggregate-temp"
    state_directory.mkdir()
    temp_directory.mkdir()
    environment = os.environ.copy()
    environment.update(
        {
            "INVOCATION_LOG": str(state_directory / "invocations.log"),
            "STATE_DIRECTORY": str(state_directory),
            "TMPDIR": str(temp_directory),
        }
    )
    return runner, environment, state_directory


def _run_aggregate(
    runner: Path,
    environment: dict[str, str],
    *arguments: str,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(runner), *arguments],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )


def _backend_harness(tmp_path: Path) -> tuple[Path, dict[str, str], Path]:
    repository = tmp_path / "backend-repo"
    test_directory = repository / "test"
    test_directory.mkdir(parents=True)
    (repository / "backend" / "tests").mkdir(parents=True)

    runner = test_directory / "backend_tests.sh"
    shutil.copy2(BACKEND_RUNNER, runner)

    virtual_environment = repository / ".venv"
    _write_executable(virtual_environment / "bin" / "activate", ":\n")
    fake_binary_directory = tmp_path / "fake-bin"
    _write_executable(fake_binary_directory / "python3", FAKE_PYTHON)
    _write_executable(fake_binary_directory / "uv", FAKE_UV)

    state_directory = tmp_path / "backend-state"
    state_directory.mkdir()
    environment = os.environ.copy()
    environment.update(
        {
            "PATH": f"{fake_binary_directory}:{environment['PATH']}",
            "VIRTUAL_ENV": str(virtual_environment),
            "PYTHON_LOG": str(state_directory / "python.log"),
            "UV_LOG": str(state_directory / "uv.log"),
            "SYNC_MARKER": str(state_directory / "synced"),
        }
    )
    return runner, environment, state_directory


def test_xdist_is_locked_in_both_supported_dev_dependency_forms() -> None:
    project = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text())
    lock = tomllib.loads((REPO_ROOT / "uv.lock").read_text())

    assert "pytest-xdist" in project["dependency-groups"]["dev"]
    assert "pytest-xdist" in project["project"]["optional-dependencies"]["dev"]

    packages = {package["name"]: package for package in lock["package"]}
    assert {"execnet", "pytest"}.issubset(
        dependency["name"]
        for dependency in packages["pytest-xdist"]["dependencies"]
    )
    assert {"pytest-xdist"}.issubset(
        dependency["name"]
        for dependency in packages["vista"]["dev-dependencies"]["dev"]
    )
    assert {"pytest-xdist"}.issubset(
        dependency["name"]
        for dependency in packages["vista"]["optional-dependencies"]["dev"]
    )


def test_backend_runner_defaults_to_four_workers_without_mutating_dependencies(
    tmp_path: Path,
) -> None:
    runner, environment, state_directory = _backend_harness(tmp_path)
    environment.pop("PYTEST_XDIST_WORKERS", None)

    result = subprocess.run(
        ["bash", str(runner)],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    python_calls = (state_directory / "python.log").read_text().splitlines()
    pytest_arguments = python_calls[-1].split()
    assert pytest_arguments[:2] == ["-m", "pytest"]
    assert pytest_arguments[pytest_arguments.index("-n") + 1] == "4"
    assert not (state_directory / "uv.log").exists()


def test_backend_runner_fails_without_installing_when_locked_dependencies_are_missing(
    tmp_path: Path,
) -> None:
    runner, environment, state_directory = _backend_harness(tmp_path)
    environment["IMPORTS_PRESENT"] = "0"
    environment["PYTEST_XDIST_WORKERS"] = "3"

    result = subprocess.run(
        ["bash", str(runner)],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "locked backend test dependencies are missing" in result.stdout
    assert "uv sync --frozen --group dev" in result.stdout
    assert not (state_directory / "uv.log").exists()
    assert not (state_directory / "synced").exists()
    python_calls = (state_directory / "python.log").read_text().splitlines()
    assert len(python_calls) == 1
    assert python_calls[0].startswith("-c ")
    assert "-m pytest" not in python_calls[0]


@pytest.mark.parametrize("workers", ["0", "-1", "auto", "1.5", "17", "100"])
def test_backend_runner_rejects_unbounded_or_invalid_worker_counts(
    tmp_path: Path,
    workers: str,
) -> None:
    runner, environment, state_directory = _backend_harness(tmp_path)
    environment["PYTEST_XDIST_WORKERS"] = workers

    result = subprocess.run(
        ["bash", str(runner)],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "PYTEST_XDIST_WORKERS must be an integer from 1 to 16" in result.stdout
    assert not (state_directory / "python.log").exists()
    assert not (state_directory / "uv.log").exists()


def test_backend_runner_contains_no_runtime_dependency_install_or_sync() -> None:
    runner = BACKEND_RUNNER.read_text(encoding="utf-8")

    assert "uv pip install" not in runner
    assert "if ! uv sync" not in runner
    assert "uv sync --frozen --extra dev --active" not in runner
    assert "Run 'uv sync --frozen --group dev'" in runner
    assert "-n auto" not in runner


@pytest.mark.parametrize(
    ("arguments", "expected_invocations"),
    [
        ([], ["backend|", "frontend|"]),
        (["--verbose"], ["backend|--verbose", "frontend|--verbose"]),
        (["-v"], ["backend|--verbose", "frontend|--verbose"]),
        (["--backend"], ["backend|"]),
        (["--frontend"], ["frontend|"]),
        (["--frontend", "--verbose"], ["frontend|--verbose"]),
    ],
)
def test_aggregate_runner_selects_suites_and_forwards_verbose(
    tmp_path: Path,
    arguments: list[str],
    expected_invocations: list[str],
) -> None:
    runner, environment, state_directory = _aggregate_harness(tmp_path)

    result = _run_aggregate(runner, environment, *arguments)

    assert result.returncode == 0, result.stderr
    invocations = (state_directory / "invocations.log").read_text().splitlines()
    assert invocations == expected_invocations


def test_aggregate_runner_finishes_backend_before_starting_frontend(
    tmp_path: Path,
) -> None:
    runner, environment, state_directory = _aggregate_harness(tmp_path)
    environment["BACKEND_DELAY"] = "0.1"
    environment["REQUIRE_BACKEND_FINISHED"] = "1"

    result = _run_aggregate(runner, environment)

    assert result.returncode == 0, result.stdout + result.stderr
    assert (state_directory / "backend.finished").exists()
    assert (state_directory / "frontend.finished").exists()


def test_aggregate_runner_continues_to_frontend_and_aggregates_failure(
    tmp_path: Path,
) -> None:
    runner, environment, state_directory = _aggregate_harness(tmp_path)
    environment.update(
        {
            "BACKEND_RESULT": "7",
            "FRONTEND_DELAY": "0.2",
        }
    )

    result = _run_aggregate(runner, environment)

    assert result.returncode == 1
    assert (state_directory / "frontend.finished").exists()
    assert "OVERALL RESULT: FAILED" in result.stdout
