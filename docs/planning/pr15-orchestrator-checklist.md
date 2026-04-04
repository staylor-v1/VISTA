# PR-15 Orchestrator Living Checklist (2026-04-04)

## Current milestone
- **PR-15 milestone 1 / step 1**: Start screen project deletion authorization + irreversible confirmation UX.

## Files changed in this step
- `frontend/src/App.js`
- `frontend/src/App.test.js`
- `backend/tests/test_projects_router.py`
- `docs/planning/feature-request-triage-2026-03-28.md`
- `docs/planning/orchestrator-session-handoff.md`
- `docs/planning/pr15-orchestrator-checklist.md`
- `docs/planning/pr15-split-artifact.md`

## Tests
- [x] `cd /workspace/VISTA && uv run pytest -q backend/tests/test_projects_router.py`
- [x] `cd /workspace/VISTA/frontend && npm test -- --runInBand src/App.test.js`
- [x] `cd /workspace/VISTA/frontend && npx playwright test e2e/specs/inspection-workbench.spec.js --grep "Inspection Workbench E2E"`

## Reviewer notes (edge cases / security / architecture)
- Delete action is disabled in dashboard menu when current user lacks project-group membership, reducing accidental unauthorized attempts before network call.
- Backend remains source of truth for authorization and confirmation phrase validation; frontend checks are additive and non-authoritative.
- Delete modal now prevents submit until exact phrase + irreversible acknowledgment, reducing accidental destructive action risk.
- Post-delete list refresh now pulls authoritative server state, avoiding stale list artifacts when concurrent changes occur.

## Remaining PR-15 milestones
- [ ] Define PR-15 milestone 1 step 2 scope (Epic 7 follow-on).
- [ ] Keep delete governance tests green while extending adjacent scope.

## Risks / blockers
- UI authorization relies on `/api/users/me/groups`; if this endpoint is unavailable in some deployments, backend still protects delete but UI may default to stricter deny behavior.
