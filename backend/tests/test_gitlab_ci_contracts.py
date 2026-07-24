from __future__ import annotations

from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
GITLAB_CI = REPO_ROOT / ".gitlab-ci.yml"


def _pipeline() -> dict:
    return yaml.safe_load(GITLAB_CI.read_text(encoding="utf-8"))


def _script(job: dict) -> str:
    commands = [*job.get("before_script", []), *job.get("script", [])]
    assert all(isinstance(command, str) for command in commands)
    return "\n".join(commands)


def _need_names(job: dict) -> set[str]:
    names: set[str] = set()
    for need in job.get("needs", []):
        names.add(need if isinstance(need, str) else need["job"])
    return names


def test_required_test_lanes_are_externally_sharded_without_nested_fanout() -> None:
    pipeline = _pipeline()

    backend = pipeline["backend:fast"]
    assert backend["parallel"] == 4
    assert backend["variables"]["PYTEST_XDIST_WORKERS"] == "1"
    assert '--shard-index "$CI_NODE_INDEX"' in _script(backend)
    assert '--shard-total "$CI_NODE_TOTAL"' in _script(backend)
    assert "${CI_NODE_INDEX}" in backend["variables"]["JUNIT_XML_PATH"]
    assert "${CI_NODE_INDEX}" in backend["variables"]["TEST_SHARD_MANIFEST_PATH"]

    frontend = pipeline["frontend:unit"]
    assert frontend["parallel"] == 4
    assert frontend["variables"]["FRONTEND_JEST_WORKERS"] == "1"
    assert "--jest-only" in _script(frontend)
    assert '--shard-index "$CI_NODE_INDEX"' in _script(frontend)
    assert "${CI_NODE_INDEX}" in frontend["variables"]["TEST_SHARD_MANIFEST_PATH"]

    custom = pipeline["frontend:custom"]
    assert "parallel" not in custom
    assert "--custom-only" in _script(custom)
    assert "npm ci" not in _script(custom)


def test_database_and_load_lanes_remain_explicitly_serial() -> None:
    pipeline = _pipeline()

    postgres = pipeline["backend:postgres"]
    assert "parallel" not in postgres
    assert "postgres:15" in {
        service if isinstance(service, str) else service["name"]
        for service in postgres["services"]
    }
    assert "-m postgres -n 0 tests/postgres" in _script(postgres)
    assert "mkdir -p artifacts/backend" in _script(postgres)

    load = pipeline["backend:load"]
    assert "parallel" not in load
    assert "-m load -n 0 tests/load" in _script(load)
    assert "mkdir -p artifacts/backend" in _script(load)
    assert load["rules"] == [
        {
            "if": '$CI_PIPELINE_SOURCE == "schedule"',
        }
    ]


def test_schedules_add_deep_lanes_without_dropping_required_coverage() -> None:
    pipeline = _pipeline()
    scheduled_rules = pipeline[".rules-required-or-scheduled"]["rules"]

    assert scheduled_rules[0] == {
        "if": '$CI_PIPELINE_SOURCE == "schedule"'
    }
    for job_name in (
        "backend:fast",
        "frontend:unit",
        "frontend:custom",
        "backend:postgres",
    ):
        assert pipeline[job_name]["rules"] == scheduled_rules

    # Full browser coverage subsumes the small critical subset on schedules,
    # and scheduled pipelines verify but do not publish container images.
    assert pipeline["e2e:critical"]["rules"] == pipeline[".rules-required"]["rules"]
    assert pipeline["image:build"]["rules"] == pipeline[".rules-required"]["rules"]


def test_playwright_uses_test_level_sharding_single_workers_and_unique_outputs() -> None:
    pipeline = _pipeline()

    critical = pipeline["e2e:critical"]
    assert critical["parallel"] == 2
    critical_script = _script(critical)
    assert "--grep @critical" in critical_script
    assert "--fully-parallel" in critical_script
    assert "--workers=1" in critical_script
    assert '--shard="$CI_NODE_INDEX/$CI_NODE_TOTAL"' in critical_script
    assert "results-${CI_NODE_INDEX}" in critical_script
    assert "blob-${CI_NODE_INDEX}" in critical_script
    assert "junit-${CI_NODE_INDEX}.xml" in critical_script

    full = pipeline["e2e:full"]
    assert full["parallel"] == 2
    full_script = _script(full)
    assert "--grep @critical" not in full_script
    assert "--fully-parallel" in full_script
    assert "--workers=1" in full_script
    assert '--shard="$CI_NODE_INDEX/$CI_NODE_TOTAL"' in full_script
    assert full["rules"][0]["if"] == '$CI_PIPELINE_SOURCE == "schedule"'


