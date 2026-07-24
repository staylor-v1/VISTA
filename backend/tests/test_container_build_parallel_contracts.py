import os
import shutil
import subprocess
from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[2]
DOCKERFILE = REPO_ROOT / "Dockerfile"
DOCKERIGNORE = REPO_ROOT / ".dockerignore"
GITHUB_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "docker-image.yml"
MANIFEST_SCRIPT = REPO_ROOT / "scripts" / "ci" / "frontend_build_manifest.sh"
PUBLISH_SCRIPT = REPO_ROOT / "scripts" / "ci" / "publish_latest_image.sh"


def _docker_stages() -> list[tuple[str, str]]:
    stages: list[tuple[str, list[str]]] = []
    for line in DOCKERFILE.read_text(encoding="utf-8").splitlines():
        normalized = line.strip()
        if normalized.upper().startswith("FROM ") and " AS " in normalized.upper():
            name = normalized.rsplit(maxsplit=1)[-1]
            stages.append((name, []))
        elif stages:
            stages[-1][1].append(line)
    return [(name, "\n".join(lines)) for name, lines in stages]


def test_docker_build_stages_have_independent_cache_boundaries():
    stages = dict(_docker_stages())

    assert "python-dependencies" in stages
    assert "frontend-build" in stages
    assert "application-runtime" in stages
    assert "final-prebuilt" in stages
    assert "final" in stages

    python_stage = stages["python-dependencies"]
    frontend_stage = stages["frontend-build"]
    runtime_stage = stages["application-runtime"]

    assert "COPY pyproject.toml uv.lock ./" in python_stage
    assert "frontend/" not in python_stage
    assert "COPY frontend/package.json frontend/package-lock.json ./" in frontend_stage
    assert "npm ci --legacy-peer-deps" in frontend_stage
    assert "npm install" not in frontend_stage
    assert "pyproject.toml" not in frontend_stage
    assert "COPY --from=python-dependencies /opt/venv /opt/venv" in runtime_stage


def test_default_and_prebuilt_targets_share_the_same_runtime():
    stages = _docker_stages()
    stage_names = [name for name, _ in stages]
    contents = dict(stages)

    assert stage_names[-1] == "final"
    assert "FROM application-runtime AS final-prebuilt" in DOCKERFILE.read_text(
        encoding="utf-8"
    )
    assert "FROM application-runtime AS final" in DOCKERFILE.read_text(encoding="utf-8")
    assert "COPY --from=frontend-build /app/frontend/build /app/ui2" in contents["final"]

    prebuilt_stage = contents["final-prebuilt"]
    assert "COPY frontend/build /app/ui2" in prebuilt_stage
    assert (
        "COPY .ci-artifacts/frontend-build.sha256 "
        "/app/.ci-artifacts/frontend-build.sha256"
    ) in prebuilt_stage
    assert "frontend_build_manifest verify" in prebuilt_stage


def test_runtime_keeps_entrypoint_and_does_not_reinstall_uv():
    dockerfile = DOCKERFILE.read_text(encoding="utf-8")
    runtime_and_final_stages = dockerfile.split("FROM base AS application-runtime", 1)[1]

    assert 'CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]' in dockerfile
    assert "ENV FRONTEND_BUILD_PATH=/app/ui2" in dockerfile
    assert "pip install" not in runtime_and_final_stages


def test_runtime_records_commit_and_project_pipeline_identity():
    runtime = dict(_docker_stages())["application-runtime"]

    assert "ARG VISTA_BUILD_COMMIT=local" in runtime
    assert "ARG VISTA_CI_PIPELINE_IID=0" in runtime
    assert 'org.opencontainers.image.revision="${VISTA_BUILD_COMMIT}"' in runtime
    assert 'io.vista.ci.pipeline-iid="${VISTA_CI_PIPELINE_IID}"' in runtime


