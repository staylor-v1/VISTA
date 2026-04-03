# PR-12 Orchestrator Living Checklist (2026-04-03)

## Current milestone
- **PR-12 milestone 2 / step 1**: configurable hotkeys storage + validation baseline with project-configuration UI plumbing.

## Files changed in this step
- `backend/core/schemas.py`
- `backend/routers/inspection_workbench.py`
- `backend/tests/test_inspection_workbench_router.py`
- `frontend/src/components/ProjectConfigurationPanel.js`
- `frontend/src/components/__tests__/ProjectConfigurationPanel.test.js`
- `docs/planning/inspection-workbench-pr-artifact.md`
- `docs/planning/pr12-orchestrator-checklist.md`
- `docs/planning/pr12-split-artifact.md`
- `docs/planning/pr12-hotkeys-screenshot-analysis.md`

## Tests
- [x] `cd backend && pytest tests/test_inspection_workbench_router.py -k "project_configuration"`
- [x] `cd frontend && npm test -- --runInBand src/components/__tests__/ProjectConfigurationPanel.test.js`
- [x] `cd frontend && npx playwright test e2e/specs/inspection-workbench.spec.js --grep "PR-11 project configuration screenshot artifact"`

## Remaining PR-12 milestones
- [~] Configurable hotkeys storage + validation and UI plumbing (baseline landed; runtime inspector hotkey binding not yet wired).
- [ ] Workspace-state hardening for panel open/resize/orientation persistence.
- [ ] Ingest discrepancy counters/validation APIs and reportable discrepancy summaries.
- [ ] Export bundle coverage for images/metadata/overlays/annotations + report options.
- [ ] Red-team / blue-team cross-type adversarial matrix (`PT1/PT2/PT3`) and governance closeout checklist.

## Risks / blockers
- Current frontend hotkey section persists values to project configuration, but runtime class-action keyboard listeners still use legacy auto-generated mappings; follow-up milestone must connect persisted bindings into inspector workflows.
- Validation currently allows any single alphanumeric key. If product requires reserved-key protection (e.g., browser shortcuts), add deny-list policy + UX guidance in next step.
