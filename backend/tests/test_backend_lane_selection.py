"""Contracts for opt-in backend test lanes and the default fast runner."""

from __future__ import annotations

import ast
import tomllib
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
LOAD_TEST_ROOT = REPO_ROOT / "backend" / "tests" / "load"


def _decorator_name(decorator: ast.expr) -> str:
    names: list[str] = []
    value: ast.expr = decorator
    while isinstance(value, ast.Attribute):
        names.append(value.attr)
        value = value.value
    if isinstance(value, ast.Name):
        names.append(value.id)
    return ".".join(reversed(names))


def test_pytest_registers_separate_postgres_and_load_markers():
    project = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text())
    configured_markers = {
        marker.split(":", 1)[0].strip()
        for marker in project["tool"]["pytest"]["ini_options"]["markers"]
    }

    assert {"smoke", "postgres", "load"}.issubset(configured_markers)


def test_scheduled_load_directory_contains_explicitly_marked_tests():
    load_test_files = sorted(LOAD_TEST_ROOT.rglob("test_*.py"))
    assert load_test_files

    for test_file in load_test_files:
        module = ast.parse(test_file.read_text(encoding="utf-8"))
        test_functions = [
            node
            for node in module.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name.startswith("test_")
        ]
        assert test_functions
        assert all(
            "pytest.mark.load"
            in {_decorator_name(decorator) for decorator in function.decorator_list}
            for function in test_functions
        ), f"{test_file} contains a scheduled test without @pytest.mark.load"


def test_fast_backend_runner_excludes_all_opt_in_database_and_load_tests():
    runner = (REPO_ROOT / "test" / "backend_tests.sh").read_text(encoding="utf-8")

    assert '-m "not postgres and not load"' in runner
    assert 'tests/' in runner
