# PR-16-M6 Replay Artifact (2026-04-04)

## Slice label
- `PR-16-M6` — clone API error-detail surfacing and stale source-selection hardening.

## Scope
- Surface backend clone error `detail` messages in Project Configuration UI.
- Clear stale `copySourceProjectId` when compatible source list changes.
- Disable clone action if no compatible source projects exist.
- Preserve existing API routes and persistence schema.

## Spec delta
- **Current behavior (before):** clone failures always surfaced as generic HTTP status errors; previously selected source IDs could remain stale if source options changed.
- **Target behavior (after):** clone failures show backend-provided `detail` text when present; stale selected source IDs are reset and clone action is disabled when no compatible sources remain.
- **API contract delta:** none (existing `POST /api/projects/{project_id}/configuration/clone`).
- **Data model/migration:** none.
- **Backward compatibility:** full.

## Files touched
- `frontend/src/components/ProjectConfigurationPanel.js`
- `frontend/src/components/__tests__/ProjectConfigurationPanel.test.js`
- `docs/planning/feature-request-triage-2026-03-28.md`
- `docs/planning/orchestrator-session-handoff.md`
- `docs/planning/pr16-m6-replay-artifact.md`

## Replay steps
1. Harden copy-source state lifecycle in `ProjectConfigurationPanel` by clearing stale selected source IDs and tightening clone-button disabled conditions.
2. Update clone flow to parse API error payload and surface backend `detail` message.
3. Add progressive synthetic-user matrix test coverage validating clone-error detail rendering.
4. Run frontend + backend guardrail suites.

## Reviewer guardrails
- Confirm clone errors preserve backend detail context.
- Confirm stale source selections cannot trigger clone requests.
- Confirm matrix coverage remains intact for synthetic users (`basic`, `intermediate`, `advanced`) across project types (`PT1`, `PT2`, `PT3`).

## Living checklist
- [x] Milestone complete: `PR-16-M6`
- [x] Files changed scoped to clone flow hardening + tests + planning docs
- [x] Guardrail tests pass in existing frontend/backend frameworks
- [x] Remaining risk tracked: `PR-16-M7+` requires next explicit feature contract
