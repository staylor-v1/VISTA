import json
import posixpath
import re
import shlex
from dataclasses import dataclass
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]


def _read_repo_file(relative_path: str) -> str:
    return (REPO_ROOT / relative_path).read_text(encoding="utf-8")


def _dockerfile_stage(dockerfile: str, stage_name: str) -> str:
    stage_marker = f" AS {stage_name}\n"
    stage_start = dockerfile.index(stage_marker) + len(stage_marker)
    return dockerfile[stage_start:].split("\nFROM ", maxsplit=1)[0]


def _dockerfile_stages(dockerfile: str) -> list[str]:
    """Return stage bodies in build order without coupling to stage aliases."""
    headers = list(
        re.finditer(
            r"(?im)^[ \t]*FROM(?:[ \t]+--[^\s]+)*[ \t]+\S+"
            r"(?:[ \t]+AS[ \t]+\S+)?[ \t]*$",
            dockerfile,
        )
    )
    return [
        dockerfile[header.end() : headers[index + 1].start()]
        if index + 1 < len(headers)
        else dockerfile[header.end() :]
        for index, header in enumerate(headers)
    ]


def _dockerfile_stage_parent(dockerfile: str, stage_name: str) -> str:
    stage_suffix = f" AS {stage_name}"
    stage_header = next(
        line for line in dockerfile.splitlines() if line.endswith(stage_suffix)
    )
    return stage_header.split()[1]


@dataclass(frozen=True)
class _DockerfileTransferInstruction:
    command: str
    sources: tuple[str, ...]
    destination: str
    from_stage: str | None


def _dockerfile_logical_instructions(stage: str) -> list[str]:
    instructions: list[str] = []
    continuation: list[str] = []
    for physical_line in stage.splitlines():
        line = physical_line.rstrip()
        if not continuation and (not line.strip() or line.lstrip().startswith("#")):
            continue

        trailing_backslashes = len(line) - len(line.rstrip("\\"))
        continues = trailing_backslashes % 2 == 1
        if continues:
            line = line[:-1]
        continuation.append(line.strip())
        if not continues:
            instructions.append(" ".join(continuation))
            continuation = []

    if continuation:
        instructions.append(" ".join(continuation))
    return instructions


def _dockerfile_transfer_instructions(
    stage: str,
) -> list[_DockerfileTransferInstruction]:
    instructions: list[_DockerfileTransferInstruction] = []
    for logical_instruction in _dockerfile_logical_instructions(stage):
        match = re.match(r"^(COPY|ADD)\s+(.+)$", logical_instruction, flags=re.I)
        if match is None:
            continue

        command = match.group(1).upper()
        arguments = match.group(2).strip()
        from_stage: str | None = None
        while arguments.startswith("--"):
            option_match = re.match(
                r"^(--[A-Za-z][A-Za-z0-9-]*)(?:=([^\s]+))?(?:\s+|$)",
                arguments,
            )
            if option_match is None:
                raise ValueError(f"Unsupported {command} option syntax: {arguments}")
            option_name = option_match.group(1).lower()
            option_value = option_match.group(2)
            arguments = arguments[option_match.end() :].lstrip()
            if option_name == "--from":
                if option_value is None:
                    value_tokens = shlex.split(arguments, posix=True)
                    if not value_tokens:
                        raise ValueError(f"{command} --from is missing a value")
                    option_value = value_tokens[0]
                    raw_value_match = re.match(
                        r"^(?:\"[^\"]*\"|'[^']*'|\S+)\s*",
                        arguments,
                    )
                    if raw_value_match is None:
                        raise ValueError(f"{command} --from is missing a value")
                    arguments = arguments[raw_value_match.end() :].lstrip()
                from_stage = option_value

        if arguments.startswith("["):
            tokens = json.loads(arguments)
            if not isinstance(tokens, list) or not all(
                isinstance(token, str) for token in tokens
            ):
                raise ValueError(f"{command} JSON form must contain only strings")
        else:
            tokens = shlex.split(arguments, posix=True)
        if len(tokens) < 2:
            raise ValueError(f"{command} must contain a source and destination")
        instructions.append(
            _DockerfileTransferInstruction(
                command=command,
                sources=tuple(tokens[:-1]),
                destination=tokens[-1],
                from_stage=from_stage,
            )
        )
    return instructions


def _dockerfile_copy_sources(stage: str) -> list[str]:
    sources: list[str] = []
    for instruction in _dockerfile_transfer_instructions(stage):
        if instruction.command == "COPY":
            sources.extend(instruction.sources)
    return sources


