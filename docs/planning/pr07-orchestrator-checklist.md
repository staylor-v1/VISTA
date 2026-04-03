# PR-07 Orchestrator Living Checklist (2026-04-03)

## Current milestone
- **PR-07 milestone 4 / step 1**: add downloadable export bundle archive with object-storage image references.

## Files changed in this step
- `backend/routers/export.py`
- `backend/tests/test_export.py`
- `docs/planning/inspection-workbench-pr-artifact.md`
- `docs/planning/pr07-orchestrator-checklist.md`
- `docs/planning/pr07-split-artifact.md`

## Tests
- [x] `pytest backend/tests/test_export.py -k test_project_bundle_json_supports_progressive_users_per_project_type`
- [x] `pytest backend/tests/test_export.py -k test_project_bundle_archive_supports_progressive_users_per_project_type`

## Remaining PR-07 milestones
- [x] Add downloadable export bundle packaging flow for image/object payload references.
- [x] Expand bundle payload to include explicit annotation records and per-part discrepancy summaries.
- [x] Add frontend export action wiring and user-visible status handling.
- [ ] Add cross-type E2E coverage for bundle initiation and response validation (`PT1`, `PT2`, `PT3`).

## Risks / blockers
- Current bundle archive currently packages a JSON manifest with object-storage references only (no binary file payload bundling yet).
- Annotation/discrepancy detail payload still derives from part metadata keys and therefore depends on metadata contract consistency.
