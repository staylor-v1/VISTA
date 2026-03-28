# AGENTS.md (Repository Root)

These instructions apply to the entire repository unless a deeper AGENTS.md overrides them.

## When to apply this workflow
Apply this workflow when the user asks for a **migration**, **refactor**, or other multi-step architectural/codebase change.

## Orchestrated Multi-Agent Workflow
Use the following role sequence and keep outputs explicit:

1. **Spec Writer**
   - Research current implementation before proposing edits.
   - Produce a technical spec with:
     - current behavior,
     - target behavior,
     - API signatures/contracts,
     - logic/data-model changes,
     - migration/backward-compat notes.

2. **Planner**
   - Break spec into small independent milestones.
   - For each milestone, list exact files to change.
   - Define milestone-level acceptance tests.

3. **Implementer**
   - Execute one milestone at a time.
   - Keep change scope bounded (one function/service at a time where practical).
   - For each milestone, explain rationale and provide concrete diffs/changes.

4. **QA / Tester**
   - Run automated tests for each milestone.
   - A milestone is not done until required tests pass.
   - If tests fail, fix or clearly document blocker.

5. **Reviewer**
   - Perform skeptical final review for:
     - edge cases,
     - security risks,
     - architectural consistency,
     - regression risk.

## Global constraints
- **Bias toward questions:** If high-impact ambiguity exists, ask clarifying questions before planning.
- **Pin success:** Define "Done" by explicit passing tests and verification checks.
- **Bound the canvas:** Prevent scope drift by keeping implementations narrowly scoped.
