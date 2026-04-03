# PR-12 Orchestrator Living Checklist (2026-04-03)

## Current milestone
- **PR-12 milestone 3 / step 1**: workspace-state hardening for panel open/resize/orientation persistence.

## Files changed in this step
- `backend/routers/inspection_workbench.py`
- `backend/tests/test_inspection_workbench_router.py`
- `docs/planning/pr12-orchestrator-checklist.md`
- `docs/planning/pr12-split-artifact.md`

## Tests
- [x] `cd backend && pytest tests/test_inspection_workbench_router.py -k workspace_state_persistence_supports_progressive_users`

## Remaining PR-12 milestones
- [x] Configurable hotkeys storage + validation and UI plumbing.
- [~] Configurable hotkeys runtime binding in inspector keyboard handlers (remaining follow-up is shared legacy compact-classification mapping convergence outside workbench scope).
- [~] Workspace-state hardening for panel open/resize/orientation persistence (backend normalization/clamping landed; frontend panel-resize controls and explicit orientation toggles remain).
- [ ] Ingest discrepancy counters/validation APIs and reportable discrepancy summaries.
- [ ] Export bundle coverage for images/metadata/overlays/annotations + report options.
- [ ] Red-team / blue-team cross-type adversarial matrix (`PT1/PT2/PT3`) and governance closeout checklist.

## Risks / blockers
- Frontend currently persists workspace state frequently but does not yet expose draggable panel resize controls; this milestone hardens payload contracts so future UI controls cannot persist invalid dimensions/orientations.
- Existing persisted workspace metadata for active users will be normalized on next read/write cycle; no migration is required but analytics should monitor if large volumes of malformed legacy state are observed.
