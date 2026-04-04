# PR-14 Orchestrator Living Checklist (2026-04-04)

## Current milestone
- **PR-14 milestone 1 / step 2**: extend Playwright E2E matrix + screenshot analytics for report metadata-normalization telemetry.

## Files changed in this step
- `frontend/e2e/fixtures/inspectionWorkbenchMocks.js`
- `frontend/e2e/specs/inspection-workbench.spec.js`
- `docs/planning/pr14-orchestrator-checklist.md`
- `docs/planning/pr14-split-artifact.md`
- `docs/planning/pr14-screenshot-analysis.md`

## Tests
- [x] `cd frontend && npm test -- --runInBand src/components/__tests__/InspectionWorkbenchPanel.test.js`
- [x] `cd frontend && npx playwright test e2e/specs/inspection-workbench.spec.js --grep "Inspection Workbench E2E"`
- [x] `cd frontend && npx playwright test e2e/specs/inspection-workbench.spec.js --grep "PR-14 report normalization screenshot artifact"`

## Remaining PR-14 milestones
- [x] Add report telemetry surfacing to E2E matrix and visual analytics notes.
- [ ] Extend report telemetry surface with actionable links/filters for discrepancy triage workflow.

## Risks / blockers
- Report telemetry relies on backend normalization fields introduced in PR-13 and will remain hidden when those fields are absent/zero.
