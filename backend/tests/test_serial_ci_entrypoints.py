from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]


def test_output_only_runner_option_defaults_to_both_suites_in_order(
    tmp_path: Path,
) -> None:
    test_directory = tmp_path / "test"
    test_directory.mkdir()
    runner = test_directory / "run_tests.sh"
    shutil.copy2(REPO_ROOT / "test" / "run_tests.sh", runner)

    log = tmp_path / "runner.log"
    for suite in ("backend", "frontend"):
        script = test_directory / f"{suite}_tests.sh"
        script.write_text(
            "#!/usr/bin/env bash\n"
            f'printf "{suite}:%s\\\\n" "$*" >>"$RUNNER_LOG"\n',
            encoding="utf-8",
        )
        script.chmod(0o755)

    environment = os.environ.copy()
    environment["RUNNER_LOG"] = str(log)
    result = subprocess.run(
        ["bash", str(runner), "--verbose"],
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert log.read_text(encoding="utf-8").splitlines() == [
        "backend:--verbose",
        "frontend:--verbose",
    ]


def test_github_critical_e2e_gate_uses_direct_specs_and_one_worker() -> None:
    workflow_path = REPO_ROOT / ".github" / "workflows" / "docker-image.yml"
    workflow = yaml.safe_load(workflow_path.read_text(encoding="utf-8"))
    steps = workflow["jobs"]["test"]["steps"]

    critical = next(
        step
        for step in steps
        if step.get("name") == "Run critical end-to-end workflows serially"
    )
    command = critical["run"]
    for spec in (
        "full-inspection-workflow.spec.js",
        "inspection-workbench.spec.js",
        "pt3-fullscreen-annotation-parity.spec.js",
    ):
        assert spec in command
    assert "--workers=1" in command
    assert "--grep" not in command
    assert "--shard" not in command

    build_steps = workflow["jobs"]["build"]["steps"]
    assert not any(
        step.get("name") == "Run tests in container" for step in build_steps
    )


def test_simple_production_build_keeps_identity_and_safe_context() -> None:
    dockerfile = (REPO_ROOT / "Dockerfile").read_text(encoding="utf-8")
    dockerignore = (REPO_ROOT / ".dockerignore").read_text(
        encoding="utf-8"
    ).splitlines()

    assert "npm ci --legacy-peer-deps" in dockerfile
    assert "npm install" not in dockerfile
    assert 'org.opencontainers.image.revision="${VISTA_BUILD_COMMIT}"' in dockerfile
    assert 'io.vista.ci.pipeline-iid="${VISTA_CI_PIPELINE_IID}"' in dockerfile
    assert "final-prebuilt" not in dockerfile

    for excluded in (
        ".venv/",
        "test/",
        "backend/tests/",
        "frontend/e2e/",
        "frontend/artifacts/",
        "frontend/node_modules/.cache/",
    ):
        assert excluded in dockerignore
