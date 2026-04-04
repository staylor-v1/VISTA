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

## Incremental execution status (2026-04-04)

- **Completed this session:** PR-14 milestone 2 step 1 (Project Data normalization telemetry now exposes actionable discrepancy triage links/filters).
- **Next unimplemented PR slice:** PR-14 milestone 2 step 2 red-team/blue-team hardening for adversarial metadata normalization categories and empty-state UX copy.
- **Target PR label:** PR-14 milestone 2 step 2.
- **Acceptance target:** triage actions remain stable for unknown normalization fields and continue to guide operators when no affected parts match active batch/defect filters.
