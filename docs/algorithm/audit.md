# Audit: how the engine turns a request into a result (Phase A)

Date: 2026-10-15. Scope: the mission engine, the specification pipeline, the built-in agents, the validators and the mission UI. The audit checks them against the Definition-to-Verified-Result master prompt (primary source: [`docs/spec/definition-to-verified-result.md`](../spec/definition-to-verified-result.md)). References like "MP §4" point to that document.

**Method.** I read the code: `packages/core/src/missions/*`, `spec/*`, `workflows/builtin.ts`, `agents/runtime.ts`, the manifests, instructions and schemas of the built-in agents, `apps/ui/src/pages/Missions.tsx`, and the mission tests. A line reference such as `engine.ts:1250` points to `packages/core/src/missions/engine.ts`, line 1250, at commit `90efe2d`.

**What this audit did not do.**
- No language model was run: the container has no local model runtime (`ollama` and `lms` are absent) and no cloud key.
- Every statement about agent behaviour is therefore about the **code paths and contracts**, not about how well a particular model follows them.
- The before/after comparison (MP §12) is planned in the design. Its live-model part has not been carried out.

## 1. Summary

1. **There are two task algorithms, and they do not share a data model.**
   - **Missions** (`missions/engine.ts`, 2,785 lines, 10 phases, 12 agents) carry out natural-language tasks.
   - **The specification pipeline** (`workflows/builtin.ts`, `SPEC_PIPELINE`, 7 agents + 5 code functions) produces a specification document.
   - Missions use `NormalizedTask`: requirements `R1…` and criteria `AC1…` as two unlinked lists. The pipeline uses `Requirement`/`SpecTask` with `requirement_ids`, priorities and coverage checks.
   - The master prompt asks for **one** main algorithm (MP §3, §14). The stronger requirements model lives in the pipeline, which missions never use.
2. **Missions never define the result as an object.**
   - The whole "what must exist at the end" is one string: `desired_outcome` (`types.ts:51`).
   - Missing: result type, composition, behaviour, inputs, outputs, quality criteria, expected artifacts (MP §3 stage 2, 12 properties).
   - Every downstream agent receives only `objective: string`.
3. **Traceability breaks twice.**
   - Acceptance criteria do not reference requirements.
   - Plan steps reference neither: `done_criteria` is free text (`types.ts:90`), and `validatePlan` (`plan.ts:41`) checks IDs, roles and cycles but not coverage.
   - A requirement can therefore disappear between analysis and planning without any check noticing.
4. **No pre-execution review of the specification.**
   - The independent reviewer runs **after** execution (`phaseReview`, `engine.ts:1966`). A misunderstanding is caught only after the work is done.
   - MP §3 stage 8 requires the review before handing the task to executors.
5. **Honesty about the outcome is strong and must be kept.** These parts are reusable as they are:
   - the deterministic guard over the verifier (`verify.ts:32`);
   - the honest final status (`verify.ts:97`);
   - idempotent steps;
   - crash recovery;
   - local-only model fallback;
   - change sets and work copies.

   What is missing is mostly **upstream** (definition, requirements, traceability) and **around handoffs**. The parts that judge the outcome are largely in place.

## 2. Inventory: what exists

