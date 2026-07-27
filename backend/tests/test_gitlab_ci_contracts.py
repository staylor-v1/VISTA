from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
GITLAB_CI = REPO_ROOT / ".gitlab-ci.yml"
GITHUB_CI = REPO_ROOT / ".github" / "workflows" / "docker-image.yml"


def _pipeline(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def test_gitlab_pipeline_keeps_the_historical_build_only_contract() -> None:
    pipeline = _pipeline(GITLAB_CI)

    assert set(pipeline) == {"variables", "stages", "build"}
    assert pipeline["variables"] == {
        "QUAY_USERNAME": "${QUAY_USERNAME}",
        "QUAY_IMAGE_NAME": "vista",
        "QUAY_REGISTRY": "quay.io",
    }
    assert pipeline["stages"] == ["build"]

    build = pipeline["build"]
    assert build["stage"] == "build"
    assert build["image"] == "podman:latest"
    assert build["services"] == ["podman:dind"]
    assert build["only"] == ["main", "merge_requests"]


def test_gitlab_build_logs_in_and_pushes_latest_and_commit_sha_tags() -> None:
    build = _pipeline(GITLAB_CI)["build"]

    assert build["before_script"] == [
        'echo "$QUAY_PASSWORD" | podman login quay.io '
        '-u "$QUAY_USERNAME" --password-stdin'
    ]
    assert build["script"] == [
        "podman build --ignorefile Dockerfile.dockerignore "
        "-t $QUAY_REGISTRY/$QUAY_USERNAME/$QUAY_IMAGE_NAME:latest "
        "-t $QUAY_REGISTRY/$QUAY_USERNAME/$QUAY_IMAGE_NAME:$CI_COMMIT_SHA .",
        "podman push $QUAY_REGISTRY/$QUAY_USERNAME/$QUAY_IMAGE_NAME:latest",
        "podman push $QUAY_REGISTRY/$QUAY_USERNAME/$QUAY_IMAGE_NAME:$CI_COMMIT_SHA",
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
