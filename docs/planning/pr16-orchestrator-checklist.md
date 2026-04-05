# PR-16 Orchestrator Living Checklist (2026-04-05)

## Current milestone
- **PR-16-M13**: clone config-entry contract hardening for malformed successful clone collection members.

## Files changed in this milestone
- `frontend/src/components/ProjectConfigurationPanel.js`
- `frontend/src/components/__tests__/ProjectConfigurationPanel.test.js`
- `docs/planning/feature-request-triage-2026-03-28.md`
- `docs/planning/orchestrator-session-handoff.md`
- `docs/planning/pr16-m13-replay-artifact.md`
- `docs/planning/pr16-orchestrator-checklist.md`

## Tests
- [x] `cd /workspace/VISTA/frontend && npm test -- --runInBand src/components/__tests__/ProjectConfigurationPanel.test.js`

## Reviewer notes (edge cases / security / architecture)
- Clone success handling now enforces both top-level and entry-level payload contracts for clone responses.
- Entry-level contract hardening prevents render-time crashes from malformed array members (for example non-object `defect_types` or non-array `part_views.required_modalities`).
- Existing clone API contract remains unchanged (`POST /api/projects/{project_id}/configuration/clone` with `{ source_project_id }`).
- UI continues to surface backend-provided `detail` when available and falls back to explicit contract errors when success payload shape is invalid.

## Remaining PR-16 milestones
- [x] `PR-16-M1` configuration clone API baseline.
- [x] `PR-16-M1a` self-clone guard.
- [x] `PR-16-M2` frontend clone API integration.
- [x] `PR-16-M3` clone source/target project-type compatibility enforcement.
- [x] `PR-16-M4` planning-state reconciliation.
- [x] `PR-16-M5` clone-source empty-state UX hardening.
- [x] `PR-16-M6` clone error detail surfacing + stale-source reset.
- [x] `PR-16-M7` clone feedback reset hardening.
- [x] `PR-16-M8` clone in-flight submission hardening.
- [x] `PR-16-M9` post-clone source reset hardening.
- [x] `PR-16-M10` clone error parsing hardening.
- [x] `PR-16-M11` clone success payload contract hardening.
- [x] `PR-16-M12` clone config-shape contract hardening.
- [x] `PR-16-M13` clone config-entry contract hardening.
- [ ] `PR-16-M14+` pending explicit approval of next feature-request contract.

## Risks / blockers
- Browser-based screenshot/visual analytics tooling (`browser_container`) is unavailable in this execution environment, so visual screenshot analysis remains blocked for this slice.
