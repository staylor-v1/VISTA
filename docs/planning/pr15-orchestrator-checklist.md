# PR-15 Orchestrator Living Checklist (2026-04-04)

## Current milestone
- **PR-15 milestone 1 / step 3 (part 2 / step 2)**: Server-backed workspace persistence for inspector image visibility field.

## Files changed in this step
- `backend/routers/inspection_workbench.py`
- `backend/tests/test_inspection_workbench_router.py`
- `frontend/src/components/InspectionWorkbenchPanel.js`
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
- Frontend hydration and autosave both use strict boolean handling for image visibility, reducing drift between initial render state and persisted state.
- Change is backward compatible: old workspace payloads without `inspector.image_enabled` default to enabled image rendering.

## Remaining PR-15 milestones
- [ ] Implement PR-15 milestone 1 step 3 (part 2 / step 3+) scope for broader cross-surface workspace preferences.
- [ ] Preserve delete-governance + workspace/configuration synthetic test matrices while extending scope.

## Risks / blockers
- Cross-surface workspace preferences beyond inspector shortcut help, normalization triage field, and image visibility remain out of scope for this slice and require explicit follow-on scoping.
