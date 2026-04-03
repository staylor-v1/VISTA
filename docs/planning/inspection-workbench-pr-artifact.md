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
- [x] PR-07 implemented in current working branch.
- [x] PR-08 implemented in current working branch.
- [~] PR-09 in progress (milestone 1 landed: inspector modalities/quick-switch/measurement capture controls).
- [~] PR-10 in progress (milestone 1 started: backend annotation payload + audit metadata endpoints).
- [~] PR-11 in progress (milestone 1 started: backend project-configuration API baseline).
- [~] PR-12 in progress (milestone 1 started: delete-project governance API hardening baseline).

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

## PR-07 scope record (implemented)

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

### Milestone 3 — export bundle JSON summary baseline
- Added backend endpoint `GET /api/projects/{project_id}/export-bundle-json`.
- Export bundle summary currently includes project metadata plus aggregate counters for:
  - images (`total`, `total_bytes`),
  - parts (`total`),
  - annotations (`total` from part metadata),
  - overlays (`configured_layers`, `segmentation_runs` from part metadata),
  - measurements (`ai_runs` from part metadata).
- Added pytest API coverage in the existing export test suite for three progressive simulated users (`basic`, `intermediate`, `advanced`) across all project types (`PT1`, `PT2`, `PT3`) with progressively denser synthetic metadata workflows.

### Milestone 3 — step 2 (frontend summary action wiring)
- Added Project Data export action in `InspectionWorkbenchPanel`:
  - `Export Bundle Summary` button invokes `GET /api/projects/{project_id}/export-bundle-json`.
  - Shows loading text during request and success alert with image/annotation/segmentation summary counts.
  - Surfaces request failures with user-visible inline error message.
- Extended existing React Testing Library coverage to validate the new export action for three progressive simulated users (`basic`, `intermediate`, `advanced`) across all project types (`PT1`, `PT2`, `PT3`) while preserving existing workbench flows.

### Milestone 3 — step 3 (annotation records + discrepancy summaries)
- Expanded backend `GET /api/projects/{project_id}/export-bundle-json` payload to include explicit annotation records in addition to aggregate counters.
- Added per-part discrepancy summaries based on export metadata consistency checks:
  - missing overlay layers when segmentation runs exist,
  - incomplete annotation fields (`defect_class`/`modality`),
  - measurement runs missing `run_id`.
- Extended existing pytest export coverage to verify discrepancy summary behavior for progressive synthetic users (`basic`, `intermediate`, `advanced`) across all project types (`PT1`, `PT2`, `PT3`) while preserving prior aggregate assertions.

### Milestone 4 — step 1 (downloadable bundle archive baseline)
- Added backend endpoint `GET /api/projects/{project_id}/export-bundle` that returns a zip archive.
- Archive currently contains `export-manifest.json` with:
  - project identity/type metadata,
  - existing `bundle_summary` contract from `export-bundle-json`,
  - image reference records (`image_id`, `filename`, `object_storage_key`, `size_bytes`) for object-storage retrieval workflows.
- Added pytest API coverage in the existing export suite for three progressive simulated users (`basic`, `intermediate`, `advanced`) across all project types (`PT1`, `PT2`, `PT3`) validating zip delivery and manifest contract shape.

### Milestone 4 — step 2 (frontend archive action + cross-type E2E)
- Added Project Data export action in `InspectionWorkbenchPanel`:
  - `Prepare Export Archive` button invokes `GET /api/projects/{project_id}/export-bundle`.
  - Shows loading text during request and success alert with archive size/content-type metadata.
  - Surfaces request failures with a user-visible inline error message.
- Extended existing React Testing Library coverage to validate archive action behavior for three progressive simulated users (`basic`, `intermediate`, `advanced`) across all project types (`PT1`, `PT2`, `PT3`).
- Extended Playwright E2E fixtures/specs to validate bundle archive initiation and in-panel success state for all project types and simulated users.

### PR-08 — UI exposure foundation (project type selection + visibility)

### Milestone 1 — create-project project-type selection
- Added `Project Type` selector to the create-project modal with explicit choices for `PT1`, `PT2`, and `PT3`.
- Wired selected value into existing `POST /api/projects/` payload via `project_type`.
- Added automated RTL tests to cover three simulated users (`basic`, `intermediate`, `advanced`) for each project type (`PT1`, `PT2`, `PT3`) with progressive synthetic data.

