# Vista Testing Strategy

Vista's tests are organized as a layered, efficient pyramid: deterministic unit tests at the base, API/router integration tests in the middle, and a small set of Playwright end-to-end tests for user-critical workflows.

## Test commands

| Layer | Command | Purpose |
| --- | --- | --- |
| Backend smoke | `pytest -q -m smoke` | Runs representative authentication, project, upload, grouping, inspection, analysis, export, and deletion workflows in seconds. |
| Backend unit and API integration | `./test/backend_tests.sh` | Runs FastAPI router, CRUD, model/schema, cache, security, export, metadata, and analysis toolbox tests with a fixed worker count. |
| PostgreSQL integration | `cd backend && VISTA_POSTGRES_TEST_DATABASE_URL=postgresql+asyncpg://user:pass@localhost/vista_test python -m pytest -q -m postgres -n 0 tests/postgres` | Runs Alembic, native server-default/timezone, transactional, proxy-auth, and deletion-audit contracts serially against a disposable PostgreSQL database. |
| Backend scheduled load | `cd backend && python -m pytest -q -m load -n 0 tests/load` | Runs high-volume ingest/list contracts serially outside the pull-request feedback loop. |
| Frontend unit/component | `./test/frontend_tests.sh` | Runs React Testing Library/Jest tests once in-band plus the custom test runner. |
| Frontend end-to-end | `cd frontend && npm run test:e2e` | Runs Playwright workflows against the React app with network mocks. |
| Frontend all | `cd frontend && npm run test:ci` | Runs the frontend unit suite followed by Playwright E2E tests. |

## User-story coverage matrix

| Vista user story | Primary unit/API coverage | End-to-end coverage |
| --- | --- | --- |
| Create, list, archive, and summarize projects | `backend/tests/test_projects_router.py`, `backend/tests/test_project_dashboard_counts.py`, `frontend/src/__tests__/Project.test.js`, `frontend/src/App.test.js` | `frontend/e2e/specs/full-inspection-workflow.spec.js` |
| Upload, browse, group, and delete images | `backend/tests/test_images_router.py`, `backend/tests/test_image_deletion.py`, `backend/tests/test_groups.py`, `frontend/src/components/__tests__/ImageUploader.test.js`, `frontend/src/components/__tests__/ImageGallery.test.js`, `frontend/src/components/__tests__/GroupedImagesPage.test.js` | `frontend/e2e/specs/full-inspection-workflow.spec.js` |
| Inspect images and preserve visual measurement accuracy | `backend/tests/test_reviews.py`, `frontend/src/__tests__/ImageView.measurements.test.js`, `frontend/src/components/__tests__/MeasurementAccuracy.test.js`, `frontend/src/components/__tests__/MeasurementTool.test.js` | `frontend/e2e/specs/inspection-workbench.spec.js` |
| Run analysis overlays and segmentation workflows | `backend/tests/test_analyze_router.py`, `backend/tests/test_analyze_toolbox_contract.py`, `backend/tests/test_segmentation_integrations.py`, `frontend/src/components/__tests__/AnalyzeWorkbenchTab.test.js`, `frontend/src/components/__tests__/OverlaysTab.test.js` | `frontend/e2e/specs/overlays-autoassign.spec.js` |
| Manage metadata, calibration, exports, and reports | `backend/tests/test_project_metadata_crud.py`, `backend/tests/test_images_metadata_endpoints.py`, `backend/tests/test_export.py`, `frontend/src/components/__tests__/ProjectDataMetadataTab.test.js`, `frontend/src/components/__tests__/ProjectDataExportPanel.test.js`, `frontend/src/components/__tests__/CalibrationManager.test.js` | `frontend/e2e/specs/full-inspection-workflow.spec.js` |
| Authenticate users, groups, and API keys securely | `backend/tests/test_auth_system.py`, `backend/tests/test_unified_auth.py`, `backend/tests/test_groups_auth.py`, `backend/tests/test_api_keys.py`, `backend/tests/test_security_headers.py` | Covered through mocked authorized workflows in Playwright specs. |
| Recover from cache, config, and storage edge cases | `backend/tests/test_cache_manager.py`, `backend/tests/test_cache_limits.py`, `backend/tests/test_config.py`, `backend/tests/test_boto3_client_utils.py`, `backend/tests/test_volume_loader.py`, `frontend/src/utils/__tests__/serviceDiagnostics.test.js` | Not E2E by design; these are faster and more deterministic as unit/API tests. |

