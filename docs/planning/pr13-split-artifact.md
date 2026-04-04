# PR-13 Split Artifact (2026-04-04)

This artifact tracks the first incremental PR slice for the next unimplemented orchestrator backlog item after PR-12.

## Proposed incremental PR from this session

1. **PR-13 milestone 1 step 1 — export bundle record completeness (overlay + measurement records)**
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

- Report option controls for project-level exports.
- Red-team/blue-team adversarial coverage across project types and synthetic user complexity levels.