### Milestone 2 — project-type visibility and smoke coverage
- Added project-type display to project dashboard cards and project detail metadata so workflow mode is visible before/after navigation.
- Added Playwright smoke coverage for PT1/PT2/PT3 entry points validating type visibility on dashboard and project detail pages.
- Preserved existing PT inspection workbench behavior and contracts without backend API changes.

### PR-09 — inspector modalities, overlays, and measurements
- Add inspector surface for per-view modality toggles and thumbnail quick-switching.
- Add zoom/pan interactions with synchronized controls and image on/off controls.
- Add measurement capture/display flows for part inspection workflows.
- Acceptance: component + E2E tests pass for PT1/PT2/PT3 with common-control assertions.

#### PR-09 milestone 1 (implemented in artifact branch)
- Added shared inspector controls across PT1/PT2/PT3 for:
  - modality toggles,
  - per-view quick-switch buttons,
  - image visibility toggle,
  - manual measurement capture list persisted through workspace-state payload.
- Extended existing React Testing Library + Playwright suites to assert these controls with three progressive synthetic users (`basic`, `intermediate`, `advanced`) for all project types.
- Screenshot is generated during E2E runs at `frontend/artifacts/pr09-inspector-modalities-measurements.png` and intentionally **not committed**; see `docs/planning/pr09-screenshot-analysis.md` for recorded UI analytics.

#### PR-09 milestone 2 (in progress in artifact branch)
- Added shared inspector viewport controls in `InspectionWorkbenchPanel` for all project types (`PT1`, `PT2`, `PT3`):
  - synchronized zoom controls (`Zoom +`, `Zoom -`, `Reset`),
  - pan controls (`↑`, `←`, `→`, `↓`),
  - explicit viewport state indicator (`Zoom x • Pan (x, y)`).
- Extended workbench workspace-state persistence to include `inspector.viewport_transform` for server-backed rehydration.
- Extended existing React Testing Library scenarios (three simulated users per project type) to assert:
  - viewport controls mutate state correctly,
  - PT2/PT3 MPR navigation assertions remain scoped to 3D pane controls.

### PR-10 — annotations + audit trail metadata
- Expand annotations to include defect class, modality, comment, disposition, measurements, bbox, hide/show.
- Preserve and display annotation timestamp + username in hover/details.
- Add review-status affordances in inspector/summary workflows.
- Acceptance: API + UI tests verify create/edit/hide/show + audit metadata rendering across project types.

#### PR-10 milestone 1 (implemented in artifact branch)
- Added inspection workbench backend annotation endpoints on part context:
  - `POST /api/projects/{project_id}/parts/{part_id}/annotations`
  - `GET /api/projects/{project_id}/parts/{part_id}/annotations`
  - `PATCH /api/projects/{project_id}/parts/{part_id}/annotations/{annotation_id}`
- Implemented unified annotation payload contract including:
  - `defect_class`, `modality`, `comment`, `disposition`, `measurements`, `bbox`, `hidden`.
  - audit metadata: `created_at`, `created_by`, `updated_at`, `updated_by`.
- Persisted annotations in part metadata (`metadata.annotations`) to avoid schema migration during this milestone.
- Added pytest API coverage in existing test suite for three simulated users (`basic`, `intermediate`, `advanced`) across all project types (`PT1`, `PT2`, `PT3`) verifying create/edit/hide/show and audit metadata.

#### PR-10 milestone 2 (implemented in artifact branch)
- Added inspection workbench frontend annotation controls with unified payload inputs (`defect_class`, `modality`, `comment`, `disposition`, `measurements`, `bbox`) and create action against existing PR-10 milestone-1 backend APIs.
- Added in-panel annotation audit rendering (`updated_by`, `updated_at`) plus hide/show toggles mapped to `PATCH /annotations/{annotation_id}`.
- Extended existing React Testing Library suite to validate three progressive simulated users (`basic`, `intermediate`, `advanced`) across all project types (`PT1`, `PT2`, `PT3`) for create + hide/show + audit metadata visibility.
- Added in-panel annotation edit workflow for existing records with save/cancel controls and PATCH updates for `defect_class`, `modality`, `comment`, and `disposition`.
- Extended existing React Testing Library coverage to verify annotation edit + save flows while preserving hide/show + audit metadata assertions across all project types and progressive synthetic user scenarios.

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