def test_docker_context_excludes_test_and_cache_trees_but_allows_prebuilt_inputs():
    patterns = set(DOCKERIGNORE.read_text(encoding="utf-8").splitlines())

    assert ".venv/" in patterns
    assert "test/" in patterns
    assert "backend/tests/" in patterns
    assert "backend/_cache/" in patterns
    assert "backend/logs/" in patterns
    assert "frontend/e2e/" in patterns
    assert "frontend/artifacts/" in patterns
    assert "frontend/.cache/" in patterns
    assert "frontend/node_modules/.cache/" in patterns
    assert "!frontend/build/" in patterns
    assert "!frontend/build/**" in patterns
    assert "!.ci-artifacts/" in patterns
    assert "!.ci-artifacts/frontend-build.sha256" in patterns


def test_production_image_smoke_check_does_not_expect_excluded_test_sources():
    workflow_text = GITHUB_WORKFLOW.read_text(encoding="utf-8")
    workflow = yaml.safe_load(workflow_text)
    build_steps = workflow["jobs"]["build"]["steps"]

    assert not any(step.get("name") == "Run tests in container" for step in build_steps)
    assert not any(
        "test/run_tests.sh" in step.get("run", "") for step in build_steps
    )
    assert any(step.get("name") == "Test container" for step in build_steps)
    assert "/api/health" in workflow_text


