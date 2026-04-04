# Orchestrator Clean Replay Index (2026-04-04)

This artifact is the single lookup table to replay the already-implemented flat PR slices after app inspection.

## Objective

Provide a deterministic, low-risk replay path so the same changes can be submitted upstream as clean incremental PRs.

## Replay sources

1. `docs/planning/pr15-split-artifact.md`
   - Canonical ordering for `PR-15-M1` through `PR-15-M8`.
2. `docs/planning/pr15-m8-replay-artifact.md`
   - Exact replay and verification details for `PR-15-M8`.
3. `docs/planning/orchestrator-session-handoff.md`
   - Session-level acceptance constraints and baseline verification commands.

## Canonical submit order

1. `PR-15-M1` — Start screen deletion governance hardening.
2. `PR-15-M2` — Configurable inspector hotkeys persistence.
3. `PR-15-M3` — Workspace-backed shortcut-help visibility persistence.
4. `PR-15-M4` — Workspace-backed normalization-triage persistence.
5. `PR-15-M5` — Workspace-backed inspector image-visibility persistence.
6. `PR-15-M6` — Workspace-backed inspector modality/view persistence hardening.
7. `PR-15-M7` — Workspace-backed inspector viewport-transform persistence hardening.
8. `PR-15-M8` — Workspace-backed inspector manual-measurement persistence hardening.

## Verification baseline to run after each replayed slice

- `uv run pytest -q backend/tests/test_inspection_workbench_router.py`
- `cd frontend && npm test -- --runInBand src/components/__tests__/InspectionWorkbenchPanel.test.js`

## Scope gate

No additional PR-15 slices are currently open.
Define `PR-15-M9+` only after explicit approval of additional Epic 7 preference contracts.
