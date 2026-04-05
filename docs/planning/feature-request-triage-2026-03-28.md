# Feature Request Triage & Development Plan (2026-03-28)

This plan consolidates the original feature-request list plus the additional PT1/PT2/PT3 requirements.

## User Modes / Project Types

- **PT1**: Multiple external images of the same part (same Serial Number / SN) from different angles.
- **PT2**: 2D slices from a 3D scan per part.
- **PT3**: 2D slices from a 3D scan per part (same viewer needs as PT2).

## Current-State Triage

## 1) Implemented (or substantially implemented)

1. **Start screen project creation**
   - Name, description, and access-group fields exist in UI and backend creation flow.
2. **Static keyboard shortcuts + discoverability**
   - Hotkeys for class actions and a help panel/list are available.
3. **Session persistence (partial)**
   - Image-view and gallery preferences persist in browser local storage.
   - Not yet server-backed per-user/per-device persistence.
4. **Measurement and annotation foundations (partial)**
   - Measurement tools, overlays, and calibration are implemented.
   - Classification/comments/review metadata exists.
5. **Report/data export (partial)**
   - Excel export exists.

## 2) Already tracked in current planning docs

No direct matches were found for the project-configuration, batch/part, PT1/PT2/PT3 visualization, or segmentation-specific requests.

Existing planning docs currently focus on auth architecture and test remediation.

## 3) Remaining requests to open as issues

### A) Core workflow / project setup

1. Start screen **Delete Project** with role restrictions and explicit confirmation warning.
2. Server-backed **per-user workspace state** (open panels, resize, orientation, hotkeys).
3. **Configurable** hotkeys.
4. New top-level IA: **Project Configuration** and **Project Data** tabs.
5. Project config cloning: copy settings from an existing project.

### B) PT1 part-based inspection (SN grouped external views)

6. Grouping images by **Serial Number (SN)**.
7. Batch + part model and tabs: create/delete batches, assign parts.
8. PT1 view board showing all configured external views (top/bottom/left/right/front/back; configurable subset).
9. Defect-centric sort/filter in part summary.
10. Part-level review state indicator/checkmark.

### C) PT2/PT3 multi-planar reconstruction (MPR) style viewer

11. Four-quadrant viewer layout:
    - three orthographic 2D slice panes,
    - one 3D orientation pane with crosshairs and orientation plane.
12. Slice scrolling through volumes in all three orthographic panes.
13. Color-coordinated crosshair planes and corresponding 2D quadrants.
14. Spatial locator overlays in each 2D view showing where other planes intersect.
15. Synchronized zoom/pan with overlays across orthographic panes.
16. Contrast adjustment controls (explicitly not medical window/level semantics).
17. Overlay system:
    - one+ layer, ideally 2+ concurrent overlays,
    - false-color options for overlays,
    - grayscale base-image rendering,
    - click tooltip/annotator showing base + overlay value at cursor.

### D) Defect/annotation domain model enhancements

18. Defect types management with name/color/definition.
19. Process settings for required/optional review actions.
20. Display settings tied to anomaly color maps.
21. Unified annotations payload/UX for class, modality, disposition, bbox, hide/show.
22. Annotation audit trail display (timestamp + username on hover/details).

### E) ML actions in the inspector

23. Button to run segmentation on the currently displayed image/slice.
24. Show segmentation result in the same inspection context where invoked.
25. Invoke AI-augmented geometric measurements.
26. Retrieve and display geometric measurement outputs inline in inspector workflow.

### F) Data ingest/export and infrastructure alignment

27. High-volume ingest API with counters, discrepancy detection, and part organization.
28. Export bundles for images/metadata/overlays/annotations.
29. Project-level report generation in **JSON** format.
30. Keep backend storage architecture aligned with current stack:
    - images/artifacts in S3-compatible object storage,
    - metadata in Postgres.

## Proposed issue sequencing (recommended order)

### Epic 1 — Data model & project-type scaffolding
- Add `project_type` enum (PT1/PT2/PT3).
- Add SN/part/batch entities and relationships.
- Add view/modality/configuration entities.

### Epic 2 — PT1 workflow
- SN grouping + part summary tabs.
- Configurable external-view matrix.
- Part review workflow and defect-first filtering.