def _run_build_context_bind_mounts(stage: str) -> list[str]:
    """Return RUN instructions that can read files directly from build context."""
    bind_mounts: list[str] = []
    for instruction in _dockerfile_logical_instructions(stage):
        if not re.match(r"^RUN\s", instruction, flags=re.I):
            continue
        mount_values = re.findall(r"(?:^|\s)--mount=([^\s]+)", instruction)
        if any(
            any(option.strip().lower() == "type=bind" for option in mount.split(","))
            for mount in mount_values
        ):
            bind_mounts.append(instruction)
    return bind_mounts


def _normalized_transfer_source(
    instruction: _DockerfileTransferInstruction,
    source: str,
) -> str:
    normalized_source = posixpath.normpath(source.replace("\\", "/"))
    if instruction.from_stage is None:
        # Docker resolves context sources relative to the context root and ignores a
        # leading slash.
        return normalized_source.lstrip("/")

    absolute_source = f"/{normalized_source.lstrip('/')}"
    if absolute_source == "/app":
        return "."
    if absolute_source.startswith("/app/"):
        return absolute_source.removeprefix("/app/")
    if absolute_source == "/":
        return "."
    return absolute_source.lstrip("/")


def _root_test_copy_sources(stage: str) -> list[str]:
    return [
        normalized_source
        for instruction in _dockerfile_transfer_instructions(stage)
        for source in instruction.sources
        if instruction.command == "COPY"
        and (
            (
                normalized_source := _normalized_transfer_source(
                    instruction, source
                )
            )
            == "test"
            or normalized_source.startswith("test/")
        )
    ]


def _root_test_transfer_sources(stage: str) -> list[str]:
    return [
        normalized_source
        for instruction in _dockerfile_transfer_instructions(stage)
        for source in instruction.sources
        if (
            (
                normalized_source := _normalized_transfer_source(
                    instruction, source
                )
            )
            in {"", ".", "test"}
            or normalized_source.startswith("test/")
        )
    ]


def _unsafe_production_transfer_sources(stage: str) -> list[str]:
    return [
        normalized_source
        for instruction in _dockerfile_transfer_instructions(stage)
        for source in instruction.sources
        if (
            (
                normalized_source := _normalized_transfer_source(
                    instruction, source
                )
            )
            in {"", ".", "test"}
            or (
                normalized_source.startswith("test/")
                and normalized_source != "test/data"
                and not normalized_source.startswith("test/data/")
            )
        )
    ]


def _stage_copies_root_test(stage: str) -> bool:
    return bool(_root_test_transfer_sources(stage))


def test_production_dockerfile_copies_only_runtime_test_data_assets():
    dockerfile = _read_repo_file("Dockerfile")
    stages = _dockerfile_stages(dockerfile)
    build_stages, final_stage = stages[:-1], stages[-1]
    test_copy_instructions = [
        (
            [
                _normalized_transfer_source(instruction, source)
                for source in instruction.sources
            ],
            instruction.destination,
        )
        for instruction in _dockerfile_transfer_instructions(final_stage)
        if instruction.command == "COPY"
        if any(
            _normalized_transfer_source(instruction, source) == "test"
            or _normalized_transfer_source(instruction, source).startswith("test/")
            for source in instruction.sources
        )
    ]

    assert len(stages) >= 2
    assert all(not _root_test_transfer_sources(stage) for stage in build_stages)
    assert all(not _run_build_context_bind_mounts(stage) for stage in build_stages)
    assert _run_build_context_bind_mounts(final_stage) == []
    assert _unsafe_production_transfer_sources(final_stage) == []
    assert all(not _root_test_copy_sources(stage) for stage in build_stages)
    assert _root_test_copy_sources(final_stage) == ["test/data"]
    assert test_copy_instructions == [(["test/data"], "/app/test/data")]


def test_production_stage_parser_does_not_require_historical_aliases():
    dockerfile = """  FROM --platform=linux/amd64 example.invalid/runtime AS compile-assets
RUN echo build
\tfrom example.invalid/runtime as production-runtime
COPY ./test/data /app/test/data
"""

    stages = _dockerfile_stages(dockerfile)

    assert len(stages) == 2
    assert "RUN echo build" in stages[0]
    assert _root_test_copy_sources(stages[-1]) == ["test/data"]


