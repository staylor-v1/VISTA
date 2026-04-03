# PR-12 Orchestrator Living Checklist (2026-04-03)

## Current milestone
- **PR-12 milestone 3 / step 2**: frontend panel-layout controls wired to server-backed workspace-state persistence.

## Files changed in this step
- `frontend/src/components/InspectionWorkbenchPanel.js`
- `frontend/src/components/__tests__/InspectionWorkbenchPanel.test.js`
- `docs/planning/pr12-orchestrator-checklist.md`
- `docs/planning/pr12-split-artifact.md`

## Tests
- [x] `cd frontend && npm test -- --runInBand src/components/__tests__/InspectionWorkbenchPanel.test.js`

## Remaining PR-12 milestones
- [x] Configurable hotkeys storage + validation and UI plumbing.
- [~] Configurable hotkeys runtime binding in inspector keyboard handlers (remaining follow-up is shared legacy compact-classification mapping convergence outside workbench scope).
- [~] Workspace-state hardening for panel open/resize/orientation persistence (backend normalization/clamping + frontend panel-layout controls landed; draggable interactions remain).
- [ ] Ingest discrepancy counters/validation APIs and reportable discrepancy summaries.
- [ ] Export bundle coverage for images/metadata/overlays/annotations + report options.
- [ ] Red-team / blue-team cross-type adversarial matrix (`PT1/PT2/PT3`) and governance closeout checklist.

## Risks / blockers
- Frontend panel layout now supports explicit open/orientation/size controls, but no drag-handle interaction exists yet for direct mouse-resize ergonomics.
- Existing persisted workspace metadata for active users will be normalized on next read/write cycle; no migration is required but analytics should monitor if large volumes of malformed legacy state are observed.
