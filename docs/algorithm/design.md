# Design: the Definition-to-Verified-Result algorithm (Phase B)

Date: 2026-10-15. Input: the audit ([`audit.md`](audit.md)) and the master prompt ([`docs/spec/definition-to-verified-result.md`](../spec/definition-to-verified-result.md), "MP"). Worked examples: [`examples.md`](examples.md).

This document fixes the decisions that the implementation follows (milestones M2–M4, §13). Anything marked **decision** may only change through an update of this document.

## 1. Principles

1. **One algorithm.** The mission engine becomes the Definition-to-Verified-Result (DVR) engine. The specification pipeline stops being a separate path (§12). Every task goes through the same stages; stages that a task does not need are skipped by explicit rules, not by a second algorithm.
2. **One data model.** The **Result Contract** is the single, versioned description of the task. Every role reads it, and every check is a function of it.
3. **Code owns the contract; agents propose.**
   - Agents return their own small, schema-validated outputs.
   - The engine merges those outputs into the contract through typed operations. An agent therefore cannot change the structure, delete a requirement silently or mark something verified.
4. **Expected, actual and evidence are three separate things** (MP §7). The contract holds the **expected** result, and the **result record** holds what was **actually** produced together with the **evidence** for each criterion. A criterion is met only by evidence, never by a claim.
5. **Deterministic first.** Whatever code can check reliably, code checks: IDs, references, coverage, artifact presence, quotes, check results, vague wording. Models judge only what needs judgement: meaning, contradictions, the quality of a specification.
6. **Minimal sufficient roles.** The coordinator is the engine's code, which takes routing hints from the analyst. Roles that cost a model call run only when the task needs them (§4.3).
7. **No new power from text.** A requirement, a plan step or an agent report never grants a tool, a path, a network or an access mode. Permissions come only from the mission scope, the role's package and the user's decisions, and a step can only narrow them.

## 2. Stage mapping

The eight stages of MP §3 map onto mission phases. Two phases are new (**bold**).

| DVR stage (MP §3) | Mission phase | Who does the work | What goes into the contract |
|---|---|---|---|
| 1. Intent interpretation | `analysis` | `mission-analyst` (one call) | `intent`: the user's verbatim statements kept apart from interpretations; missing information; ambiguities |
| 2. Result definition | `analysis` (same call) + code | `mission-analyst`, then the merge in code | `result` (12 properties), `requirements` with nested `acceptance_criteria`, `expected_artifacts`, `scope`, `assumptions`, `open_questions`; code adds system constraints and derives the verification plan |
| 3. Context and research | `context`, `research`, `strategy` (unchanged, conditional) | `project-explorer`, `researcher`, `web-researcher`, `solution-architect` | Research facts linked to requirements; `decisions` (the chosen option with alternatives and rationale) |
| 4. Requirements registry | **`requirements`** | Code; `requirements-analyst` for complex tasks or when validation finds gaps that need judgement | Requirement patches (add, update, reject) with reasons |
| 5. Ambiguities, gaps, contradictions | **`requirements`** (same phase) | Validators (code); `contradiction-checker` for moderate and complex tasks; the user for blocking questions | `issues`, `open_questions`, resolutions as `decisions` |
| 6. Decomposition | `planning` | `mission-planner` | `implementation_plan` (subtasks linked to requirements, criteria and artifacts); coverage is checked by code |
| 7. Final specification | **`specification`** | Code (deterministic renderer) | A rendered specification, saved with the contract version |
| 8. Independent spec review | **`specification`** (bounded loop) | Validators; `spec-reviewer` for moderate and complex tasks | Review findings; defects go back to stage 4 or 6; at most `maxSpecReviewRounds` rounds |
| Approval | pending kind `spec` | The user (or auto-approval, §6.4) | `status = approved`; a decision entry |
| Execution | `execution` | Roles through a **handoff** (§5) | Result record: actual artifacts and step reports |
| Verification | `verification` | Code checks, the `verifier`, the guard | Evidence per criterion; criterion status |
| Fix loop | `fix` | `implementer` with a bounded fix task (§7) | A new result-record round |
| Final review | `review` | `independent-reviewer` | Distortion and defect findings |
| Summary | `summary` | Code | Final status (honest-outcome rules, §6.5) and a report |

**Decision.** Phase order: `analysis → context → research → strategy → requirements → planning → specification → execution → verification ⇄ fix → review → summary`.
- `requirements` comes after `strategy` because MP stage 4 turns "the request **and the research**" into the registry.
- The architect works from the draft registry that analysis produced.

Phase → status mapping (`statusForPhase`): `requirements → analyzing`, `specification → planning`. **The set of statuses does not change**, so the lifecycle and the existing transition tests stay valid.

## 3. The Result Contract, schema v1

Format: JSON with snake_case field names (the same convention as the agent outputs). TypeScript types live in `packages/core/src/contract/types.ts`; the JSON Schema lives in `contract/schema.ts`.
- Every object in the schema has `additionalProperties: false`, so no field can be added "around" the checks.
- The schema is validated with the Ajv instance the agent runtime already uses.

### 3.1. Top level

```jsonc
{
  "schema_version": "1.0",
  "contract_id": "M-12",              // = mission key; "task_id" of MP §4
  "version": 7,                       // +1 on every accepted change
  "status": "approved",               // draft | in_review | approved | in_progress | verified | partially_verified | failed | cancelled
  "title": "Add a --version flag to the CLI",
  "original_request": "…verbatim, never changed after version 1…",
  "attachments": [{ "kind": "document", "ref": "doc_…", "title": "…" }],
  "intent": { … },                    // §3.2
  "problem_statement": "…",
  "objective": "…",
  "result": { … },                    // §3.3
  "scope": { "in_scope": [ScopeItem], "out_of_scope": [ScopeItem] },
  "assumptions": [Assumption],
  "constraints": [Constraint],
  "requirements": [Requirement],      // §3.4, with nested acceptance criteria
  "expected_artifacts": [ExpectedArtifact],
  "implementation_plan": [Subtask],   // §3.5
  "risks": [Risk],
  "open_questions": [Question],
  "issues": [Issue],
  "decisions": [Decision],
  "verification_plan": [VerificationItem],
  "completion_conditions": [CompletionCondition],
  "history": [HistoryEntry]           // §3.7
}
```

**Identifier formats.** IDs are unique within a contract, stable across versions and never reused. The engine assigns them (§3.6).

