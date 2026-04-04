# PR-13 Orchestrator Living Checklist (2026-04-04)

## Current milestone
- **PR-13 milestone 3 / step 1**: red-team/blue-team hardening for export metadata normalization against adversarial part payload shapes across `PT1/PT2/PT3`.

## Files changed in this step
- `backend/routers/export.py`
- `backend/tests/test_export.py`
- `docs/planning/pr13-orchestrator-checklist.md`
- `docs/planning/pr13-split-artifact.md`
- `docs/planning/inspection-workbench-pr-artifact.md`

## Tests
- [x] `cd /workspace/VISTA && pytest backend/tests/test_export.py -k "bundle_json and adversarial_non_list_metadata_shapes"`

## Remaining PR-13 milestones
- [~] Export bundle coverage for images/metadata/overlays/annotations + report options (step 1 landed: overlay/measurement records in JSON/archive; step 2 landed: Project Data mode selector + JSON report action control).
- [~] Red-team / blue-team adversarial cross-type matrix (`PT1/PT2/PT3`) for export/report workflows (step 1 landed: backend metadata-shape hardening + cross-type regression tests).

## Risks / blockers
- Export archive currently emits normalized metadata records and image references; binary object-storage retrieval packing remains an explicit follow-up due to runtime/cost constraints.
- Report option product contract (JSON only vs additional formats/scopes such as PDF) remains partially unspecified and may require API contract adjustment.
- Adversarial report-route scenarios (e.g., large cardinality stress + mixed malformed-but-list payloads) remain for follow-up hardening.
