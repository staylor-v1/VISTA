# PR-11 Orchestrator Checklist

## Current milestone
- **PR-11 milestone 1 / step 1**: backend project-configuration API baseline (`GET/PUT`) with migration-safe defaults.

## Files changed in this step
- `backend/core/schemas.py`
- `backend/routers/inspection_workbench.py`
- `backend/tests/test_inspection_workbench_router.py`
- `docs/planning/inspection-workbench-pr-artifact.md`
- `docs/planning/pr11-orchestrator-checklist.md`

## Tests
- [x] `pytest backend/tests/test_inspection_workbench_router.py -k project_configuration_round_trip_supports_progressive_users`
- [x] `pytest backend/tests/test_inspection_workbench_router.py -k workspace_state_supports_progressive_users`

## Remaining PR-11 milestones
- [ ] Add Project UI tab for **Project Configuration** with sectioned forms.
- [ ] Wire frontend API integration for configuration load/save.
- [ ] Add copy-configuration workflow from existing project.
- [ ] Add frontend component/E2E coverage for PT1/PT2/PT3 progressive synthetic users.

## Risks / blockers
- Copy-configuration behavior contract is not yet defined (replace vs merge semantics).
- Frontend information architecture now has only `Inspection` + `Project Data`; adding a third tab may require layout refinements.
