from __future__ import annotations

import os
import signal
import shutil
import subprocess
import time
import tomllib
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
AGGREGATE_RUNNER = REPO_ROOT / "test" / "run_tests.sh"
BACKEND_RUNNER = REPO_ROOT / "test" / "backend_tests.sh"
FRONTEND_RUNNER = REPO_ROOT / "test" / "frontend_tests.sh"
SHARD_SELECTOR = REPO_ROOT / "scripts" / "ci" / "select_test_shard.sh"
CI_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "docker-image.yml"

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
if [ "$suite" = "frontend" ] && [ "${REQUIRE_CONCURRENT:-0}" = "1" ]; then
  attempt=0
  while [ ! -f "$STATE_DIRECTORY/backend.started" ] && [ "$attempt" -lt 100 ]; do
    sleep 0.01
    attempt=$((attempt + 1))
  done
  [ -f "$STATE_DIRECTORY/backend.started" ] || exit 91
  [ ! -f "$STATE_DIRECTORY/backend.finished" ] || exit 92
fi

if [ "${TERMINATION_PROBE:-0}" = "1" ]; then
  (
    sleep "$delay"
    touch "$STATE_DIRECTORY/$suite.orphaned"
  ) &
  wait "$!"
else
  sleep "$delay"
fi
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

FAKE_NPM = """\
#!/usr/bin/env bash
set -eu

printf '%s\\n' "$*" >>"$NPM_LOG"
exit "${JEST_RESULT:-0}"
"""

FAKE_NODE = """\
#!/usr/bin/env bash
set -eu

printf '%s\\n' "$*" >>"$NODE_LOG"
exit "${CUSTOM_RESULT:-0}"
"""


def _write_executable(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)


def _write_sized_test(path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)


def _restore_aggregate_runner_signal_defaults() -> None:
    # pytest-xdist workers can inherit SIGINT as ignored. A disposition ignored
    # at exec time cannot subsequently be trapped by Bash, so give the child
    # the same signal baseline it has when launched from a developer shell.
    for handled_signal in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(handled_signal, signal.SIG_DFL)


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
    selector = repository / "scripts" / "ci" / "select_test_shard.sh"
    selector.parent.mkdir(parents=True)
    shutil.copy2(SHARD_SELECTOR, selector)

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
    environment.pop("PYTEST_XDIST_WORKERS", None)
    environment.pop("TEST_SHARD_MANIFEST_PATH", None)
    return runner, environment, state_directory


def _frontend_harness(tmp_path: Path) -> tuple[Path, dict[str, str], Path]:
    repository = tmp_path / "frontend-repo"
    test_directory = repository / "test"
    test_directory.mkdir(parents=True)
    frontend = repository / "frontend"
    (frontend / "src" / "__tests__").mkdir(parents=True)

    runner = test_directory / "frontend_tests.sh"
    shutil.copy2(FRONTEND_RUNNER, runner)
    selector = repository / "scripts" / "ci" / "select_test_shard.sh"
    selector.parent.mkdir(parents=True)
    shutil.copy2(SHARD_SELECTOR, selector)

    _write_executable(
        frontend / "node_modules" / ".bin" / "react-scripts",
        "#!/usr/bin/env bash\nexit 0\n",
    )
    (frontend / "src" / "__tests__" / "test-runner.cjs").write_text(
        "// custom runner fixture\n",
        encoding="utf-8",
    )

    fake_binary_directory = tmp_path / "frontend-fake-bin"
    _write_executable(fake_binary_directory / "npm", FAKE_NPM)
    _write_executable(fake_binary_directory / "node", FAKE_NODE)

    state_directory = tmp_path / "frontend-state"
    state_directory.mkdir()
    environment = os.environ.copy()
    environment.update(
        {
            "PATH": f"{fake_binary_directory}:{environment['PATH']}",
            "NPM_LOG": str(state_directory / "npm.log"),
            "NODE_LOG": str(state_directory / "node.log"),
        }
    )
    environment.pop("FRONTEND_JEST_WORKERS", None)
    environment.pop("FRONTEND_JEST_CACHE_DIR", None)
    environment.pop("CI_JOB_ID", None)
    environment.pop("TEST_SHARD_MANIFEST_PATH", None)
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


