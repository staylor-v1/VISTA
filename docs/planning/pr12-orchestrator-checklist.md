# PR-12 Orchestrator Living Checklist (2026-04-03)

## Current milestone
- **PR-12 milestone 1 / step 2**: frontend delete-project warning UX with explicit typed confirmation and backend contract wiring.

## Files changed in this step
- `frontend/src/App.js`
- `frontend/src/App.test.js`
- `docs/planning/inspection-workbench-pr-artifact.md`
- `docs/planning/pr12-orchestrator-checklist.md`

## Tests
- [x] `cd frontend && npm test -- --runInBand src/App.test.js`

## Remaining PR-12 milestones
- [ ] Configurable hotkeys storage + validation and UI plumbing.
- [ ] Workspace-state hardening for panel open/resize/orientation persistence.
- [ ] Ingest discrepancy counters/validation APIs and reportable discrepancy summaries.
- [ ] Export bundle coverage for images/metadata/overlays/annotations + report options.
- [ ] Red-team / blue-team cross-type adversarial matrix (`PT1/PT2/PT3`) and governance closeout checklist.

## Risks / blockers
- Current delete authorization boundary still relies on proxy-auth requirement + project group membership; product may require explicit admin/owner role once role model is introduced.
- Frontend currently surfaces backend confirmation/auth errors as toast text; if product requires richer in-modal remediation guidance, add structured error mapping in a follow-up step.
