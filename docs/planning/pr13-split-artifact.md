# PR-13 Split Artifact (2026-04-04)

This artifact tracks incremental PR slices for the next unimplemented orchestrator backlog item after PR-12.

## Proposed incremental PR from this session

1. **PR-13 milestone 2 step 1 — Project Data report option controls + validation**
   - Scope:
     - Add a Project Data export/report action selector in `InspectionWorkbenchPanel` with explicit mode values:
       - `bundle_summary`
       - `bundle_archive`
       - `report_json`
     - Add a unified action trigger button (`Run Export/Report`) that routes to existing backend endpoints:
       - `GET /api/projects/{project_id}/export-bundle-json`
       - `GET /api/projects/{project_id}/export-bundle`
       - `GET /api/projects/{project_id}/report-json`
     - Add client-side validation guardrail for unsupported mode values before API invocation.
     - Extend existing frontend RTL progressive synthetic-user matrix (`basic`, `intermediate`, `advanced`) across all project types (`PT1`, `PT2`, `PT3`) to validate mode controls and success surfaces.
   - Files:
     - `frontend/src/components/InspectionWorkbenchPanel.js`
     - `frontend/src/components/__tests__/InspectionWorkbenchPanel.test.js`
     - `docs/planning/pr13-orchestrator-checklist.md`
     - `docs/planning/pr13-split-artifact.md`
     - `docs/planning/inspection-workbench-pr-artifact.md`
   - Automated coverage:
     - Existing frontend test framework (`react-scripts` + RTL):
       - Progressive cross-type workbench tests exercise `report_json`, `bundle_archive`, `bundle_summary` mode paths.
       - Validation test confirms unsupported mode selection is blocked with a user-visible error.

2. **PR-13 milestone 1 step 1 — export bundle record completeness (overlay + measurement records)**
   - Scope:
     - Add normalized per-part overlay and AI measurement records to `GET /api/projects/{project_id}/export-bundle-json`.
     - Keep discrepancy detection behavior and existing aggregate counters backward-compatible.
     - Ensure `GET /api/projects/{project_id}/export-bundle` manifest now contains enriched bundle summary records.
     - Extend existing backend pytest progressive synthetic-user matrix (`basic`, `intermediate`, `advanced`) across `PT1/PT2/PT3` to assert new record contracts.
   - Files:
     - `backend/routers/export.py`
     - `backend/tests/test_export.py`
     - `docs/planning/pr13-orchestrator-checklist.md`
     - `docs/planning/pr13-split-artifact.md`
     - `docs/planning/inspection-workbench-pr-artifact.md`
   - Automated coverage:
     - Existing backend pytest framework:
       - `export-bundle-json` progressive scenarios across all project types.
       - `export-bundle` archive/manifest progressive scenarios across all project types.

## Cherry-pick guidance

- Keep this PR isolated to backend export contract enrichment + tests.
- Keep report-option UI/API follow-up in a separate PR-13 milestone commit.

## Remaining PR-13 backlog after this checkpoint

- Red-team/blue-team adversarial coverage across project types and synthetic user complexity levels.

## Proposed incremental PR from this session (milestone 3 step 1)

1. **PR-13 milestone 3 step 1 — backend adversarial metadata-shape normalization**
   - Scope:
     - Harden `GET /api/projects/{project_id}/export-bundle-json` to normalize metadata arrays (`annotations`, `overlay_layers`, `segmentation_runs`, `measurement_runs`) by accepting only list-of-dict payloads.
     - Prevent malformed scalar/object metadata from inflating counts or producing invalid normalized records.
     - Extend backend pytest matrix with a red-team-style adversarial scenario for each project type (`PT1`, `PT2`, `PT3`) where malformed metadata shapes are intentionally submitted.
   - Files:
     - `backend/routers/export.py`
     - `backend/tests/test_export.py`
     - `docs/planning/pr13-orchestrator-checklist.md`
     - `docs/planning/pr13-split-artifact.md`
     - `docs/planning/inspection-workbench-pr-artifact.md`
  - Automated coverage:
    - Existing backend pytest framework:
      - `pytest backend/tests/test_export.py -k "bundle_json and adversarial_non_list_metadata_shapes"`

## Proposed incremental PR from this session (milestone 3 step 2)

1. **PR-13 milestone 3 step 2 — mixed-list adversarial normalization + report telemetry closeout**
   - Scope:
     - Extend backend metadata normalization to return dropped-item counts for list fields that contain non-object elements.
     - Add discrepancy telemetry to `GET /api/projects/{project_id}/export-bundle-json`:
       - `counts.dropped_non_object_metadata_items` per part,
       - discrepancy code `metadata_items_dropped_non_object` when any dropped items are detected.
     - Extend `GET /api/projects/{project_id}/report-json` with normalization summary telemetry:
       - `summary.metadata_normalization.dropped_non_object_items` keyed by metadata array field.
     - Add cross-type red-team/blue-team tests across `PT1`, `PT2`, `PT3` and progressive synthetic users (`basic`, `intermediate`, `advanced`) covering mixed list payloads and report summary normalization counts.
   - Files:
     - `backend/routers/export.py`
     - `backend/tests/test_export.py`
     - `docs/planning/pr13-orchestrator-checklist.md`
     - `docs/planning/pr13-split-artifact.md`
     - `docs/planning/inspection-workbench-pr-artifact.md`
   - Automated coverage:
     - Existing backend pytest framework:
       - `pytest backend/tests/test_export.py -k "bundle_json and (adversarial_non_list_metadata_shapes or dropped_non_object_metadata_items)"`
       - `pytest backend/tests/test_export.py -k "report_json and metadata_normalization and (PT1 or PT2 or PT3)"`