## Test design principles

1. Prefer unit tests for pure parsing, serialization, metadata-key, and state-transition logic.
2. Prefer backend API tests for authorization boundaries, validation failures, persistence side effects, cache invalidation, and file-storage behaviors.
3. Prefer frontend component tests for user-visible states, form validation, keyboard/pointer interactions, and API failure rendering.
4. Keep Playwright specs focused on high-value journeys only: project setup, inspection workbench, overlay assignment, upload-to-report flow, and failure recovery that must be validated in a real browser.
5. Every new bug fix should add the lowest-layer regression test that would have caught it; only add E2E coverage when browser integration is the risk.
6. Keep the `smoke` marker on representative existing workflows rather than maintaining a duplicate smoke-only implementation.

## PostgreSQL integration lane

The normal backend runner always selects `not postgres and not load`, so its
fast SQLite fixtures remain isolated from opt-in database and high-volume
lanes. PostgreSQL tests live under `backend/tests/postgres/`, carry the
registered `postgres` marker, use a separate async engine and FastAPI `get_db`
override, and are always run serially.

Set `VISTA_POSTGRES_TEST_DATABASE_URL` to an explicitly disposable database to
opt in. As a destructive-operation guard, its database name must start with
`test_` or end with `_test`; generic databases such as `postgres` and the
PostgreSQL templates are rejected. Without the variable, direct collection of
the lane skips cleanly. The fixture upgrades that database with Alembic and
truncates application tables between tests; it must never use
`Base.metadata.create_all`. CI additionally proves the incremental
`20260428_0008` to `head` upgrade before running the contracts with
`DEBUG=false`, `SKIP_HEADER_CHECK=false`, and a proxy shared secret.

## Project-type and scheduled-load contracts

PT1/PT2/PT3 API coverage is matrixed only where the project type changes the
contract: generated defect names, configuration-clone compatibility, and the
PT3-only volume-reconstruction boundary. Progressive workflow tests use one
representative project type so user-complexity scenarios do not multiply
identical API behavior.

High-volume tests live under `backend/tests/load/` and carry the registered
`load` marker. The normal backend runner selects
`not postgres and not load`; run the load lane explicitly and serially on a
schedule. The initial contract ingests and lists 1,000 uniquely encoded images
so dropped, duplicated, or misnamed records are detectable.

## Security scan gates

The security workflow always publishes scanner output before enforcing its
result. Trivy gates all fixed and unfixed HIGH/CRITICAL container findings.
Safety gates known vulnerabilities in the locked runtime dependency export.
Bandit scans production backend code at MEDIUM-or-higher severity and
confidence, while Semgrep gates WARNING/ERROR findings from its security-audit
ruleset. Scanner releases are pinned exactly so CI policy cannot drift between
runs. A missing scanner status is itself a failure, and JSON, logs, status files,
and SARIF remain available as workflow artifacts when a gate fails.

## Red-team robustness checklist

Use this checklist when adding or refactoring tests:

- Empty projects, empty image groups, and missing optional metadata.
- Malformed image IDs, path traversal attempts, and unsupported file types.
- API 401/403/404/409/422/500 responses surfaced as actionable UI states.
- Rapid repeated clicks, interrupted uploads, stale cache entries, and deleted resources reopened from history.
- Large metadata payloads, unusual Unicode filenames, duplicate names, and mixed project types.
- Browser viewport changes, splitter resizing, keyboard-only operation, and focus restoration after modals.

## Done criteria for test refactors

A test refactor is complete only when:

- Locked dependencies are installed before testing with `uv sync --frozen --group dev` and `cd frontend && npm ci`; test commands never install dependencies.
- Backend tests pass with `./test/backend_tests.sh`.
- Frontend unit tests pass with `./test/frontend_tests.sh`.
- Playwright tests either pass with `npm run test:e2e` or have a documented environment blocker such as missing system browser dependencies.
- Any new test helpers are shared rather than duplicated and do not hide unexpected console errors.
