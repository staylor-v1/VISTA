# PR-12 Split Artifact (2026-04-03)

This artifact captures the incremental work completed in this session so it can be split into clean source-repo PRs after full-app inspection.

## Proposed incremental PR from this session

1. **PR-12 milestone 1 step 2 — frontend delete-project governance UX**
   - Scope:
     - Add `Delete` action to dashboard project-card menu.
     - Add destructive confirmation modal requiring exact phrase `DELETE <project_name>`.
     - Wire deletion request to existing backend governance API (`DELETE /api/projects/{project_id}` with `confirmation_phrase` payload).
     - Remove deleted project from dashboard state on success and preserve backend error messaging on failure.
   - Files:
     - `frontend/src/App.js`
     - `frontend/src/App.test.js`
   - Automated coverage:
     - Existing frontend Jest/RTL framework.
     - Progressive synthetic-user matrix (`basic`, `intermediate`, `advanced`) for each project type (`PT1`, `PT2`, `PT3`) validating invalid phrase rejection + successful deletion.

## Cherry-pick guidance

- Keep this PR isolated from backend governance endpoint changes (already captured in previous PR-12 milestone-1 step-1 artifact commit).
- Keep docs-only milestone bookkeeping changes in a separate follow-up commit if maintainers prefer code-only PRs.

## Remaining PR-12 backlog after this checkpoint

- Configurable hotkeys storage + validation and UI plumbing.
- Workspace-state hardening for panel open/resize/orientation persistence.
- Ingest discrepancy counters/validation APIs and reportable discrepancy summaries.
- Export bundle coverage for images/metadata/overlays/annotations + report options.
- Red-team / blue-team cross-type adversarial matrix and governance closeout.
