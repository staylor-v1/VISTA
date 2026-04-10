# PR-07 Split Artifact (2026-04-03)

This artifact captures the PR-07 milestone slice completed in this session so maintainers can cherry-pick it into a clean incremental source-repo PR after full-app inspection.

## Proposed incremental PR from this session

1. **PR-07 milestone 4 step 2 — frontend archive action + cross-type E2E validation**
   - Scope:
     - add `Prepare Export Archive` action in Project Data workbench controls,
     - invoke `GET /api/projects/{project_id}/export-bundle` and render success/error status in context,
     - extend existing Jest + Playwright suites to verify archive initiation for progressive synthetic users (`basic`, `intermediate`, `advanced`) across project types (`PT1`, `PT2`, `PT3`).
   - Files:
     - `frontend/src/components/InspectionWorkbenchPanel.js`
     - `frontend/src/components/__tests__/InspectionWorkbenchPanel.test.js`
     - `frontend/e2e/fixtures/inspectionWorkbenchMocks.js`
     - `frontend/e2e/specs/inspection-workbench.spec.js`
     - `docs/planning/inspection-workbench-pr-artifact.md`
     - `docs/planning/pr07-orchestrator-checklist.md`
     - `docs/planning/pr07-split-artifact.md`

2. **PR-07 milestone 4 step 1 — downloadable bundle archive baseline**
   - Scope:
     - add `GET /api/projects/{project_id}/export-bundle` archive endpoint,
     - package `export-manifest.json` with project summary + image object-storage references,
     - validate archive contract in existing pytest export suite using progressive synthetic users (`basic`, `intermediate`, `advanced`) across project types (`PT1`, `PT2`, `PT3`).
   - Files:
     - `backend/routers/export.py`
     - `backend/tests/test_export.py`
     - `docs/planning/inspection-workbench-pr-artifact.md`
     - `docs/planning/pr07-orchestrator-checklist.md`
     - `docs/planning/pr07-split-artifact.md`

3. **PR-07 milestone 3 step 3 — bundle detail payload hardening (already completed in prior checkpoint)**
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

- None for PR-07 baseline scope; optional future enhancement is direct browser download + retry UX polish.
