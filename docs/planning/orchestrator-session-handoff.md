# Orchestrator Session Handoff (Codex)

Use this playbook to run large migrations/refactors with disciplined role separation.

## Kickoff prompt for new sessions

Copy this into a new Codex chat session:

> Use `AGENTS.md` at repo root and run the Orchestrated Multi-Agent Workflow for this task.
> Start with Spec Writer output, then Planner milestones (with exact files), then implement milestone-by-milestone with tests after each step.
> If ambiguities affect architecture or data contracts, ask clarifying questions first.

## Required execution format

For each milestone:
1. **Spec delta** (what this step changes)
2. **Files touched** (exact paths)
3. **Implementation** (small scoped diff)
4. **Tests executed** (commands + pass/fail)
5. **Reviewer notes** (edge/security/consistency)

## Done criteria

A task is done only when:
- milestone acceptance tests pass,
- full required test suite passes,
- reviewer checklist is complete,
- no unresolved high-severity risks remain.

## Suggested reviewer checklist

- Input validation and auth boundaries are preserved.
- No insecure defaults introduced.
- Backward compatibility or migration path is documented.
- Error handling and observability are adequate.
- Performance/latency impact is acceptable or measured.

## Active session pointer (2026-04-04)

- **Current milestone:** PR-14 milestone 1 step 1 (Project Data report normalization telemetry surface).
- **Scope boundary for first implementation step:** frontend-only rendering of existing `report-json` telemetry contract (`summary.metadata_normalization.dropped_non_object_items`).
- **Required tests:** existing React Testing Library matrix across project types (`PT1`,`PT2`,`PT3`) and progressive synthetic users (`basic`,`intermediate`,`advanced`).
