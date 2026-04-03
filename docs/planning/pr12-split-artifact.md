# PR-12 Split Artifact (2026-04-03)

This artifact captures the incremental work completed in this session so it can be split into clean source-repo PRs after full-app inspection.

## Proposed incremental PR from this session

1. **PR-12 milestone 4 step 1 — backend bulk-ingest discrepancy counters baseline**
   - Scope:
    - Add a project-scoped bulk ingest endpoint `POST /api/projects/{project_id}/ingest`.
    - Accept batch + part records and upsert missing batches while preserving existing project access controls.
    - Return ingest counters (`received`, `created`, `skipped`) and discrepancy records for:
      - duplicate serial numbers inside one ingest payload,
      - serial numbers already assigned to a different batch in the same project.
    - Keep schema migration risk low by reusing existing `inspection_batches` and `inspection_parts` tables/contracts.
    - Extend backend pytest coverage in the existing framework for three progressive synthetic users (`basic`, `intermediate`, `advanced`) across each project type (`PT1`, `PT2`, `PT3`).
   - Files:
    - `backend/core/schemas.py`
    - `backend/routers/inspection_workbench.py`
    - `backend/tests/test_inspection_workbench_router.py`
    - `docs/planning/pr12-orchestrator-checklist.md`
    - `docs/planning/pr12-split-artifact.md`
    - `docs/planning/inspection-workbench-pr-artifact.md`
   - Automated coverage:
    - Existing backend pytest framework:
      - progressive synthetic-user ingest scenarios across `PT1/PT2/PT3`,
      - discrepancy assertions for duplicate payload serials and cross-batch serial conflicts.

2. **PR-12 milestone 3 step 2 — frontend panel-layout controls + persistence wiring**
   - Scope:
    - Add `InspectionWorkbenchPanel` controls for each persisted panel contract (`part_list`, `inspector`, `mpr_controls`):
      - open/closed toggle,
      - width/height numeric controls,
      - orientation selector (`vertical`/`horizontal`).
    - Normalize panel-layout values client-side before persistence to keep payloads aligned with backend clamp/normalization guardrails.
    - Persist normalized `panel_layout` through existing `PUT /api/projects/{project_id}/workspace-state` saves without changing API contracts.
    - Extend existing RTL matrix coverage for progressive synthetic users across `PT1/PT2/PT3`, including adversarial width/height values and orientation updates.
   - Files:
    - `frontend/src/components/InspectionWorkbenchPanel.js`
    - `frontend/src/components/__tests__/InspectionWorkbenchPanel.test.js`
    - `docs/planning/pr12-orchestrator-checklist.md`
    - `docs/planning/pr12-split-artifact.md`
   - Automated coverage:
    - Existing frontend Jest/RTL framework:
      - progressive synthetic-user matrix (`basic`, `intermediate`, `advanced`) across `PT1/PT2/PT3`,
      - red-team oversized/undersized panel dimensions normalized by blue-team clamping before persistence.

3. **PR-12 milestone 3 step 1 — workspace-state panel-layout hardening baseline**
   - Scope:
    - Add backend workspace-state normalization for panel layout contracts (`part_list`, `inspector`, `mpr_controls`).
    - Clamp persisted panel dimensions to safe ranges and normalize invalid orientation values to migration-safe defaults.
    - Preserve backward compatibility by retaining existing workspace keys while ensuring normalized `panel_layout` is always present.
    - Add backend pytest coverage (existing framework) for progressive synthetic users across `PT1/PT2/PT3`, including adversarial malformed panel-layout payloads.
   - Files:
    - `backend/routers/inspection_workbench.py`
    - `backend/tests/test_inspection_workbench_router.py`
    - `docs/planning/pr12-orchestrator-checklist.md`
    - `docs/planning/pr12-split-artifact.md`
   - Automated coverage:
    - Existing backend pytest matrix:
      - progressive synthetic-user scenarios (`basic`, `intermediate`, `advanced`) across `PT1/PT2/PT3`,
      - red-team malformed panel-layout payloads normalized by blue-team guardrails (dimension clamps + orientation fallback).