| Entity | Format | Entity | Format |
|---|---|---|---|
| Requirement | `REQ-001` | Assumption | `ASM-001` |
| Acceptance criterion | `AC-001` | Constraint | `CON-001` |
| Expected artifact | `ART-001` | Question | `Q-001` |
| Subtask (plan step) | `S1`, `S2`, … | Issue | `ISS-001` |
| Scope item | `SC-001` | Decision | `DEC-001` |
| Risk | `RSK-001` | Verification item | `VER-001` |
| Completion condition | `DONE-001` | Evidence (result record) | `EV-001` |

Plan steps keep the existing `S<n>` format, which the planner, `validatePlan`, the UI and 29 tests already use. Changing it would buy nothing.

### 3.2. Intent (stage 1)

```ts
interface Intent {
  problem: string;               // what problem the user wants solved
  goal: string;                  // the intended goal
  object: string;                // what is worked on (a project, a document, a module…)
  expected_result: string;       // the user's expectation, in one or two sentences
  audience: string;              // who the result is for
  usage_context: string;         // where it will be used
  user_statements: string[];     // VERBATIM fragments of the original request
  explicit_constraints: string[];
  implied_requirements: string[];   // the analyst's reading; never confirmed by itself
  missing_information: string[];
  ambiguities: string[];
}
```

**Rule (code).**
- Every `user_statements[i]` must be a substring of the **user's own words** after normalization (case, whitespace, typographic quotes and dashes).
- The user's own words are `original_request` plus the user's answers to questions and the user's clarifications. All of them are stored as user messages of the mission.
- A statement that is not found produces a **major** finding `fabricated_statement`.

This is how the system keeps "what the user said" apart from "what an agent thinks the user meant" (MP §3 stage 1).

### 3.3. Result definition (stage 2, the 12 properties)

```ts
interface ResultDefinition {
  result_type: 'software' | 'feature' | 'bugfix' | 'document' | 'specification' | 'research' | 'analysis' | 'integration' | 'automation' | 'other'; // 1
  purpose: string;                 // 2: which problem the result solves
  users: string[];                 // 3: who uses it and in which conditions
  composition: string[];           // 4: files, components, sections or data that must exist
  behavior: string[];              // 5: "when …, then …" statements
  inputs: string[];                // 6
  outputs: string[];               // 7
  constraint_ids: string[];        // 8: → constraints[]
  quality_criteria: string[];      // 9: each must be backed by a requirement with a criterion (validator)
  // 10. acceptance criteria live under requirements[].acceptance_criteria
  verification_approach: string;   // 11: summary; concrete methods are per criterion
  artifact_ids: string[];          // 12: → expected_artifacts[]
}
```

**Decision.** Acceptance criteria are not duplicated in the result definition. They hang under requirements, so every criterion proves a specific requirement and no criterion floats free. This closes audit loss L2.

### 3.4. Requirements and acceptance criteria (stage 4)

```ts
interface Requirement {
  id: string;                      // REQ-001
  title: string;
  description: string;
  rationale: string;
  source: 'user' | 'attachment' | 'project' | 'research' | 'agent_proposal' | 'decision';
  request_quote: string | null;    // required for source=user: a verbatim fragment of the user's words (request, answers, clarifications; checked)
  evidence_ids: string[];          // grounded evidence or claims from context/research
  type: 'functional' | 'non_functional' | 'constraint' | 'security' | 'interface' | 'data' | 'integration' | 'documentation' | 'other';
  priority: 'must' | 'should' | 'could';
  status: 'confirmed' | 'proposed' | 'assumption' | 'needs_clarification' | 'rejected' | 'superseded';
  confirmed_by: 'request' | 'user' | 'decision' | null;   // set by CODE only
  related: string[];               // REQ ids
  dependencies: string[];          // REQ ids
  acceptance_criteria: AcceptanceCriterion[];
  implementation_status: 'not_started' | 'in_progress' | 'implemented' | 'verified' | 'failed' | 'not_applicable';
}

interface AcceptanceCriterion {
  id: string;                      // AC-001
  condition: string;               // an observable condition
  verification_method: 'artifact_exists' | 'check_command' | 'review' | 'source_verification' | 'manual';
  artifact_ids: string[];          // which expected artifacts it inspects (artifact_exists, review)
  check: { source_id: string; name: string } | null;     // a named project check (check_command)
  expected_evidence: string;       // what will prove it
}
```

**The categories of MP §3 stage 4** map onto fields as follows:

| MP category | Contract representation |
|---|---|
| User requirements | `source=user`, `status=confirmed`, `confirmed_by=request` |
| Conclusions drawn from the project | `source=project` or `research`, with `evidence_ids` |
| Agent proposals | `source=agent_proposal`, `status=proposed` until the user confirms |
| Confirmed decisions | `source=decision` + a `decisions[]` entry |
| Unconfirmed assumptions | `status=assumption` or `assumptions[]` with `status=proposed` |
| Open questions | `open_questions[]` with `status=open` |

**Decision.** Verification methods stay the five that the guard already enforces (`verify.ts`). The MP's methods map onto them:
- automated test, run → `check_command`;
- comparison, inspection → `review`;
- demonstration → `manual`;
- the presence of a file or document → `artifact_exists`;
- confirmation by sources → `source_verification`.

More methods would add enum values for small models to confuse, without giving the guard anything new to enforce.

**Priority** is MoSCoW without "won't": an item that will not be done goes to `scope.out_of_scope` with a reason. That is also how the "exclude an unnecessary feature" action works (§10).

### 3.5. Expected artifacts, subtasks and other entities

