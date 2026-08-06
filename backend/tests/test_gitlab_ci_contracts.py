from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
GITLAB_CI = REPO_ROOT / ".gitlab-ci.yml"
GITHUB_CI = REPO_ROOT / ".github" / "workflows" / "docker-image.yml"


def _pipeline(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _effective_job(pipeline: dict, job_name: str) -> dict:
    """Resolve the subset of GitLab ``extends`` needed by contract tests."""
    job = pipeline[job_name]
    parents = job.get("extends", [])
    if isinstance(parents, str):
        parents = [parents]
    effective: dict = {}
    for parent in parents:
        effective.update(_effective_job(pipeline, parent))
    effective.update(job)
    return effective


def _image_build_jobs(pipeline: dict) -> list[dict]:
    jobs = []
    for name, value in pipeline.items():
        if name.startswith(".") or not isinstance(value, dict):
            continue
        effective = _effective_job(pipeline, name)
        commands = effective.get("script", [])
        if isinstance(commands, str):
            commands = [commands]
        if any("podman build " in command for command in commands):
            jobs.append(effective)
    return jobs


def _pipeline_commands(value: object) -> list[str]:
    """Collect shell commands regardless of whether CI keeps them on a job/template."""
    if isinstance(value, dict):
        commands: list[str] = []
        for key, child in value.items():
            if key in {"before_script", "script", "after_script"}:
                commands.extend([child] if isinstance(child, str) else child)
            elif isinstance(child, dict):
                commands.extend(_pipeline_commands(child))
        return commands
    return []


def test_gitlab_pipeline_retains_secure_podman_image_build_contract() -> None:
    pipeline = _pipeline(GITLAB_CI)

    assert pipeline["variables"]["QUAY_IMAGE_NAME"] == "vista"
    assert pipeline["variables"]["QUAY_REGISTRY"] == "quay.io"
    builds = _image_build_jobs(pipeline)
    assert len(builds) == 1
    build = builds[0]
    assert build["stage"] == "build"
    assert build["image"] == "podman:latest"
    assert build["services"] == ["podman:dind"]


def test_gitlab_build_logs_in_and_pushes_latest_and_commit_sha_tags() -> None:
    pipeline = _pipeline(GITLAB_CI)
    builds = _image_build_jobs(pipeline)
    assert len(builds) == 1
    # Login, build, and pushes must belong to the same effective job. Finding each
    # command somewhere in the pipeline would allow unrelated jobs to satisfy the
    # contract even though the image build itself could not authenticate or push.
    commands = _pipeline_commands(builds[0])

    login_commands = [command for command in commands if "podman login " in command]
    assert len(login_commands) == 1
    assert 'echo "$QUAY_PASSWORD"' in login_commands[0]
    assert "--password-stdin" in login_commands[0]

    build_commands = [command for command in commands if "podman build " in command]
    assert len(build_commands) == 1
    assert "--ignorefile Dockerfile.dockerignore" in build_commands[0]
    assert "$QUAY_IMAGE_NAME:latest" in build_commands[0]
    assert "$QUAY_IMAGE_NAME:$CI_COMMIT_SHA" in build_commands[0]
    assert '"$QUAY_REGISTRY/$QUAY_USERNAME/$QUAY_IMAGE_NAME:latest"' in build_commands[0]
    assert (
        '"$QUAY_REGISTRY/$QUAY_USERNAME/$QUAY_IMAGE_NAME:$CI_COMMIT_SHA"'
        in build_commands[0]
    )
    push_commands = [command for command in commands if "podman push " in command]
    assert any("$QUAY_IMAGE_NAME:latest" in command for command in push_commands)
    assert any("$QUAY_IMAGE_NAME:$CI_COMMIT_SHA" in command for command in push_commands)
    assert all(
        command.removeprefix("podman push ").startswith('"')
        and command.endswith('"')
        for command in push_commands
    )


def test_gitlab_build_discovery_allows_additional_jobs_and_inherited_setup() -> None:
    pipeline = {
        ".podman": {
            "image": "podman:latest",
            "before_script": ["podman login quay.io"],
        },
        "backend-tests": {"script": ["pytest"]},
        "container-image": {
            "extends": ".podman",
            "stage": "build",
            "script": ["podman build -t image ."],
        },
    }

    assert _image_build_jobs(pipeline) == [
        {
            "image": "podman:latest",
            "before_script": ["podman login quay.io"],
            "extends": ".podman",
            "stage": "build",
            "script": ["podman build -t image ."],
        }
    ]


def test_gitlab_build_contract_ignores_commands_from_unrelated_jobs() -> None:
    pipeline = {
        ".podman": {"before_script": ["podman login quay.io"]},
        "container-image": {
            "extends": ".podman",
            "script": ["podman build -t image .", "podman push image"],
        },
        "unrelated": {
            "script": ["podman login other.invalid", "podman push other/image"]
        },
    }

    build = _image_build_jobs(pipeline)[0]

    assert _pipeline_commands(build) == [
        "podman login quay.io",
        "podman build -t image .",
        "podman push image",
    ]


def test_github_workflow_retains_verification_before_its_image_build() -> None:
    workflow = _pipeline(GITHUB_CI)
    jobs = workflow["jobs"]

    assert jobs["build"]["needs"] == "test"
    test_step_names = {
        step.get("name") for step in jobs["test"]["steps"] if "name" in step
    }
    assert "Verify PostgreSQL migration upgrade path" in test_step_names
    assert "Run PostgreSQL integration contracts serially" in test_step_names
    assert "Run critical end-to-end workflows serially" in test_step_names