@pytest.mark.parametrize(
    "stage",
    [
        "RUN --mount=type=bind,target=/src cp /src/test/run_tests.sh /app/",
        "RUN --mount=source=.,type=bind,target=/context true",
        "RUN --mount=target=/src,TYPE=BIND,source=. \\\n+          find /src/test -type f",
    ],
)
def test_production_run_parser_detects_build_context_bind_mounts(stage: str):
    assert _run_build_context_bind_mounts(stage) == [
        " ".join(line.strip().removesuffix("\\").strip() for line in stage.splitlines())
    ]


def test_production_run_parser_allows_non_bind_buildkit_mounts():
    stage = "RUN --mount=type=cache,target=/root/.cache uv sync --frozen"

    assert _run_build_context_bind_mounts(stage) == []


def test_backend_dev_reconciles_bind_mounted_dependencies_before_startup():
    development_dockerfile = _read_repo_file("Dockerfile.dev")
    backend_dev_stage = _dockerfile_stage(development_dockerfile, "backend-dev")

    assert (
        'CMD ["sh", "-c", "uv sync --frozen --no-install-project && exec uvicorn '
        'main:app --host 0.0.0.0 --port 8000 --reload"]'
        in backend_dev_stage
    )


@pytest.mark.parametrize(
    ("stage", "unsafe_source"),
    [
        ("COPY . /app", "."),
        ('COPY ["./test/run_tests.sh", "/app/test/run_tests.sh"]', "test/run_tests.sh"),
        (
            "COPY \\\n"
            "  ./test/backend_tests.sh \\\n"
            "  /app/test/backend_tests.sh",
            "test/backend_tests.sh",
        ),
        ("ADD ./test /app/test", "test"),
        ('ADD ["./test/test_mcp_server.py", "/app/test/"]', "test/test_mcp_server.py"),
        ("COPY --from=builder /app/test /app/test", "test"),
        ("COPY --from=builder /app /app", "."),
    ],
)
def test_production_transfer_parser_detects_test_suite_bypasses(
    stage: str,
    unsafe_source: str,
):
    assert _unsafe_production_transfer_sources(stage) == [unsafe_source]


@pytest.mark.parametrize(
    "stage",
    [
        "COPY ./test/data /app/test/data",
        'COPY ["./test/data", "/app/test/data"]',
        "COPY --chown=appuser:appuser \\\n"
        "  ./test/data/3D/geometric \\\n"
        "  /app/test/data/3D/geometric",
        "COPY --from=builder /app/test/data /app/test/data",
        "ADD ./test/data/PT1/regex.txt /app/test/data/PT1/regex.txt",
    ],
)
def test_production_transfer_parser_allows_only_runtime_test_data(stage: str):
    assert _unsafe_production_transfer_sources(stage) == []
    assert _root_test_transfer_sources(stage)
    assert _stage_copies_root_test(stage)


@pytest.mark.parametrize("command", ["COPY", "ADD"])
def test_production_pre_final_stage_rejects_runtime_test_data(command: str):
    stage = f"{command} ./test/data /app/test/data"

    assert _root_test_transfer_sources(stage) == ["test/data"]
    assert _stage_copies_root_test(stage)


def test_container_build_inputs_do_not_reference_removed_test_toolbox():
    dockerfile = _read_repo_file("Dockerfile")
    dockerignore = _read_repo_file(".dockerignore")

    assert "test_toolbox" not in dockerfile
    assert "test_toolbox" not in dockerignore


def test_production_ignore_policy_exposes_only_runtime_test_data():
    development_ignore = _read_repo_file(".dockerignore").splitlines()
    production_ignore = _read_repo_file("Dockerfile.dockerignore").splitlines()
    selective_production_rules = [
        "# Keep only runtime sample assets from the root test tree. Test runners and",
        "# suites remain outside the production build context.",
        "test/*",
        "!test/data/",
        "!test/data/**",
    ]

    assert "test/" not in development_ignore
    assert production_ignore == (
        development_ignore[: development_ignore.index("backend/tests/")]
        + selective_production_rules
        + development_ignore[development_ignore.index("backend/tests/") :]
    )


def test_root_test_assets_are_scoped_to_backend_dev_and_production_data_only():
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
    ):
        assert not _stage_copies_root_test(test_free_stage)

    production_stages = _dockerfile_stages(production_dockerfile)
    production_build_stages, production_final = (
        production_stages[:-1],
        production_stages[-1],
    )
    assert len(production_stages) >= 2
    assert all(
        not _stage_copies_root_test(stage) for stage in production_build_stages
    )
    assert _root_test_copy_sources(production_final) == ["test/data"]
