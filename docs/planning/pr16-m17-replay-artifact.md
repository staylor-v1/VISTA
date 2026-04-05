# PR-16-M17 Replay Artifact (2026-04-05)

## Scope
- Milestone label: `PR-16-M17`
- Theme: clone configuration hotkey-domain contract hardening.
- Objective: reject clone success payloads that pass type checks but contain invalid hotkey semantics.

## Files
- `frontend/src/components/ProjectConfigurationPanel.js`
- `frontend/src/components/__tests__/ProjectConfigurationPanel.test.js`
- `docs/planning/feature-request-triage-2026-03-28.md`
- `docs/planning/orchestrator-session-handoff.md`
- `docs/planning/pr16-orchestrator-checklist.md`
- `docs/planning/pr16-m17-replay-artifact.md`

## Contract delta
- Clone success handler (`getCloneConfigOrThrow`) now enforces hotkey-domain constraints:
  - `accept_classification`, `reject_classification`, and `toggle_shortcut_help` must each be a single alphanumeric key.
  - hotkey assignments must be unique across all three bindings.
- Invalid payloads now raise:
  - `Failed to copy project configuration (invalid config hotkey domain fields)`

## Test evidence
- Frontend matrix suite (existing framework, progressive synthetic users across project types):
  - `cd /workspace/VISTA/frontend && npm test -- --runInBand src/components/__tests__/ProjectConfigurationPanel.test.js`

## Replay order
1. Apply `ProjectConfigurationPanel.js` hotkey-domain validation guard in clone success handling.
2. Apply `ProjectConfigurationPanel.test.js` malformed-hotkey clone-response regression coverage.
3. Re-run frontend matrix command above.
4. Update planning + handoff + checklist docs for `PR-16-M17` completion and next boundary.