def test_frontend_manifest_is_deterministic_and_detects_mutation(tmp_path):
    if shutil.which("sha256sum") is None:
        raise AssertionError("sha256sum is required by the container build")

    build_directory = tmp_path / "build"
    manifest = tmp_path / "frontend-build.sha256"
    (build_directory / "static" / "js").mkdir(parents=True)
    (build_directory / "index.html").write_text("<main>Vista</main>\n", encoding="utf-8")
    bundle = build_directory / "static" / "js" / "main.js"
    bundle.write_text("window.VISTA = true;\n", encoding="utf-8")

    create_command = [
        "sh",
        str(MANIFEST_SCRIPT),
        "create",
        str(build_directory),
        str(manifest),
    ]
    verify_command = [
        "sh",
        str(MANIFEST_SCRIPT),
        "verify",
        str(build_directory),
        str(manifest),
    ]

    subprocess.run(create_command, cwd=REPO_ROOT, check=True)
    first_manifest = manifest.read_text(encoding="ascii")
    subprocess.run(create_command, cwd=REPO_ROOT, check=True)

    assert manifest.read_text(encoding="ascii") == first_manifest
    assert len(first_manifest.strip()) == 64
    subprocess.run(verify_command, cwd=REPO_ROOT, check=True)

    bundle.write_text("window.VISTA = false;\n", encoding="utf-8")
    mismatch = subprocess.run(
        verify_command,
        cwd=REPO_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert mismatch.returncode != 0
    assert "does not match" in mismatch.stderr


def test_frontend_manifest_rejects_symlinks(tmp_path):
    build_directory = tmp_path / "build"
    manifest = tmp_path / "frontend-build.sha256"
    build_directory.mkdir()
    (build_directory / "index.html").write_text(
        "<main>Vista</main>\n", encoding="utf-8"
    )
    (build_directory / "linked-index.html").symlink_to("index.html")

    result = subprocess.run(
        [
            "sh",
            str(MANIFEST_SCRIPT),
            "create",
            str(build_directory),
            str(manifest),
        ],
        cwd=REPO_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "unsupported file type" in result.stderr
    assert not manifest.exists()


def test_frontend_manifest_rejects_a_directory_manifest_target(tmp_path):
    build_directory = tmp_path / "build"
    manifest_directory = tmp_path / "manifest-target"
    build_directory.mkdir()
    manifest_directory.mkdir()
    (build_directory / "index.html").write_text(
        "<main>Vista</main>\n", encoding="utf-8"
    )

    result = subprocess.run(
        [
            "sh",
            str(MANIFEST_SCRIPT),
            "create",
            str(build_directory),
            str(manifest_directory),
        ],
        cwd=REPO_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "manifest path must not be a directory" in result.stderr
    assert not list(manifest_directory.iterdir())


def test_frontend_manifest_propagates_individual_hash_failures(tmp_path):
    real_sha256sum = shutil.which("sha256sum")
    assert real_sha256sum is not None

    build_directory = tmp_path / "build"
    manifest = tmp_path / "frontend-build.sha256"
    build_directory.mkdir()
    (build_directory / "index.html").write_text(
        "<main>Vista</main>\n", encoding="utf-8"
    )
    (build_directory / "broken.js").write_text(
        "window.VISTA = true;\n", encoding="utf-8"
    )

    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake_sha256sum = fake_bin / "sha256sum"
    fake_sha256sum.write_text(
        "#!/bin/sh\n"
        'case " $* " in\n'
        '  *" ./broken.js "*) exit 17 ;;\n'
        "esac\n"
        f'exec "{real_sha256sum}" "$@"\n',
        encoding="utf-8",
    )
    fake_sha256sum.chmod(0o755)
    environment = os.environ.copy()
    environment["PATH"] = f"{fake_bin}{os.pathsep}{environment['PATH']}"

    result = subprocess.run(
        [
            "sh",
            str(MANIFEST_SCRIPT),
            "create",
            str(build_directory),
            str(manifest),
        ],
        cwd=REPO_ROOT,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "could not hash every build file" in result.stderr
    assert not manifest.exists()


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


def _run_publish_script(
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
    calls = (
        log.read_text(encoding="utf-8").splitlines()
        if log.exists()
        else []
    )
    return result, calls


def test_latest_publisher_promotes_current_image_and_allows_first_publish(tmp_path):
    result, calls = _run_publish_script(
        tmp_path,
        LATEST_PULL_RESULT="missing",
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "tag source:sha repository:latest" in calls
    assert "push repository:latest" in calls


def test_latest_publisher_refuses_to_move_tag_backwards(tmp_path):
    result, calls = _run_publish_script(
        tmp_path,
        LATEST_PIPELINE_IID="43",
    )

    assert result.returncode == 0, result.stdout + result.stderr
    assert "Skipping stale publication" in result.stdout
    assert not any(call.startswith("tag ") for call in calls)
    assert not any(call.startswith("push ") for call in calls)


def test_latest_publisher_fails_closed_on_identity_or_registry_errors(
    tmp_path,
):
    wrong_source, wrong_source_calls = _run_publish_script(
        tmp_path / "wrong-source",
        SOURCE_PIPELINE_IID="41",
    )
    assert wrong_source.returncode != 0
    assert "source image pipeline IID does not match" in wrong_source.stderr
    assert not any(call.startswith("push ") for call in wrong_source_calls)

    registry_error, registry_error_calls = _run_publish_script(
        tmp_path / "registry-error",
        LATEST_PULL_RESULT="error",
    )
    assert registry_error.returncode != 0
    assert "could not read existing latest image" in registry_error.stderr
    assert not any(call.startswith("push ") for call in registry_error_calls)

    ambiguous_error, ambiguous_error_calls = _run_publish_script(
        tmp_path / "ambiguous-error",
        LATEST_PULL_RESULT="ambiguous",
    )
    assert ambiguous_error.returncode != 0
    assert "could not read existing latest image" in ambiguous_error.stderr
    assert not any(call.startswith("push ") for call in ambiguous_error_calls)


def test_latest_publisher_rejects_integer_overflow_before_promotion(tmp_path):
    oversized_latest, oversized_latest_calls = _run_publish_script(
        tmp_path / "oversized-latest",
        LATEST_PIPELINE_IID="999999999999999999999999999999",
    )
    assert oversized_latest.returncode != 0
    assert "invalid pipeline IID" in oversized_latest.stderr
    assert "Illegal number" not in oversized_latest.stderr
    assert not any(call.startswith("push ") for call in oversized_latest_calls)

    oversized_current, oversized_current_calls = _run_publish_script(
        tmp_path / "oversized-current",
        CI_PIPELINE_IID="999999999999999999999999999999",
        SOURCE_PIPELINE_IID="999999999999999999999999999999",
    )
    assert oversized_current.returncode != 0
    assert "at most 18 digits" in oversized_current.stderr
    assert not any(call.startswith("pull ") for call in oversized_current_calls)
