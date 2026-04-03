# PR-07 Split Artifact (2026-04-03)

This artifact captures the PR-07 milestone slice completed in this session so maintainers can cherry-pick it into a clean incremental source-repo PR after full-app inspection.

## Proposed incremental PR from this session

1. **PR-07 milestone 3 step 3 — bundle detail payload hardening**
   - Scope:
     - extend `GET /api/projects/{project_id}/export-bundle-json` with explicit annotation records,
     - add per-part discrepancy summaries in export payload,
     - validate the enhanced contract using the existing backend pytest export suite with progressive synthetic users (`basic`, `intermediate`, `advanced`) across project types (`PT1`, `PT2`, `PT3`).
   - Files:
     - `backend/routers/export.py`
     - `backend/tests/test_export.py`
     - `docs/planning/inspection-workbench-pr-artifact.md`
     - `docs/planning/pr07-orchestrator-checklist.md`
     - `docs/planning/pr07-split-artifact.md`

## Remaining PR-07 backlog after this checkpoint

- Add downloadable export bundle packaging flow for image/object payload references.
- Add cross-type E2E coverage for bundle initiation and response validation.
