from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
GITLAB_CI = REPO_ROOT / ".gitlab-ci.yml"


def _pipeline() -> dict:
    return yaml.safe_load(GITLAB_CI.read_text(encoding="utf-8"))


def _commands(job: dict) -> str:
    commands = [*job.get("before_script", []), *job.get("script", [])]
    assert all(isinstance(command, str) for command in commands)
    return "\n".join(commands)


def test_pipeline_is_fail_closed_for_main_pushes_and_merge_requests() -> None:
    pipeline = _pipeline()
    expected_rules = [
        {
            "if": (
                '$CI_PIPELINE_SOURCE == "push" '
                '&& $CI_COMMIT_BRANCH == "main"'
            )
        },
        {"if": '$CI_PIPELINE_SOURCE == "merge_request_event"'},
        {"when": "never"},
    ]

    assert pipeline["workflow"]["rules"] == expected_rules
    assert pipeline[".verified-pipeline"]["rules"] == expected_rules
    for job_name in (
        "backend:verify",
        "frontend:verify",
        "postgres:verify",
        "e2e:critical",
        "image:build",
    ):
        assert pipeline[job_name]["extends"] == ".verified-pipeline"


def test_required_verification_progresses_in_explicit_serial_stages() -> None:
    pipeline = _pipeline()

    assert pipeline["stages"] == [
        "backend",
        "frontend",
        "postgres",
        "e2e",
        "build",
        "publish",
    ]
    assert [
        pipeline[job_name]["stage"]
        for job_name in (
            "backend:verify",
            "frontend:verify",
            "postgres:verify",
            "e2e:critical",
            "image:build",
            "image:publish",
        )
    ] == pipeline["stages"]

    for name, config in pipeline.items():
        if not isinstance(config, dict) or name.startswith("."):
            continue
        assert "parallel" not in config
        assert "needs" not in config
        assert "cache" not in config


def test_test_lanes_are_complete_and_do_not_restore_sharding_or_load() -> None:
    pipeline = _pipeline()

    backend = _commands(pipeline["backend:verify"])
    assert '-m "not postgres" tests' in backend
    assert " -n " not in backend

    frontend = _commands(pipeline["frontend:verify"])
    assert "npm ci --legacy-peer-deps" in frontend
    assert frontend.index("npm run test:unit:ci") < frontend.index(
        "node src/__tests__/test-runner.cjs"
    )

    postgres = _commands(pipeline["postgres:verify"])
    assert "alembic upgrade 20260428_0008" in postgres
    assert "alembic upgrade head" in postgres
    assert "-m postgres tests/postgres" in postgres
    assert " -n " not in postgres

    critical = _commands(pipeline["e2e:critical"])
    for spec in (
        "full-inspection-workflow.spec.js",
        "inspection-workbench.spec.js",
        "pt3-fullscreen-annotation-parity.spec.js",
    ):
        assert spec in critical
    assert "--workers=1" in critical
    assert "--retries=0" in critical
    assert "--grep" not in critical
    assert "--shard" not in critical
    assert "--fully-parallel" not in critical

    assert "backend:load" not in pipeline
    assert "e2e:full" not in pipeline


def test_image_is_built_normally_and_only_the_main_sha_is_pushed() -> None:
    pipeline = _pipeline()
    build = _commands(pipeline["image:build"])

    assert 'podman build --build-arg "VISTA_BUILD_COMMIT=${CI_COMMIT_SHA}"' in build
    assert '--build-arg "VISTA_CI_PIPELINE_IID=${CI_PIPELINE_IID}"' in build
    assert 'podman push "$SHA_IMAGE"' in build
    assert 'podman push "$LATEST_IMAGE"' not in build
    assert "final-prebuilt" not in build
    assert "frontend_build_manifest" not in build
    assert "--cache-from" not in build
    assert "--cache-to" not in build
    assert "--jobs" not in build
    assert "--layers" not in build

    main_guard = 'if [ "${CI_COMMIT_BRANCH:-}" = "main" ]; then'
    assert main_guard in build
    assert build.index(main_guard) < build.index('podman push "$SHA_IMAGE"')


def test_latest_publication_is_main_only_serialized_and_monotonic() -> None:
    pipeline = _pipeline()
    publish = pipeline["image:publish"]

    assert publish["stage"] == "publish"
    assert publish["interruptible"] is False
    assert publish["resource_group"] == "vista-latest-image"
    assert publish["environment"]["name"] == "production"
    assert publish["rules"] == [
        {
            "if": (
                '$CI_PIPELINE_SOURCE == "push" '
                '&& $CI_COMMIT_BRANCH == "main"'
            )
        },
        {"when": "never"},
    ]
    assert "publish_latest_image.sh" in _commands(publish)
    assert "podman build" not in _commands(publish)
