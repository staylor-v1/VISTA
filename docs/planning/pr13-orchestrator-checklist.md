# PR-13 Orchestrator Living Checklist (2026-04-04)

## Current milestone
- **PR-13 milestone 2 / step 1**: add Project Data export/report mode controls with validation (`bundle_summary`, `bundle_archive`, `report_json`) and progressive cross-type test coverage.

## Files changed in this step
- `frontend/src/components/InspectionWorkbenchPanel.js`
- `frontend/src/components/__tests__/InspectionWorkbenchPanel.test.js`
- `docs/planning/pr13-orchestrator-checklist.md`
- `docs/planning/pr13-split-artifact.md`
- `docs/planning/inspection-workbench-pr-artifact.md`

## Tests
- [x] `cd /workspace/VISTA/frontend && npm test -- --runInBand --watch=false src/components/__tests__/InspectionWorkbenchPanel.test.js`

## Remaining PR-13 milestones
- [~] Export bundle coverage for images/metadata/overlays/annotations + report options (step 1 landed: overlay/measurement records in JSON/archive; step 2 landed: Project Data mode selector + JSON report action control).
- [ ] Red-team / blue-team adversarial cross-type matrix (`PT1/PT2/PT3`) for export/report workflows.

## Risks / blockers
- Export archive currently emits normalized metadata records and image references; binary object-storage retrieval packing remains an explicit follow-up due to runtime/cost constraints.
- Report option product contract (JSON only vs additional formats/scopes such as PDF) remains partially unspecified and may require API contract adjustment.
