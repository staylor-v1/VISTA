# Orchestrator Unified PR Planning (2026-04-04)

This document consolidates PR planning/replay status into one source so operators do not need to cross-reference multiple per-PR artifacts during post-inspection submission.

## 1) Unified status ledger

| Series | Planned slices | Status | Canonical slice artifacts |
|---|---|---|---|
| PR-07 | milestone slices for export bundle + frontend action + E2E matrix | Complete | `docs/planning/pr07-split-artifact.md` |
| PR-09 | shared inspector controls + viewport persistence E2E hardening | Complete | `docs/planning/pr09-orchestrator-checklist.md` |
| PR-10 | annotation edit workflow + selector hardening | Complete | `docs/planning/pr10-split-artifact.md` |
| PR-11 | project configuration editing + validation + copy flow checks | Complete | `docs/planning/pr11-split-artifact.md` |
| PR-12 | workspace/panel persistence + ingest baseline + discrepancy surfacing | Complete | `docs/planning/pr12-split-artifact.md` |
| PR-13 | export/report option controls + adversarial normalization | Complete | `docs/planning/pr13-split-artifact.md` |
| PR-14 | report telemetry UI + triage filtering + red/blue hardening | Complete | `docs/planning/pr14-split-artifact.md` |
| PR-15 | `PR-15-M1` through `PR-15-M8` | Complete | `docs/planning/pr15-split-artifact.md`, `docs/planning/pr15-m8-replay-artifact.md` |
| PR-16 | `PR-16-M1`, `PR-16-M1a` | Complete | `docs/planning/pr16-split-artifact.md`, `docs/planning/pr16-m1-replay-artifact.md` |

## 2) Single replay order (clean incremental upstream submission)

Submit in numeric order by series and slice:

1. PR-07 replay slices from `pr07-split-artifact.md`
2. PR-09 replay slice from `pr09-orchestrator-checklist.md`
3. PR-10 replay slices from `pr10-split-artifact.md`
4. PR-11 replay slices from `pr11-split-artifact.md`
5. PR-12 replay slices from `pr12-split-artifact.md`
6. PR-13 replay slices from `pr13-split-artifact.md`
7. PR-14 replay slices from `pr14-split-artifact.md`
8. `PR-15-M1` → `PR-15-M8`
9. `PR-16-M1`
10. `PR-16-M1a`

## 3) Acceptance gates before/after each replayed slice

Required commands:

- `uv run pytest -q backend/tests/test_inspection_workbench_router.py`
- `cd frontend && npm test -- --runInBand src/components/__tests__/InspectionWorkbenchPanel.test.js`

When replaying slices that touch export/report workflows, also run:

- `uv run pytest -q backend/tests/test_export.py`

When replaying slices that touch Project Configuration flows, also run:

- `cd frontend && npm test -- --runInBand src/components/__tests__/ProjectConfigurationPanel.test.js`

## 4) Scope/control policy

- Keep PR slicing flat and function/service scoped.
- Do not merge unrelated files in a replayed slice.
- `PR-16-M2+` is **not** open by default; start only with explicit approved feature contract.

## 5) Operator checklist

- [ ] Replay only one planned slice (or one split-artifact-defined slice group) at a time.
- [ ] Run required tests immediately after each replayed slice.
- [ ] Verify file list matches the slice artifact exactly.
- [ ] Confirm no scope drift before opening each upstream PR.
- [ ] Open PRs in the exact replay order listed above.

## 6) Consolidation note

This file is now the umbrella planning index for cross-series PR execution. Existing per-series docs remain as evidence and slice-level detail, but operators should start from this document for full-sequence planning.
