# PR-15 Orchestrator Living Checklist (2026-04-04)

## Current milestone
- **PR-15-M6**: Server-backed workspace persistence hardening for inspector modalities and selected view fields.

## Files changed in this milestone
- `backend/routers/inspection_workbench.py`
- `backend/tests/test_inspection_workbench_router.py`
- `frontend/src/components/__tests__/InspectionWorkbenchPanel.test.js`
- `docs/planning/feature-request-triage-2026-03-28.md`
- `docs/planning/orchestrator-session-handoff.md`
- `docs/planning/pr15-orchestrator-checklist.md`
- `docs/planning/pr15-split-artifact.md`

## Tests
- [x] `cd /workspace/VISTA && uv run pytest -q backend/tests/test_inspection_workbench_router.py`
- [x] `cd /workspace/VISTA/frontend && npm test -- --runInBand src/components/__tests__/InspectionWorkbenchPanel.test.js`

## Reviewer notes (edge cases / security / architecture)
- Workspace-state normalization enforces strict typing for `inspector.normalization_triage_field` and `inspector.image_enabled` to prevent malformed persisted values from destabilizing UI behavior.
- Workspace-state normalization enforces list/string semantics for `inspector.modalities` and `inspector.view_name`, reducing hydration regressions from inconsistent payload types.
- Backward compatibility is preserved: missing workspace keys continue to fall back to safe defaults and existing part-derived UI behavior.

## Remaining PR-15 milestones
- [ ] Define and implement `PR-15-M7` for broader cross-surface workspace preferences.
- [ ] Preserve delete-governance + workspace/configuration synthetic test matrices while extending scope.

## Risks / blockers
- Remaining Epic 7 personalization scope is not yet carved into named flat PR slices beyond `PR-15-M6`.
