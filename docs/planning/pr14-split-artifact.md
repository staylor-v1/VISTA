# PR-14 Split Artifact (2026-04-04)

This artifact tracks the first incremental PR slice after PR-13 closeout.

## Proposed incremental PR from this session

1. **PR-14 milestone 1 step 1 — report normalization telemetry UI surface**
   - Scope:
     - Render dropped metadata normalization counters returned by `GET /api/projects/{project_id}/report-json`.
     - Keep existing report success summary intact.
     - Hide normalization banner when no dropped counters are present.
   - Files:
     - `frontend/src/components/InspectionWorkbenchPanel.js`
     - `frontend/src/components/__tests__/InspectionWorkbenchPanel.test.js`
     - `docs/planning/feature-request-triage-2026-03-28.md`
     - `docs/planning/orchestrator-session-handoff.md`
     - `docs/planning/pr14-orchestrator-checklist.md`
     - `docs/planning/pr14-split-artifact.md`
   - Automated coverage:
     - Existing frontend Jest/RTL framework:
       - progressive synthetic-user matrix (`basic`, `intermediate`, `advanced`) across `PT1`, `PT2`, `PT3`.
       - assertions for report mode success plus conditional normalization telemetry banner visibility.

## Remaining PR-14 backlog after this checkpoint

- Add Playwright E2E coverage and screenshot analytics for report telemetry banner states.
- Validate UX copy for discrepancy triage actions with product/design.
