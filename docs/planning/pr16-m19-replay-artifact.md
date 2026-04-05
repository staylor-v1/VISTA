# PR-16-M19 Replay Artifact (clone semantic-value contract hardening)

Date: 2026-04-05

## Scope

- Theme: clone semantic-value contract hardening.
- Primary objective: reject malformed successful clone payloads whose scalar values are technically typed but semantically invalid.

## Files changed

- `frontend/src/components/ProjectConfigurationPanel.js`
- `frontend/src/components/__tests__/ProjectConfigurationPanel.test.js`
- `docs/planning/feature-request-triage-2026-03-28.md`
- `docs/planning/orchestrator-session-handoff.md`
- `docs/planning/pr16-orchestrator-checklist.md`
- `docs/planning/pr16-m19-replay-artifact.md`

## Functional delta

- Added semantic scalar validation in clone success payload handling before cloned config hydration.
- New validation rejects clone payloads when any of the following are present:
  - blank image modality IDs or labels,
  - blank part view IDs or labels,
  - blank required modality references in part views,
  - blank defect names,
  - non-hex defect colors.
- Failure path emits explicit contract error: `Failed to copy project configuration (invalid config semantic fields)`.

## Tests run

1. `cd /workspace/VISTA/frontend && npm test -- --runInBand src/components/__tests__/ProjectConfigurationPanel.test.js`
2. `cd /workspace/VISTA/frontend && npx playwright test e2e/specs/inspection-workbench.spec.js --grep "PR-11 project configuration screenshot artifact"`

## Replay order

1. Apply code and tests from this slice.
2. Run required frontend suite command listed above.
3. Run targeted Playwright smoke command listed above.
4. Update planning docs/checklist and preserve artifact references.
5. Continue only with explicit approval for `PR-16-M20+`.
