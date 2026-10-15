# Missions: running natural-language specifications (specification section 28)

Status: implemented · Updated: 2026-10-14 · Code: `packages/core/src/missions/*` · Tests: `packages/core/test/missions.test.ts` (21 scenarios, including the 15 acceptance scenarios of 28.17), `apps/server/test/api.test.ts` (HTTP).

## 1. Terms

- **Mission:** a task the user wrote in natural language and the whole process of carrying it out. The UI section is "Missions"; a mission key looks like `M-001`.
- **Task:** an item of the tracker in the "Tasks" section. It is a different entity.
- **Phase:** a stage of the 28.5 algorithm: analysis, context, research, strategy, plan, execution, verification, fix, review, summary.
- **Mission step:** the record of the work of one agent. There are two kinds of steps: phase steps (for example "Request analysis") and plan steps (`S1`, `S2`, … and `FIX1`).
- **Change set:** proposed file changes. A mission has one cumulative set (`changeGroup = mission:<id>`). Nothing changes in the original project before the user decides (section 29).

## 2. Modules

| File | What it does |
|---|---|
| `state.ts` | 15 statuses (28.11), the table of allowed transitions, phase labels. `assertTransition` rejects invalid transitions with `INVALID_STATE_TRANSITION`. |
| `types.ts` | Typed schemas: the scope (`MissionScope`), policy, limits, the internal specification (`NormalizedTask`), criteria, plan steps, solution options, the strategy, questions to the user (`PendingApproval`), decisions, the summary, the UI view. |
| `plan.ts` | Roles and their agents. A deterministic plan check: IDs like `S1`, only available roles, no file changes in plan mode, dependencies exist, no cycles, the last step is verification. |
| `verify.ts` | The criteria guard (`guardCriteria`), the final status (`finalStatus`), the summary and the Markdown report. |
| `context.ts` | Quote verification in code: in documents and project files (including other selected systems) and in downloaded web pages. Cross-system search that shows the source system. Compression of step results for the next agents. |
| `checks.ts` | Project check commands. They run only by name and only in a work copy (section 29). |
| `engine.ts` | `MissionEngine`: the phase driver, running agents, user decisions, interventions, recovery. |

## 3. The adaptive algorithm (28.5)

```
analysis → [context] → [research] → [strategy] → planning → execution → verification ⇄ fix → [review] → summary
                                                    └── plan mode: planning → summary
```

Phases in brackets run only when they are needed. Code decides (`nextPhase`) from the internal specification produced by the analyst agent:

| Phase | When it runs |
|---|---|
| context | The task is about a project (`project_exploration`, or the type is implementation, bugfix or improvement) and the scope has projects. Or local research is needed, documents are given or other systems are selected. Not for the "public sources only" scope. |
| research | `web_research`, the `public` scope or an attached link. If web access is not allowed, the phase does not run and the summary shows a limitation. |
| strategy | `alternatives`, complexity `complex` or type `design`. |
| review | `independent_review` or complexity `complex`. |

A simple task goes "analysis → plan → execution → verification → summary" with 3–4 agents. There is no fixed chain of dozens of agents (28.6).

### 3.1. Phases

1. **Analysis.** The `mission-analyst` agent turns free text into the internal specification: type, outcome, requirements, constraints, criteria, risks, questions, complexity, the phases needed.
   - The original request is stored separately and verbatim (`original_request`).
   - A blocking question without an assumption moves the mission to "Needs your input" with a concrete question.
   - A non-blocking question becomes an explicit assumption.
   - There are at most three rounds of questions. If there is still no answer, this is recorded as a limitation.
2. **Context.** `project-explorer` and `researcher` work in parallel within `maxParallel`.
   - The quotes of the evidence are verified by code. An unconfirmed claim becomes an assumption.
   - For the "several systems" scope, a deterministic search over the selected systems runs first. Every result keeps its `systemId`.
3. **Research.** `web-researcher` works. Quotes are compared with the saved text of the downloaded pages, and independent domains are counted.
4. **Strategy.** `solution-architect` builds the options: reuse, configure, library, extend, new, combined.
   - If an approval is needed, a `strategy` question appears.
   - The user's choice (`selectedBy: user`) is kept when the plan is recalculated.
5. **Plan.** `mission-planner` works.
   - `validatePlan` checks the plan. On errors the planner gets one attempt to fix the plan, with the errors listed.
   - If the requirements changed while the planner worked, the plan is made again for the new revision.
   - A `Conflict: …` line in the planner notes becomes a `conflict` question (28.13).
   - Plan approval depends on the `approvePlan` policy:
     - `always`: always approved by the user;
     - `risky` (default): when there is a high-risk step, a high risk from the analyst, or project checks that are not allowed yet;
     - `never`: not requested.