```ts
interface ExpectedArtifact {
  id: string;                      // ART-001
  kind: 'file_change' | 'document' | 'report' | 'specification' | 'check_result' | 'agent_draft' | 'workflow_draft' | 'other';
  description: string;
  location: string | null;         // a path glob ("src/search/**") or a vault folder ("Missions/")
  requirement_ids: string[];
  required: boolean;
}

interface Subtask {                // = the existing PlanStep, extended
  id: string;                      // S1
  title: string; goal: string; role: PlanRole;
  inputs: string[]; actions: string[]; expected_output: string;
  requirement_ids: string[];       // which requirements the step serves
  criterion_ids: string[];         // which criteria it must satisfy
  artifact_ids: string[];          // which expected artifacts it creates or changes
  depends_on: string[]; tools: string[];
  permissions: string[];           // informational; validated against the role, never granted by it
  done_criteria: string[];         // completion conditions (existing field name kept)
  escalate_when: string[];         // when to stop and ask
  verification: string; risk: 'low' | 'medium' | 'high'; keep_existing: boolean;
}

interface ScopeItem { id: string; text: string; source: 'user' | 'agent_proposal' | 'decision'; reason: string | null }
interface Assumption { id: string; text: string; source: 'analyst' | 'default_answer' | 'user'; status: 'proposed' | 'confirmed' | 'rejected'; impact: string; refs: string[] }
interface Constraint { id: string; text: string; kind: 'scope' | 'technology' | 'security' | 'privacy' | 'policy' | 'resource' | 'compatibility' | 'other'; source: 'user' | 'project' | 'system' }
interface Question { id: string; text: string; blocking: boolean; impact: 'architecture' | 'security' | 'cost' | 'reversibility' | 'acceptance' | 'scope' | 'other'; options: string[]; default_assumption: string | null; status: 'open' | 'answered' | 'assumed' | 'withdrawn'; answer: string | null; refs: string[] }
interface Issue { id: string; type: FindingType; severity: 'critical' | 'major' | 'minor'; description: string; refs: string[]; options: string[]; resolution: string | null; status: 'open' | 'resolved' | 'accepted'; found_by: 'validator' | 'agent' | 'user'; found_in: 'requirements' | 'specification' | 'verification' | 'review' }
interface Decision { id: string; text: string; rationale: string; alternatives: string[]; decided_by: 'user' | 'architect' | 'engine' | 'reviewer'; refs: string[]; at: string }
interface Risk { id: string; text: string; level: 'low' | 'medium' | 'high'; mitigation: string; refs: string[] }
interface VerificationItem { id: string; criterion_ids: string[]; method: AcceptanceCriterion['verification_method']; check: { source_id: string; name: string } | null; owner: 'code' | 'verifier' | 'user'; when: 'after_step' | 'final'; step_id: string | null }
interface CompletionCondition { id: string; text: string; kind: 'criteria' | 'artifacts' | 'checks' | 'approval' | 'other' }
```

**System constraints.** Code adds constraints with `source=system` from the facts of the mission, so that every role and the rendered specification see them. Examples:
- "Project *X* is in *Read only* mode: no file changes can be prepared."
- "Web access is not allowed for this mission."
- "The vault is read only."

Agents cannot remove them.

**Derived parts.** `verification_plan` and `completion_conditions` are derived by code from the criteria, artifacts and plan, never written by agents:
- one verification item per criterion method and check;
- the conditions "every applicable criterion met", "every required artifact present", "required checks passed" and, when changes must reach a project, "the user applied the change set".

### 3.6. Identifier allocation and stability

- Agents use **local** IDs in their outputs (`R1`, `AC1`, `A1`), which are easy for small models. The engine maps them to contract IDs (`REQ-001`, …) and rewrites the references inside that output.
- Later agent inputs show contract IDs, and the agents refer to them.
- **Stability on re-analysis.** When the analyst runs again (after answers), each new item is matched to an existing one by an exact normalized text match, then by high similarity (Jaccard ≥ 0.85 on words, the measure the spec validators already use).
  - A match keeps the old ID and its status.
  - Anything else gets the next free number.
  - An existing item without a match becomes `superseded`. It is never deleted, and a history entry records the change.
- IDs are never reused: the allocator takes `max(existing, retired) + 1`.

### 3.7. Versioning and history

- **Schema version.** `schema_version: "1.0"`. A loader `upgradeContract(json)` applies migrations step by step. An unknown major version is refused with the new error code `CONTRACT_SCHEMA_UNSUPPORTED`; nothing is guessed.
- **Contract version.** Every accepted merge or user edit creates version `n+1`:
  - the full snapshot goes into the new table `mission_contracts(mission_id, version, contract, actor, reason, created_at)`;
  - `missions.contract_version` points to the current version;
  - snapshot and pointer are written in **one transaction** together with the mission's phase change. A crash therefore never leaves a phase that refers to a contract version that does not exist.
- **History entry:**

```ts
interface HistoryEntry {
  version: number; at: string;
  actor: 'user' | 'engine' | `agent:${string}`;
  action: 'create' | 'analysis' | 'requirements' | 'plan' | 'answer' | 'assumption' | 'edit' | 'exclude' | 'constraint' | 'review' | 'approve' | 'status';
  summary: string;
  changes: { op: 'add' | 'update' | 'remove'; path: string; before?: unknown; after?: unknown }[];  // path: "requirements/REQ-003/priority"
  reason: string | null;
}
```

- **"Why was this decided?"** Every non-trivial choice produces a `decisions[]` entry with its rationale, its alternatives and who decided. This covers the chosen option, a resolved contradiction, an exclusion, an assumption the user confirmed, and an approval despite findings. History entries point to that decision.
- **Snapshots** let the UI show the difference between any two versions (§10).
- **Immutability.** `original_request` is set at version 1, and the validator compares it with version 1 on every version. A change produces a **critical** finding `original_request_changed`.

### 3.8. Validation rules

Validation is a pure function `validateContract(contract, ctx) → { findings, metrics }`. It runs after every merge and every user edit. It reuses `vagueTerms`, `MEASURABLE`, `dependencyCycles` and the Jaccard duplicate check from `spec/validators.ts`; it does not copy them.