def test_backend_runner_shards_recursive_default_tests_and_writes_exact_manifest(
    tmp_path: Path,
) -> None:
    runner, environment, state_directory = _backend_harness(tmp_path)
    repository = runner.parent.parent
    for name, size in [
        ("test_large.py", 30),
        ("test_medium.py", 20),
        ("test_small.py", 10),
        ("unit/test_nested.py", 8),
        ("unit/nested_case_test.py", 7),
    ]:
        _write_sized_test(repository / "backend" / "tests" / name, size)
    _write_sized_test(
        repository / "backend" / "tests" / "postgres" / "test_nested.py",
        100,
    )
    _write_sized_test(
        repository / "backend" / "tests" / "load" / "stress_test.py",
        100,
    )
    manifest = state_directory / "manifests" / "backend-1.txt"
    environment["TEST_SHARD_MANIFEST_PATH"] = str(manifest)

    result = subprocess.run(
        [
            "bash",
            str(runner),
            "--shard-index",
            "1",
            "--shard-total",
            "1",
        ],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    pytest_arguments = (
        state_directory / "python.log"
    ).read_text().splitlines()[-1].split()
    assert pytest_arguments[pytest_arguments.index("-n") + 1] == "1"
    selected = manifest.read_text(encoding="utf-8").splitlines()
    assert set(selected) == {
        "tests/test_large.py",
        "tests/test_medium.py",
        "tests/test_small.py",
        "tests/unit/test_nested.py",
        "tests/unit/nested_case_test.py",
    }
    assert "tests/postgres/test_nested.py" not in selected
    assert "tests/load/stress_test.py" not in selected
    assert all(path in pytest_arguments for path in selected)
    assert not list(manifest.parent.glob(".vista-test-shard-manifest.*"))


def test_backend_runner_rejects_nested_worker_override_in_sharded_mode(
    tmp_path: Path,
) -> None:
    runner, environment, state_directory = _backend_harness(tmp_path)
    repository = runner.parent.parent
    _write_sized_test(repository / "backend" / "tests" / "test_one.py", 10)
    environment["PYTEST_XDIST_WORKERS"] = "3"

    result = subprocess.run(
        [
            "bash",
            str(runner),
            "--shard-index=1",
            "--shard-total=1",
        ],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "PYTEST_XDIST_WORKERS must equal 1 in sharded mode" in result.stdout
    assert not (state_directory / "python.log").exists()


@pytest.mark.parametrize(
    "arguments",
    [
        ["--shard-index", "1"],
        ["--shard-total", "2"],
        ["--shard-index", "0", "--shard-total", "2"],
        ["--shard-index", "3", "--shard-total", "2"],
        ["--shard-index", "1", "--shard-total", "65"],
    ],
)
def test_backend_runner_rejects_invalid_shard_pairs(
    tmp_path: Path,
    arguments: list[str],
) -> None:
    runner, environment, state_directory = _backend_harness(tmp_path)

    result = subprocess.run(
        ["bash", str(runner), *arguments],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "shard" in result.stdout.lower()
    assert not (state_directory / "python.log").exists()


def test_backend_runner_fails_an_empty_shard_before_pytest(
    tmp_path: Path,
) -> None:
    runner, environment, state_directory = _backend_harness(tmp_path)
    repository = runner.parent.parent
    _write_sized_test(repository / "backend" / "tests" / "test_only.py", 10)

    result = subprocess.run(
        [
            "bash",
            str(runner),
            "--shard-index",
            "2",
            "--shard-total",
            "2",
        ],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "backend test shard 2/2 is empty" in result.stdout
    python_calls = (state_directory / "python.log").read_text().splitlines()
    assert len(python_calls) == 1
    assert python_calls[0].startswith("-c ")


def test_backend_runner_default_output_stays_compact(tmp_path: Path) -> None:
    runner, environment, state_directory = _backend_harness(tmp_path)
    environment.pop("CI", None)
    environment.pop("BACKEND_TEST_MAXFAIL", None)

    result = subprocess.run(
        ["bash", str(runner)],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    pytest_arguments = (
        state_directory / "python.log"
    ).read_text().splitlines()[-1].split()
    assert "-q" in pytest_arguments
    assert "--tb=line" in pytest_arguments
    assert "--show-capture=no" in pytest_arguments
    assert "--disable-warnings" in pytest_arguments
    assert "--maxfail=10" in pytest_arguments
    assert "--show-capture=all" not in pytest_arguments


def test_backend_runner_verbose_enables_full_diagnostics(tmp_path: Path) -> None:
    runner, environment, state_directory = _backend_harness(tmp_path)

    result = subprocess.run(
        ["bash", str(runner), "--verbose"],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    pytest_arguments = (
        state_directory / "python.log"
    ).read_text().splitlines()[-1].split()
    assert "-v" in pytest_arguments
    assert "--tb=long" in pytest_arguments
    assert "--show-capture=all" in pytest_arguments
    assert "--show-capture=no" not in pytest_arguments
    assert "--disable-warnings" not in pytest_arguments
    assert "-q" not in pytest_arguments


def test_backend_runner_ci_collects_every_failure_by_default(
    tmp_path: Path,
) -> None:
    runner, environment, state_directory = _backend_harness(tmp_path)
    environment["CI"] = "true"
    environment.pop("BACKEND_TEST_MAXFAIL", None)

    result = subprocess.run(
        ["bash", str(runner)],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stderr
    pytest_arguments = (
        state_directory / "python.log"
    ).read_text().splitlines()[-1].split()
    assert not any(
        argument.startswith("--maxfail")
        for argument in pytest_arguments
    )


@pytest.mark.parametrize(
    "maxfail",
    ["", "-1", "1.5", "many"],
)
def test_backend_runner_rejects_invalid_explicit_failure_caps(
    tmp_path: Path,
    maxfail: str,
) -> None:
    runner, environment, state_directory = _backend_harness(tmp_path)
    environment["BACKEND_TEST_MAXFAIL"] = maxfail

    result = subprocess.run(
        ["bash", str(runner)],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert (
        "BACKEND_TEST_MAXFAIL must be 0 or a positive integer"
        in result.stdout
    )
    python_calls = (state_directory / "python.log").read_text().splitlines()
    assert len(python_calls) == 1
    assert python_calls[0].startswith("-c ")
    assert "-m pytest" not in python_calls[0]


def test_backend_ci_workflow_explicitly_disables_failure_cap() -> None:
    workflow = CI_WORKFLOW.read_text(encoding="utf-8")

    assert 'BACKEND_TEST_MAXFAIL: "0"' in workflow


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


def test_frontend_runner_defaults_to_two_jest_workers_and_runs_custom(
    tmp_path: Path,
) -> None:
    runner, environment, state_directory = _frontend_harness(tmp_path)

    result = subprocess.run(
        ["bash", str(runner)],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    npm_call = (state_directory / "npm.log").read_text().strip()
    assert "run test:unit:ci --" in npm_call
    assert "--maxWorkers=2" in npm_call.split()
    assert (
        f"--cacheDirectory={runner.parent.parent}/.cache/jest/local-unsharded"
        in npm_call.split()
    )
    assert (state_directory / "node.log").read_text().strip() == (
        "src/__tests__/test-runner.cjs"
    )


def test_frontend_runner_jest_shard_uses_one_worker_and_exact_manifest(
    tmp_path: Path,
) -> None:
    runner, environment, state_directory = _frontend_harness(tmp_path)
    repository = runner.parent.parent
    for relative_path, size in [
        ("src/App.test.js", 30),
        ("src/components/Medium.spec.jsx", 20),
        ("src/utils/Small.test.tsx", 10),
        ("src/features/__tests__/arbitrary.ts", 9),
        ("src/__tests__/Overlapping.test.js", 8),
        ("src/__tests__/root-arbitrary.js", 7),
    ]:
        _write_sized_test(repository / "frontend" / relative_path, size)
    manifest = state_directory / "manifests" / "frontend-1.txt"
    environment["TEST_SHARD_MANIFEST_PATH"] = str(manifest)

    result = subprocess.run(
        [
            "bash",
            str(runner),
            "--jest-only",
            "--shard-index",
            "1",
            "--shard-total",
            "1",
        ],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    npm_arguments = (state_directory / "npm.log").read_text().split()
    assert "--maxWorkers=1" in npm_arguments
    assert (
        f"--cacheDirectory={repository}/.cache/jest/local-shard-1-of-1"
        in npm_arguments
    )
    assert "--runTestsByPath" in npm_arguments
    selected = manifest.read_text(encoding="utf-8").splitlines()
    assert set(selected) == {
        "src/App.test.js",
        "src/components/Medium.spec.jsx",
        "src/utils/Small.test.tsx",
        "src/features/__tests__/arbitrary.ts",
        "src/__tests__/Overlapping.test.js",
        "src/__tests__/root-arbitrary.js",
    }
    assert len(selected) == len(set(selected))
    assert all(path in npm_arguments for path in selected)
    assert not (state_directory / "node.log").exists()
    assert not list(manifest.parent.glob(".vista-test-shard-manifest.*"))


def test_frontend_runner_gives_concurrent_local_shards_distinct_caches(
    tmp_path: Path,
) -> None:
    runner, environment, _ = _frontend_harness(tmp_path)
    repository = runner.parent.parent
    for index in range(1, 5):
        _write_sized_test(
            repository / "frontend" / "src" / f"Shard{index}.test.js",
            10,
        )

    processes: list[tuple[subprocess.Popen[str], Path]] = []
    for index in range(1, 5):
        npm_log = tmp_path / f"npm-shard-{index}.log"
        shard_environment = environment.copy()
        shard_environment["NPM_LOG"] = str(npm_log)
        process = subprocess.Popen(
            [
                "bash",
                str(runner),
                "--jest-only",
                "--shard-index",
                str(index),
                "--shard-total",
                "4",
            ],
            env=shard_environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        processes.append((process, npm_log))

    cache_arguments = set()
    for process, npm_log in processes:
        stdout, stderr = process.communicate(timeout=10)
        assert process.returncode == 0, stdout + stderr
        arguments = npm_log.read_text(encoding="utf-8").split()
        cache_arguments.update(
            argument
            for argument in arguments
            if argument.startswith("--cacheDirectory=")
        )

    assert cache_arguments == {
        (
            f"--cacheDirectory={repository}/.cache/jest/"
            f"local-shard-{index}-of-4"
        )
        for index in range(1, 5)
    }


def test_frontend_runner_ci_cache_includes_job_and_shard_identity(
    tmp_path: Path,
) -> None:
    runner, environment, state_directory = _frontend_harness(tmp_path)
    repository = runner.parent.parent
    _write_sized_test(repository / "frontend" / "src" / "One.test.js", 10)
    environment["CI_JOB_ID"] = "8675309"

    result = subprocess.run(
        [
            "bash",
            str(runner),
            "--jest-only",
            "--shard-index",
            "1",
            "--shard-total",
            "1",
        ],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    npm_arguments = (state_directory / "npm.log").read_text().split()
    assert (
        f"--cacheDirectory={repository}/.cache/jest/"
        "ci-job-8675309-shard-1-of-1"
    ) in npm_arguments


def test_frontend_runner_treats_cache_override_as_a_resolved_namespace_root(
    tmp_path: Path,
) -> None:
    runner, environment, state_directory = _frontend_harness(tmp_path)
    repository = runner.parent.parent
    _write_sized_test(repository / "frontend" / "src" / "One.test.js", 10)
    environment["FRONTEND_JEST_CACHE_DIR"] = "custom jest cache"

    result = subprocess.run(
        [
            "bash",
            str(runner),
            "--jest-only",
            "--shard-index",
            "1",
            "--shard-total",
            "1",
        ],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    npm_call = (state_directory / "npm.log").read_text(encoding="utf-8")
    expected_cache = repository / "custom jest cache" / "local-shard-1-of-1"
    assert f"--cacheDirectory={expected_cache}" in npm_call
    assert expected_cache.is_dir()


@pytest.mark.parametrize(
    ("variable", "value", "error"),
    [
        (
            "FRONTEND_JEST_CACHE_DIR",
            "",
            "FRONTEND_JEST_CACHE_DIR must not be empty when set",
        ),
        (
            "CI_JOB_ID",
            "../../shared",
            "CI_JOB_ID must be a positive integer when set",
        ),
    ],
)
def test_frontend_runner_rejects_unsafe_cache_namespace_inputs(
    tmp_path: Path,
    variable: str,
    value: str,
    error: str,
) -> None:
    runner, environment, state_directory = _frontend_harness(tmp_path)
    environment[variable] = value

    result = subprocess.run(
        ["bash", str(runner), "--jest-only"],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert error in result.stdout
    assert not (state_directory / "npm.log").exists()


def test_frontend_runner_custom_only_needs_no_jest_install(
    tmp_path: Path,
) -> None:
    runner, environment, state_directory = _frontend_harness(tmp_path)
    repository = runner.parent.parent
    (
        repository
        / "frontend"
        / "node_modules"
        / ".bin"
        / "react-scripts"
    ).unlink()

    result = subprocess.run(
        ["bash", str(runner), "--custom-only"],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert not (state_directory / "npm.log").exists()
    assert (state_directory / "node.log").read_text().strip() == (
        "src/__tests__/test-runner.cjs"
    )


@pytest.mark.parametrize(
    "arguments",
    [
        ["--jest-only", "--custom-only"],
        ["--jest-only", "--shard-index", "1"],
        ["--jest-only", "--shard-total", "2"],
        ["--shard-index", "1", "--shard-total", "1"],
        ["--jest-only", "--shard-index", "0", "--shard-total", "2"],
        ["--jest-only", "--shard-index", "3", "--shard-total", "2"],
        ["--jest-only", "--shard-index", "1", "--shard-total", "65"],
    ],
)
def test_frontend_runner_rejects_conflicting_or_invalid_lane_and_shard_options(
    tmp_path: Path,
    arguments: list[str],
) -> None:
    runner, environment, state_directory = _frontend_harness(tmp_path)

    result = subprocess.run(
        ["bash", str(runner), *arguments],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert not (state_directory / "npm.log").exists()
    assert not (state_directory / "node.log").exists()


def test_frontend_runner_fails_an_empty_jest_shard_before_npm(
    tmp_path: Path,
) -> None:
    runner, environment, state_directory = _frontend_harness(tmp_path)
    repository = runner.parent.parent
    _write_sized_test(repository / "frontend" / "src" / "Only.test.js", 10)

    result = subprocess.run(
        [
            "bash",
            str(runner),
            "--jest-only",
            "--shard-index",
            "2",
            "--shard-total",
            "2",
        ],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "frontend Jest shard 2/2 is empty" in result.stdout
    assert not (state_directory / "npm.log").exists()
    assert not (state_directory / "node.log").exists()


def test_frontend_runner_rejects_nested_worker_override_in_sharded_mode(
    tmp_path: Path,
) -> None:
    runner, environment, state_directory = _frontend_harness(tmp_path)
    repository = runner.parent.parent
    _write_sized_test(repository / "frontend" / "src" / "One.test.js", 10)
    environment["FRONTEND_JEST_WORKERS"] = "2"

    result = subprocess.run(
        [
            "bash",
            str(runner),
            "--jest-only",
            "--shard-index",
            "1",
            "--shard-total",
            "1",
        ],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "FRONTEND_JEST_WORKERS must equal 1 in sharded mode" in result.stdout
    assert not (state_directory / "npm.log").exists()


@pytest.mark.parametrize("workers", ["0", "-1", "auto", "1.5", "9", "100"])
def test_frontend_runner_rejects_unbounded_or_invalid_worker_counts(
    tmp_path: Path,
    workers: str,
) -> None:
    runner, environment, state_directory = _frontend_harness(tmp_path)
    environment["FRONTEND_JEST_WORKERS"] = workers

    result = subprocess.run(
        ["bash", str(runner), "--jest-only"],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "FRONTEND_JEST_WORKERS must be an integer from 1 to 8" in result.stdout
    assert not (state_directory / "npm.log").exists()


@pytest.mark.parametrize(
    ("arguments", "expected_invocations"),
    [
        ([], ["backend|", "frontend|"]),
        (["--verbose"], ["backend|--verbose", "frontend|--verbose"]),
        (["-v"], ["backend|--verbose", "frontend|--verbose"]),
        (["--backend"], ["backend|"]),
        (["--frontend"], ["frontend|"]),
        (["--frontend", "--verbose"], ["frontend|--verbose"]),
        (["--sequential"], ["backend|", "frontend|"]),
    ],
)
def test_aggregate_runner_selects_suites_and_forwards_only_runner_options(
    tmp_path: Path,
    arguments: list[str],
    expected_invocations: list[str],
) -> None:
    runner, environment, state_directory = _aggregate_harness(tmp_path)

    result = _run_aggregate(runner, environment, *arguments)

    assert result.returncode == 0, result.stderr
    invocations = (state_directory / "invocations.log").read_text().splitlines()
    assert sorted(invocations) == sorted(expected_invocations)


def test_aggregate_runner_overlaps_backend_and_frontend_by_default(
    tmp_path: Path,
) -> None:
    runner, environment, state_directory = _aggregate_harness(tmp_path)
    environment["BACKEND_DELAY"] = "0.3"
    environment["REQUIRE_CONCURRENT"] = "1"

    result = _run_aggregate(runner, environment)

    assert result.returncode == 0, result.stdout + result.stderr
    assert (state_directory / "backend.finished").exists()
    assert (state_directory / "frontend.finished").exists()


def test_aggregate_runner_sequential_opt_out_finishes_backend_first(
    tmp_path: Path,
) -> None:
    runner, environment, state_directory = _aggregate_harness(tmp_path)
    environment["BACKEND_DELAY"] = "0.1"
    environment["REQUIRE_BACKEND_FINISHED"] = "1"

    result = _run_aggregate(runner, environment, "--sequential")

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


@pytest.mark.parametrize(
    ("sent_signal", "expected_exit_code"),
    [
        (signal.SIGHUP, 129),
        (signal.SIGINT, 130),
        (signal.SIGTERM, 143),
    ],
)
def test_aggregate_runner_signal_stops_both_process_trees(
    tmp_path: Path,
    sent_signal: signal.Signals,
    expected_exit_code: int,
) -> None:
    runner, environment, state_directory = _aggregate_harness(tmp_path)
    environment.update(
        {
            "BACKEND_DELAY": "0.4",
            "FRONTEND_DELAY": "0.4",
            "TERMINATION_PROBE": "1",
        }
    )

    process = subprocess.Popen(
        ["bash", str(runner)],
        env=environment,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        preexec_fn=_restore_aggregate_runner_signal_defaults,
    )
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if (
            (state_directory / "backend.started").exists()
            and (state_directory / "frontend.started").exists()
        ):
            break
        time.sleep(0.01)
    else:
        process.kill()
        process.communicate(timeout=2)
        pytest.fail("aggregate runner did not start both suites")

    process.send_signal(sent_signal)
    stdout, stderr = process.communicate(timeout=2)
    assert process.returncode == expected_exit_code, stdout + stderr

    # A descendant that escaped cleanup would create its own marker after its
    # suite shell had already been terminated.
    time.sleep(0.5)
    assert not list(state_directory.glob("*.orphaned"))
    assert not list(state_directory.glob("*.finished"))
