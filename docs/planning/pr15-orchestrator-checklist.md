# PR-15 Orchestrator Living Checklist (2026-04-04)

## Current milestone
- **PR-15 milestone 1 / step 3 (part 2 / step 3)**: Server-backed workspace persistence hardening for inspector modalities and selected view fields.

## Files changed in this step
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
- Workspace-state normalization now enforces string semantics for `inspector.normalization_triage_field`, preventing malformed persisted values from causing unstable UI filtering.
- Workspace-state normalization now enforces boolean semantics for `inspector.image_enabled`, preventing malformed persisted values from introducing inconsistent image-toggle behavior.
- Workspace-state normalization now enforces list semantics for `inspector.modalities` and string semantics for `inspector.view_name`, preventing malformed payload types from causing invalid workspace hydration state.
- Change remains backward compatible: payloads missing `inspector.modalities` or `inspector.view_name` default to safe empty values and continue to hydrate from part defaults in UI.

## Remaining PR-15 milestones
- [ ] Implement PR-15 milestone 1 step 3 (part 2 / step 4+) scope for broader cross-surface workspace preferences.
- [ ] Preserve delete-governance + workspace/configuration synthetic test matrices while extending scope.

## Risks / blockers
- Cross-surface workspace preferences beyond inspector shortcut help, normalization triage field, and image visibility remain out of scope for this slice and require explicit follow-on scoping.
