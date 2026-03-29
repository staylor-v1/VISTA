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
8. **PR-08 — UI exposure foundation (project type selection + visibility)**
9. **PR-09 — inspector modalities, overlays, and measurements**
10. **PR-10 — annotations + audit trail metadata**
11. **PR-11 — project configuration surface (modalities/views/defect/process/display/copy-config)**
12. **PR-12 — hardening: discrepancy detection, regression/e2e matrix, governance closeout**

## Execution Log

- [x] PR-01 implemented in current working branch.
- [x] PR-02 implemented in current working branch.
- [x] PR-03 implemented in current working branch.
- [x] PR-04 implemented in current working branch.
- [x] PR-05 implemented in current working branch.
- [x] PR-06 implemented in current working branch.
- [~] PR-07 in progress (kept on original scope because implementation is already underway).
- [ ] PR-08 not started.
- [ ] PR-09 not started.
- [ ] PR-10 not started.
- [ ] PR-11 not started.
- [ ] PR-12 not started.

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

### Milestone 2 — preserve original PR-07 scope + handoff (updated)
- Keep PR-07 on the originally-started scope (`bulk ingest/export/report JSON + workspace persistence/governance`) to avoid churn mid-stream.
- Start the UI exposure foundation in PR-08 and treat PR-07 outputs as prerequisites for cross-type workflow rollout.

## Feature extension plan (new)

### PR-08 — UI exposure foundation (project type selection + visibility)
- Ensure every PT feature addition is discoverable in the product UI when shipped (no backend-only PT capability).
- Add project-type selector (`PT1`/`PT2`/`PT3`) to project creation UI, persisted through existing create-project API contract.
- Add project-type visibility in project list/detail surfaces so users can confirm active mode before entering workflows.
- Acceptance: create-project flow tests verify type selection and persisted type rendering; UI smoke coverage for PT1/PT2/PT3 entry points.

### PR-09 — inspector modalities, overlays, and measurements
- Add inspector surface for per-view modality toggles and thumbnail quick-switching.
- Add zoom/pan interactions with synchronized controls and image on/off controls.
- Add measurement capture/display flows for part inspection workflows.
- Acceptance: component + E2E tests pass for PT1/PT2/PT3 with common-control assertions.

### PR-10 — annotations + audit trail metadata
- Expand annotations to include defect class, modality, comment, disposition, measurements, bbox, hide/show.
- Preserve and display annotation timestamp + username in hover/details.
- Add review-status affordances in inspector/summary workflows.
- Acceptance: API + UI tests verify create/edit/hide/show + audit metadata rendering across project types.

### PR-11 — project configuration surface
- Add Project Configuration tab sections for:
  - image modalities (add/manage + example upload + calibration),
  - part views (manual/auto add + required modalities),
  - defect types (name/color/definition),
  - process settings checkboxes,
  - display settings/color maps,
  - copy configuration from existing project.
- Ensure project configuration options are available across project types unless explicitly constrained by product requirements.
- Acceptance: form/API round-trip tests plus migration-safe defaults for existing projects.

### PR-12 — hardening + discrepancy workflows + governance closeout
- Add delete-project flow with restricted access + explicit warning confirmation UX (if not completed in PR-07).
- Finalize server-backed per-user workspace persistence for panel open/resize/orientation and inspector context.
- Finalize static hotkey listing UI and configurable hotkeys storage/validation across project types.
- Add high-volume ingest API ergonomics: counters, discrepancy detection, part-organization validation.
- Add export bundle coverage for images/metadata/overlays/annotations and PDF report options.
- Close gaps with cross-type red-team scenarios (PT1/PT2/PT3) and stabilize with blue-team fixes.
- Acceptance: end-to-end matrix with adversarial cases, authorization checks, performance sanity checks, and release checklist sign-off.
