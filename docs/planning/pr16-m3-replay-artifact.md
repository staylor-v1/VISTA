# PR-16-M3 Replay Artifact (2026-04-04)

## Slice label
- `PR-16-M3` — Project configuration clone type-compatibility hardening.

## Scope
- Enforce same `project_type` requirement in `POST /api/projects/{project_id}/configuration/clone`.
- Reduce invalid clone attempts in UI by filtering source-project options to matching project type.
- Preserve progressive synthetic-user + project-type matrix regression coverage.

## Spec delta
- **Current behavior:** clone API allowed cross-project-type cloning when access checks passed.
- **Target behavior:** clone API rejects cross-project-type cloning with explicit `400` contract error.
- **API contract delta:**
  - Endpoint unchanged: `POST /api/projects/{project_id}/configuration/clone`.
  - New validation rule: `source_project.project_type == target_project.project_type`.
  - New error detail:
    - `source_project_id must belong to a project with the same project_type as the target project`
- **Data model/migration:** none.
- **Backward compatibility:** additive validation hardening only; request/response schema shape is unchanged.

## Files touched
- `backend/routers/inspection_workbench.py`
- `backend/tests/test_inspection_workbench_router.py`
- `frontend/src/components/ProjectConfigurationPanel.js`
- `frontend/src/components/__tests__/ProjectConfigurationPanel.test.js`
- `docs/planning/feature-request-triage-2026-03-28.md`
- `docs/planning/orchestrator-session-handoff.md`
- `docs/planning/pr16-m3-replay-artifact.md`

## Replay steps
1. Apply backend clone guard enforcing same project type.
2. Add backend regression test covering cross-type rejection across PT1/PT2/PT3 x basic/intermediate/advanced synthetic users.
3. Apply frontend source-project filtering and explanatory helper text in Project Configuration copy workflow.
4. Add frontend regression test confirming cross-type project options are hidden from copy-source selector.
5. Run validation commands:
   - `uv run pytest -q backend/tests/test_inspection_workbench_router.py -k project_configuration_clone`
   - `cd frontend && npm test -- --runInBand src/components/__tests__/ProjectConfigurationPanel.test.js`

## Reviewer guardrails
- Ensure cross-type clones are rejected with a deterministic 400 error and no metadata write side-effects.
- Ensure UI filtering does not remove same-type project options and does not break successful clone flow.
- Ensure prior clone/self-clone/access-control tests remain green.

## Living checklist
- [x] Milestone complete: `PR-16-M3`
- [x] Backend + frontend clone hardening implemented
- [x] Synthetic-user/project-type regression coverage present
- [x] Replay instructions and guardrails documented
