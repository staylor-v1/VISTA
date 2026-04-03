# PR-12 Orchestrator Living Checklist (2026-04-03)

## Current milestone
- **PR-12 milestone 2 / step 2**: configurable hotkeys runtime binding in inspection workbench keyboard handlers.

## Files changed in this step
- `frontend/src/components/InspectionWorkbenchPanel.js`
- `frontend/src/components/__tests__/InspectionWorkbenchPanel.test.js`
- `docs/planning/pr12-orchestrator-checklist.md`
- `docs/planning/pr12-split-artifact.md`

## Tests
- [x] `cd frontend && npm test -- --runInBand src/components/__tests__/InspectionWorkbenchPanel.test.js`

## Remaining PR-12 milestones
- [x] Configurable hotkeys storage + validation and UI plumbing.
- [~] Configurable hotkeys runtime binding in inspector keyboard handlers (this step adds pass/reject/help bindings; remaining follow-up is shared legacy compact-classification mapping convergence).
- [ ] Workspace-state hardening for panel open/resize/orientation persistence.
- [ ] Ingest discrepancy counters/validation APIs and reportable discrepancy summaries.
- [ ] Export bundle coverage for images/metadata/overlays/annotations + report options.
- [ ] Red-team / blue-team cross-type adversarial matrix (`PT1/PT2/PT3`) and governance closeout checklist.

## Risks / blockers
- Runtime bindings now honor project configuration hotkeys for inspection review actions, but global keyboard listeners still coexist with legacy compact-classification shortcuts in non-workbench screens.
- Validation currently allows any single alphanumeric key. If product requires reserved-key protection (e.g., browser shortcuts), add deny-list policy + UX guidance in follow-up.