### Epic 3 — PT2/PT3 viewer
- 4-pane viewer shell.
- Orthographic slice scrolling.
- 3D orientation pane + synchronized crosshairs.
- Spatial intersection lines/locators.

### Epic 4 — Overlay + quantitative tooling
- Overlay layering + color mapping.
- Shared zoom/pan transforms.
- Pixel/overlay value tooltips.
- AI geometric measurement invocation/results.

### Epic 5 — ML segmentation integration
- Segmentation invoke endpoint + job lifecycle.
- In-context rendering of segmentation outputs.

### Epic 6 — Ingest/export/reporting
- Bulk ingest + discrepancy checker.
- Export package outputs.
- JSON report generation.

### Epic 7 — UX personalization & governance
- Per-user server-backed workspace persistence.
- Configurable hotkeys.
- Project deletion authorization + warning UX.

## Notes

- Existing capabilities should be treated as **partial foundations** for this plan, not final equivalents of the requested PT workflows.
- PT2 and PT3 currently share the same viewer requirements and can likely share one technical implementation with mode-specific configuration.

## Incremental execution status (2026-04-04, replanned)

PR-15 execution has been flattened so each function-level change maps to one submitted PR slice.

- **Completed PR slices:**
  - `PR-15-M1`: Start screen deletion governance hardening.
  - `PR-15-M2`: Configurable inspector hotkeys persistence.
  - `PR-15-M3`: Workspace-backed shortcut-help visibility persistence.
  - `PR-15-M4`: Workspace-backed normalization-triage persistence.
  - `PR-15-M5`: Workspace-backed inspector image-visibility persistence.
  - `PR-15-M6`: Workspace-backed inspector modality/view persistence hardening.
  - `PR-15-M7`: Workspace-backed inspector viewport-transform persistence hardening.
  - `PR-15-M8`: Workspace-backed inspector manual-measurement persistence hardening.
- **Artifacts for clean replay and submission order:** `docs/planning/pr15-split-artifact.md`, `docs/planning/pr15-m8-replay-artifact.md`.
- **Next unimplemented PR slice:** `PR-16-M1` — project configuration cloning API (`POST /api/projects/{project_id}/configuration/clone`) to unlock request **A5**.
- **Planning rule going forward:** keep labels flat (`PR-15-M#`) and avoid step/part/sub-step hierarchy unless a milestone must be split for hard technical coupling.

## New incremental series: PR-16 (2026-04-04)

- `PR-16-M1` (this slice): add server contract for cloning a project's inspection configuration from another accessible project.
- Replay/submit artifact: `docs/planning/pr16-split-artifact.md`.

## Incremental execution status (2026-04-04, updated)

- **Completed PR slices:**
  - `PR-16-M1`: project configuration cloning API contract and access guards.
  - `PR-16-M1a`: clone self-target guard (`source_project_id != project_id`) and regression coverage across PT1/PT2/PT3.
- **Replay/submit artifacts:** `docs/planning/pr16-split-artifact.md`, `docs/planning/pr16-m1-replay-artifact.md`.
- **Next unimplemented PR slice:** none currently planned; open `PR-16-M2+` only after explicit feature-contract approval.


## Orchestrator closeout artifact index (2026-04-04)

- Clean replay order for submitted incremental PRs is maintained in:
  - `docs/planning/pr15-split-artifact.md`
  - `docs/planning/pr15-m8-replay-artifact.md`
  - `docs/planning/orchestrator-clean-replay-index-2026-04-04.md`
- Execution status for this plan segment: **no unfinished PR-15 slices remain**. New scope requires explicit PR-15-M9+ approval.

## Orchestrator execution sync (2026-04-04, closeout refresh)

- Verified against `docs/planning/orchestrator-session-handoff.md`: there are no unfinished planned PR slices in currently approved `PR-15` and `PR-16` scope.
- Post-inspection replay/submission artifact for clean incremental upstream PRs: `docs/planning/orchestrator-post-inspection-pr-submission-artifact-2026-04-04.md`.
- Any additional implementation must start at `PR-16-M2+` only after explicit feature-contract approval.

## Orchestrator execution sync (2026-04-04, implementation-session refresh)

- Re-checked planned-slice status before implementation kickoff: `PR-15` and `PR-16` remain fully complete with no unfinished slices.
- Created an execution-ready artifact for post-inspection upstream submission sequencing:
  - `docs/planning/orchestrator-next-pr-execution-artifact-2026-04-04.md`
