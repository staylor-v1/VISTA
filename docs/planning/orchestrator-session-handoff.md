# Orchestrator Session Handoff (Codex)

Use this playbook to run large migrations/refactors with disciplined role separation.

## Kickoff prompt for new sessions

Copy this into a new Codex chat session:

> Use `AGENTS.md` at repo root and run the Orchestrated Multi-Agent Workflow for this task.
> Start with Spec Writer output, then Planner milestones (with exact files), then implement milestone-by-milestone with tests after each milestone.
> Keep PR slicing flat: one submitted PR per function-level change by default (`PR-XX-M#` labels), and only split further when technically required.
> If ambiguities affect architecture or data contracts, ask clarifying questions first.

## Required execution format

For each milestone/PR slice:
1. **Spec delta** (what this slice changes)
2. **Files touched** (exact paths)
3. **Implementation** (small scoped diff)
4. **Tests executed** (commands + pass/fail)
5. **Reviewer notes** (edge/security/consistency)

## Done criteria

A task is done only when:
- milestone acceptance tests pass,
- full required test suite passes,
- reviewer checklist is complete,
- no unresolved high-severity risks remain.

## Suggested reviewer checklist

- Input validation and auth boundaries are preserved.
- No insecure defaults introduced.
- Backward compatibility or migration path is documented.
- Error handling and observability are adequate.
- Performance/latency impact is acceptable or measured.

## Active session pointer (2026-04-04)

- **Current completed PR slices:**
  - `PR-15-M1` — Start screen deletion governance hardening.
  - `PR-15-M2` — Configurable inspector hotkeys persistence.
  - `PR-15-M3` — Workspace-backed shortcut-help visibility persistence.
  - `PR-15-M4` — Workspace-backed normalization-triage persistence.
  - `PR-15-M5` — Workspace-backed inspector image-visibility persistence.
  - `PR-15-M6` — Workspace-backed inspector modality/view persistence hardening.
  - `PR-15-M7` — Workspace-backed inspector viewport-transform persistence hardening.
  - `PR-15-M8` — Workspace-backed inspector manual-measurement persistence hardening.
- **Delivered summary:**
  - Deletion governance is role-restricted with irreversible confirmation and stale-state-safe list refresh.
  - Inspector hotkeys are editable, validated, persisted, and runtime-synchronized.
  - Workspace persistence now strictly normalizes/helpfully hydrates shortcut-help visibility, normalization triage field, image visibility, modalities, and selected view.
  - Workspace persistence now also strictly normalizes inspector viewport transform (`zoom`, `panX`, `panY`) with bounded numeric ranges.
  - Workspace persistence now strictly normalizes `inspector.measurements` into durable `{id,label,value}` tuples, filtering malformed entries for cross-surface hydration safety.
- **Replay artifacts for clean incremental PRs:** `docs/planning/pr15-split-artifact.md`, `docs/planning/pr15-m8-replay-artifact.md`.

- **Artifact index for post-inspection clean PR submission:** `docs/planning/orchestrator-clean-replay-index-2026-04-04.md`.
- **Next scope boundary:** no open PR-15 slice; define `PR-15-M9+` only after approving additional Epic 7 preference contracts.
- **Required tests for next slice:** preserve green status for:
  - `uv run pytest -q backend/tests/test_inspection_workbench_router.py`,
  - `npm test -- --runInBand src/components/__tests__/InspectionWorkbenchPanel.test.js`,
  - broader frontend/backend suites when scope expands.

## Active follow-on pointer (2026-04-04, updated)

- **Current completed PR slices:**
  - `PR-16-M1` — project configuration cloning contract, source-project access enforcement, and PT1/PT2/PT3 synthetic progressive-user coverage.
  - `PR-16-M1a` — self-clone rejection guard (`source_project_id` must differ from route `project_id`) with dedicated cross-project-type regression tests.
- **Replay artifacts for clean incremental PR submission:** `docs/planning/pr16-split-artifact.md`, `docs/planning/pr16-m1-replay-artifact.md`.
- **Next scope boundary:** no open PR-16 slice; define `PR-16-M2+` only after explicit approval of the next feature contract.

## Session update (2026-04-04, closeout refresh)

