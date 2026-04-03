# PR-12 Orchestrator Living Checklist (2026-04-03)

## Current milestone
- **PR-12 milestone 4 / step 1**: backend bulk-ingest discrepancy counters and part-organization validation API baseline.

## Files changed in this step
- `backend/core/schemas.py`
- `backend/routers/inspection_workbench.py`
- `backend/tests/test_inspection_workbench_router.py`
- `docs/planning/pr12-orchestrator-checklist.md`
- `docs/planning/pr12-split-artifact.md`
- `docs/planning/inspection-workbench-pr-artifact.md`

## Tests
- [x] `cd backend && pytest -q tests/test_inspection_workbench_router.py -k ingest --maxfail=1`

## Remaining PR-12 milestones
- [x] Configurable hotkeys storage + validation and UI plumbing.
- [~] Configurable hotkeys runtime binding in inspector keyboard handlers (remaining follow-up is shared legacy compact-classification mapping convergence outside workbench scope).
- [~] Workspace-state hardening for panel open/resize/orientation persistence (backend normalization/clamping + frontend panel-layout controls landed; draggable interactions remain).
- [~] Ingest discrepancy counters/validation APIs and reportable discrepancy summaries (backend ingest baseline landed; frontend ingest UX + summary surfacing pending).
- [ ] Export bundle coverage for images/metadata/overlays/annotations + report options.
- [ ] Red-team / blue-team cross-type adversarial matrix (`PT1/PT2/PT3`) and governance closeout checklist.

## Risks / blockers
- Ingest baseline currently skips conflicting records and reports counters/discrepancies; explicit override/merge policy (e.g., reassignment across batches) still needs product-level decision.
- API currently targets project-part ingest records; image-object storage ingest orchestration remains a follow-up milestone.