| Component | Where | What it does |
|---|---|---|
| Mission engine | `missions/engine.ts` | Phases `analysis → context → research → strategy → planning → execution → verification ⇄ fix → review → summary`; adaptive skipping (`nextPhase`, `engine.ts:978`); approvals; persisted steps with idempotency keys; events; recovery |
| Mission state machine | `missions/state.ts` | 15 statuses, an explicit transition table, phase → status mapping |
| Plan validation | `missions/plan.ts` | Step ID format `S<n>`, duplicates, unavailable roles, no implementer in plan mode, missing dependencies removed, cycles, a final verifier step appended |
| Guard and final status | `missions/verify.ts` | Rejects "met" without evidence; failed or unrun checks lower the status; `manual` criteria are only the user's; "Completed" only if every applicable criterion is met and nothing failed, was skipped or blocks |
| Project checks | `missions/checks.ts` | Named user-defined commands, run only in a work copy and sandboxed; content-hash approval for risky scripts |
| Grounding | `missions/context.ts`, `research/grounding.ts` | Quotes from documents and web pages are checked in code |
| Spec pipeline | `workflows/builtin.ts:10` | coordinator → inventory → researcher → ground → [requirements-analyst → validators → contradiction-checker → user resolution → decomposer → validators → spec-writer → render → spec-reviewer → approval] × N → save |
| Spec validators | `spec/validators.ts` | Duplicate IDs, broken references, cycles, vague wording without a measurable criterion, missing criteria, unsupported requirements, near-duplicates, orphan tasks, uncovered requirements; metrics (`withCriteriaPct`, `coveragePct`) |
| Spec renderer | `spec/render.ts` | Deterministic Markdown: requirements, decomposition, traceability matrix, evidence, contradictions, automatic checks |
| Agent runtime | `agents/runtime.ts` | The platform preamble; validation against the package output schema (Ajv, JSON Schema 2020-12); up to `repairAttempts` repair rounds; `STRUCTURED_OUTPUT_FAILED` otherwise |
| Mission agents | `agents-builtin/*` | mission-analyst, project-explorer, researcher, web-researcher, solution-architect, mission-planner, implementer, verifier, security-reviewer, documenter, independent-reviewer, mission-advisor |
| Spec agents (not used by missions) | `agents-builtin/*` | coordinator, inventory-analyst, requirements-analyst, contradiction-checker, decomposer, spec-writer, spec-reviewer |
| Mission UI | `apps/ui/src/pages/Missions.tsx` | Readiness, a phase stepper, criteria, plan, original request, assumptions, user additions, a live log, limitations, an outcome card, approval cards |
| Tests | `packages/core/test/missions.test.ts` | 29 cases (28.17 scenarios 1–15 with variants, the state machine, the advisor) with scripted model responses |

## 3. Assessment against the master prompt

Legend: **Works**: implemented and covered by a test. **Partial**: exists, but with a gap that matters for the master prompt. **Missing**: not implemented.

### 3.1. Audit items (MP §2)

| # | Item | State | Evidence |
|---|---|---|---|
| 1 | Architecture and file structure | Works | `docs/architecture/overview.md`, `missions.md` |
| 2 | Agent roles, instructions, configs | Works | Agent packages with manifests, schemas and test cases; a platform preamble |
| 3 | Creating tasks and specifications | Partial | Two separate mechanisms with incompatible models (§1 point 1) |
| 4 | Decomposition and distribution | Partial | `mission-planner` plus `validatePlan`; no requirement or criterion links in steps |
| 5 | Storage formats | Partial | Missions keep JSON columns in `missions` (`system-migrations.ts:429`); there are no contract versions, only a `revision` counter |
| 6 | Orchestrator and context passing | Partial | `stepInput` (`engine.ts:1596`) builds a role-specific input; there is no common handoff object |
| 7 | Verification, testing, saving results | Works / Partial | The guard, checks and report work; `artifact_exists` is weak (§4, L4) |
| 8 | Algorithms, validators, schemas | Partial | Strong validators exist only in the spec pipeline |
| 9 | Local model limitations | Works | Schema validation with repair, fallback to another **local** model (`engine.ts` `FALLBACK_CODES`), a step timeout, budgets, compact outputs |

### 3.2. The eight stages (MP §3)

