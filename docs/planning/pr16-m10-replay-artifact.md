# PR-16-M10 Replay Artifact (2026-04-05)

## Slice label

- `PR-16-M10` — clone error parsing hardening.

## Scope

- Prevent JSON parsing exceptions from leaking to users when clone API failures return non-JSON bodies.
- Preserve existing clone success flow, in-flight protections, and detail-first error surfacing semantics.

## Spec delta

- **Current behavior (before):** clone flow always attempted `response.json()`, so non-JSON error bodies could bubble parser exceptions into UI alerts.
- **Target behavior (after):** clone flow safely parses JSON when available and falls back to status-based errors when response body is not JSON.
- **API contract delta:** none (`POST /api/projects/{project_id}/configuration/clone` unchanged).
- **Data model delta:** none (no schema/state-shape changes).
- **Backward compatibility:** fully backward compatible; only improves failure-path resilience.

## Files touched

- `frontend/src/components/ProjectConfigurationPanel.js`
- `frontend/src/components/__tests__/ProjectConfigurationPanel.test.js`
- `docs/planning/feature-request-triage-2026-03-28.md`
- `docs/planning/orchestrator-session-handoff.md`
- `docs/planning/pr16-orchestrator-checklist.md`

## Milestone implementation notes

1. Added `parseJsonSafely(response)` helper to guard clone-response JSON parsing.
2. Updated clone handler to use guarded parser before detail/status message resolution.
3. Extended PT1/PT2/PT3 × basic/intermediate/advanced synthetic-user matrix with non-JSON clone-failure assertions.

## Acceptance tests

- `cd frontend && npm test -- --runInBand src/components/__tests__/ProjectConfigurationPanel.test.js`

## Reviewer checklist

- Verify clone endpoint payload remains `{ source_project_id }`.
- Verify detail-based backend errors continue to render when present.
- Verify non-JSON clone errors now render fallback status message (`Failed to copy project configuration (<status>)`) rather than parser text.
- Verify no regressions in in-flight lock behavior (`Copying...`) or post-success source reset behavior.

## Living checklist

- [x] Milestone complete: `PR-16-M10`
- [x] Files changed scoped to clone error parsing hardening + tests + planning docs
- [x] Acceptance tests green
- [x] Remaining risk tracked: `PR-16-M11+` requires next explicit feature contract