- Added explicit next-start rule: open `PR-16-M2+` only from a newly approved contract; no hidden carry-over scope is authorized.


## Orchestrator execution sync (2026-04-04, artifact-refresh)

- Revalidated both planning sources (`feature-request-triage-2026-03-28.md` and `orchestrator-session-handoff.md`) for unfinished slices: none remain in approved `PR-15`/`PR-16` scope.
- Added refreshed post-inspection replay/submission runbook artifact:
  - `docs/planning/orchestrator-post-inspection-pr-submission-artifact-2026-04-04-v2.md`
- Next feature implementation boundary is unchanged: open `PR-16-M2+` only after explicit feature-contract approval.

## Orchestrator execution sync (2026-04-04, unified-planning-refresh)

- Consolidated cross-series PR planning into one umbrella doc:
  - `docs/planning/orchestrator-unified-pr-planning-2026-04-04.md`
- This unified doc now serves as the first-stop source for replay/submission planning across `PR-07` through `PR-16`.
- Existing per-series split/checklist artifacts remain as slice-level detail and evidence.


## Incremental execution status (2026-04-04, PR-16-M2 frontend clone integration)

- **Completed PR slices:**
  - `PR-16-M2`: Project Configuration UI now clones from existing project via `POST /api/projects/{project_id}/configuration/clone` instead of client-side GET+PUT chaining.
- **Replay/submission artifact:** `docs/planning/pr16-m2-replay-artifact.md`.
- **Next unimplemented PR slice:** none currently planned; open `PR-16-M3+` only after explicit feature-contract approval.


## Orchestrator execution sync (2026-04-04, next-unimplemented-execution-request)

- Re-validated planned-slice status across triage + handoff docs: no unfinished planned slices remain through `PR-16-M2`.
- Created an execution artifact for post-inspection clean replay and scope-boundary control:
  - `docs/planning/orchestrator-next-unimplemented-pr-execution-2026-04-04.md`
- Next implementation is blocked on explicit feature-contract approval for `PR-16-M3+`; no hidden carry-over work is authorized.

## Orchestrator execution sync (2026-04-04, PR-queue reconciliation refresh)

- Re-ran planning reconciliation for the two source-of-truth docs:
  - `docs/planning/feature-request-triage-2026-03-28.md`
  - `docs/planning/orchestrator-session-handoff.md`
- Outcome: there is still no unimplemented planned slice through approved scope (`PR-16` complete through `PR-16-M2`).
- Execution artifact for post-inspection replay + clean upstream submission sequencing:
  - `docs/planning/orchestrator-next-pr-execution-artifact-2026-04-04-v2.md`
- Scope gate remains unchanged: begin `PR-16-M3+` only after explicit feature-contract approval.

## Incremental execution status (2026-04-04, PR-16-M3 clone type-compatibility hardening)

- **Completed PR slices:**
  - `PR-16-M3`: clone-flow hardening enforces same-`project_type` source/target compatibility and filters frontend copy-source options to matching project type.
- **Why this unblocked progress:** explicit operator approval was provided to proceed beyond prior contract-gating language; this slice starts `PR-16-M3` with a concrete backend+frontend contract.
- **Replay/submission artifact:** `docs/planning/pr16-m3-replay-artifact.md`.
- **Next unimplemented PR slice:** open `PR-16-M4+` from the next approved feature contract or continue the approved `PR-16` stream.
## Incremental execution status (2026-04-04, PR-16-M4 planning-state reconciliation + submission artifact)

- **Completed PR slices:**
  - `PR-16-M4`: synchronized planning source-of-truth docs after `PR-16-M3` delivery and added a post-inspection submission artifact with explicit replay/testing gates.
- **Replay/submission artifact:** `docs/planning/pr16-m4-replay-artifact.md`.
- **Next unimplemented PR slice:** open `PR-16-M5+` only after explicit feature-contract approval.

## Incremental execution status (2026-04-04, PR-16-M5 clone source UX hardening + matrix integrity)

- **Completed PR slices:**
  - `PR-16-M5`: hardened Project Configuration clone UX to show explicit empty-state guidance when no compatible same-type source projects are available, and fixed the PT1/PT2/PT3 synthetic-user clone test matrix to validate type filtering against each active project type.