4. **PR-12 milestone 2 step 2 — configurable hotkeys runtime binding in inspection workbench**
   - Scope:
    - Load `process_settings.configurable_hotkeys` during workbench initialization.
    - Add keyboard handlers in `InspectionWorkbenchPanel` that map configured hotkeys to review actions:
      - accept => `pass`,
      - reject => `reject_pending`,
      - help toggle => in-panel shortcut help visibility.
    - Preserve existing review buttons and ensure keyboard handlers ignore text-entry focus targets.
    - Add automated RTL coverage for progressive synthetic users across `PT1/PT2/PT3` verifying configured keyboard actions and help-panel toggling.
   - Files:
    - `frontend/src/components/InspectionWorkbenchPanel.js`
    - `frontend/src/components/__tests__/InspectionWorkbenchPanel.test.js`
    - `docs/planning/pr12-orchestrator-checklist.md`
    - `docs/planning/pr12-split-artifact.md`
   - Automated coverage:
    - Existing frontend Jest/RTL framework:
      - progressive synthetic-user matrix (`basic`, `intermediate`, `advanced`) across `PT1/PT2/PT3`,
      - configurable hotkeys trigger pass/reject status updates and shortcut-help panel visibility.

5. **PR-12 milestone 2 step 1 — configurable hotkeys storage + validation baseline**
   - Scope:
    - Extend project-configuration schema with `process_settings.configurable_hotkeys` and strict validation:
      - required bindings (`accept_classification`, `reject_classification`, `toggle_shortcut_help`),
      - single alphanumeric characters,
      - unique key assignments.
    - Extend default configuration payload to include hotkey defaults (`a`, `r`, `h`).
    - Add Project Configuration UI controls for hotkey editing and persistence via existing `PUT /configuration` contract.
    - Add automated backend/frontend coverage for progressive synthetic users across `PT1/PT2/PT3`.
   - Files:
    - `backend/core/schemas.py`
    - `backend/routers/inspection_workbench.py`
    - `backend/tests/test_inspection_workbench_router.py`
    - `frontend/src/components/ProjectConfigurationPanel.js`
    - `frontend/src/components/__tests__/ProjectConfigurationPanel.test.js`
   - Automated coverage:
    - Existing backend pytest framework:
      - round-trip configuration for progressive synthetic users (`basic`, `intermediate`, `advanced`) across `PT1/PT2/PT3`,
      - invalid hotkey payload rejection (`422`) across `PT1/PT2/PT3`.
    - Existing frontend Jest/RTL framework:
      - progressive synthetic-user matrix (`basic`, `intermediate`, `advanced`) across `PT1/PT2/PT3` verifying hotkey edit persistence in save payload.
    - Playwright visual smoke:
      - project-configuration screenshot capture + visual analytics notes in `docs/planning/pr12-hotkeys-screenshot-analysis.md` (binary screenshot intentionally not committed).

## Cherry-pick guidance

- Keep this PR isolated from runtime inspector keyboard binding migration (next PR-12 milestone).
- Keep docs-only milestone bookkeeping changes in a separate follow-up commit if maintainers prefer code-only PRs.

## Remaining PR-12 backlog after this checkpoint

- Shared runtime convergence between workbench configurable hotkeys and legacy compact-classification keyboard mappings on non-workbench screens.
- Workspace-state hardening follow-up: draggable panel-resize interactions and dock/undock ergonomics.
- Ingest discrepancy counters/validation APIs follow-up: frontend ingest UX + dashboard/project-data discrepancy summarization.
- Export bundle coverage for images/metadata/overlays/annotations + report options.
- Red-team / blue-team cross-type adversarial matrix and governance closeout.
