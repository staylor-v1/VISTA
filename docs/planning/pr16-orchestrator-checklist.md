# PR-16 Orchestrator Living Checklist (2026-04-04)

## Current milestone
- **PR-16-M2**: Project configuration clone UI integration.

## Files changed in this milestone
- `frontend/src/components/ProjectConfigurationPanel.js`
- `frontend/src/components/__tests__/ProjectConfigurationPanel.test.js`
- `docs/planning/feature-request-triage-2026-03-28.md`
- `docs/planning/orchestrator-session-handoff.md`
- `docs/planning/pr16-m2-replay-artifact.md`
- `docs/planning/pr16-orchestrator-checklist.md`

## Tests
- [x] `cd /workspace/VISTA/frontend && npm test -- --runInBand src/components/__tests__/ProjectConfigurationPanel.test.js`
- [x] `cd /workspace/VISTA && uv run pytest -q backend/tests/test_inspection_workbench_router.py -k project_configuration_clone`

## Reviewer notes (edge cases / security / architecture)
- UI copy flow now delegates clone persistence to backend clone endpoint and no longer executes a client-side GET+PUT chain.
- Clone requests submit only `source_project_id`; source/target authorization remains enforced server-side.
- Success messaging is only shown after clone API success, preserving failure visibility when clone requests fail.

## Remaining PR-16 milestones
- [x] `PR-16-M1` configuration clone API baseline.
- [x] `PR-16-M1a` self-clone guard.
- [x] `PR-16-M2` frontend clone API integration.
- [ ] `PR-16-M3+` pending explicit approval of next feature-request contract.

## Risks / blockers
- Playwright browser binaries are not yet installed in this environment, so screenshot-based E2E visual verification is currently blocked.