| Stage | State | What exists | What is missing |
|---|---|---|---|
| 1. Intent interpretation | Partial | `mission-analyst` produces a title, task type, problem, outcome, questions and assumptions | No separate fields for object, audience, usage context, explicit constraints vs implied requirements, missing information; the user's words are not kept apart from interpretations |
| 2. Result definition | **Missing** | `desired_outcome` (one string) | The 12 properties; expected artifacts; behaviour; inputs and outputs |
| 3. Context and research | Works | `context`/`research`/`strategy` phases; grounded evidence; options with scores; facts vs assumptions in evidence (`kind`) | Research results are not linked to the requirements they support |
| 4. Requirements registry | Partial | `requirements[]` with `source` (request/attachment/inferred/user) | Type, priority, status, rationale, dependencies, per-requirement acceptance criteria and verification method, implementation status, related requirements. Agent proposals are not distinguished from user requirements |
| 5. Ambiguity, gaps, contradictions | Partial | Blocking questions (up to 3 rounds); a conflict check for **added** requirements (planner `Conflict:` notes, `engine.ts:1560`) | No check of the initial set: duplicates, vague terms, missing criteria and contradictions within the request are not detected in missions. The validators exist in `spec/validators.ts` but missions do not call them |
| 6. Decomposition | Partial | Steps with goal, role, inputs, expected output, dependencies, tools, done criteria, verification, risk; parallelism by dependencies | No requirement or criterion IDs per step, no artifacts per step, no permissions or forbidden actions per step, no escalation conditions; no coverage check |
| 7. Final specification document | **Missing in missions** | The mission report is written after the fact (`summaryMarkdown`, `verify.ts`) | A specification (MP §3 stage 7, 22 sections adapted to scale) that another team could execute without the conversation. The spec pipeline renders a document, but missions never produce one |
| 8. Independent spec review | **Missing in missions** | `spec-reviewer` in the pipeline; `independent-reviewer` in missions only **after** execution | A bounded review → fix → review loop before execution; blocking defects stopping the "ready" status |

### 3.3. The Result Contract and its use (MP §4–§9)

| Requirement | State | Note |
|---|---|---|
| A single formal contract shared by all agents (MP §4) | **Missing** | Each agent has its own input shape; there is no shared object |
| Structure validation, required fields, unique IDs, reference checks | Partial | Only in the spec pipeline (`validateRequirements`, `validateTasks`) and for plan steps |
| Every requirement has acceptance criteria | Partial | Pipeline: yes. Missions: criteria exist, but nothing ties them to requirements |
| Schema versioning, preserved original request, change history, decision rationale | Partial | `original_request` is kept unchanged. The `revision` counter and the audit log say **that** something changed, not **what**. Only the strategy carries a rationale |
| An agent cannot change the structure to bypass checks | Works for agent outputs | Outputs are validated against package schemas and the engine copies only known fields. There is no contract object to protect yet |
| The eight roles (MP §5) | Partial | Coordinator: the engine (code) plays this role, plus `mission-analyst`. Requirements analyst: `mission-analyst` (shallow; the real `requirements-analyst` is unused). Researcher: yes. Architect: yes. Decomposer: `mission-planner`. Implementer: yes. Verifier: yes. Independent reviewer: only after execution |
| Minimal set of roles per task | Works | `nextPhase` skips context, research, strategy and review when the analyst says they are not needed (`engine.ts:978`) |
| Structured handoff (MP §6) | Partial | Inputs are structured but role-specific. Missing: confirmed vs allowed-assumption requirements, forbidden actions, required permissions, completion conditions, report format |
| Structured report and "do not trust the previous agent" | Partial | The implementer's claimed actions are cross-checked with tool calls (`engine.ts` `execStep`). Other roles are not. The verifier never sees which requirement a step was meant to satisfy |
| Expected vs actual vs evidence (MP §7) | Partial | Criteria carry `status` + `evidence` + `decidedBy`. There is no list of **expected** artifacts, so "actual" cannot be compared with "expected" |
| Bounded fix loop (MP §8) | Partial | Bounded by rounds (`maxFixRounds`, 0–5, default 2) and re-verified. **Not bounded by time.** No root-cause classification. No stop when the fix would need a requirement, architecture or permission change |
| Integration (MP §9) | Works / Partial | Logging (`mission_events`), recovery (`start()` pauses interrupted missions, side-effect steps are not repeated), step persistence. **Spec versions are not stored** |