#### PR-11 milestone 1 (implemented in artifact branch)
- Added inspection workbench backend project-configuration endpoints:
  - `GET /api/projects/{project_id}/configuration`
  - `PUT /api/projects/{project_id}/configuration`
- Added migration-safe default configuration payload for existing projects with no persisted config metadata.
- Added strongly typed configuration schemas covering modalities, part views, defect types, process settings, and display settings.
- Added pytest API coverage in the existing test framework for three progressive simulated users (`basic`, `intermediate`, `advanced`) across all project types (`PT1`, `PT2`, `PT3`) to verify configuration read/write round-trip behavior.

### PR-12 — hardening + discrepancy workflows + governance closeout
- Add delete-project flow with restricted access + explicit warning confirmation UX (if not completed in PR-07).
- Finalize server-backed per-user workspace persistence for panel open/resize/orientation and inspector context.
- Finalize static hotkey listing UI and configurable hotkeys storage/validation across project types.
- Add high-volume ingest API ergonomics: counters, discrepancy detection, part-organization validation.
- Add export bundle coverage for images/metadata/overlays/annotations and PDF report options.
- Close gaps with cross-type red-team scenarios (PT1/PT2/PT3) and stabilize with blue-team fixes.
- Acceptance: end-to-end matrix with adversarial cases, authorization checks, performance sanity checks, and release checklist sign-off.

#### PR-12 milestone 1 (step 1 implemented in artifact branch)
- Added backend delete-project governance endpoint:
  - `DELETE /api/projects/{project_id}` with explicit confirmation payload.
- Enforced explicit warning confirmation phrase contract (`DELETE <project_name>`) to reduce accidental destructive operations.
- Enforced proxy-authentication-only boundary for delete-project flow (`require_proxy_user`), rejecting API-key authenticated requests.
- Added pytest coverage in the existing backend framework for three progressive synthetic users (`basic`, `intermediate`, `advanced`) across each project type (`PT1`, `PT2`, `PT3`) validating:
  - confirmation phrase mismatch rejection,
  - successful deletion with exact phrase,
  - API key auth rejection for governance boundary hardening.

#### PR-12 milestone 1 (step 2 implemented in artifact branch)
- Added dashboard delete-project warning UX with explicit typed confirmation phrase and destructive-action modal:
  - project card menu now includes `Delete`,
  - modal requires typed phrase `DELETE <project_name>`,
  - frontend calls existing governance endpoint `DELETE /api/projects/{project_id}` with `confirmation_phrase`.
- Added existing-framework frontend automation (`App.test.js`) for three progressive synthetic users (`basic`, `intermediate`, `advanced`) across each project type (`PT1`, `PT2`, `PT3`) validating:
  - wrong confirmation phrase surfaces backend error,
  - correct phrase successfully deletes and removes project card from UI.
- Artifact intent: this checkpoint commit can be cherry-picked as a clean PR focused strictly on PR-12 milestone-1 frontend governance UX while preserving previously landed backend policy constraints.

#### PR-12 milestone 2 (step 1 implemented in artifact branch)
- Added project-configuration schema support for configurable keyboard shortcuts in process settings:
  - `process_settings.configurable_hotkeys.accept_classification`
  - `process_settings.configurable_hotkeys.reject_classification`
  - `process_settings.configurable_hotkeys.toggle_shortcut_help`
- Added backend validation guardrails for configurable hotkeys:
  - all three bindings are required,
  - each binding must be a single alphanumeric key,
  - key assignments must be unique to avoid collisions.
- Added default configuration wiring so legacy projects receive migration-safe hotkey defaults (`a`, `r`, `h`) without schema migration.
- Added frontend Project Configuration editing controls for hotkey bindings and preserved existing save contract (`PUT /api/projects/{project_id}/configuration`).
- Extended existing automated coverage in current frameworks:
  - backend pytest: progressive synthetic users (`basic`, `intermediate`, `advanced`) across `PT1/PT2/PT3` for configuration round-trip + invalid hotkey rejection,
  - frontend RTL: progressive synthetic users across `PT1/PT2/PT3` for hotkey editing persistence.
  - Playwright screenshot smoke + visual analytics recorded in `docs/planning/pr12-hotkeys-screenshot-analysis.md` (runtime screenshot artifact intentionally not committed).

