# PR-16-M20 Replay Artifact (clone defect-name uniqueness contract hardening)

## Scope

- Frontend clone payload contract hardening:
  - reject successful clone payloads that contain duplicate defect names (case-insensitive) before hydrating configuration state.
- Frontend regression coverage:
  - preserve progressive synthetic-user matrix (`basic`, `intermediate`, `advanced`) across `PT1`, `PT2`, and `PT3`.

## Files touched

- `frontend/src/components/ProjectConfigurationPanel.js`
- `frontend/src/components/__tests__/ProjectConfigurationPanel.test.js`
- `docs/planning/feature-request-triage-2026-03-28.md`
- `docs/planning/orchestrator-session-handoff.md`
- `docs/planning/pr16-orchestrator-checklist.md`
- `docs/planning/pr16-m20-replay-artifact.md`

## Required verification commands

1. `cd /workspace/VISTA/frontend && npm test -- --runInBand src/components/__tests__/ProjectConfigurationPanel.test.js`

## Replay order for clean upstream PR submission

1. Apply changes from this slice only (`PR-16-M20`).
2. Run required verification command.
3. Confirm project-configuration clone flow rejects duplicate defect names with explicit relational-contract error.
4. Submit as standalone PR with label `PR-16-M20`.
5. Continue only with explicit approval for `PR-16-M21+`.
