# PR-12 Split Artifact (2026-04-03)

This artifact captures the incremental work completed in this session so it can be split into clean source-repo PRs after full-app inspection.

## Proposed incremental PR from this session

1. **PR-12 milestone 2 step 2 — configurable hotkeys runtime binding in inspection workbench**
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

2. **PR-12 milestone 2 step 1 — configurable hotkeys storage + validation baseline**
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
- Workspace-state hardening for panel open/resize/orientation persistence.
- Ingest discrepancy counters/validation APIs and reportable discrepancy summaries.
- Export bundle coverage for images/metadata/overlays/annotations + report options.
- Red-team / blue-team cross-type adversarial matrix and governance closeout.
