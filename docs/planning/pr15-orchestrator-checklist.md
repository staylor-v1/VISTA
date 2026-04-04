# PR-15 Orchestrator Living Checklist (2026-04-04)

## Current milestone
- **PR-15 milestone 1 / step 2**: Configurable inspector hotkeys UX + server-backed configuration persistence.

## Files changed in this step
- `frontend/src/components/InspectionWorkbenchPanel.js`
- `frontend/src/components/__tests__/InspectionWorkbenchPanel.test.js`
- `docs/planning/feature-request-triage-2026-03-28.md`
- `docs/planning/orchestrator-session-handoff.md`
- `docs/planning/pr15-orchestrator-checklist.md`
- `docs/planning/pr15-split-artifact.md`

## Tests
- [x] `cd /workspace/VISTA/frontend && npm test -- --runInBand src/components/__tests__/InspectionWorkbenchPanel.test.js`

## Reviewer notes (edge cases / security / architecture)
- Hotkey save validates single-character alphanumeric input and uniqueness before making network requests, reducing malformed configuration payloads.
- Server remains source of truth via schema validation on `/configuration`; frontend validation is additive and fail-fast.
- Runtime keyboard listeners are updated only from persisted (normalized) config response, reducing state drift between displayed hints and active bindings.

## Remaining PR-15 milestones
- [ ] Define PR-15 milestone 1 step 3 scope (Epic 7 follow-on).
- [ ] Preserve delete-governance + workspace/configuration synthetic test matrices while extending scope.

## Risks / blockers
- Hotkey configuration save currently scopes to inspection workbench; dashboard/start-screen hotkey customization remains out of scope.