def test_lockfile_caches_store_downloads_not_installed_dependencies() -> None:
    pipeline = _pipeline()

    backend_cache = pipeline[".backend-job"]["cache"]
    assert backend_cache["key"]["files"] == ["uv.lock", "pyproject.toml"]
    assert backend_cache["key"]["prefix"] == "backend-${CI_COMMIT_REF_SLUG}"
    assert backend_cache["paths"] == [".cache/uv/"]
    assert backend_cache["policy"] == "pull"

    frontend_cache = pipeline[".frontend-job"]["cache"]
    assert frontend_cache["key"]["files"] == [
        "frontend/package-lock.json",
        "frontend/package.json",
    ]
    assert frontend_cache["key"]["prefix"] == "frontend-${CI_COMMIT_REF_SLUG}"
    assert frontend_cache["paths"] == [".cache/npm/"]
    assert frontend_cache["policy"] == "pull"

    playwright_cache = pipeline[".playwright-job"]["cache"]
    assert playwright_cache["key"] == frontend_cache["key"]
    assert playwright_cache["policy"] == "pull"

    # CI_RUNNER_EXECUTABLE_ARCH normally contains a slash (for example,
    # linux/amd64), which GitLab forbids in cache keys.
    assert "CI_RUNNER_EXECUTABLE_ARCH" not in GITLAB_CI.read_text(
        encoding="utf-8"
    )

    assert pipeline["frontend:build"]["cache"]["policy"] == "pull-push"
    assert pipeline["backend:postgres"]["cache"]["policy"] == "pull-push"

    all_cache_paths = [
        path
        for config in pipeline.values()
        if isinstance(config, dict) and "cache" in config
        for path in config["cache"].get("paths", [])
    ]
    assert not any(
        "node_modules" in path or ".venv" in path for path in all_cache_paths
    )


def test_frontend_build_is_single_source_for_browser_and_container_jobs() -> None:
    pipeline = _pipeline()
    frontend_build = pipeline["frontend:build"]

    assert frontend_build["stage"] == "prepare"
    assert _script(frontend_build).count("npm run build") == 1
    assert "frontend_build_manifest.sh create" in _script(frontend_build)
    assert frontend_build["artifacts"]["expire_in"] == "1 day"
    assert "frontend/build/" in frontend_build["artifacts"]["paths"]

    assert _need_names(pipeline[".playwright-job"]) == {"frontend:build"}
    assert _need_names(pipeline["image:build"]) == {"frontend:build"}


def test_image_build_overlaps_tests_and_latest_publication_is_fully_gated() -> None:
    pipeline = _pipeline()
    image_build = pipeline["image:build"]
    build_script = _script(image_build)

    assert image_build["stage"] == "build"
    assert "--jobs=2" in build_script
    assert "--layers" in build_script
    assert "--cache-from" in build_script
    assert "--cache-to" in build_script
    assert '--build-arg "VISTA_BUILD_COMMIT=${CI_COMMIT_SHA}"' in build_script
    assert (
        '--build-arg "VISTA_CI_PIPELINE_IID=${CI_PIPELINE_IID}"'
        in build_script
    )
    assert "--target final-prebuilt" in build_script
    assert "frontend_build_manifest.sh verify" in build_script
    assert "QUAY_USERNAME must be configured as a non-secret" in build_script
    assert "npm install" not in build_script
    assert "npm ci" not in build_script

    publish = pipeline["image:publish"]
    assert publish["stage"] == "publish"
    assert publish["resource_group"] == "vista-latest-image"
    assert "podman build" not in _script(publish)
    assert "publish_latest_image.sh" in _script(publish)
    assert "podman tag" not in _script(publish)
    assert {
        "backend:fast",
        "frontend:unit",
        "frontend:custom",
        "backend:postgres",
        "e2e:critical",
        "image:build",
    } == _need_names(publish)
    assert publish["rules"] == [
        {
            "if": (
                '$CI_COMMIT_BRANCH == "main" '
                '&& $CI_PIPELINE_SOURCE != "schedule"'
            )
        }
    ]


def test_merge_request_rules_cannot_publish_or_write_shared_caches() -> None:
    pipeline = _pipeline()
    required_rules = pipeline[".rules-required"]["rules"]

    assert required_rules[0] == {
        "if": (
            '$CI_COMMIT_BRANCH == "main" '
            '&& $CI_PIPELINE_SOURCE != "schedule"'
        )
    }
    assert required_rules[1] == {
        "if": '$CI_PIPELINE_SOURCE == "merge_request_event"'
    }
    assert "merge_request_event" not in str(pipeline["image:publish"]["rules"])
    assert "CACHE_POLICY" not in GITLAB_CI.read_text(encoding="utf-8")


def test_latest_publication_cannot_overlap_and_stale_pipelines_are_cancelled() -> None:
    pipeline = _pipeline()
    publish = pipeline["image:publish"]

    assert pipeline["workflow"]["auto_cancel"]["on_new_commit"] == "conservative"
    assert publish["interruptible"] is False
    assert publish["resource_group"] == "vista-latest-image"
    assert publish["environment"]["name"] == "production"

    jobs_before_publish = []
    for name, config in pipeline.items():
        if (
            not isinstance(config, dict)
            or name.startswith(".")
            or name == "image:publish"
            or "stage" not in config
        ):
            continue
        inherited = pipeline.get(config.get("extends"), {})
        jobs_before_publish.append(
            config.get("interruptible", inherited.get("interruptible"))
        )
    assert jobs_before_publish
    assert all(interruptible is True for interruptible in jobs_before_publish)
