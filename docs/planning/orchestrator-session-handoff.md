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
- **Delivered summary:**
  - Deletion governance is role-restricted with irreversible confirmation and stale-state-safe list refresh.
  - Inspector hotkeys are editable, validated, persisted, and runtime-synchronized.
  - Workspace persistence now strictly normalizes/helpfully hydrates shortcut-help visibility, normalization triage field, image visibility, modalities, and selected view.
- **Replay artifact for clean incremental PRs:** `docs/planning/pr15-split-artifact.md`.
- **Next scope boundary:** define `PR-15-M7` from Epic 7 for additional cross-surface workspace preferences.
- **Required tests for next slice:** preserve green status for:
  - `uv run pytest -q backend/tests/test_inspection_workbench_router.py`,
  - `npm test -- --runInBand src/components/__tests__/InspectionWorkbenchPanel.test.js`,
  - broader frontend/backend suites when scope expands.
