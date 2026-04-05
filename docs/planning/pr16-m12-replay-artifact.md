# PR-16-M12 Replay Artifact — Clone config-shape contract hardening (2026-04-05)

## Slice label

- `PR-16-M12` — clone config-shape contract hardening.

## Scope

- Reject successful clone payloads that include `config` but omit required top-level sections.
- Preserve existing clone endpoint request/response transport contract:
  - `POST /api/projects/{project_id}/configuration/clone`
  - request body `{ "source_project_id": "<id>" }`
- Prevent malformed clone payloads from causing render-time crashes in Project Configuration UI.

## Spec delta

- **Current behavior (before):** clone success only checked that `config` existed; malformed payloads like `{ config: {} }` could be accepted and break downstream rendering assumptions.
- **Target behavior (after):** clone success requires valid top-level config shape (`image_modalities`, `part_views`, `defect_types`, `process_settings`, `display_settings`); invalid shape surfaces an actionable error.
- **API contract delta:** none (same endpoint and request body).

## Files touched

- `frontend/src/components/ProjectConfigurationPanel.js`
- `frontend/src/components/__tests__/ProjectConfigurationPanel.test.js`
- `docs/planning/feature-request-triage-2026-03-28.md`
- `docs/planning/orchestrator-session-handoff.md`
- `docs/planning/pr16-orchestrator-checklist.md`
- `docs/planning/pr16-m12-replay-artifact.md`

## Implementation steps (clean replay)

1. Harden clone payload guard helper to validate top-level config shape before hydrating panel state.
2. Extend PT1/PT2/PT3 × basic/intermediate/advanced synthetic matrix with malformed-success clone payload assertions.
3. Update planning/handoff/checklist docs to reflect `PR-16-M12` delivery and next boundary.

## Test commands

- `cd /workspace/VISTA/frontend && npm test -- --runInBand src/components/__tests__/ProjectConfigurationPanel.test.js`

## Reviewer checkpoints

- Confirm malformed clone success payloads fail gracefully with explicit UI error text.
- Confirm standard successful clone path still displays source-aware success message and resets source selection.
- Confirm no backend contract changes were introduced.

## Post-inspection clean submission order

1. `PR-16-M12` (this slice) as a single commit.
2. Run required tests above before opening upstream PR.
3. Continue only with explicitly approved `PR-16-M13+` contract.
