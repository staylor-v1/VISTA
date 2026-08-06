from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
GITLAB_CI = REPO_ROOT / ".gitlab-ci.yml"
LOCAL_DOCKERFILE = REPO_ROOT / "Dockerfile"
DEPLOYED_DOCKERFILE = REPO_ROOT / "Dockerfile.prod"
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
        if any("buildah build " in command for command in commands):
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


def test_production_dockerfile_stays_in_sync_with_local_build() -> None:
    """Keep CI fixes mergeable with the historically deployed build recipe."""
    assert DEPLOYED_DOCKERFILE.read_bytes() == LOCAL_DOCKERFILE.read_bytes()


def test_gitlab_pipeline_matches_deployed_buildah_shape() -> None:
    pipeline = _pipeline(GITLAB_CI)

    assert pipeline["variables"]["QUAY_USERNAME"] == "vista-tk"
    assert pipeline["variables"]["QUAY_REGISTRY"] == "quay.io"
    assert pipeline["stages"] == ["build", "test", "deploy"]
    builds = _image_build_jobs(pipeline)
    assert len(builds) == 1
    build = builds[0]
    assert build["stage"] == "build"
    assert build["image"] == "quay.io/buildah/stable"
    assert build["variables"]["STORAGE_DRIVER"] == "vfs"
    assert build["artifacts"] == {
        "paths": ["build-image.tar"],
        "expire_in": "1hr",
    }
    assert build["only"] == ["branches"]


def test_gitlab_build_uses_production_dockerfile_and_exports_deploy_artifact() -> None:
    pipeline = _pipeline(GITLAB_CI)
    builds = _image_build_jobs(pipeline)
    assert len(builds) == 1
    # Login, build, and pushes must belong to the same effective job. Finding each
    # command somewhere in the pipeline would allow unrelated jobs to satisfy the
    # contract even though the image build itself could not authenticate or push.
    commands = _pipeline_commands(builds[0])

    login_commands = [command for command in commands if "buildah login " in command]
    assert len(login_commands) == 1
    assert "-u=$QUAY_ROBOT_NAME" in login_commands[0]
    assert "-p=$QUAY_ROBOT_PASSWORD" in login_commands[0]

    build_commands = [command for command in commands if "buildah build " in command]
    assert len(build_commands) == 1
    assert "--storage-driver $STORAGE_DRIVER" in build_commands[0]
    assert "$QUAY_USERNAME/build:latest" in build_commands[0]
    assert "vista-tk-deployednetwork-qual:$CI_COMMIT_SHORT_SHA" in build_commands[0]
    assert "-f Dockerfile.prod ." in build_commands[0]
    push_commands = [command for command in commands if "buildah push " in command]
    assert any(
        "vista-tk-deployednetwork-qual:$CI_COMMIT_SHORT_SHA" in command
        for command in push_commands
    )
    assert any("docker-archive:build-image.tar" in command for command in push_commands)


def test_gitlab_test_jobs_match_deployed_commands_with_public_registries() -> None:
    pipeline = _pipeline(GITLAB_CI)

    backend = pipeline["backend-tests"]
    assert backend["image"].endswith(
        "vista-tk-deployednetwork-qual:$CI_COMMIT_SHORT_SHA"
    )
    assert backend["variables"] == {
        "DEBUG": "true",
        "SKIP_HEADER_CHECK": "true",
        "FAST_TEST_MODE": "true",
    }
    assert backend["script"] == ["cd backend", "pytest -v -n 2 --tb=short tests/"]

    frontend = pipeline["frontend-tests"]
    assert frontend["image"] == "node:22-alpine"
    assert frontend["needs"] == []
    assert frontend["script"] == [
        "cd frontend",
        "npm config set registry https://registry.npmjs.org/",
        "npm install",
        "npm test -- --watchAll=false",
    ]


def test_gitlab_deploy_jobs_reuse_archived_image_and_preserve_targets() -> None:
    pipeline = _pipeline(GITLAB_CI)
    expected_targets = {
        "Deploy to dev": ("vista-tk-deployednetwork-dev", "on_success"),
        "Deploy to qual": ("vista-tk-deployednetwork-qual", "on_success"),
        "Deploy to prod": ("vista-tk-deployednetwork-prod", "manual"),
        "Deploy to deployednetwork2": ("vista-tk-deployednetwork2-prod", "manual"),
    }

    for name, (image_name, when) in expected_targets.items():
        job = pipeline[name]
        assert job["image"] == "quay.io/buildah/stable"
        assert job["needs"] == ["build"]
        assert job["variables"]["IMAGE_NAME"] == image_name
        assert job["when"] == when
        assert "buildah pull docker-archive:build-image.tar" in job["script"]
        assert any("${IMAGE_NAME}:latest" in command for command in job["script"])

    postgres_commands = pipeline["Update postgres image"]["script"]
    assert postgres_commands[0] == "buildah pull docker.io/bitnami/postgresql:latest"
    assert any(
        "bitnami-postgresql-deployednetwork2:18.1" in command
        for command in postgres_commands
    )
    assert any("bitnami-postgresql:18.1" in command for command in postgres_commands)


def test_gitlab_build_discovery_allows_additional_jobs_and_inherited_setup() -> None:
    pipeline = {
        ".buildah": {
            "image": "quay.io/buildah/stable",
            "before_script": ["buildah login quay.io"],
        },
        "backend-tests": {"script": ["pytest"]},
        "container-image": {
            "extends": ".buildah",
            "stage": "build",
            "script": ["buildah build -t image ."],
        },
    }

    assert _image_build_jobs(pipeline) == [
        {
            "image": "quay.io/buildah/stable",
            "before_script": ["buildah login quay.io"],
            "extends": ".buildah",
            "stage": "build",
            "script": ["buildah build -t image ."],
        }
    ]


def test_gitlab_build_contract_ignores_commands_from_unrelated_jobs() -> None:
    pipeline = {
        ".buildah": {"before_script": ["buildah login quay.io"]},
        "container-image": {
            "extends": ".buildah",
            "script": ["buildah build -t image .", "buildah push image"],
        },
        "unrelated": {
            "script": ["buildah login other.invalid", "buildah push other/image"]
        },
    }

    build = _image_build_jobs(pipeline)[0]

    assert _pipeline_commands(build) == [
        "buildah login quay.io",
        "buildah build -t image .",
        "buildah push image",
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
