# PR-09 Orchestrator Living Checklist (2026-04-04)

## Current milestone
- **PR-09 milestone 2 / step 2**: E2E hardening for shared inspector viewport controls and persisted workspace-state viewport contract.

## Files changed in this step
- `frontend/e2e/specs/inspection-workbench.spec.js`
- `docs/planning/inspection-workbench-pr-artifact.md`
- `docs/planning/pr09-orchestrator-checklist.md`

## Tests
- [x] `cd frontend && npx playwright test e2e/specs/inspection-workbench.spec.js --grep "Inspection Workbench E2E"`

## Remaining PR-09 milestones
- [x] Shared inspector modalities/quick-switch/image visibility/measurement capture controls across PT1/PT2/PT3.
- [x] Shared inspector viewport controls (`Zoom`, `Pan`, `Reset`) with visible state readout.
- [x] Component + E2E assertions for common inspector controls and workspace-state continuity.

## Risks / blockers
- Playwright assertions validate viewport state text and persisted payload shape, but do not pixel-validate transformed imagery because image rendering is mock-driven in this test harness.
