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

2. **PR-14 milestone 1 step 2 — E2E matrix coverage + screenshot analytics**
   - Scope:
     - Extend Playwright mocks with `GET /api/projects/{project_id}/report-json` telemetry payloads for progressive synthetic users.
     - Assert Project Data report mode behavior in the existing PT1/PT2/PT3 × (`basic`,`intermediate`,`advanced`) matrix.
     - Capture a runtime screenshot artifact for advanced telemetry state and document visual analytics output.
   - Files:
     - `frontend/e2e/fixtures/inspectionWorkbenchMocks.js`
     - `frontend/e2e/specs/inspection-workbench.spec.js`
     - `docs/planning/pr14-orchestrator-checklist.md`
     - `docs/planning/pr14-split-artifact.md`
     - `docs/planning/pr14-screenshot-analysis.md`
   - Automated coverage:
     - `npx playwright test e2e/specs/inspection-workbench.spec.js --grep "Inspection Workbench E2E"`
     - `npx playwright test e2e/specs/inspection-workbench.spec.js --grep "PR-14 report normalization screenshot artifact"`

## Remaining PR-14 backlog after this checkpoint

- Validate UX copy for discrepancy triage actions with product/design.
- Extend report telemetry banner into actionable triage filters/links that deep-link into dropped-metadata categories.

## Proposed incremental PR from this session (next slice)

3. **PR-14 milestone 2 step 1 — actionable discrepancy triage filters**
   - Scope:
     - Extend the report normalization telemetry banner with clickable field-level triage actions.
     - Apply an in-panel filter to part rows so operators can immediately locate parts with mixed metadata values.
     - Keep backend contracts unchanged (`GET /report-json` + existing `parts` payload).
   - Files:
     - `frontend/src/components/InspectionWorkbenchPanel.js`
     - `frontend/src/components/__tests__/InspectionWorkbenchPanel.test.js`
     - `frontend/e2e/fixtures/inspectionWorkbenchMocks.js`
     - `frontend/e2e/specs/inspection-workbench.spec.js`
     - `docs/planning/feature-request-triage-2026-03-28.md`
     - `docs/planning/orchestrator-session-handoff.md`
     - `docs/planning/pr14-orchestrator-checklist.md`
   - Automated coverage:
     - `cd frontend && npm test -- --runInBand src/components/__tests__/InspectionWorkbenchPanel.test.js`
     - `cd frontend && npx playwright test e2e/specs/inspection-workbench.spec.js --grep "Inspection Workbench E2E"`

4. **PR-14 milestone 2 step 2 — adversarial normalization hardening + filtered empty-state guidance**
   - Scope:
     - Normalize/report unknown normalization categories safely in telemetry chips without breaking triage actions.
     - Keep field-chip triage selectors stable for known fields while hardening generated ids for adversarial field names.
     - Add filtered empty-state guidance so operators know when triage matches exist but are hidden by current batch/defect filters.
     - Keep backend response contracts unchanged.
   - Files:
     - `frontend/src/components/InspectionWorkbenchPanel.js`
     - `frontend/src/components/__tests__/InspectionWorkbenchPanel.test.js`
     - `frontend/e2e/fixtures/inspectionWorkbenchMocks.js`
     - `frontend/e2e/specs/inspection-workbench.spec.js`
     - `docs/planning/feature-request-triage-2026-03-28.md`
     - `docs/planning/orchestrator-session-handoff.md`
     - `docs/planning/pr14-orchestrator-checklist.md`
     - `docs/planning/pr14-screenshot-analysis.md`

## Clean incremental PR replay artifact

After validation of the combined app state, replay clean PRs in this order:

1. `PR-14-m2-step1` — actionable discrepancy triage filters/links.
2. `PR-14-m2-step2` — adversarial normalization hardening + filtered empty-state guidance.

Each replay PR should include:
- focused diff for one milestone,
- matching Jest + Playwright evidence for PT matrix (`PT1/PT2/PT3`) and progressive synthetic users (`basic`,`intermediate`,`advanced`),
- updated living checklist pointer in `docs/planning/orchestrator-session-handoff.md`.