- **Replay/submission artifact:** `docs/planning/pr16-m5-replay-artifact.md`.
- **Next unimplemented PR slice:** open `PR-16-M6+` only after explicit feature-contract approval.


## Incremental execution status (2026-04-04, PR-16-M6 clone error-detail surfacing + stale-source hardening)

- **Completed PR slices:**
  - `PR-16-M6`: surfaced backend clone API `detail` errors in Project Configuration UI, reset stale clone source selections when compatibility-filtered options change, and tightened clone-button disable guards.
- **Replay/submission artifact:** `docs/planning/pr16-m6-replay-artifact.md`.
- **Next unimplemented PR slice:** open `PR-16-M7+` only after explicit feature-contract approval.

## Incremental execution status (2026-04-04, PR-16-M7 clone-feedback reset hardening)

- **Completed PR slices:**
  - `PR-16-M7`: reset clone success/error alerts when source selection changes and clear stale status before each clone attempt.
- **Why this slice exists:** advanced synthetic workflows can involve repeated source switching; stale alerts can mislead operators about which source generated the current UI state.
- **Replay/submission artifact:** `docs/planning/pr16-m7-replay-artifact.md`.
- **Next unimplemented PR slice:** open `PR-16-M8+` only after explicit feature-contract approval.

## Incremental execution status (2026-04-04, PR-16-M8 clone in-flight submission hardening)

- **Completed PR slices:**
  - `PR-16-M8`: clone-flow UX now hard-locks clone controls while a clone request is in flight, shows explicit in-progress button state, and prevents duplicate clone submissions from rapid re-click workflows.
- **Why this slice exists:** progressive synthetic-user workflows include repeated source selection and rapid retries; without an in-flight lock, duplicate clone requests can race and produce confusing operator feedback.
- **Replay/submission artifact:** `docs/planning/pr16-m8-replay-artifact.md`.
- **Next unimplemented PR slice:** open `PR-16-M9+` only after explicit feature-contract approval.

## Incremental execution status (2026-04-04, PR-16-M9 post-clone source reset hardening)

- **Completed PR slices:**
  - `PR-16-M9`: after successful configuration clone, copy-source selection now resets to placeholder state and success messaging includes copied source project name.
- **Why this slice exists:** progressive synthetic-user workflows repeatedly clone from templates; auto-resetting source selection reduces accidental repeated clone submissions against stale intent.
- **Replay/submission artifact:** `docs/planning/pr16-m9-replay-artifact.md`.
- **Next unimplemented PR slice:** open `PR-16-M10+` only after explicit feature-contract approval.

## Incremental execution status (2026-04-05, PR-16-M10 clone error parsing hardening)

- **Completed PR slices:**
  - `PR-16-M10`: hardened clone error handling to gracefully process non-JSON API error payloads and preserve actionable fallback status messaging.
- **Why this slice exists:** reverse-proxy/network edge paths can return HTML/text error bodies; parsing hardening prevents opaque JSON parse errors from leaking into operator-facing alerts.
- **Replay/submission artifact:** `docs/planning/pr16-m10-replay-artifact.md`.
- **Next unimplemented PR slice:** open `PR-16-M11+` only after explicit feature-contract approval.

## Incremental execution status (2026-04-05, PR-16-M11 clone success payload contract hardening)

- **Completed PR slices:**
  - `PR-16-M11`: hardened frontend clone handling to reject successful clone responses that omit `config`, preventing silent fallback to empty defaults.
- **Why this slice exists:** clone endpoint success semantics should guarantee a hydrated configuration payload; accepting success without `config` risks destructive empty-state replacement in advanced multi-step workflows.
- **Replay/submission artifact:** `docs/planning/pr16-m11-replay-artifact.md`.
- **Next unimplemented PR slice:** open `PR-16-M12+` only after explicit feature-contract approval.

## Incremental execution status (2026-04-05, PR-16-M12 clone config-shape contract hardening)

- **Completed PR slices:**
  - `PR-16-M12`: hardened frontend clone handling to reject successful clone payloads with structurally invalid `config` objects (missing required top-level arrays/objects), preventing runtime crashes from malformed success responses.
