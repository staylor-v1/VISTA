# PR-13 Orchestrator Living Checklist (2026-04-04)

## Current milestone
- **PR-13 milestone 1 / step 1**: expand export-bundle artifact records for overlays + AI measurement runs to close export bundle coverage gaps.

## Files changed in this step
- `backend/routers/export.py`
- `backend/tests/test_export.py`
- `docs/planning/pr13-orchestrator-checklist.md`
- `docs/planning/pr13-split-artifact.md`
- `docs/planning/inspection-workbench-pr-artifact.md`

## Tests
- [x] `cd /workspace/VISTA && uv run pytest -q backend/tests/test_export.py -k "bundle_json_supports_progressive_users_per_project_type or bundle_archive_supports_progressive_users_per_project_type" --maxfail=1`

## Remaining PR-13 milestones
- [~] Export bundle coverage for images/metadata/overlays/annotations + report options (step 1 landed: overlay/measurement record exports in JSON and bundle archive manifest).
- [ ] Frontend Project Data report option controls and validation for export/report mode selection.
- [ ] Red-team / blue-team adversarial cross-type matrix (`PT1/PT2/PT3`) for export/report workflows.

## Risks / blockers
- Export archive currently emits normalized metadata records and image references; binary object-storage retrieval packing remains an explicit follow-up due to runtime/cost constraints.
- Report option product contract (JSON only vs additional formats/scopes) remains partially unspecified and may require API contract adjustment.