#### PR-12 milestone 2 (step 2 implemented in artifact branch)
- Added runtime workbench hotkey binding support by loading `process_settings.configurable_hotkeys` from project configuration during `InspectionWorkbenchPanel` initialization.
- Added keyboard handler behavior for configured keys:
  - accept hotkey => mark selected part as `pass`,
  - reject hotkey => mark selected part as `reject_pending`,
  - help hotkey => toggle shortcut-help panel visibility in the inspection header.
- Added guardrail logic so configured hotkeys are ignored while text-entry controls (`input`, `textarea`, `select`) are focused.
- Added visible hotkey-hint summary in the selected part header for discoverability.
- Extended existing React Testing Library coverage for progressive synthetic users (`basic`, `intermediate`, `advanced`) across all project types (`PT1`, `PT2`, `PT3`) to verify configured hotkeys trigger expected review transitions and help-panel visibility.

#### PR-11 milestone 2 (step 1 implemented in artifact branch)
- Added frontend **Project Configuration** tab in `Project` view so configuration workflows are first-class alongside `Inspection` and `Project Data`.
- Added `ProjectConfigurationPanel` with backend round-trip wiring to existing PR-11 milestone-1 APIs:
  - `GET /api/projects/{project_id}/configuration`
  - `PUT /api/projects/{project_id}/configuration`
  - copy-from-existing flow via project list + source configuration fetch.
- Added RTL automation in the existing test framework covering three simulated users (`basic`, `intermediate`, `advanced`) for each project type (`PT1`, `PT2`, `PT3`) with progressively complex synthetic configuration payloads.
- Artifact intent: this checkpoint commit is structured to be cherry-picked as the first clean frontend PR for PR-11 milestone-2 UI surface, with subsequent PRs reserved for deeper section editing UX and validation hardening.

#### PR-11 milestone 2 (step 2 implemented in artifact branch)
- Added first section-editing workflow in `ProjectConfigurationPanel` for defect taxonomy management:
  - add defect type rows,
  - inline edit for `name`, `color`, and `definition`,
  - remove defect type rows prior to save.
- Preserved existing configuration API contract (`PUT /api/projects/{project_id}/configuration`) while expanding editable surface area with minimal schema risk.
- Extended existing React Testing Library coverage with three progressive synthetic users (`basic`, `intermediate`, `advanced`) across all project types (`PT1`, `PT2`, `PT3`) to validate add/edit/remove workflows and persisted payload updates.

#### PR-11 milestone 2 (step 3 implemented in artifact branch)
- Added Playwright E2E coverage for Project Configuration workflows across all project types (`PT1`, `PT2`, `PT3`) and progressive synthetic users (`basic`, `intermediate`, `advanced`) validating:
  - configuration save after defect-type edits,
  - copy-from-existing-project workflow and UI rehydration,
  - persisted payload capture for both save and copy actions.
- Extended shared E2E fixture routing with project-configuration mocks (`GET/PUT /api/projects/{project_id}/configuration`) and deterministic source-project metadata to exercise copy flows.
- Generated runtime screenshot artifact (`frontend/artifacts/pr11-project-configuration.png`, intentionally not committed) and recorded visual analytics in `docs/planning/pr11-screenshot-analysis.md`.

#### PR-11 milestone 2 (step 4 implemented in artifact branch)
- Expanded `ProjectConfigurationPanel` section editing UX for image modalities:
  - add modality rows,
  - inline edit for modality `label` and `id`,
  - toggle `calibration_required` and `example_image_uploaded`,
  - remove modality rows before save.
- Preserved the existing configuration API contract (`PUT /api/projects/{project_id}/configuration`) and reused current payload shape without schema migration.
- Extended existing React Testing Library coverage for all project types (`PT1`, `PT2`, `PT3`) and progressive synthetic users (`basic`, `intermediate`, `advanced`) to validate modality add/edit/remove flows and persisted payload updates.
