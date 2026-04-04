# PR-11 Split Artifact (2026-04-03)

This artifact captures the incremental work completed in this session so it can be split into a clean source-repo PR after full-app inspection.

## Proposed incremental PR from this session

1. **PR-11 milestone 2 step 5 — part-view section editing workflow**
   - Scope:
     - Add editable part-view rows in `ProjectConfigurationPanel` (add/edit/remove).
     - Persist part-view fields using existing configuration API contract.
     - Normalize comma-separated required-modality input into persisted arrays.
   - Files:
     - `frontend/src/components/ProjectConfigurationPanel.js`
     - `frontend/src/components/__tests__/ProjectConfigurationPanel.test.js`
   - Tests:
     - `cd frontend && npm test -- --runInBand src/components/__tests__/ProjectConfigurationPanel.test.js`

2. **PR-11 milestone bookkeeping docs update**
   - Scope:
     - Record milestone completion in artifact/checklist docs for orchestrator handoff continuity.
   - Files:
     - `docs/planning/inspection-workbench-pr-artifact.md`
     - `docs/planning/pr11-orchestrator-checklist.md`
     - `docs/planning/pr11-split-artifact.md`


3. **PR-11 milestone 2 step 6 — client-side configuration validation guardrails**
   - Scope:
     - Add save-time validation in `ProjectConfigurationPanel` for malformed project configuration payloads.
     - Block save when hotkeys are duplicated/non-alphanumeric, defect colors are not hex, or part views reference unknown modalities.
     - Keep API contract unchanged and preserve existing progressive synthetic-user matrix.
   - Files:
     - `frontend/src/components/ProjectConfigurationPanel.js`
     - `frontend/src/components/__tests__/ProjectConfigurationPanel.test.js`
   - Tests:
     - `cd frontend && npm test -- --runInBand src/components/__tests__/ProjectConfigurationPanel.test.js`

## Remaining PR-11 backlog after this checkpoint

- Add richer field-level inline validation UX (save-time guardrails are now in place).
- Consider copy-configuration merge semantics if product chooses merge-overwrite behavior.
