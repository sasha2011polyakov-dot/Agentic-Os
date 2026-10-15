# Workflow engine

Status: implemented · Code: `packages/core/src/workflows/*`, `spec/*`, `research/functions.ts`, `tasks/tasks.ts`

## 1. Purpose
A workflow is a declarative graph of steps: agents, deterministic platform functions, user decisions and loops. The built-in "Specification" and "Web research" pipelines run on it, and so do the user's workflows from the visual editor.

The engine is responsible for five things. The state **survives a restart**. The user sees **every decision**. **Retries and limits** are enforced automatically. **Actions with side effects** are never repeated silently. **Errors** are reported honestly.

## 2. Workflow definition
```jsonc
{
  "id": "spec-pipeline", "name": "…", "version": 1,
  "inputSchema": { /* JSON Schema of the start form */ },
  "nodes": [
    { "id": "coordinator", "type": "agent", "agent": "coordinator", "title": "Task analysis",
      "dependsOn": ["context"], "input": { "goal": { "$path": "input.goal" } }, "retries": 1 },
    { "id": "ground", "type": "function", "fn": "spec.ground_evidence", "input": { … } },
    { "id": "clarify", "type": "approval", "when": { "path": "…missing_information", "some": { "field": "blocking", "equals": true } },
      "prompt": { … }, "questions": { "$pluck": "…" }, "onReject": "cancel", "allowRevise": false },
    { "id": "revise", "type": "loop", "body": ["requirements", "…", "final"], "until": { … }, "maxIterations": { "$path": "limits.maxReviewIterations" }, "extendWhen": { … } }
  ],
  "output": { "specDocId": { "$path": "nodes.save.output.specDocId" } }
}
```

| Node type | What it does |
|---|---|
| `agent` | Runs an agent of the system through `AgentRuntime`: permissions, budget, step timeout, retries on temporary errors |
| `function` | A deterministic platform function: validators, document assembly, saving. Packages and users **cannot** add functions: definitions contain no executable code |
| `approval` | A user decision: `approve`, `reject` or `revise` with a comment; answers to questions; a choice of options |
| `loop` | Repeats its body until `until` holds or `maxIterations` is reached. `extendWhen` gives extra iterations by the user's decision (at most +5). Nested loops are not supported |

**Data binding** uses a safe expression language without `eval` (`workflows/expr.ts`): `$path`, `$concat`, `$pluck`, `$count`, `$template`, `$literal`. Conditions: `equals`, `in`, `some`, `empty`, `notEmpty`, `exists`, `all`, `any`, `not`. Paths read only own properties of objects; prototypes are not reachable.

**Expression context:** `input`, `limits`, `scope`, `run`, `loop.{iteration, number, isLast, max}`, `nodes.<id>.{status, iteration, output}`. `status` comes from the last finished execution of the node, `output` from the last successful one. So skipping a step in a later iteration does not erase its data.

**Definition check** (`checkDefinition`): unique IDs; existing dependencies, functions and nodes referred to by expressions; no circular dependencies (`loop` is the tool for repetitions); no dependencies "into" a loop; an iteration limit on every loop. The editor shows the errors on the specific nodes.

## 3. States
Run: `pending → running ⇄ waiting_for_approval`, `running → paused → running`, final: `completed | failed | cancelled`.
Step: `pending → running → completed | failed | cancelled`, `pending → skipped` (the `when` condition is false), `pending → waiting_for_approval → completed`.

| Situation | Behaviour |
|---|---|
| A temporary model error (`PROVIDER_*`, `TIMEOUT`, `STRUCTURED_OUTPUT_FAILED`) | The step is retried after a delay (`retries`, 1 by default). While waiting, the step stays `running`, so it cannot start twice |
| An error the user fixes (no model, the agent is disabled, budget, offline, cloud policy, key) | The run is **paused** with a clear reason and a hint. Finished results are kept. "Resume" repeats only the failed step |
| Any other error | The step is `failed`, parallel steps are cancelled, the run is `failed`. Steps with `optional: true` do not fail the run |
| Pause | New steps do not start; running ones finish. A pending decision can be answered during the pause too |
| Cancel | Running steps are interrupted through an `AbortSignal`; unfinished ones become `cancelled`. Results are kept. A cancelled run cannot be resumed |
| Deadlock (steps whose dependencies cannot be met) | The run is `failed` with an explanation. The final state is evaluated only in a tick where nothing changed |

