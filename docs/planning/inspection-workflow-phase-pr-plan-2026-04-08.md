# Inspection Workflow PR Plan (2026-04-08)

## Context
This plan adds an end-to-end inspection workflow UI contract where users:
1. configure serial-number hierarchy,
2. ingest project data,
3. inspect parts (segmentation/measurement/visual review),
4. disposition each part (accept/reject), and
5. generate reports in JSON or PDF.

## Proposed PR sequence

### PR-17 — Project phase labeling + workflow framing
- Add an explicit **Project phase** selector/label near the top of the inspection workbench.
- Initial phases:
  - Data Ingestion
  - Part Inspection
  - Reporting
- Acceptance checks:
  - Project workbench renders phase badge + selector.
  - Phase value can be changed without reloading project data.

### PR-18 — Serial number scheme configuration
- Extend project configuration with serial-number hierarchy controls:
  - batch SN enabled,
  - optional sub-batch organization,
  - sub-batch SN enabled,
  - part SN enabled.
- Persist these controls in project configuration metadata.
- Acceptance checks:
  - Configuration UI shows all SN controls.
  - Save/load round-trip preserves SN scheme choices.

### PR-19 — Report format expansion (JSON + PDF)
- Preserve JSON report export.
- Add PDF report export endpoint and UI mode.
- Acceptance checks:
  - JSON export still returns existing report summary payload.
  - PDF export returns `application/pdf` response with downloadable content.
  - Workbench success state distinguishes JSON vs PDF results.

## Backward compatibility notes
- Existing project configurations remain valid; new SN fields default safely when absent.
- JSON report schema remains unchanged.
- PDF report is additive and does not alter existing export routes.
