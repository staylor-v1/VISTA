# PR-16 Orchestrator Living Checklist (2026-04-04)

## Current milestone
- **PR-16-M1**: Project configuration cloning API.

## Files changed in this milestone
- `backend/core/schemas.py`
- `backend/routers/inspection_workbench.py`
- `backend/tests/test_inspection_workbench_router.py`
- `docs/planning/feature-request-triage-2026-03-28.md`
- `docs/planning/orchestrator-session-handoff.md`
- `docs/planning/pr16-split-artifact.md`
- `docs/planning/pr16-orchestrator-checklist.md`

## Tests
- [x] `cd /workspace/VISTA && uv run pytest -q backend/tests/test_inspection_workbench_router.py -k project_configuration_clone`
- [x] `cd /workspace/VISTA && uv run pytest -q backend/tests/test_inspection_workbench_router.py -k project_configuration`

## Reviewer notes (edge cases / security / architecture)
- Clone endpoint enforces access checks for both source and target project IDs before metadata copy.
- Clone operation falls back to default project configuration when source metadata is absent/malformed.
- Scope remains function-local (`clone_project_configuration`) with no schema contract breaks on existing endpoints.

## Remaining PR-16 milestones
- [x] `PR-16-M1` configuration clone API baseline.
- [ ] `PR-16-M2+` pending explicit approval of next feature-request contract.

## Risks / blockers
- No frontend workflow wiring in this slice; endpoint is backend-ready for UI integration.
