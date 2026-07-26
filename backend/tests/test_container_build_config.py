import shlex
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]


def _read_repo_file(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def _dockerfile_stage(dockerfile: str, stage_name: str) -> str:
    stage_marker = f" AS {stage_name}\n"
    stage_start = dockerfile.index(stage_marker) + len(stage_marker)
    return dockerfile[stage_start:].split("\nFROM ", maxsplit=1)[0]


def _dockerfile_stage_parent(dockerfile: str, stage_name: str) -> str:
    stage_suffix = f" AS {stage_name}"
    stage_header = next(
        line for line in dockerfile.splitlines() if line.endswith(stage_suffix)
    )
    return stage_header.split()[1]


def _dockerfile_copy_sources(stage: str) -> list[str]:
    sources: list[str] = []
    for line in stage.splitlines():
        stripped_line = line.strip()
        if not stripped_line.upper().startswith("COPY "):
            continue

        tokens = shlex.split(stripped_line)
        arguments = tokens[1:]
        while arguments and arguments[0].startswith("--"):
            arguments.pop(0)
        sources.extend(arguments[:-1])
    return sources


def _stage_copies_root_test(stage: str) -> bool:
    for source in _dockerfile_copy_sources(stage):
        normalized_source = source.removeprefix("./").rstrip("/")
        if normalized_source in {"", ".", "test"} or normalized_source.startswith(
            "test/"
        ):
            return True
    return False


def test_production_dockerfile_does_not_copy_test_only_folders_into_image():
    dockerfile = _read_repo_file("Dockerfile")

    assert "test_toolbox" not in dockerfile
    assert "COPY test" not in dockerfile
    assert "COPY ./test" not in dockerfile


def test_ci_build_configuration_does_not_reference_removed_test_toolbox():
    ci_config = _read_repo_file(".gitlab-ci.yml")
    dockerfile = _read_repo_file("Dockerfile")
    dockerignore = _read_repo_file(".dockerignore")

    checked_build_files = "\n".join([ci_config, dockerfile, dockerignore])

    assert "test_toolbox" not in checked_build_files


def test_production_ignore_policy_adds_only_root_test_exclusion():
    development_ignore = _read_repo_file(".dockerignore").splitlines()
    production_ignore = _read_repo_file("Dockerfile.dockerignore").splitlines()

    assert "test/" not in development_ignore
    assert production_ignore.count("test/") == 1
    assert [line for line in production_ignore if line != "test/"] == development_ignore


def test_root_test_assets_are_owned_and_scoped_to_backend_dev_not_toolbox():
    development_ignore = _read_repo_file(".dockerignore").splitlines()
    development_dockerfile = _read_repo_file("Dockerfile.dev")
    production_dockerfile = _read_repo_file("Dockerfile")
    base_stage = _dockerfile_stage(development_dockerfile, "base")
    backend_runtime_stage = _dockerfile_stage(
        development_dockerfile, "backend-runtime"
    )
    backend_dev_stage = _dockerfile_stage(development_dockerfile, "backend-dev")
    toolbox_stage = _dockerfile_stage(
        development_dockerfile, "toolbox-model-service"
    )
    frontend_stage = _dockerfile_stage(development_dockerfile, "frontend-dev")

    assert "test/" not in development_ignore
    assert _dockerfile_stage_parent(development_dockerfile, "backend-runtime") == "base"
    assert (
        _dockerfile_stage_parent(development_dockerfile, "backend-dev")
        == "backend-runtime"
    )
    assert (
        _dockerfile_stage_parent(development_dockerfile, "toolbox-model-service")
        == "backend-runtime"
    )

    test_copy = "COPY --chown=appuser:appuser ./test /app/test"
    assert "RUN chown -R appuser:appuser /app" in backend_runtime_stage
    assert test_copy in backend_dev_stage
    assert _dockerfile_copy_sources(backend_dev_stage).count("./test") == 1

    for test_free_stage in (
        base_stage,
        backend_runtime_stage,
        toolbox_stage,
        frontend_stage,
        production_dockerfile,
    ):
        assert not _stage_copies_root_test(test_free_stage)
