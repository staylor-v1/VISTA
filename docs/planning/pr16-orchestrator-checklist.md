# PR-16 Orchestrator Living Checklist (2026-04-05)

## Current milestone
- **PR-16-M19**: clone semantic-value contract hardening for malformed successful clone payloads that contain blank identifiers/labels/names or non-hex defect colors.

## Files changed in this milestone
- `frontend/src/components/ProjectConfigurationPanel.js`
- `frontend/src/components/__tests__/ProjectConfigurationPanel.test.js`
- `docs/planning/feature-request-triage-2026-03-28.md`
- `docs/planning/orchestrator-session-handoff.md`
- `docs/planning/pr16-m19-replay-artifact.md`
- `docs/planning/pr16-orchestrator-checklist.md`

## Tests
- [x] `cd /workspace/VISTA/frontend && npm test -- --runInBand src/components/__tests__/ProjectConfigurationPanel.test.js`
- [x] `cd /workspace/VISTA/frontend && npx playwright test e2e/specs/inspection-workbench.spec.js --grep "PR-11 project configuration screenshot artifact"`

## Reviewer notes (edge cases / security / architecture)
- Clone success handling now enforces top-level, entry-level, scalar-field, settings-field, domain-enum, and hotkey-domain payload contracts for clone responses.
- Relational-integrity hardening prevents duplicate cloned modality/view IDs and unknown part-view modality references from silently hydrating and destabilizing downstream save/edit workflows.
- Semantic-value hardening now blocks clone payloads that pass type/domain/relational checks but still contain blank or invalid scalar content that violates save-time expectations.
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
- [x] `PR-16-M14` clone config scalar-field contract hardening.
- [x] `PR-16-M15` clone settings-field contract hardening.
- [x] `PR-16-M16` clone domain-enum contract hardening.
- [x] `PR-16-M17` clone hotkey-domain contract hardening.
- [x] `PR-16-M18` clone relational-integrity contract hardening.
- [x] `PR-16-M19` clone semantic-value contract hardening.
- [ ] `PR-16-M20+` pending explicit approval of next feature-request contract.

## Risks / blockers
- `browser_container` is unavailable in this execution environment; Playwright-based screenshot capture + analytics were used as fallback evidence.