### 3.4. UI (MP §10)

The mission page is one long page. It already shows: the original request, assumptions, criteria with status, the plan, the log, limitations, the outcome, approvals, pause and resume, retry, requirement adding, criteria editing and plan editing.

**Missing from MP §10:**
- the structured understanding of the task and the expected result;
- a requirements registry with acceptance criteria per requirement;
- issues and open questions as a list;
- research results;
- expected vs actual artifacts;
- verification results per criterion with evidence links;
- mismatches;
- the history of the specification.

**Missing user actions:**
- confirm or reject an assumption;
- edit a single requirement;
- exclude a feature (move to out of scope);
- approve the specification as such (only the plan is approved);
- re-run verification as an explicit action (possible only indirectly).

### 3.5. Tests (MP §11)

The 20 required scenarios map onto the existing 29 tests as follows (details in the design, §9):
- **Covered:** 9 scenarios (2, 6, 7, 10, 12, 13, 14, 15, 16).
- **Partly covered:** 5 scenarios (1, 4, 5, 9, 11).
- **Not covered:** 6 scenarios (3, 8 at the mission level, 17, 18, 19, 20).

### 3.6. Quality metrics (MP §12)

- The spec pipeline computes `withCriteriaPct`, `withVerifiedSourcePct`, `coveragePct`, `mustCoveragePct` and `orphanTasks`.
- Missions compute none.
- There is no harness that runs the same requests through two versions.

## 4. Where the understanding of the result is lost

The chain of a mission and the points where information disappears:

```
request ──L1──▶ NormalizedTask ──L2──▶ criteria ──L3──▶ plan steps ──L8──▶ agent inputs ──L4──▶ verification
                     │L6                                     │L5                              │L11
                assumptions as text                  no spec, no pre-review           fix = "try again"
```

| ID | Loss | Root cause | Consequence |
|---|---|---|---|
| L1 | The result is a sentence, not a definition | `NormalizedTask.desired_outcome: string`; the analyst schema has no fields for result type, composition, behaviour, inputs, outputs, artifacts | An executor or verifier cannot tell **what must exist** at the end; "make a good search" survives as "a good search" |
| L2 | Criteria are detached from requirements | Two parallel lists (`R<n>`, `AC<n>`) without links (`mission-analyst/schemas/output.schema.json`) | It is impossible to tell which requirement is unverified; "all criteria met" can hide a requirement with no criterion |
| L3 | Requirements fall out of the plan silently | `PlanStep` has no `requirement_ids`/`criterion_ids`; `validatePlan` checks no coverage | A requirement the planner forgot is never executed, yet nothing flags it before verification |
| L4 | "Artifact exists" means "anything exists" | `guardCriteria` case `artifact_exists` (`verify.ts:63`): `ctx.artifacts.some(x => x.status !== 'missing')` | A wrong or unrelated artifact satisfies the criterion (MP §11 scenario 9 is only partly protected) |
| L5 | No specification and no review before execution | Missions have no stage 7/8 equivalent; the reviewer runs after execution | Misunderstandings cost a full execution round; the user approves a plan, not a definition of the result |
| L6 | Assumptions blend into facts | Non-blocking question defaults are concatenated into `assumptions` as text (`engine.ts:1250`); `inferred` requirements are not marked when they reach the verifier; no confirm/reject state | The verifier and the user cannot see which requirements rest on a guess |
| L7 | Contradictions inside the original request are not detected | The conflict check exists only for requirements added later (`engine.ts:1560`); `spec/validators.ts` is not used | Conflicting requirements reach execution |
| L8 | Handoffs carry the "what", not the "how it will be judged" | `stepInput` passes all requirements, a free-text `done_criteria` and no forbidden actions or allowed paths | An implementer cannot tell which criteria its step must satisfy; going beyond the step is not detected (scenario 17) |
| L9 | The specification has no history | `revision` counter + `extra_requirements`; no snapshots; decisions other than the strategy have no rationale | "Why was this decided?" cannot be answered (MP §4) |
| L10 | Two algorithms | Missions and the spec pipeline evolved separately | Duplicated effort; the better requirements model is unused by the main path |
| L11 | The fix loop does not reason about causes | `phaseFix` sends the problem list to the implementer; bounded only by rounds | A fix that needs a requirement or permission change is attempted anyway; there is no time bound |
| L12 | No measurements | No metrics in missions | Improvements cannot be shown (MP §12) |

