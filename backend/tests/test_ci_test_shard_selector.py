from __future__ import annotations

import itertools
import subprocess
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
SELECTOR = REPO_ROOT / "scripts" / "ci" / "select_test_shard.sh"


def _write_sized_file(path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"x" * size)


def _run_selector(
    working_directory: Path,
    root: str,
    pattern: str,
    index: str | int,
    total: str | int,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "sh",
            str(SELECTOR),
            root,
            pattern,
            str(index),
            str(total),
        ],
        cwd=working_directory,
        check=False,
        capture_output=True,
        text=True,
    )


def _selected_paths(
    working_directory: Path,
    root: str,
    pattern: str,
    index: int,
    total: int,
) -> list[str]:
    result = _run_selector(working_directory, root, pattern, index, total)
    assert result.returncode == 0, result.stderr
    return result.stdout.splitlines()


def _all_shards(
    working_directory: Path,
    root: str,
    pattern: str,
    total: int,
) -> list[list[str]]:
    return [
        _selected_paths(working_directory, root, pattern, index, total)
        for index in range(1, total + 1)
    ]


def _assert_complete_disjoint_partition(
    shards: list[list[str]], expected: set[str]
) -> None:
    shard_sets = [set(shard) for shard in shards]

    assert set().union(*shard_sets) == expected
    for left, right in itertools.combinations(shard_sets, 2):
        assert left.isdisjoint(right)


def test_equal_size_ties_and_output_are_deterministic(tmp_path: Path) -> None:
    for name, size in [
        ("a.test", 8),
        ("b.test", 8),
        ("c.test", 4),
        ("d.test", 4),
    ]:
        _write_sized_file(tmp_path / "suite" / name, size)

    first = _selected_paths(tmp_path, "suite", "*.test", 1, 2)
    second = _selected_paths(tmp_path, "suite", "*.test", 1, 2)

    assert first == second == ["suite/a.test", "suite/c.test"]
    assert _selected_paths(tmp_path, "suite", "*.test", 2, 2) == [
        "suite/b.test",
        "suite/d.test",
    ]


def test_shards_have_complete_disjoint_file_coverage(tmp_path: Path) -> None:
    expected = set()
    for number in range(11):
        relative_path = f"suite/group-{number % 3}/case-{number}.spec"
        _write_sized_file(tmp_path / relative_path, number + 1)
        expected.add(relative_path)

    shards = _all_shards(tmp_path, "suite", "*.spec", 4)

    _assert_complete_disjoint_partition(shards, expected)


def test_largest_first_assignment_balances_total_file_bytes(tmp_path: Path) -> None:
    for number, size in enumerate([80, 70, 60, 50, 40, 30, 20, 10]):
        _write_sized_file(tmp_path / "suite" / f"case-{number}.test", size)

    shards = _all_shards(tmp_path, "suite", "*.test", 4)
    shard_sizes = [
        sum((tmp_path / relative_path).stat().st_size for relative_path in shard)
        for shard in shards
    ]

    assert shard_sizes == [90, 90, 90, 90]


def test_empty_match_succeeds_without_output(tmp_path: Path) -> None:
    (tmp_path / "empty-suite").mkdir()

    result = _run_selector(tmp_path, "empty-suite", "*.test", 1, 4)

    assert result.returncode == 0
    assert result.stdout == ""
    assert result.stderr == ""


@pytest.mark.parametrize(
    ("root", "pattern", "index", "total"),
    [
        ("missing", "*.test", 1, 4),
        ("suite-file", "*.test", 1, 4),
        ("suite", "", 1, 4),
        ("suite", "/*.test", 1, 4),
        ("suite", "*.test", 0, 4),
        ("suite", "*.test", -1, 4),
        ("suite", "*.test", "one", 4),
        ("suite", "*.test", 1, 0),
        ("suite", "*.test", 1, "four"),
        ("suite", "*.test", 5, 4),
    ],
)
def test_invalid_inputs_are_rejected(
    tmp_path: Path,
    root: str,
    pattern: str,
    index: str | int,
    total: str | int,
) -> None:
    (tmp_path / "suite").mkdir()
    (tmp_path / "suite-file").write_text("not a directory", encoding="utf-8")

    result = _run_selector(tmp_path, root, pattern, index, total)

    assert result.returncode != 0
    assert result.stdout == ""
    assert result.stderr


def test_wrong_argument_count_is_rejected(tmp_path: Path) -> None:
    result = subprocess.run(
        ["sh", str(SELECTOR), "only-a-root"],
        cwd=tmp_path,
        check=False,
        capture_output=True,
        text=True,
    )

    assert result.returncode != 0
    assert "Usage:" in result.stderr


@pytest.mark.parametrize(
    ("root", "pattern", "expected_paths"),
    [
        (
            "backend/tests",
            "test_*.py",
            {
                path.as_posix()
                for path in (REPO_ROOT / "backend" / "tests").glob("test_*.py")
            },
        ),
        (
            "frontend/src",
            "*.test.js",
            {
                path.as_posix()
                for path in (REPO_ROOT / "frontend" / "src").rglob("*.test.js")
            },
        ),
    ],
)
def test_current_test_trees_distribute_across_four_shards(
    root: str,
    pattern: str,
    expected_paths: set[str],
) -> None:
    expected_relative_paths = {
        Path(path).relative_to(REPO_ROOT).as_posix() for path in expected_paths
    }

    shards = _all_shards(REPO_ROOT, root, pattern, 4)

    assert all(shard for shard in shards)
    _assert_complete_disjoint_partition(shards, expected_relative_paths)
