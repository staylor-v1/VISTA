from __future__ import annotations

import subprocess

from backend.scripts import run_migrations


def _cp(returncode: int = 0, stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args=[], returncode=returncode, stdout=stdout, stderr=stderr)


def test_parse_head_revisions_extracts_revision_tokens() -> None:
    stdout = "abc123 (head)\ndef456 (head)\n"
    assert run_migrations._parse_head_revisions(stdout) == ["abc123", "def456"]


def test_run_merges_multiple_heads_then_upgrades(monkeypatch) -> None:
    calls: list[tuple[str, ...]] = []

    def fake_run(*args: str) -> subprocess.CompletedProcess[str]:
        calls.append(args)
        if args == ("heads",):
            return _cp(stdout="rev_a (head)\nrev_b (head)\n")
        return _cp()

    monkeypatch.setattr(run_migrations, "_run_alembic_command", fake_run)

    rc = run_migrations.run()

    assert rc == 0
    assert calls == [
        ("heads",),
        ("merge", "-m", "auto-merge concurrent heads", "rev_a", "rev_b"),
        ("upgrade", "head"),
    ]


def test_run_upgrades_single_head_without_merge(monkeypatch) -> None:
    calls: list[tuple[str, ...]] = []

    def fake_run(*args: str) -> subprocess.CompletedProcess[str]:
        calls.append(args)
        if args == ("heads",):
            return _cp(stdout="rev_main (head)\n")
        return _cp()

    monkeypatch.setattr(run_migrations, "_run_alembic_command", fake_run)

    rc = run_migrations.run()

    assert rc == 0
    assert calls == [
        ("heads",),
        ("upgrade", "head"),
    ]
