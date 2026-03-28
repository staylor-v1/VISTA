# Inspection Workbench Incremental PR Artifact (2026-03-28)

This file is the execution artifact for the orchestrated migration so the combined implementation can later be split into clean incremental PRs.

## Planned PR Stack

1. **PR-01 — Project-type scaffolding (`PT1/PT2/PT3`)**
   - Add `project_type` to backend project model, API schemas, and migration.
   - Add automated tests covering three simulated users per project type with synthetic progressive workflows.
2. **PR-02 — PT1 batch/part/SN domain model**
3. **PR-03 — PT1 view-board + part-level workflow UI**
4. **PR-04 — PT2/PT3 four-pane MPR shell and synchronized slice state**
5. **PR-05 — overlay layering + tooltip values + contrast controls**
6. **PR-06 — segmentation/AI measurement invocation + in-context results**
7. **PR-07 — bulk ingest/export/report JSON + workspace persistence/governance**

## Execution Log

- [x] PR-01 implemented in current working branch.
- [x] PR-02 implemented in current working branch.
- [x] PR-03 implemented in current working branch.
- [ ] PR-04 pending.
- [ ] PR-05 pending.
- [ ] PR-06 pending.
- [ ] PR-07 pending.

## PR-02 scope record (implemented)

- Added backend `inspection_batches` and `inspection_parts` domain entities with uniqueness/index constraints.
- Added project-scoped API endpoints:
  - `POST /api/projects/{project_id}/batches`
  - `GET /api/projects/{project_id}/batches`
  - `POST /api/projects/{project_id}/parts`
  - `GET /api/projects/{project_id}/parts`
- Added automated tests with three simulated users per project type (`PT1`, `PT2`, `PT3`) and progressively complex synthetic workflows.

## Split Guidance

When preparing upstream PRs:
- Cherry-pick PR-01 commit first.
- Keep each PR constrained to one milestone and its matching tests.
- Do not mix schema migrations from different milestones in one PR.

## PR-03 scope record (implemented)

### Milestone 1 — Project Data tab shell
- Added project-level tabs (`Inspection`, `Project Data`) in `Project` view.
- Added `InspectionWorkbenchPanel` component that:
  - fetches `/batches` + `/parts` for project,
  - shows counts and review-state badges,
  - supports client-side filter by batch.
- Added automated tests that simulate three users with progressively complex synthetic workflows for each project type (`PT1`, `PT2`, `PT3`).

### Milestone 2 — PT1 view-board + part workflow controls
- Added part detail panel with configurable external view board shell (front/back/left/right/top/bottom or metadata-driven subset).
- Added defect-centric filtering (`all`, `has defects`, `critical only`) and sorting (`defect count`, `serial`).
- Added part-level review actions and persisted review-state updates through `PATCH /api/projects/{project_id}/parts/{part_id}`.
- Added full Playwright E2E test-suite layout (`playwright.config.js`, `e2e/specs`, `e2e/fixtures`) covering `PT1/PT2/PT3` workbench flows and screenshot capture to `frontend/artifacts/pr03-workbench.png` (runtime artifact, not committed as binary).
