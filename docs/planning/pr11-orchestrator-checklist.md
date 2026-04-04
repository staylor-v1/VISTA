# PR-11 Orchestrator Checklist

## Current milestone
- **PR-11 milestone 2 / step 6**: add client-side Project Configuration validation guardrails (modalities/views/defect colors/hotkeys) before save across PT1/PT2/PT3 progressive synthetic users.

## Files changed in this step
- `frontend/src/components/ProjectConfigurationPanel.js`
- `frontend/src/components/__tests__/ProjectConfigurationPanel.test.js`
- `docs/planning/inspection-workbench-pr-artifact.md`
- `docs/planning/pr11-split-artifact.md`
- `docs/planning/pr11-orchestrator-checklist.md`
## Tests
- [x] `cd frontend && npm test -- --runInBand src/components/__tests__/ProjectConfigurationPanel.test.js`

## Remaining PR-11 milestones
- [x] Add Project UI tab for **Project Configuration** with sectioned forms.
- [x] Wire frontend API integration for configuration load/save.
- [x] Add copy-configuration workflow from existing project.
- [x] Expand section editing UX/validation beyond defect types, including client-side process/display guardrails for save-time validation.
- [x] Add frontend E2E coverage for Project Configuration save/copy/edit flows across PT1/PT2/PT3 progressive synthetic users.

## Risks / blockers
- Copy-configuration semantics are currently full replacement; merge semantics still require product confirmation.
- Validation currently blocks malformed hotkeys/colors/unknown modality references, but save-time errors are aggregated in one message; field-level inline error UX remains a follow-up refinement.