## 5. What works and must be preserved

- **The honest-outcome rules** (`guardCriteria`, `finalStatus`, `blockingProblems`): an agent's "done" without evidence is not accepted, and skipped stages rule out "Completed". The new contract feeds these rules; it does not replace them.
- **Idempotent, persisted steps** (`stepKey`, `idempotency_key`): recovery and re-entry never repeat finished work, and side-effect steps are never repeated silently.
- **Local-first model handling**: schema validation with repair, fallback to another local model and never to the cloud, budgets and timeouts.
- **Security boundaries**:
  - tools per role;
  - scope (`RunScope`);
  - checks only by name and only in a work copy;
  - change sets applied only by an explicit user decision;
  - access modes never raised by the engine.
- **Grounding of quotes** in code.
- **Adaptive phase skipping**, the "minimal set of roles" principle.
- **The spec pipeline's validators and renderer**: they should become the shared validation layer, not a second implementation.

## 6. Required changes (input for the design)

In priority order. Each item names the loss it closes.

1. **One data model, the Result Contract**, owned by code and versioned. Agents propose and the engine merges, so agents never write the contract directly. Closes L1, L2, L9, L10.
2. **Result definition and requirements registry in the analysis stage.** Requirements get a type, priority, status and source. Acceptance criteria hang **under** requirements. Assumptions and questions get IDs and states. Closes L1, L2, L6.
3. **Deterministic contract validation** that reuses and extends `spec/validators.ts`: IDs, references, coverage, vague terms, missing criteria, cycles, assumption misuse. Applied after every merge. Closes L2, L3, L7.
4. **Plan steps reference requirements, criteria and expected artifacts.** Coverage is checked before execution. Closes L3, L8.
5. **A specification stage and a bounded pre-execution review.**
   - The specification is rendered deterministically from the contract.
   - Validators always run; `spec-reviewer` runs for moderate and complex tasks.
   - The user approves the specification.

   Closes L5, L7.
6. **A common handoff and report envelope.**
   - Each step receives its requirements, criteria, expected artifacts, forbidden actions and completion conditions.
   - Each report is cross-checked against tool calls and recorded side effects.
   - Changes outside the step's declared artifacts are flagged.

   Closes L4, L8.
7. **Expected vs actual vs evidence**: expected artifacts are matched to produced ones, and evidence is linked per criterion. Closes L4.
8. **The fix loop**:
   - a time bound in addition to rounds;
   - the cause of each failure is classified;
   - the loop stops and asks when a fix would change requirements, architecture, permissions or scope.

   Closes L11.
9. **The UI task workspace** (MP §10) with sections and the missing actions.
10. **The 20 scenario tests, a metrics module and a comparison harness.** Closes L12.

The spec pipeline should then be **re-based on the contract**: the same validators and renderer, `requirements-analyst` and `decomposer` used by missions for complex tasks. It must not be extended separately.

## 7. Limits of this audit

- **No model was run**, so the quality of analyst outputs on real requests is unknown. Small local models may fail the richer schema; the design addresses this by splitting stages and repairing in code.
- **The UI was assessed from source, not in use.** The M0 screenshots show the English UI, but nobody tested it for usability.
- **Workflow features beyond the spec pipeline were not audited** (the generic workflow editor, extensions).
