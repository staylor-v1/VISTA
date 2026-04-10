# PR-13 Orchestrator Living Checklist (2026-04-04)

## Current milestone
- **PR-13 milestone 3 / step 2**: red-team/blue-team closeout for mixed-list adversarial metadata and report-route normalization telemetry across `PT1/PT2/PT3`.

## Files changed in this step
- `backend/routers/export.py`
- `backend/tests/test_export.py`
- `docs/planning/pr13-orchestrator-checklist.md`
- `docs/planning/pr13-split-artifact.md`
- `docs/planning/inspection-workbench-pr-artifact.md`

## Tests
- [x] `cd /workspace/VISTA && pytest backend/tests/test_export.py -k "bundle_json and (adversarial_non_list_metadata_shapes or dropped_non_object_metadata_items)"`
- [x] `cd /workspace/VISTA && pytest backend/tests/test_export.py -k "report_json and metadata_normalization and (PT1 or PT2 or PT3)"`

## Remaining PR-13 milestones
- [x] Export bundle coverage for images/metadata/overlays/annotations + report options (step 1 landed: overlay/measurement records in JSON/archive; step 2 landed: Project Data mode selector + JSON report action control).
- [x] Red-team / blue-team adversarial cross-type matrix (`PT1/PT2/PT3`) for export/report workflows (step 1 landed: backend metadata-shape hardening; step 2 landed: mixed-list dropped-item discrepancy telemetry + report normalization matrix).

## Risks / blockers
- Export archive currently emits normalized metadata records and image references; binary object-storage retrieval packing remains an explicit follow-up due to runtime/cost constraints.
- Report option product contract (JSON only vs additional formats/scopes such as PDF) remains partially unspecified and may require API contract adjustment.
- Report endpoint now surfaces normalization telemetry for dropped non-object list entries, but frontend does not yet visualize those fields.
