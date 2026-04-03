# PR-07 Orchestrator Living Checklist (2026-04-03)

## Current milestone
- **PR-07 milestone 3 / step 2**: frontend export bundle summary action wiring with user-visible status feedback in Project Data.

## Files changed in this step
- `frontend/src/components/InspectionWorkbenchPanel.js`
- `frontend/src/components/__tests__/InspectionWorkbenchPanel.test.js`
- `docs/planning/inspection-workbench-pr-artifact.md`
- `docs/planning/pr07-orchestrator-checklist.md`

## Tests
- [x] `cd frontend && npm test -- --runInBand src/components/__tests__/InspectionWorkbenchPanel.test.js`

## Remaining PR-07 milestones
- [ ] Add downloadable export bundle packaging flow for image/object payload references.
- [ ] Expand bundle payload to include explicit annotation records and per-part discrepancy summaries.
- [x] Add frontend export action wiring and user-visible status handling.
- [ ] Add cross-type E2E coverage for bundle initiation and response validation (`PT1`, `PT2`, `PT3`).

## Risks / blockers
- Current milestone surfaces summary counters only; it does not yet provide binary archive packaging.
- Overlay and annotation counters are derived from part metadata keys and therefore depend on metadata contract consistency.
