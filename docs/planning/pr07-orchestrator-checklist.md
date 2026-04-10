# PR-07 Orchestrator Living Checklist (2026-04-03)

## Current milestone
- **PR-07 milestone 4 / step 2**: add cross-type E2E coverage for bundle initiation and response validation (`PT1`, `PT2`, `PT3`).

## Files changed in this step
- `frontend/src/components/InspectionWorkbenchPanel.js`
- `frontend/src/components/__tests__/InspectionWorkbenchPanel.test.js`
- `frontend/e2e/fixtures/inspectionWorkbenchMocks.js`
- `frontend/e2e/specs/inspection-workbench.spec.js`
- `docs/planning/inspection-workbench-pr-artifact.md`
- `docs/planning/pr07-orchestrator-checklist.md`
- `docs/planning/pr07-split-artifact.md`

## Tests
- [x] `cd frontend && npm test -- --runInBand src/components/__tests__/InspectionWorkbenchPanel.test.js`
- [x] `cd frontend && npx playwright test e2e/specs/inspection-workbench.spec.js --grep "Inspection Workbench E2E"`

## Remaining PR-07 milestones
- [x] Add downloadable export bundle packaging flow for image/object payload references.
- [x] Expand bundle payload to include explicit annotation records and per-part discrepancy summaries.
- [x] Add frontend export action wiring and user-visible status handling.
- [x] Add cross-type E2E coverage for bundle initiation and response validation (`PT1`, `PT2`, `PT3`).

## Risks / blockers
- Current bundle archive currently packages a JSON manifest with object-storage references only (no binary file payload bundling yet).
- Annotation/discrepancy detail payload still derives from part metadata keys and therefore depends on metadata contract consistency.
