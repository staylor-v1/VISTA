# PR-15 Split Artifact (2026-04-04)

This artifact captures the combined implementation state for PR-15 milestone 1 step 1 and defines clean replay PR boundaries.

## Implemented incremental PR slice in this session

1. **PR-15 milestone 1 step 1 — Start screen deletion governance hardening**
   - Scope:
     - Role-gate project deletion affordance in dashboard UI using user group memberships.
     - Require explicit irreversible confirmation state (exact phrase + acknowledgment checkbox) before enabling destructive submit.
     - Refresh project list from backend after successful deletion to prevent stale local-state regressions.
     - Add progressive synthetic-user matrix coverage for PT1/PT2/PT3 authorized and unauthorized delete workflows.
   - Files:
     - `frontend/src/App.js`
     - `frontend/src/App.test.js`
     - `backend/tests/test_projects_router.py`
     - `docs/planning/feature-request-triage-2026-03-28.md`
     - `docs/planning/orchestrator-session-handoff.md`
     - `docs/planning/pr15-orchestrator-checklist.md`
     - `docs/planning/pr15-split-artifact.md`
   - Automated coverage:
     - `cd /workspace/VISTA && uv run pytest -q backend/tests/test_projects_router.py`
   - `cd /workspace/VISTA/frontend && npm test -- --runInBand src/App.test.js`
   - `cd /workspace/VISTA/frontend && npx playwright test e2e/specs/inspection-workbench.spec.js --grep "Inspection Workbench E2E"`

2. **PR-15 milestone 1 step 2 — Configurable inspector hotkeys persistence**
   - Scope:
     - Fix inspection workbench configuration hydration to consume backend `config` response contract.
     - Add hotkey editor controls in inspector workspace with uniqueness + single-character validation.
     - Persist hotkey bindings to project configuration endpoint and apply persisted bindings immediately to runtime shortcuts/help text.
     - Add PT1/PT2/PT3 progressive synthetic-user Jest coverage for invalid and valid hotkey-save workflows.
   - Files:
     - `frontend/src/components/InspectionWorkbenchPanel.js`
     - `frontend/src/components/__tests__/InspectionWorkbenchPanel.test.js`
     - `docs/planning/feature-request-triage-2026-03-28.md`
     - `docs/planning/orchestrator-session-handoff.md`
     - `docs/planning/pr15-orchestrator-checklist.md`
     - `docs/planning/pr15-split-artifact.md`
   - Automated coverage:
     - `cd /workspace/VISTA/frontend && npm test -- --runInBand src/components/__tests__/InspectionWorkbenchPanel.test.js`

3. **PR-15 milestone 1 step 3 (part 1) — Workspace-backed shortcut-help visibility persistence**
   - Scope:
     - Normalize workspace-state `inspector.shortcut_help_visible` as a strict boolean in backend router boundaries.
     - Hydrate inspection workbench shortcut-help panel visibility from workspace state.
     - Persist shortcut-help visibility changes in workspace autosave payloads.
     - Extend PT1/PT2/PT3 progressive synthetic-user backend + frontend tests for shortcut-help workspace persistence.
   - Files:
     - `backend/routers/inspection_workbench.py`
     - `backend/tests/test_inspection_workbench_router.py`
     - `frontend/src/components/InspectionWorkbenchPanel.js`
     - `frontend/src/components/__tests__/InspectionWorkbenchPanel.test.js`
     - `docs/planning/feature-request-triage-2026-03-28.md`
     - `docs/planning/orchestrator-session-handoff.md`
     - `docs/planning/pr15-orchestrator-checklist.md`
     - `docs/planning/pr15-split-artifact.md`
  - Automated coverage:
    - `cd /workspace/VISTA && uv run pytest -q backend/tests/test_inspection_workbench_router.py`
    - `cd /workspace/VISTA/frontend && npm test -- --runInBand src/components/__tests__/InspectionWorkbenchPanel.test.js`

4. **PR-15 milestone 1 step 3 (part 2 / step 1) — Workspace-backed normalization-triage persistence**
   - Scope:
     - Normalize workspace-state `inspector.normalization_triage_field` as a strict string in backend router boundaries.
     - Hydrate inspection workbench normalization triage filter from workspace state.
     - Persist normalization triage filter changes in workspace autosave payloads.
     - Extend PT1/PT2/PT3 progressive synthetic-user backend + frontend tests for normalization triage persistence semantics.
   - Files:
     - `backend/routers/inspection_workbench.py`
     - `backend/tests/test_inspection_workbench_router.py`
     - `frontend/src/components/InspectionWorkbenchPanel.js`
     - `frontend/src/components/__tests__/InspectionWorkbenchPanel.test.js`
     - `docs/planning/feature-request-triage-2026-03-28.md`
     - `docs/planning/orchestrator-session-handoff.md`
     - `docs/planning/pr15-orchestrator-checklist.md`
     - `docs/planning/pr15-split-artifact.md`
  - Automated coverage:
    - `cd /workspace/VISTA && uv run pytest -q backend/tests/test_inspection_workbench_router.py`
    - `cd /workspace/VISTA/frontend && npm test -- --runInBand src/components/__tests__/InspectionWorkbenchPanel.test.js`

5. **PR-15 milestone 1 step 3 (part 2 / step 2) — Workspace-backed inspector image-visibility persistence**
   - Scope:
     - Normalize workspace-state `inspector.image_enabled` as a strict boolean in backend router boundaries.
     - Hydrate inspection workbench image visibility toggle from workspace state using strict boolean semantics.
     - Persist image visibility changes in workspace autosave payloads.
     - Extend PT1/PT2/PT3 progressive synthetic-user backend + frontend tests for image visibility persistence semantics.
   - Files:
     - `backend/routers/inspection_workbench.py`
     - `backend/tests/test_inspection_workbench_router.py`
     - `frontend/src/components/InspectionWorkbenchPanel.js`
     - `frontend/src/components/__tests__/InspectionWorkbenchPanel.test.js`
     - `docs/planning/feature-request-triage-2026-03-28.md`
     - `docs/planning/orchestrator-session-handoff.md`
     - `docs/planning/pr15-orchestrator-checklist.md`
     - `docs/planning/pr15-split-artifact.md`
   - Automated coverage:
     - `cd /workspace/VISTA && uv run pytest -q backend/tests/test_inspection_workbench_router.py`
     - `cd /workspace/VISTA/frontend && npm test -- --runInBand src/components/__tests__/InspectionWorkbenchPanel.test.js`

## Clean incremental PR replay artifact

After validation of the combined app state, replay clean PRs in this order:

1. `PR-15-m1-step1` — Start screen deletion governance hardening.
2. `PR-15-m1-step2` — Configurable inspector hotkeys persistence.
3. `PR-15-m1-step3-part1` — Workspace-backed shortcut-help visibility persistence.
4. `PR-15-m1-step3-part2-step1` — Workspace-backed normalization-triage persistence.
5. `PR-15-m1-step3-part2-step2` — Workspace-backed inspector image-visibility persistence.

Replay PR requirements:
- keep diff focused to milestone scope only,
- include frontend + backend synthetic-user matrix evidence,
- include Playwright PT1/PT2/PT3 matrix run evidence,
- update `docs/planning/orchestrator-session-handoff.md` active session pointer.

## Remaining PR-15 backlog after this checkpoint

- Select and scope PR-15 milestone 1 step 3 from Epic 7 (`per-user workspace persistence` cross-surface rollout, additional configurable hotkey governance, or deletion-governance follow-on UX).
- Continue PR-15 milestone 1 step 3 with part 2 step 3+ for additional cross-surface workspace preferences.
