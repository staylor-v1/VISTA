# PR-15 Split Artifact (2026-04-04)

This artifact re-baselines PR-15 into **flat, submit-ready PR slices**. Default unit is one user-visible function change per PR. Milestones are used only when one function needs multiple coupled commits.

## Delivery model (updated)

- Every listed item below is intended to ship as its own submitted PR.
- Naming uses `PR-15-M#` only (no step/part/sub-step hierarchy).
- Scope per PR should stay bounded to one function/service boundary where practical.
- If a slice cannot pass acceptance in one PR, split into milestone sub-PRs under the same `M#` label and document why.

## Flat PR slices and status

1. **PR-15-M1 — Start screen deletion governance hardening** ✅ completed
   - Role-gate delete affordance by user group.
   - Enforce irreversible confirmation phrase + acknowledgment checkbox.
   - Refresh project list from backend after delete.

2. **PR-15-M2 — Configurable inspector hotkeys persistence** ✅ completed
   - Hydrate workbench hotkeys from canonical configuration contract.
   - Provide validated hotkey editor UX.
   - Persist to project configuration endpoint and sync runtime bindings.

3. **PR-15-M3 — Workspace-backed shortcut-help visibility persistence** ✅ completed
   - Normalize `inspector.shortcut_help_visible` as strict boolean.
   - Hydrate and autosave shortcut-help visibility state.

4. **PR-15-M4 — Workspace-backed normalization-triage persistence** ✅ completed
   - Normalize `inspector.normalization_triage_field` as strict string.
   - Hydrate and autosave triage-field selection.

5. **PR-15-M5 — Workspace-backed inspector image-visibility persistence** ✅ completed
   - Normalize `inspector.image_enabled` as strict boolean.
   - Hydrate and autosave image-visibility toggle.

6. **PR-15-M6 — Workspace-backed inspector modality/view persistence hardening** ✅ completed
   - Normalize `inspector.modalities` as strict list.
   - Normalize `inspector.view_name` as strict string.
   - Preserve backward-compatible hydration defaults.

7. **PR-15-M7 — Workspace-backed inspector viewport-transform persistence hardening** ✅ completed
   - Normalize `inspector.viewport_transform.zoom` as bounded float (`0.5`-`4.0`).
   - Normalize `inspector.viewport_transform.panX` and `panY` as bounded ints (`-200`-`200`).
   - Preserve backward-compatible defaults for missing/invalid viewport values.

8. **PR-15-M8 — Workspace-backed inspector manual-measurement persistence hardening** ✅ completed
   - Normalize `inspector.measurements` as strict list of `{id,label,value}` tuples.
   - Filter malformed/empty entries during hydration-safe workspace normalization.
   - Preserve backward compatibility by accepting numeric measurement values and coercing to strings.

## Replay order for clean incremental PR submission

1. `PR-15-M1` — Start screen deletion governance hardening.
2. `PR-15-M2` — Configurable inspector hotkeys persistence.
3. `PR-15-M3` — Workspace-backed shortcut-help visibility persistence.
4. `PR-15-M4` — Workspace-backed normalization-triage persistence.
5. `PR-15-M5` — Workspace-backed inspector image-visibility persistence.
6. `PR-15-M6` — Workspace-backed inspector modality/view persistence hardening.
7. `PR-15-M7` — Workspace-backed inspector viewport-transform persistence hardening.
8. `PR-15-M8` — Workspace-backed inspector manual-measurement persistence hardening.

## Per-PR acceptance requirements

Each PR must include:
- focused diff for the named slice,
- backend + frontend PT1/PT2/PT3 synthetic-user matrix evidence,
- updated pointer in `docs/planning/orchestrator-session-handoff.md`.

## Remaining PR-15 backlog

- No open PR-15 backlog items remain after `PR-15-M8`.
- Keep future slicing flat (`M#`) and avoid nested step/part naming when Epic 7 scope expands.
