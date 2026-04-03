# PR-11 Orchestrator Checklist

## Current milestone
- **PR-11 milestone 2 / step 2**: frontend defect-type section editing workflow (add/edit/remove) in Project Configuration.

## Files changed in this step
- `frontend/src/components/ProjectConfigurationPanel.js`
- `frontend/src/components/__tests__/ProjectConfigurationPanel.test.js`
- `docs/planning/inspection-workbench-pr-artifact.md`
- `docs/planning/pr11-orchestrator-checklist.md`
- `docs/planning/pr11-screenshot-analysis.md`

## Tests
- [x] `cd frontend && npm test -- --runInBand src/components/__tests__/ProjectConfigurationPanel.test.js`
- [x] `cd frontend && npx playwright test e2e/specs/inspection-workbench.spec.js --grep "PR-09 inspector controls screenshot artifact"`

## Remaining PR-11 milestones
- [x] Add Project UI tab for **Project Configuration** with sectioned forms.
- [x] Wire frontend API integration for configuration load/save.
- [x] Add copy-configuration workflow from existing project.
- [~] Expand section editing UX/validation beyond defect types (modalities, part views, process/display guardrails).
- [ ] Add frontend E2E coverage for Project Configuration save/copy/edit flows across PT1/PT2/PT3 progressive synthetic users.

## Risks / blockers
- Copy-configuration semantics are currently full replacement; merge semantics still require product confirmation.
- Defect type inputs currently rely on backend validation errors for malformed values (no pre-submit client validation yet).
