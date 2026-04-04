# PR-16-M1 Replay Artifact (2026-04-04)

## Scope

Finalize the planned project-configuration clone slice with explicit edge-case guardrails and deterministic tests.

## Canonical clean PR sequence

1. **PR-16-M1** — Project configuration clone API contract and baseline coverage.
   - Endpoint: `POST /api/projects/{project_id}/configuration/clone`.
   - Request schema: `{ "source_project_id": "<uuid>" }`.
   - Enforce access control on both target and source projects.
   - Validate clone behavior using progressive synthetic users across PT1/PT2/PT3.

2. **PR-16-M1a** — Self-clone guard hardening.
   - Reject same-project clone attempts with `400 Bad Request`.
   - Error detail: `source_project_id must be different from project_id`.
   - Add PT1/PT2/PT3 regression test coverage for this validation.

## Verification commands

- `uv run pytest -q backend/tests/test_inspection_workbench_router.py -k project_configuration_clone`
- `uv run pytest -q backend/tests/test_inspection_workbench_router.py -k project_configuration`

## Notes

- Keep replay slices flat and function-scoped for clean cherry-picks.
- Do not introduce `PR-16-M2+` without explicit approval of a new feature contract.