| Code | Severity | Rule |
|---|---|---|
| `schema_invalid` | critical | The JSON Schema check failed (structure, enums, required fields, unknown fields) |
| `duplicate_id` | critical | An ID repeats within the contract (any entity type) |
| `bad_id` | critical | An ID does not match its entity's format |
| `broken_ref` | critical | A reference points to a missing ID (requirement dependencies or related, criterion artifact IDs, subtask requirement, criterion, artifact or step IDs, artifact requirement IDs, risk, issue or decision refs, verification item criteria, result constraint and artifact IDs) |
| `cycle` | critical | A cycle in requirement dependencies or in subtask `depends_on` |
| `original_request_changed` | critical | Differs from version 1 |
| `blocking_question_open` | critical (gate) | A question with `blocking=true` and `status=open` |
| `missing_criteria` | major (must) / minor (should, could) | An active requirement without acceptance criteria |
| `criterion_method_mismatch` | major | `artifact_exists` without `artifact_ids`; `check_command` naming a check that does not exist for the project |
| `uncovered` | major (must) / minor | Once a plan exists: an active requirement not referenced by any subtask, or a criterion not assigned to any subtask or to final verification |
| `orphan_task` | minor | A subtask (except verifier and documenter) with no `requirement_ids` |
| `artifact_unowned` | major | A required expected artifact that no subtask produces (once a plan exists) |
| `fabricated_statement` | major | A `user_statements` entry or a `request_quote` is not in the user's own words (request, answers, clarifications) |
| `unconfirmed_proposal` | major | `source=agent_proposal` (or `research`/`project`) with `status=confirmed` but `confirmed_by` not in {user, decision} |
| `assumption_as_fact` | major | A `must` requirement whose only basis is an assumption (`status=assumption`) at approval time |
| `vague` | minor (major for `must`) | Vague wording (the `VAGUE` list) without a measurable criterion (`MEASURABLE`) in the requirement or its criteria |
| `invented_threshold` | minor | A numeric threshold in a criterion of a requirement with `source=agent_proposal` and no `evidence_ids`: flagged for confirmation (MP: "do not invent arbitrary norms") |
| `duplicate` | minor | Near-duplicate requirements (Jaccard ≥ 0.85) |
| `empty_result` | major | `result.purpose` empty, or `result.composition` and `result.outputs` both empty, or no expected artifacts for `software`/`feature`/`bugfix`/`document`/`specification` results |
| `no_functional` | major | A result of type `software`/`feature`/`bugfix` without any active functional requirement |
| `scope_overlap` | minor | The same text in `in_scope` and `out_of_scope` |
| `role_permission` | critical | A subtask requests a permission or tool that its role's package does not have |

**Gates:**
- **Execution may start only when:**
  - there are no critical findings;
  - no blocking question is open;
  - `status = approved`, either by the user or by auto-approval (§6.4).
- **Auto-approval is possible only when** there are no major findings and no open agent proposals or assumptions on `must` requirements.

### 3.9. The result record: actual results and evidence

```ts
interface ResultRecord {
  contract_version: number;        // the contract version the work was done against
  round: number;                   // 0 = first execution, n = after fix round n
  artifacts: { ref: string; kind: ExpectedArtifact['kind']; location: string; produced_by: string | null; expected_id: string | null; exists: boolean; checked_at: string }[];
  evidence: { id: string; criterion_id: string; kind: 'check_run' | 'artifact' | 'quote' | 'review' | 'user_confirmation'; ref: string; summary: string; by: 'code' | 'agent' | 'user'; at: string }[];
  criteria: { id: string; status: CriterionStatus; evidence_ids: string[]; decided_by: 'verifier' | 'guard' | 'user'; notes: string }[];
  reports: StepReport[];           // §5.2
}
```

**Invariants (code):**
1. **A criterion is `met` only with at least one evidence item whose `ref` resolves to a real record:** a `mission_checks` row, an existing document or a change-set file that was not skipped, a grounded quote, or a user confirmation. Agent text alone is never a `ref`. The existing guard remains the final arbiter of statuses.
2. **An expected artifact is present** only when a produced artifact has the same kind and its location matches the expected glob or folder, and the artifact still exists. `artifact_exists` criteria check **their** `artifact_ids`, not "any artifact". This closes audit loss L4 and MP §11 scenario 9.
3. **A report item counts only when a tool call or a recorded side effect confirms it.** "Created X" without `create_document` or `propose_file_change` succeeding is discarded, and the discard is noted.
4. **A passing check is evidence only for `check_command` criteria.** It counts for the criterion's own `check`, or for any check of that project when the criterion names none (the current behaviour). A green build never satisfies a `review` or `artifact_exists` criterion.

## 4. Roles

### 4.1. MP roles → agents

| MP role (MP §5) | Implementation | Change |
|---|---|---|
| Coordinator | **The engine's code** (`nextPhase`, the gates, merges), with routing hints from `mission-analyst` (`complexity`, `needs`) | **Decision:** no model-based coordinator. Routing is deterministic, cheaper and testable. The `coordinator` agent remains only for the legacy workflow |
| Requirements analyst | `mission-analyst` (draft registry, stage 1–2) + `requirements-analyst` (refinement, stage 4, complex tasks) | Both packages get a major version: v2 output shapes (§4.2) |
| Researcher | `project-explorer`, `researcher`, `web-researcher` | Outputs are linked to requirements by ID where the agent can tell; otherwise code links them by the step's `requirement_ids` |
| Architect | `solution-architect` | Its choice becomes a `decisions[]` entry with alternatives |
| Decomposer | `mission-planner` | v2: steps carry `requirement_ids`, `criterion_ids` and `artifact_ids` |
| Implementer | `implementer` (also `documenter` for documents) | Receives a handoff (§5.1); its report is cross-checked (§5.2); file changes outside the step's artifact locations are denied (§5.3) |
| Verifier | Code checks + `verifier` + the guard | v2: receives requirements with their criteria and expected artifacts; each problem has a `cause` (§7) |
| Independent reviewer | `spec-reviewer` **before** execution (stage 8) and `independent-reviewer` **after** it | `spec-reviewer` v2 receives the rendered spec and the checklist of MP §3 stage 8 |

`contradiction-checker` is reused in the `requirements` phase. `mission-advisor` is unchanged: it discusses, but it never changes anything without a user action.

### 4.2. Agent output changes (summary)

All changes are **additive with defaults** wherever possible, so that small models can omit them. Code fills the defaults and the validators report what is missing. Every changed package gets a major version (`2.0.0`), and the agent test cases are updated with it.

| Agent | New or changed output |
|---|---|
| `mission-analyst` | `intent` (§3.2); `result` (§3.3, compact); `requirements[]` with `type`, `priority`, `source`, `request_quote` and nested `acceptance_criteria[]`; `expected_artifacts[]`; `out_of_scope[]`; `assumptions[]` as objects; `questions[]` with `impact` and `options` |
| `requirements-analyst` | **Patches**, not a rewrite: `add[]`, `update[]` (by ID: changed fields), `reject[]` (ID + reason), new criteria, `issues[]`. A patch cannot touch `id`, `confirmed_by`, `status=confirmed` or `original_request` |
| `contradiction-checker` | `issues[]` with `refs` to contract IDs (existing shape) |
| `mission-planner` | `steps[].requirement_ids`, `criterion_ids`, `artifact_ids`; optional `actions`, `permissions`, `escalate_when` |
| `spec-reviewer` | `checklist[]`: the 11 questions of MP §3 stage 8, each with `ok` and `reason`; `defects[]` with `target` (an ID or a section), `stage` (`result`, `requirements`, `plan`, `other`) and `severity`; `verdict` |
| `implementer`, `documenter`, `researcher` | Optional report fields: `requirements_addressed`, `criteria_addressed`, `decisions_needed`, `not_done` |
| `verifier` | Input: requirements with criteria, expected artifacts, the result record. Output: per-criterion `evidence_refs`; `problems[].cause` |