- Re-validated open-slice status: no unfinished planned slices remain in `PR-15` or `PR-16`.
- Added post-inspection clean replay/submission artifact:
  - `docs/planning/orchestrator-post-inspection-pr-submission-artifact-2026-04-04.md`
- Required synthetic-user/project-type coverage remains satisfied by backend and frontend suites in this closeout pass.

## Session update (2026-04-04, implementation-session refresh)

- Re-ran required guardrail suites to confirm `PR-16-M1/M1a` remains green before any new scope admission:
  - `uv run pytest -q backend/tests/test_inspection_workbench_router.py`
  - `npm test -- --runInBand src/components/__tests__/InspectionWorkbenchPanel.test.js`
- Added execution artifact for clean incremental replay/submission after product inspection:
  - `docs/planning/orchestrator-next-pr-execution-artifact-2026-04-04.md`
- Next unimplemented slice remains **none** in approved scope; begin at `PR-16-M2+` only with explicit contract approval.


## Session update (2026-04-04, artifact-refresh)

- Re-checked active planned scope across handoff and triage docs: no unfinished planned PR slices remain.
- Added refreshed post-inspection clean replay/submission artifact:
  - `docs/planning/orchestrator-post-inspection-pr-submission-artifact-2026-04-04-v2.md`
- Required guardrail suites to preserve before replaying upstream PRs:
  - `uv run pytest -q backend/tests/test_inspection_workbench_router.py`
  - `npm test -- --runInBand src/components/__tests__/InspectionWorkbenchPanel.test.js`

## Session update (2026-04-04, unified-planning-refresh)

- Added a single consolidated PR-planning index for operators:
  - `docs/planning/orchestrator-unified-pr-planning-2026-04-04.md`
- Unified index covers replay status/order for `PR-07` through `PR-16` so planning is no longer fragmented across one or two series artifacts.
- Keep per-slice artifacts for implementation detail, but start orchestration/replay from the unified index.


## Session update (2026-04-04, PR-16-M2 frontend clone integration)

- Implemented `PR-16-M2`: Project Configuration copy flow now calls the clone API directly (`POST /api/projects/{project_id}/configuration/clone`) and hydrates returned config payload.
- Extended existing frontend RTL matrix coverage to validate clone endpoint usage for three synthetic users (`basic`, `intermediate`, `advanced`) across each project type (`PT1`, `PT2`, `PT3`).
- Added clean replay/submission artifact:
  - `docs/planning/pr16-m2-replay-artifact.md`
- Next unimplemented slice remains **none** in approved scope; begin at `PR-16-M3+` only with explicit contract approval.


## Session update (2026-04-04, next-unimplemented execution request)

- Reconfirmed there is no unfinished planned PR slice in approved scope (`PR-15` complete; `PR-16` complete through `PR-16-M2`).
- Added operator artifact for post-inspection replay order and living checklist state:
  - `docs/planning/orchestrator-next-unimplemented-pr-execution-2026-04-04.md`
- Enforcement remains: require explicit feature-contract approval before beginning `PR-16-M3+`.

## Session update (2026-04-04, PR-queue reconciliation refresh)

- Re-ran cross-doc queue reconciliation and confirmed no unfinished planned slices in approved scope (`PR-15` complete; `PR-16` complete through `PR-16-M2`).
- Produced execution artifact for post-inspection replay/submission and strict next-scope admission controls:
  - `docs/planning/orchestrator-next-pr-execution-artifact-2026-04-04-v2.md`
- Required guardrail suites re-validated in this refresh run:
  - `uv run pytest -q backend/tests/test_inspection_workbench_router.py`
  - `cd frontend && npm test -- --runInBand src/components/__tests__/InspectionWorkbenchPanel.test.js`
- `PR-16-M3+` remains contract-gated; no implicit carry-over scope is authorized.

## Session update (2026-04-04, PR-16-M3 start and delivery)

- Started and completed `PR-16-M3` after explicit operator direction to continue the next milestone.
- Delivered clone-type compatibility hardening:
  - Backend clone API now rejects cross-project-type clone attempts.
  - Frontend Project Configuration copy picker now lists only same-type source projects.
- Added/validated progressive synthetic-user coverage (`basic`, `intermediate`, `advanced`) across `PT1`/`PT2`/`PT3` for the new guard behavior.
- Replay/submission artifact:
  - `docs/planning/pr16-m3-replay-artifact.md`