6. **Execution.**
   - Steps run according to their dependencies. Independent steps run in parallel up to `maxParallel`.
   - `implementer` steps that change files run strictly one at a time.
   - Steps of the `verifier` role are closed by the "Verification" phase.
   - An agent report about an action that is not confirmed by a tool call is not counted and is recorded as a limitation ("do not imitate execution").
7. **Verification.** Every run of this phase gets its own marker (`verification:<round>:<id>`), so the results of different runs do not mix. The order:
   - validators: changes only within the mission scope; the original projects did not change during execution (a baseline snapshot of hashes);
   - the allowed check commands in a work copy with the current content of the set;
   - a security review of the changes;
   - the `verifier` agent;
   - the criteria guard.
8. **Fix.** The loop is limited by `maxFixRounds` (2 by default). It starts only for what a change can fix: failed checks, `not_met` criteria, serious defects. It does not touch limitations of the environment such as "the checks did not run" or "the changes are only proposed".
9. **Independent review.** `independent-reviewer` works. It compares the result with the original text of the request and looks for distortions of its meaning.
10. **Summary.**
    - The status is computed from the criteria and the evidence (`finalStatus`).
    - At most one report is saved. On a recalculation it is updated in place.
    - If the documenter has already prepared a document, no separate report is created.
    - If the source allows applying, the mission asks the `apply_changes` question.

## 4. An honest result (28.16)

`guardCriteria` does not accept "done" from an agent without evidence:

- `met` without evidence becomes `unverifiable`;
- `check_command`: a failed check gives `not_met`; if no checks ran, the result is `unverifiable` with the reasons listed;
- `artifact_exists` without the artifact gives `not_met`;
- `source_verification` without a confirmed quote gives `unverifiable`; a single independent web source gives `partially_met`;
- `manual` is confirmed only by the user (`confirmCriterion`);
- if the changes are only proposed and applied neither to a work copy nor to the project, the assessment is lowered to `partially_met`.

Final statuses:

- `completed`: every applicable criterion is met, and in addition:
  - no stage failed;
  - nothing did not run (`gaps`, shown as `notExecuted` in the view): a stage did not run for lack of an agent, a tool, web access, the project mode or a model, or the user skipped it (28.15);
  - there are no unresolved problems from the last verification: failed check commands and validators, critical/major verifier findings, a blocking security or independent review (28.16);
- `partially_completed`: something was achieved;
- `failed`: nothing was achieved.

Problems left after verification are always listed as limitations with the reason, even when fix rounds are disabled by the policy or the implementer is unavailable.

In plan mode with limitations, the result is `partially_completed`.

## 5. Data model (system.db)

- **`missions`.** Stores:
  - the original request and the attachments;
  - `normalized` (the internal specification) and `revision`;
  - mode, status, phase, priority;
  - scope, policy, limits;
  - context, research, options, strategy, plan and `plan_stale`;
  - criteria, extra requirements, allowed checks;
  - the baseline snapshot, limitations and stages that did not run (`gaps`), the current question (`pending`), the fix round counter;
  - review results, the summary, `report_doc_id`, usage, the error, the status reason and timestamps.
- **`mission_steps`.** Stores the phase, plan step, role, agent, input and output, status, attempts, `idempotency_key`, `side_effects` (what the step already did: tool, target, reference) and timestamps.
- **`mission_events`** is the action log (28.12.6). **`mission_messages`** holds the discussion, answers to questions, decisions and comments.
- **`mission_checks`** holds commands, validators and criteria by round.
- **`change_sets`** (`mission_id`) holds the cumulative change set of the mission.

## 6. Agents, models and budget

- An agent runs only through `AgentRuntime`: schemas, the untrusted-content envelope, the controlled tool executor.
- The run scope (`RunScope`) is set by the user: projects, documents, systems, web, denied tools, allowed checks, `missionId`, `changeGroup`.
  - The scope object is "live": denying a tool also applies to steps that are already running.
  - For the `public` scope, every tool that reads or changes local data is denied.
