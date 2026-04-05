# PR-16-M16 Replay Artifact (2026-04-05)

## Scope
- Milestone label: `PR-16-M16`
- Theme: clone configuration domain-enum contract hardening.
- Objective: reject clone success payloads that pass type checks but contain unsupported enum-backed domain values.

## Files
- `frontend/src/components/ProjectConfigurationPanel.js`
- `frontend/src/components/__tests__/ProjectConfigurationPanel.test.js`
- `docs/planning/feature-request-triage-2026-03-28.md`
- `docs/planning/orchestrator-session-handoff.md`
- `docs/planning/pr16-orchestrator-checklist.md`
- `docs/planning/pr16-m16-replay-artifact.md`

## Contract delta
- Clone success handler (`getCloneConfigOrThrow`) now enforces domain-safe enum values:
  - `part_views[].source` may only be absent, `manual`, or `auto`.
  - `display_settings.default_colormap` must be one of `grayscale|magma|viridis`.
  - `display_settings.anomaly_colormap` must be one of `grayscale|magma|viridis`.
- Invalid payloads now raise:
  - `Failed to copy project configuration (invalid config domain fields)`

## Test evidence
- Frontend matrix suite (existing framework, progressive synthetic users across project types):
  - `cd /workspace/VISTA/frontend && npm test -- --runInBand src/components/__tests__/ProjectConfigurationPanel.test.js`
- Playwright screenshot artifact workflow:
  - `cd /workspace/VISTA/frontend && npx playwright test e2e/specs/inspection-workbench.spec.js --grep "PR-09 inspector controls screenshot artifact"`

## Replay order
1. Apply `ProjectConfigurationPanel.js` domain-enum validation guard.
2. Apply `ProjectConfigurationPanel.test.js` malformed-domain clone-response regression coverage.
3. Re-run frontend matrix and Playwright screenshot commands above.
4. Update planning + handoff + checklist docs for `PR-16-M16` completion and next boundary.