## Session update (2026-04-04, PR-16-M4 planning-state reconciliation)

- Completed `PR-16-M4` documentation-scope reconciliation to align planning source-of-truth docs with delivered `PR-16-M3` state.
- Added clean replay/submission artifact:
  - `docs/planning/pr16-m4-replay-artifact.md`
- Guardrail verification for this slice preserved required project-configuration/backend coverage, including progressive synthetic users (`basic`, `intermediate`, `advanced`) across `PT1`/`PT2`/`PT3`.
- Next implementation boundary: open `PR-16-M5+` only after explicit feature-contract approval.

## Session update (2026-04-04, PR-16-M5 clone-source UX hardening + matrix correction)

- Started and completed `PR-16-M5` after explicit operator direction to run the next unimplemented PR slice.
- Delivered:
  - Project Configuration clone section now shows an explicit empty-state message and disables source selection when no same-type source projects are available.
  - Frontend test harness now varies current-project type correctly for each `PT1`/`PT2`/`PT3` loop, preserving progressive synthetic-user coverage (`basic`, `intermediate`, `advanced`) with stricter type-filter assertions.
- Replay/submission artifact:
  - `docs/planning/pr16-m5-replay-artifact.md`
- Next implementation boundary: open `PR-16-M6+` only after explicit feature-contract approval.


## Session update (2026-04-04, PR-16-M6 clone error-detail surfacing + stale-source hardening)

- Started and completed `PR-16-M6` after explicit operator direction to continue from the next unimplemented milestone.
- Delivered:
  - Clone failure UX now surfaces backend-provided `detail` messages for actionable remediation.
  - Copy-source state now clears stale selections when compatibility-filtered source options change.
  - Clone action is explicitly disabled when no compatible source projects are available.
- Progressive synthetic-user matrix coverage preserved (`basic`, `intermediate`, `advanced`) across `PT1`/`PT2`/`PT3` with clone-error rendering assertions.
- Replay/submission artifact:
  - `docs/planning/pr16-m6-replay-artifact.md`
- Next implementation boundary: open `PR-16-M7+` only after explicit feature-contract approval.

## Session update (2026-04-04, PR-16-M7 clone-feedback reset hardening)

- Started and completed `PR-16-M7` under explicit next-unimplemented-slice direction.
- Delivered:
  - Clone action now clears stale success/error alerts at clone start.
  - Changing clone source selection now clears prior alerts to prevent stale feedback carry-over.
- Progressive synthetic-user coverage preserved (`basic`, `intermediate`, `advanced`) across `PT1`/`PT2`/`PT3` with alert-reset assertions.
- Replay/submission artifact:
  - `docs/planning/pr16-m7-replay-artifact.md`
- Next implementation boundary: open `PR-16-M8+` only after explicit feature-contract approval.

## Session update (2026-04-04, PR-16-M8 clone in-flight submission hardening)

- Started and completed `PR-16-M8` under explicit next-unimplemented-slice direction.
- Delivered:
  - Copy configuration flow now keeps a dedicated in-flight state for clone requests.
  - Clone controls (source select + copy button) are disabled while clone API is in progress.
  - Copy button shows in-progress label (`Copying...`) and duplicate clone submissions are prevented.
- Progressive synthetic-user coverage preserved (`basic`, `intermediate`, `advanced`) across `PT1`/`PT2`/`PT3` with duplicate-submit prevention assertions.
- Replay/submission artifact:
  - `docs/planning/pr16-m8-replay-artifact.md`
- Next implementation boundary: open `PR-16-M9+` only after explicit feature-contract approval.

## Session update (2026-04-04, PR-16-M9 post-clone source reset hardening)

- Started and completed `PR-16-M9` under explicit next-unimplemented-slice direction.
- Delivered:
  - Successful clone now reports the specific source project name in success status.
  - Clone source selector resets to placeholder after success to avoid stale-intent repeat submissions.
- Progressive synthetic-user coverage preserved (`basic`, `intermediate`, `advanced`) across `PT1`/`PT2`/`PT3` with post-clone reset assertions.
- Replay/submission artifact:
  - `docs/planning/pr16-m9-replay-artifact.md`
- Next implementation boundary: open `PR-16-M10+` only after explicit feature-contract approval.
