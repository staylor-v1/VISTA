# PR-15-M8 Replay Artifact (2026-04-04)

## Scope

`PR-15-M8` finalizes PR-15 Epic 7 workspace preference hardening by normalizing persisted inspector manual measurements.

## Change contract

- Backend workspace-state normalization now enforces:
  - `inspector.measurements` must be an array.
  - Each entry must be an object with non-empty `label` and `value`.
  - `value` accepts string or numeric input and is persisted as string.
  - `id` is retained when present and coerced to string.
  - malformed entries are dropped.
- Frontend hydration applies the same contract before rendering measurement list state.

## Files in this slice

- `backend/routers/inspection_workbench.py`
- `backend/tests/test_inspection_workbench_router.py`
- `frontend/src/components/InspectionWorkbenchPanel.js`
- `frontend/src/components/__tests__/InspectionWorkbenchPanel.test.js`
- `docs/planning/feature-request-triage-2026-03-28.md`
- `docs/planning/orchestrator-session-handoff.md`
- `docs/planning/pr15-split-artifact.md`

## Required acceptance tests

- `uv run pytest -q backend/tests/test_inspection_workbench_router.py -k workspace_state_persistence_supports_progressive_users`
- `npm test -- --runInBand src/components/__tests__/InspectionWorkbenchPanel.test.js`

## Clean incremental replay order

1. Replay `PR-15-M1` through `PR-15-M7` from `docs/planning/pr15-split-artifact.md`.
2. Replay `PR-15-M8` changes listed in this artifact.
3. Submit PR with label/title `PR-15-M8 — Workspace-backed inspector manual-measurement persistence hardening`.