## 4. Durability and recovery
- Every state change is written to `system.db` first (`workflow_runs`, `run_steps`, `run_events`). The run stores a snapshot of the workflow definition, so editing the workflow does not change runs that have started.
- **Closing the system or the application:** running steps are interrupted and return to `pending`; the run becomes `paused` with the reason "interrupted because the system was closed".
- **Crash:** when a system opens (`WorkflowEngine.start`), `running`/`pending` runs become `paused` with the reason "Recovered after an application restart", and `running` steps become `pending`. **Nothing continues without the user.**
- **Side effects are idempotent:** `spec.save` writes its plan (requirement numbers and file names) to the run log once and marks every task it creates. Calling it again creates only what is missing. `research.save` finds an already saved report by `workflow_run`.

## 5. Limits and budget
`workflow.defaultLimits` (a system setting) + the `limits` of the definition + the limits of a specific run: `maxModelCalls`, `maxTokens`, `maxCostUsd`, `maxReviewIterations`, `stepTimeoutMs`, `maxParallel`. Consumption is tracked in `workflow_runs.totals` (calls, tokens, cost, calls without a known price). When a limit is exhausted, the run pauses. The user can raise the limit (`PATCH /runs/:id/limits`) and resume.

**The preflight check** (recommendation R8, `preflight`) shows before the run:
- which agents are not installed or are disabled, and which permissions they lack;
- which model will serve each step and why;
- an estimate of the number of model calls (minimum and worst case);
- warnings about confidential sources, cloud steps and missing web access.

`setupAgents` installs the built-in agents of the workflow. It is an explicit user action: only the permissions the package requests are granted.

## 6. The specification pipeline
`context → coordinator → [clarify] → inventory → researcher → ground → loop(requirements → req_check → contradictions → [resolve] → decompose → task_check → write → render → review → [final]) → save`

- **Quote verification** (`spec.ground_evidence`): every `fact` quote is looked up in the text of the document or the project file. A source outside the run scope or a quote that was not found is flagged, and such evidence does not count as confirmed.
- **Validators** (`spec/validators.ts`): duplicate IDs, broken references, cycles of requirements and tasks, vague wording without a measurable criterion, requirements not backed by evidence or backed only by unverified quotes, requirements without criteria, tasks without requirements, uncovered must-have requirements, near-duplicates.
- **The document** (`spec/render.ts`) is assembled by code: requirement tables, the decomposition, the traceability matrix, evidence with its verification status, decisions on contradictions, metrics and validator findings. The model writes only the narrative sections.
- **Review and approval:** if the reviewer does not accept the document, an automatic revision with the reviewer's comments follows. On the last iteration, or after the review passes, the user decides: approve, reject or send for revision with a comment.
- **Saving:**
  - requirement numbers are renumbered to be unique across the system (`REQ-NNN` after the existing ones);
  - requirement documents are created with typed `part_of`, `depends_on` and `derived_from` links, plus the specification document with links;
  - tasks go to the tracker (`origin = agent`, a link to the run, dependencies);
  - the graph gets `implements` links (task → requirement) and `derived_from` links (specification → sources).

## 7. The web research pipeline
`local (what is already known) → research-planner → web-researcher (SafeFetcher, the network.fetch / web.search permissions, domains from the grant) → research.ground_claims → loop(write ⇄ review) → [approve] → research.save`

- The report contains a table of claims with the quote status, sources with publication and retrieval dates, limitations and open questions.
- Facts are saved only for confirmed quotes (`facts`, `review_after` in 90 days).
- The graph gets `uses_source` links.
- Without web permission for the run, download tools are denied and logged. The report honestly shows that the quotes are not confirmed.

## 8. Tasks
`tasks/tasks.ts`:
- keys `T-NNN`; statuses `backlog / todo / in_progress / review / blocked / done / cancelled`;
- dependencies with protection against cycles and against nesting a task in its own subtask;
- a task with unfinished dependencies cannot be moved to in progress or done;
- **"Done" requires a confirmation** (what was checked and where the result is) or an explicit confirmation by the user; an agent can close a task only with a confirmation;
- comments, links (document, URL, requirement), a kanban board;
- MD / JSON / CSV export; formulas are neutralized in CSV;
- mirrored in the graph: `task → requirement: implements`, `depends_on`, `part_of`, `derived_from`.

## 9. API
`/api/systems/:id/workflows` (list, definition, save, check, copy, delete, preflight, setup-agents, start), `/api/systems/:id/runs` (list, state, events, pause, resume, cancel, limits, a step decision), `/api/systems/:id/tasks` (CRUD, status, dependencies, comments, links, board, export), `/api/workflows/functions` (the function palette for the editor).

## 10. Limitations of this version
- Nested loops and sub-workflows are not supported.
- Branching is expressed with `when` and `optional`; there is no `switch` node.
- Steps run inside the application process. There is no distributed execution: the workflows of one system are served by one engine.
- The preflight cost estimate is shown only when a price is set for the model.
