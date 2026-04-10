# PR-15 Orchestrator Living Checklist (2026-04-04)

## Current milestone
- **PR-15-M8**: Workspace-backed inspector manual-measurement persistence hardening.

## Files changed in this milestone
- `backend/routers/inspection_workbench.py`
- `backend/tests/test_inspection_workbench_router.py`
- `frontend/src/components/__tests__/InspectionWorkbenchPanel.test.js`
- `docs/planning/feature-request-triage-2026-03-28.md`
- `docs/planning/orchestrator-session-handoff.md`
- `docs/planning/pr15-orchestrator-checklist.md`
- `docs/planning/pr15-split-artifact.md`
- `docs/planning/pr15-m8-replay-artifact.md`

## Tests
- [x] `cd /workspace/VISTA && uv run pytest -q backend/tests/test_inspection_workbench_router.py`
- [x] `cd /workspace/VISTA/frontend && npm test -- --runInBand src/components/__tests__/InspectionWorkbenchPanel.test.js`

## Reviewer notes (edge cases / security / architecture)
- Workspace-state normalization enforces strict typing for `inspector.normalization_triage_field`, `inspector.image_enabled`, `inspector.modalities`, and `inspector.view_name` to prevent malformed persisted values from destabilizing hydration.
- Workspace-state normalization now enforces `inspector.viewport` numeric bounds and stable defaults for `zoom`, `panX`, and `panY`.
- Workspace-state normalization now enforces durable `inspector.measurements` tuples (`{id,label,value}`), dropping malformed records while preserving backward-compatible defaults for missing keys.

## Remaining PR-15 milestones
- [x] `PR-15-M7` viewport-transform persistence hardening.
- [x] `PR-15-M8` manual-measurement persistence hardening.
- [x] Preserve delete-governance + workspace/configuration synthetic test matrices while extending scope.

## Risks / blockers
- No open PR-15 backlog remains after `PR-15-M8`.
- Additional Epic 7 scope must be explicitly approved and carved as new flat slices (`PR-15-M9+`) before implementation.