### 4.3. The minimal set of roles per task

| Task | Roles that run (model calls) |
|---|---|
| Simple (`complexity=simple`, no alternatives) | analyst → planner → executor role(s) → verifier. Requirements and specification review: **code only**. No context or research unless the analyst asks for it |
| Moderate | + context roles if needed; + `contradiction-checker`; + `spec-reviewer` (one round) |
| Complex | + `solution-architect`; + `requirements-analyst`; + `spec-reviewer` (up to `maxSpecReviewRounds`); + `independent-reviewer` |

**Decision.** For a simple task, the specification review is deterministic: the full validator plus the gates.
- MP stage 8 asks for an independent review, and code is an independent reviewer of structure.
- What it cannot judge (meaning) is still covered after execution by the verifier and the guard.
- The trade-off is stated in the limitations (§14). The mission policy can force the model review (`reviewSpec: 'always'`).

## 5. Handoff and report contracts (MP §6)

### 5.1. Handoff

Every execution-phase agent receives a `handoff` object in its input, next to the role-specific fields it already receives. A compact text rendering also goes into the step note, for models that follow text better than nested JSON.

```ts
interface Handoff {
  contract_id: string; contract_version: number; subtask_id: string;
  goal: string;
  why: string;                       // the objective + the titles of the linked requirements (MP §14: "why")
  requirements: { id: string; title: string; description: string; priority: string; status: string }[];   // only linked, active ones
  allowed_assumptions: { id: string; text: string }[];   // proposed or confirmed assumptions the step may rely on
  inputs: string[];
  expected_outputs: { artifact_id: string; kind: string; location: string | null; description: string }[];
  result_format: string;             // the agent's output schema (package and version)
  acceptance_criteria: { id: string; condition: string; verification_method: string }[];
  constraints: { id: string; text: string }[];
  forbidden: string[];               // generated by code (below)
  permissions: string[];             // the tools this step may actually use
  dependencies: { step_id: string; title: string; result: unknown }[];
  verification: string;
  done_when: string[];
  escalate_when: string[];
  report: { format: 'step_report/1'; must_include: string[] };
}
```