- Idempotency. The key of a phase step: `mission:phase:role:planStep:r<revision>:f<fixRound>:<variant>`. A finished step with the same key does not run again; the saved result is used.
- Fallback model (28.15). On a model error (`MODEL_UNAVAILABLE`, `STRUCTURED_OUTPUT_FAILED`, `PROVIDER_*`, `CONTEXT_TOO_LARGE`) the engine tries up to two **other local** models. It never switches to the cloud automatically: cloud providers are not in the fallback list.
- Errors the user can fix move the mission to "Needs your input" with a concrete question:
  - `model`: model, key, network;
  - `budget`: a limit;
  - `setup_agents`: agents.
- The mission `RunBudget`: limits on calls, tokens and cost. Usage is saved in `missions.totals`.

## 7. User interventions (28.13)

| Action | API (`/api/systems/:systemId/missions/:mid/...`) | Behaviour |
|---|---|---|
| Pause / resume / cancel | `pause`, `resume`, `cancel` | Pause: running steps finish, new ones do not start, the phase cursor moves without continuing the work. Cancel: steps are cancelled, results are kept. |
| Decide on a question | `decide` | Only the actions allowed for this kind of question are accepted. An outdated `pendingId` is rejected. |
| Add a requirement, criterion or constraint | `requirements` | `revision++`, the plan is marked outdated. At the nearest safe boundary it is recalculated. Finished steps with `keep_existing` are kept, unfinished ones are replaced. If the requirement conflicts with an earlier one, a `conflict` question appears. |
| Refine criteria | `PUT criteria` | Unchanged criteria keep their status. New criteria are checked again. |
| Edit the plan | `PUT plan` | The same `validatePlan` as for the planner. |
| Research another option | `options` | The strategy is recalculated, then the plan. |
| Choose another solution | `strategy` | `selectedBy: user`, the plan is recalculated. |
| Deny a tool | `deny-tool` | Applies immediately and is written to the security log. |
| Retry a step or a phase | `steps/:sid/retry`, `phases/:phase/retry` | Retries a plan step or a whole phase (a new revision). |
| Confirm a manual criterion | `criteria/:cid/confirm` | The summary of a finished mission is recalculated. |
| Discussion | `discuss`, `messages/:msg/apply` | The advisor answers from the state of the mission. Its suggestions are applied only with the user's button. |
| Limits, title, preflight, agents | `PUT limits`, `PUT title`, `POST missions/preflight`, `POST missions/setup-agents` | The preflight shows the agents, the model route (local or cloud), permissions, project modes and checks. |

## 8. Relation to project protection (section 29)

- An agent only **proposes** changes (`propose_file_change`). Thanks to `changeGroup`, all proposals of a mission go into one set.
- Only the user changes the project mode:
  - "Read only": proposals are impossible, which is recorded as a limitation;
  - "Prepare changes": there is a set, but no work copy, and checks do not run (honestly reflected in the criteria);
  - "Work in a copy": checks run in a work copy; the original project does not change;
  - "Apply to the original project": at the end the mission asks the `apply_changes` question.
- The `apply` decision goes step by step: a review of exactly the content the user saw (otherwise `REVIEW_STALE`) → checks in a work copy → all gates of `ChangeSetService.apply` (risks with an explicit confirmation, a verified backup).
- Inside a mission, the `run_check` tool first syncs the work copy with the current set (`syncMissionWorkCopy`).

## 9. Recovery (28.11)

- A clean close of the system. The driver is interrupted. Steps without side effects return to `pending`. Implementer steps and steps with recorded `side_effects` are marked `failed` with the note "it is not repeated automatically". The mission becomes "Paused".
- A crash. At the next launch `start()` does the same for missions in working statuses.
- "Resume". Interrupted steps with side effects become an `error` question: "retry or skip". Everything else continues. Finished phases do not run again (idempotency).

## 10. Cross-system work (28.14)

- The mission scope has four kinds: `system`, `projects`, `systems` (explicitly selected other systems) and `public`.
- Agents read other systems only with the `systems.read` permission and only the selected systems.
- Evidence is verified in its source system; `systemId` is kept in `sourceReferences`.
- Results (documents, the report) are saved in the system where the mission was created. Other systems do not change (test 14).

## 11. Limitations (honestly)

- The quality of the analysis, the plan and the changes depends on the model. Small local models may fail at structured output. Then the engine tries another local model, and if that fails, it asks the user.
- A conflict between requirements is recognized by the `Conflict:` marker in the planner notes, so it depends on the model. There is no deterministic semantic contradiction detector.
- Check isolation depends on bubblewrap (section 29, §10.7). Without it the mode is "limited", and the mission summary says so plainly.
- Parallelism is limited by `maxParallel` (1–6). File changes run one after another.
