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
- [x] PR-04 implemented in current working branch.
- [x] PR-05 implemented in current working branch.
- [x] PR-06 implemented in current working branch.
- [~] PR-07 in progress.

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

## PR-04 scope record (implemented)

### Milestone 1 — PT2/PT3 four-pane MPR shell + synchronized slice state
- Added PT2/PT3-specific MPR workbench shell in `InspectionWorkbenchPanel` with:
  - four-pane layout (axial, coronal, sagittal, 3D orientation),
  - per-axis slice controls,
  - synchronized locator text across all orthographic panes.
- Preserved PT1 behavior and external-view board for part-based angle views.
- Added automated component tests using existing React Testing Library framework for all project types (`PT1/PT2/PT3`) and three progressive synthetic user scenarios (`basic`, `intermediate`, `advanced`), including synchronized slice-state assertions for PT2/PT3.


### Milestone 2 — synchronized navigation overlays and viewport state
- Added lightweight spatial-locator previews in orthographic panes with color-coded intersection lines for plane awareness.
- Added synchronized viewport controls (`Zoom +/-`, `Pan`, `Reset`) shared across orthographic panes.
- Expanded Playwright E2E assertions to validate PT2/PT3 MPR shell rendering and synchronized zoom behavior.

## PR-05 scope record (implemented)

### Milestone 1 — overlay controls and contrast baseline
- Added PT2/PT3 overlay-layer toggles driven by part metadata (`overlay_layers`) with multi-select behavior.
- Added global MPR contrast control (`50-150%`) shared across orthographic panes.
- Added cursor probe controls and synchronized tooltip payload rendering base + overlay values in-workbench context.

### Milestone 2 — synthetic workflow coverage and artifact continuity
- Expanded existing React Testing Library coverage for three simulated users (`basic`, `intermediate`, `advanced`) across all project types (`PT1`, `PT2`, `PT3`) with progressive overlay complexity.
- Expanded Playwright fixture metadata and E2E assertions to validate PR-05 controls in PT2/PT3 while preserving PT1 behavior.

## PR-06 scope record (implemented)

### Milestone 1 — invoke segmentation and AI measurements in-context
- Added inspection workbench API endpoints:
  - `POST /api/projects/{project_id}/parts/{part_id}/segmentation-runs`
  - `POST /api/projects/{project_id}/parts/{part_id}/measurement-runs`
- Added backend persistence for run outputs in part metadata (`segmentation_runs`, `measurement_runs`) without schema migration.
- Added PT2/PT3 workbench controls:
  - **Run Segmentation** button using current slice context.
  - **Run AI Measurements** button using active overlay context.
  - In-context result summaries rendered directly inside the MPR controls panel.
- Added automated tests in existing frameworks:
  - Pytest API tests covering three simulated users (`basic`, `intermediate`, `advanced`) for each project type (`PT1`, `PT2`, `PT3`) with progressive synthetic complexity.
  - React Testing Library assertions for segmentation and measurement invocation/results in PT2/PT3 flows.
  - Playwright E2E assertions for invocation controls and in-context result rendering.


### Milestone 2 — persist and rehydrate ML invocation context in workbench
- Added PT2/PT3 workbench state rehydration from part metadata so the latest `segmentation_runs` and `measurement_runs` display immediately after part selection/reload.
- Extended existing React Testing Library suite to verify progressive synthetic users (`basic`, `intermediate`, `advanced`) across all project types (`PT1`, `PT2`, `PT3`) with persisted run summaries visible for non-basic scenarios before new invocations.
- Expanded Playwright E2E fixture/scenario coverage so each project type now exercises three simulated users (`basic`, `intermediate`, `advanced`) with progressively complex data and verifies persisted run summaries in PT2/PT3 before invoking new ML actions.

## PR-07 scope record (in progress)

### Milestone 1 — project-level JSON report export endpoint
- Added backend endpoint `GET /api/projects/{project_id}/report-json` in the export router.
- Report payload currently includes:
  - `project` identity and type metadata (`id`, `name`, `project_type`, `meta_group_id`),
  - `summary` counters (`total_images`, `total_batches`, `total_parts`, `reviewed_parts`, `unreviewed_parts`).
- Added API-level tests in the existing pytest export suite for three progressive simulated users (`basic`, `intermediate`, `advanced`) across all project types (`PT1`, `PT2`, `PT3`) with synthetic data.

### Milestone 2 — per-user server-backed workspace persistence
- Added inspection workbench endpoints:
  - `GET /api/projects/{project_id}/workspace-state`
  - `PUT /api/projects/{project_id}/workspace-state`
- Workspace state is persisted per-project and per-user via namespaced project metadata keys (`inspection_workbench.workspace_state:{user_email}`), avoiding schema migration while preserving access-control boundaries.
- Added frontend workbench rehydration + debounced persistence for shared controls (`batch`, `defect_filter`, `sort`, selected part) and PT2/PT3 MPR state (`slice_position`, `viewport_transform`, `contrast_percent`, overlays, cursor probe).
- Added automated tests in existing frameworks with three progressive synthetic users (`basic`, `intermediate`, `advanced`) for each project type (`PT1`, `PT2`, `PT3`):
  - Pytest API coverage for persistence/readback and per-user isolation.
  - React Testing Library assertions for persistence requests during sequential workflows.
  - Playwright assertions that persisted state API writes occur during end-to-end project data interactions.
