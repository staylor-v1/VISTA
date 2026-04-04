# PR-16 Split Artifact (2026-04-04)

## Goal

Provide a deterministic replay plan for newly introduced planned work after PR-15 completion.

## Canonical PR order

1. `PR-16-M1` — Project configuration cloning API.
   - Add request/response schemas for clone operation.
   - Add `POST /api/projects/{project_id}/configuration/clone`.
   - Add progressive synthetic-user tests across PT1/PT2/PT3 and access-control guard tests.

## Verification commands

- `uv run pytest -q backend/tests/test_inspection_workbench_router.py -k project_configuration_clone`
- `uv run pytest -q backend/tests/test_inspection_workbench_router.py -k project_configuration`

## Notes

- Keep slices flat (`PR-16-M#`) and function-scoped.
- Additional PR-16 slices should only be added after explicit approval of the next feature-request contract.