- **Only relevant context.** The requirements, criteria and artifacts are filtered by the step's links. On top of MP §6, this is the main lever for small context windows (MP §9).
- **`forbidden` is generated by code from facts, never by a model.** Examples:
  - "Do not change files outside: `src/search/**`, `test/search/**`" (from the step's artifacts);
  - "Do not apply changes to the original project";
  - "No web access";
  - "Do not change requirements or acceptance criteria: report a problem instead".

### 5.2. Step report

The engine builds the report: the agent's optional report fields are compared with what actually happened.

```ts
interface StepReport {
  subtask_id: string; agent_id: string; round: number;
  done: string[];                                        // the agent's summary/actions
  artifacts: { ref: string; kind: string; op: string; confirmed: boolean }[];   // confirmed = a tool call or side effect proves it
  requirements_addressed: { id: string; in_scope: boolean }[];                 // in_scope = listed in the subtask
  checks_run: { name: string; status: string; ref: string }[];                 // from mission_checks / tool calls only
  not_done: string[]; problems: string[]; decisions_needed: string[];
  facts_confirmed: string[];                             // grounded quotes or check results
  assumptions: string[];
  discarded_claims: string[];                            // claims without confirmation
}
```

**"Do not trust the previous agent"** (MP §6) is implemented in three places:
1. Dependency results go to the next step as **reports** with `confirmed` flags, not as raw agent text.
2. The verifier sees the reports and the result record, not the agents' self-assessments.
3. The guard accepts only evidence with a real reference (§3.9).

### 5.3. Staying inside the subtask (MP §11 scenario 17)

- **File changes.** When a step declares expected artifacts with locations, the step's run scope gets `allowedPaths`. `propose_file_change` outside them is **denied by the tool layer**:
  - the error code is `OUT_OF_STEP_SCOPE`;
  - the attempt is recorded as an issue (`found_in=verification`, severity major).

  The agent can report the need instead, and the user decides by editing the plan or the artifact locations. A step without declared locations is not path-restricted, but the plan validator warns about it.
- **Tools.** The step's tools are the role's package tools ∩ the mission scope ∩ the step's `tools` list (when it is not empty). A step can only narrow its tools.
- **Requirements.** A report that claims requirements outside the subtask (`in_scope=false`) is shown as a scope finding. Such a claim never counts as coverage.

## 6. Stage behaviour in detail

### 6.1. Analysis (stages 1–2)

- **Input:** the request, the attachments (clipped), the scope, the projects with their access modes, answers and clarifications.
- **Output:** the analyst v2 output (§4.2).
- **The merge in code:**
  1. Map local IDs, set `confirmed_by=request` for `source=user` requirements whose `request_quote` is verified, and downgrade unverifiable user quotes to `source=agent_proposal`.
  2. Add the system constraints.
  3. Derive the verification plan and the completion conditions.
  4. Validate.
- **Questions.**
  - A question may block only if its `impact` is one of architecture, security, cost, reversibility, acceptance or scope (MP §3 stage 5). The engine downgrades any other "blocking" question that has a default answer to a non-blocking question with a recorded assumption.
  - Blocking questions go to the user, at most `MAX_QUESTION_ROUNDS` times (3, as today). After that, the work continues with assumptions, and a limitation is recorded.

### 6.2. Requirements (stages 4–5)

1. **Run the validator.**
2. **Run `requirements-analyst`** if `complexity=complex`, or if the validator found `missing_criteria`/`vague` on `must` requirements, or if research produced new facts. Its input is the contract (requirements, result, constraints, research facts, strategy decision) and the findings; its output is patches.
3. **Apply the patches**, validate, and repeat at most once if the patches introduced new critical findings.
4. **Run `contradiction-checker`** for moderate and complex tasks, and always when the user has added requirements since the last check. Its issues go into `issues[]`.
5. **Critical contradictions and blocking questions** go to the user as one approval of kind `questions` (existing) or `conflict` (existing), carrying options. The answers become decisions.
6. **Requirements that remain unverifiable** (no criterion after refinement) stay in the contract with a `missing_criteria` finding. At verification they are reported as **unverified**, never as met (MP §7).

The planner's `Conflict:` note mechanism (`engine.ts:1560`) remains as a second line of defence for requirements added during execution.

### 6.3. Planning (stage 6)

- The planner receives the requirements (ID, title, priority), the criteria (ID, condition, method), the expected artifacts and the decisions.
- `validatePlan` is extended with:
  - references to existing requirement, criterion and artifact IDs;
  - coverage: every active `must` requirement is covered by some subtask, and every criterion is covered by a subtask or by final verification;
  - every required artifact has a producing subtask;
  - role permissions.
- Coverage failures go back to the planner as feedback, once (as plan errors do today). If they remain, they become **major** findings, and approval is then required.

### 6.4. Specification and review (stages 7–8)

1. **Render** the contract into Markdown, deterministically (`contract/render.ts`).
   - The 22 sections of MP §3 stage 7 appear **when they have content**. Small tasks get a short document.
   - Sections that are empty but required (criteria, completion conditions) are rendered as "not defined", so the gap stays visible.
2. **Validate** (always).
3. **Run `spec-reviewer`** for moderate and complex tasks, or when `reviewSpec=always`. Its defects are routed back: `stage=result` or `requirements` → the `requirements` phase with feedback; `stage=plan` → `planning`. At most `maxSpecReviewRounds` rounds (default 2).
4. **Gate** (§3.8). If blocking defects remain after the rounds, the contract stays `in_review`, and the user gets an approval of kind `spec` that lists the blocking reasons. The user may revise, or approve despite the findings; the latter is recorded as a decision with the findings it overrides.
5. **Approval.**
   - The user approves through the `spec` kind of approval, which replaces the `plan` kind for new missions. Pending approvals of kind `plan` that were saved earlier are still accepted.
   - **Auto-approval** happens when all of these hold: policy `approvePlan` is not `always`; the existing risky-plan rules do not apply; there are no major findings; and no agent proposal or assumption affects a `must` requirement.
   - The approved contract version is recorded. Execution works only against an approved version.

**Saving the specification.**
- For `result_type=specification`, and in plan mode, the rendered document is saved into the vault as the mission's deliverable: one document, updated in place.
- Otherwise it is stored with the contract version and shown in the UI. It is not written into the vault, so the vault does not fill with drafts.

### 6.5. Execution, verification, summary

- **Execution** runs as today (dependencies, parallel read-only steps, implementer steps one at a time). In addition, each step gets a handoff, its report is built (§5.2), and its artifacts are matched to the expected ones.
- **Verification**, in addition to the current behaviour:
  - fills the result record;
  - evaluates `artifact_exists` against the criterion's artifacts;
  - links evidence per criterion;
  - passes the verifier the requirements and the linked criteria.
- **Requirement implementation status** is derived: `verified` when all its criteria are met; `failed` when any criterion is `not_met`; `implemented` when work exists but the criteria are unverified.
- **Final status.** The existing rules apply unchanged: `Completed` only when every applicable criterion is met, nothing failed or was skipped, and nothing blocks. Additions:
  - every required expected artifact is present;
  - no critical contract finding is open.

  Criteria of requirements that are `rejected`, `superseded` or out of scope are `not_applicable`.

### 6.6. Changes during execution (MP §11 scenarios 13–14)

- **A user edit** (requirement, constraint, exclusion, assumption decision) creates a new contract version, revalidates the contract and marks the plan stale (as today). It goes through the `requirements` phase only when contradictions must be checked.
- **Completed steps whose links are unaffected stay completed** (`keep_existing`, as today).
- **An approved contract changed by the user stays approved:** the user's edit is the approval.
- **A change made by the engine or an agent to an approved contract** (a requirements patch after a review) reopens approval.

## 7. The bounded fix loop (MP §8)

1. **Compare the actual with the contract:** collect the failing criteria, the missing artifacts and the failed checks (code).
2. **Classify the cause of each failure.** Code first:
   - failed check or missing artifact → `implementation`;
   - tool or permission denied, or `OUT_OF_STEP_SCOPE` → `permission`;
   - environment or tool unavailable → `environment`.

   Then the verifier's `cause` for the rest: `implementation` | `requirement` | `architecture` | `permission` | `environment` | `unknown`.
3. **Decide whether the failure can be fixed automatically:**
   - **only `implementation` causes are auto-fixable;**
   - `requirement`, `architecture` and `permission` causes, and anything that would change scope, **stop the loop** and create a pending decision (kind `error`, with the classified problems);
   - `environment` causes become limitations.
4. **Create a bounded fix task.**
   - It is a handoff whose `acceptance_criteria` are the failing ones and whose `expected_outputs` are the artifacts of the original steps.
   - Its `forbidden` list adds: "do not change requirements, criteria or the plan; do not widen the scope".
5. **Re-run verification:** checks and the verifier, a full round as today.
6. **Record a new result-record round** and a history entry.
7. **Limits** come from the mission policy and are both enforced:
   - `maxFixRounds` (0–5, default 2; existing);
   - `maxFixMinutes`: new, 1–240, default 30, measured from the start of the first fix round.

   When a limit is reached, the remaining problems become limitations, and the final status cannot be `Completed`.

## 8. Robustness with local models (MP §9)

| Measure | Where |
|---|---|
| Short stages, small schemas; patches instead of rewrites | Analyst v2 keeps fields flat with optional parts; `requirements-analyst` returns patches |
| Only relevant context | Handoffs filtered by links; requirements in planner and verifier inputs are compact (ID, title, priority) |
| Schemas and validation in code | Agent schemas (Ajv) + the contract schema + `validateContract` after every merge |
| Required fields and references checked | §3.8 |
| Intermediate results saved | Every merge is a contract version; every step is a row with an idempotency key that includes the contract version |
| Not relying on instructions | Gates, the guard, the tool-layer path restriction and the code-generated `forbidden` list |
| Deterministic checks as code | Quotes, artifacts, checks, IDs, coverage, vagueness |
| A failure is reported, not hidden | `STRUCTURED_OUTPUT_FAILED` after repairs → fallback to another local model → a pending question of kind `model`/`error` (existing); never a fabricated contract |

## 9. Test plan (MP §11)

**Tests run against scripted model responses** (the existing test harness), so they are deterministic and need no model. Unit tests of the contract module live in `packages/core/test/contract.test.ts`; scenario tests live in `packages/core/test/dvr.test.ts`. Existing tests are referenced as `missions.test.ts` case numbers.

| # | Scenario | Expected behaviour | Pass criteria | Existing coverage |
|---|---|---|---|---|
| 1 | Short, clear task | Analysis → plan → execution → verification without questions; spec review by code only | No question; contract approved automatically; ≤ 4 model calls; `Completed` with evidence per criterion | Partial (case 1 is a research task) |
| 2 | Vague task without a defined result | A blocking question about the result (impact: acceptance); work continues with the answer | One question; after the answer, requirements have criteria; vague wording flagged until measurable | Case 7 |
| 3 | Features listed, no acceptance criteria | `missing_criteria` findings; `requirements-analyst` proposes criteria; criteria without user confirmation stay `proposed` | Findings recorded; approval required; no requirement verified without a criterion | **New** |
| 4 | Contradictory requirements in the request | `contradiction-checker` issue (critical) → `conflict` approval with options before planning | No plan before the resolution; the resolution is a decision | Partial (case 10b covers later additions) |
| 5 | Depends on unknown project characteristics | Context phase runs; unknowns become questions or assumptions; requirements cite project evidence | Requirements with `source=project` carry `evidence_ids`; assumptions listed | Partial (cases 3, 5) |
| 6 | Several alternatives must be researched | Strategy phase; options; decision with alternatives and rationale | A `decisions[]` entry with `alternatives` | Cases 2, 6 |
| 7 | Several specialised agents | Planner assigns roles; independent steps parallel | Handoffs carry only linked requirements | Case 8 |
| 8 | Local model returns an invalid structure | Repair → fallback to another local model → pending `model` question; no contract version is created from invalid output | The contract version is unchanged; no "completed" | Runtime tests; **new** at mission level |
| 9 | Agent reports success but the artifact is missing | The report claim is discarded; `artifact_exists` criterion `not_met` for its specific artifact | `discarded_claims` non-empty; criterion `not_met`; status not `Completed` | Partial |
| 10 | Code created, tests fail | Check failed → fix round(s) → still failing → `Partially completed` / `Failed` | Cases exist | Cases 4, 11 |
| 11 | Some requirements met, others not | Per-requirement implementation status; `Partially completed` with the unmet ones named | Requirement statuses `verified` and `failed` both present | Partial (case 5) |
| 12 | Interrupted and resumed after a restart | Paused with the current contract version; resume continues at the right phase; side-effect steps not repeated | Contract version unchanged by recovery; correct phase | Cases 15a, 15b |
| 13 | The user changes a requirement during execution | New contract version; plan stale; completed unaffected steps kept | History entry; kept steps not re-run | Case 10a |
| 14 | Two requirements conflict after the change | Conflict detected (checker or planner) → user decision | No silent choice | Case 10b |
| 15 | User permission needed to continue | Pending approval (checks, apply, spec) | Nothing runs before the decision | Cases 3, 6 |
| 16 | A required tool or data source is unavailable | Limitation; status not `Completed`; no imitation | Cases exist | Cases 12a, 12d |
| 17 | An agent tries to leave its subtask | `propose_file_change` outside the step's artifact locations → `OUT_OF_STEP_SCOPE`; issue recorded; requirements claimed outside the subtask flagged | Change not in the change set; issue present | **New** |
| 18 | The specification lacks verification criteria | Validator `missing_criteria`; the gate prevents auto-approval; the rendered spec shows "not defined" | No auto-approval; finding listed | **New** |
| 19 | Broken references or duplicate IDs | Validator `broken_ref`/`duplicate_id` (critical) on a planner output → plan feedback; never stored as an approved contract | Gate blocks execution | **New** (unit + scenario) |
| 20 | The independent reviewer finds an error the implementer missed | `independent-reviewer` defect (major) → `Completed` ruled out; a fix round if the cause is implementation | Final status not `Completed`; the defect is in the summary | **New** (case 6 has a passing review) |

**Unit tests of the contract module** cover:
- the schema (unknown fields rejected);
- every validator rule (one positive and one negative case each);
- the ID allocator (stability, no reuse);
- the merge operations (cannot overwrite `confirmed_by` or `original_request`);
- history and diff;
- upgrade of an older schema;
- rendering (sections appear only with content; "not defined" for missing criteria);
- the handoff (filtering by links; `forbidden` generated);
- the report (claims without tool calls discarded);
- expected vs actual matching;
- metrics.

**Examples (Phase C)** become fixtures. The contracts of `examples.md` are stored as JSON under `packages/core/test/fixtures/contracts/`. They must pass `validateContract` with no critical or major findings, and their rendered specifications are compared with stored snapshots.

## 10. UI: the task workspace (MP §10)

The mission page becomes a **workspace with sections** instead of one long page. The live log is one section among others, not the main view. The layout follows the light and calm style planned for M4.

| Section | Shows (MP §10 items) | User actions (MP §10) | API |
|---|---|---|---|
| Overview | 1 original request; 2 how the task was understood (intent; the user's statements highlighted apart from interpretations); 3 expected result (the 12 properties); 9 current stage (stepper); outcome | Correct the understanding (edit the intent and result fields → new version); pause or resume; cancel | `PUT …/contract/understanding`, existing pause, resume and cancel |
| Requirements | 4 requirements with priority, status, source and nested criteria; findings per requirement | Edit a requirement; add a requirement or constraint; exclude a feature (→ out of scope with a reason); confirm or reject an agent proposal | `PUT …/requirements/:rid`, `POST …/requirements` (extended), `POST …/constraints`, `POST …/requirements/:rid/exclude`, `POST …/requirements/:rid/confirm` |
| Questions and issues | 5 open questions, assumptions, issues (validator and agent), contradictions | Answer; confirm or reject an assumption; resolve an issue | Existing `decide`, `POST …/assumptions/:aid` |
| Research | 6 project findings, evidence, web claims with verification status, options and the decision | Ask to research another option (existing) | Existing |
| Plan | 7 subtasks with linked requirements, criteria and artifacts; 8 assigned agents; coverage matrix | Edit the plan (existing, validated) | Existing `PUT …/plan` |
| Specification | The rendered specification of the current version; review findings | **Approve the specification**; request revision | `GET …/spec`, `decide` (kind `spec`) |
| Artifacts | 10 expected vs actual artifacts; change sets | View the actual changes (existing change-set review) | Existing |
| Verification | 11 results per criterion with evidence links; check runs; 12 mismatches (unmet criteria, missing artifacts, scope findings) | Re-run verification; confirm a manual criterion (existing) | `POST …/verify`, existing confirm |
| History | 13 contract versions with the actor, the reason and the diff; decisions with rationale | Compare two versions | `GET …/contract/versions`, `GET …/contract?version=n`, `GET …/contract/diff?from&to` |
| Log | The live event log (existing) | — | Existing SSE |

A pending approval is shown above the sections, as today, with a link to the section it concerns.

## 11. Quality metrics (MP §12)

`contract/metrics.ts` computes the metrics from the contract, the result record and the mission events. They appear in the mission view and in the comparison harness.

| MP criterion | Metric | Formula | Target |
|---|---|---|---|
| Completeness | Statement coverage | Share of `intent.user_statements` that some active requirement's `request_quote` overlaps | 100% |
| | Silent losses | Requirements present in an earlier version and missing later **without** a `superseded`, `rejected` or excluded record | 0 (asserted) |
| Unambiguity | Result definition fill | Filled properties out of 12 (applicable ones for the result type) | Shown |
| | Vague and open items at approval | `vague` findings + open questions + unconfirmed assumptions on `must` requirements | Shown; 0 blocking |
| Verifiability | Criteria coverage | Share of active `must` requirements with ≥ 1 criterion; share of criteria not `manual` | 100% / shown |
| Traceability | Plan coverage | Share of active `must` requirements referenced by subtasks; required artifacts with a producing subtask | 100% |
| | Evidence coverage | Share of applicable criteria with ≥ 1 evidence item at the end | Shown |
| | Artifact match | Share of required expected artifacts present | Shown |
| Consistency | Early detection | Issues found in `requirements`/`specification` vs those found in `verification`/`review` | Shown |
| Executability | Subtask completeness | Share of subtasks with requirement IDs, criterion IDs and completion conditions | Shown |
| Economy | Calls and tokens | Model calls, tokens, roles used, spec review rounds | Shown |
| Robustness | False success | Missions `Completed` with any applicable criterion not `met` or any required artifact missing | 0 (asserted) |
| | Repairs | Structured-output repairs and fallbacks per call | Shown |
| Security | Scope denials | `OUT_OF_STEP_SCOPE` and other denials; access-mode changes by the engine | Shown / 0 |
| Context preservation | Recovery | Resumed missions continuing at the recorded phase and version | 100% in tests |

**Before/after comparison.** A harness (`packages/core/bench/compare.ts`, run with `npm run bench:dvr`) runs a fixed set of requests against a fixture project with known defects and hidden checks. It runs them through the engine **at a given git commit** and through the current one, with the same model, and compares:
- the success rate;
- the false-success rate;
- the questions asked;
- model calls;
- the metrics above, where both versions can compute them.

**Honesty rule (MP §12).**
- No improvement is claimed without a live-model run of the harness.
- This environment has no model, so the harness is verified only with scripted responses. Results with scripted responses demonstrate that the **code paths** work; they are not quality measurements.
- The final report will say which kind of run produced each number.

## 12. The specification pipeline

**Decision.** The separate `spec-pipeline` workflow stops being a product path.
- A specification request becomes a mission with `result_type=specification` (usually in plan mode). Its deliverable is the rendered contract saved into the vault, together with the requirement and task documents that `spec.save` produces today; that saving logic is reused.
- The workflow definition remains as an example of the workflow engine. It must use the contract validators instead of its own copies.

This removes duplicate logic (audit L10) without losing the pipeline's strengths: grounding, validators, traceability rendering and the review loop all move into the main path.

## 13. Implementation plan

| Milestone | Content | Done when |
|---|---|---|
| **M2** Contract core | `packages/core/src/contract/`: types, JSON Schema, `validateContract`, ID allocator, merge operations, history and diff, upgrade, renderer, handoff and report builders, expected-vs-actual matching, metrics. Pure functions, no engine changes | Unit tests for every rule and operation pass; the example contracts validate and render; typecheck and the full suite are green |
| **M3a** Engine integration | Migration v3 (`mission_contracts`, `missions.contract_version`, `missions.result_record`); a contract store; analysis → contract; the `requirements` and `specification` phases; the `spec` approval; handoffs and reports; the step path scope; artifact matching; fix-loop causes and the time bound; API endpoints; agent packages v2 | Existing 29 mission tests pass (adapted only where behaviour intentionally changed, with the reason in the commit); new scenario tests pass |
| **M3b** Scenarios, examples, metrics | The 20 scenario tests; example fixtures; the metrics in the mission view; the comparison harness verified with scripted responses | All 20 scenarios pass; the harness runs end to end |
| **M4** UI workspace | The sections and actions of §10 in the light and calm redesign | Playwright screenshots of each section; no console errors; the actions work against the API |
| M5, M6 | Project knowledge base (MP §15); documentation and the final report | See the master prompt |

**Transition.** The contract is the source of truth from M3a.
- The legacy mission columns (`normalized`, `criteria`, `plan`) become projections written in the same transaction, so the existing UI and API keep working until M4.
- A later migration removes them.
- Missions created before M3a get a contract built from their stored data at load time: schema version `0`, upgraded through `upgradeContract`.

## 14. Risks and limitations

| Risk | Impact | Mitigation |
|---|---|---|
| The richer analyst schema fails more often on small models | More repairs and fallbacks; slower analysis | Flat fields; most new fields optional with code defaults; repairs and fallbacks are measured; if the failure rate is high, split analysis into two calls (intent+result, then the registry) behind a policy switch |
| Simple tasks get no model review of the specification | A semantic misunderstanding is found only after execution | The deterministic gate, the verifier and the guard; the policy `reviewSpec: always`; the metric "issues found late" shows whether this is a real problem |
| The engine grows further (2,785 lines today) | Harder maintenance | The contract logic is a separate pure module; the engine only orchestrates; phases may move into separate files during M3 |
| Two sources of truth during the transition | Inconsistency | Projections written in the same transaction; a test asserts consistency; removal in a later migration |
| ID matching on re-analysis maps a changed requirement to an old one | The wrong history | Only exact or very similar matches keep IDs; otherwise a new ID plus a `superseded` record; the user sees the history |
| More approvals add friction | Users disable approvals | Auto-approval for clean contracts; one combined approval (specification + plan + checks) |
| No live model in the development environment | Quality claims cannot be made | The honesty rule in §11; the harness is ready for the user's local model |