- **Why this slice exists:** accepting malformed `config` objects (for example `{}`) can crash the Project Configuration view when rendering expects array-backed sections (`image_modalities`, `part_views`, `defect_types`).
- **Replay/submission artifact:** `docs/planning/pr16-m12-replay-artifact.md`.
- **Next unimplemented PR slice:** open `PR-16-M13+` only after explicit feature-contract approval.

## Incremental execution status (2026-04-05, PR-16-M13 clone config-entry contract hardening)

- **Completed PR slices:**
  - `PR-16-M13`: hardened frontend clone handling to reject successful clone payloads whose collection entries are structurally unsafe (`image_modalities`/`defect_types` non-object members or `part_views.required_modalities` non-array values).
- **Why this slice exists:** even with valid top-level payload keys, malformed entry members can still trigger render-time exceptions in advanced edit workflows (for example `.join` on non-array `required_modalities`).
- **Replay/submission artifact:** `docs/planning/pr16-m13-replay-artifact.md`.
- **Next unimplemented PR slice:** open `PR-16-M14+` only after explicit feature-contract approval.

## Incremental execution status (2026-04-05, PR-16-M14 clone config scalar-field contract hardening)

- **Completed PR slices:**
  - `PR-16-M14`: hardened frontend clone handling to reject successful clone payloads that pass top-level/entry checks but still contain invalid scalar field types in configuration members.
- **Why this slice exists:** scalar-type drift in success payloads (for example numeric modality IDs or non-string `required_modalities` values) can silently hydrate and later break validation and edit workflows.
- **Replay/submission artifact:** `docs/planning/pr16-m14-replay-artifact.md`.
- **Next unimplemented PR slice:** open `PR-16-M15+` only after explicit feature-contract approval.

## Incremental execution status (2026-04-05, PR-16-M15 clone settings-field contract hardening)

- **Completed PR slices:**
  - `PR-16-M15`: hardened frontend clone handling to reject successful clone payloads with invalid `process_settings`/`display_settings` field types before hydration.
- **Why this slice exists:** even with valid top-level keys and entry scalar fields, malformed settings types can silently hydrate and destabilize downstream toggle/hotkey and display controls.
- **Replay/submission artifact:** `docs/planning/pr16-m15-replay-artifact.md`.
- **Next unimplemented PR slice:** open `PR-16-M16+` only after explicit feature-contract approval.



## Incremental execution status (2026-04-05, PR-16-M16 clone domain-enum contract hardening)

- **Completed PR slices:**
  - `PR-16-M16`: hardened frontend clone handling to reject successful clone payloads that contain out-of-contract domain values for enum-backed fields (`part_views[].source`, `display_settings.default_colormap`, `display_settings.anomaly_colormap`).
- **Why this slice exists:** type checks alone cannot prevent enum drift (for example `source: "api"` or unsupported colormaps) from silently hydrating invalid state that misrepresents available UI options.
- **Replay/submission artifact:** `docs/planning/pr16-m16-replay-artifact.md`.
- **Next unimplemented PR slice:** open `PR-16-M17+` only after explicit feature-contract approval.

## Incremental execution status (2026-04-05, PR-16-M17 clone hotkey-domain contract hardening)

- **Completed PR slices:**
  - `PR-16-M17`: hardened frontend clone handling to reject successful clone payloads that violate hotkey-domain constraints (non-single-key bindings or duplicated key assignments).
- **Why this slice exists:** string-type checks cannot prevent semantically invalid hotkey bindings from silently hydrating operator workflows and conflicting with shortcut behavior.
- **Replay/submission artifact:** `docs/planning/pr16-m17-replay-artifact.md`.
- **Next unimplemented PR slice:** open `PR-16-M18+` only after explicit feature-contract approval.

## Incremental execution status (2026-04-05, PR-16-M18 clone relational-integrity contract hardening)

- **Completed PR slices:**
  - `PR-16-M18`: hardened frontend clone handling to reject successful clone payloads with relational-integrity violations (duplicate modality/view IDs or `part_views[].required_modalities` references to unknown modalities).
- **Why this slice exists:** top-level/type/domain checks can still allow semantically inconsistent graph data that later fails save-time validation and confuses operators in advanced PT1/PT2/PT3 editing workflows.
- **Replay/submission artifact:** `docs/planning/pr16-m18-replay-artifact.md`.
- **Next unimplemented PR slice:** open `PR-16-M19+` only after explicit feature-contract approval.
