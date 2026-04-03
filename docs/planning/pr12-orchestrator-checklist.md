# PR-12 Orchestrator Living Checklist (2026-04-03)

## Current milestone
- **PR-12 milestone 1 / step 1**: delete-project governance API baseline with explicit confirmation phrase and proxy-auth restriction.

## Files changed in this step
- `backend/core/schemas.py`
- `backend/utils/crud.py`
- `backend/routers/projects.py`
- `backend/tests/test_projects_router.py`
- `docs/planning/inspection-workbench-pr-artifact.md`
- `docs/planning/pr12-orchestrator-checklist.md`

## Tests
- [x] `cd backend && pytest -q tests/test_projects_router.py`

## Remaining PR-12 milestones
- [ ] Frontend delete-project warning UX with explicit typed confirmation.
- [ ] Configurable hotkeys storage + validation and UI plumbing.
- [ ] Workspace-state hardening for panel open/resize/orientation persistence.
- [ ] Ingest discrepancy counters/validation APIs and reportable discrepancy summaries.
- [ ] Export bundle coverage for images/metadata/overlays/annotations + report options.
- [ ] Red-team / blue-team cross-type adversarial matrix (`PT1/PT2/PT3`) and governance closeout checklist.

## Risks / blockers
- Current delete authorization boundary relies on proxy-auth requirement + project group membership; product may require explicit admin/owner role once role model is introduced.
- Delete endpoint currently performs immediate hard delete at project row level (with relational cascades); restore flow is not part of this milestone.
