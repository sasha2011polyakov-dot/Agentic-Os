# Examples: three requests through the algorithm (Phase C)

Date: 2026-10-15. These examples check the design ([`design.md`](design.md)) against three requests of different kinds. They are **hand-written** to show what each stage must produce. **They are not model output.**

In milestone M2 they become fixtures (`packages/core/test/fixtures/contracts/`) that must pass `validateContract`, and their rendered specifications become snapshots.

The JSON below is abbreviated: `…` marks fields omitted for readability. Every ID that appears is defined somewhere in the same example.

---

## Example 1. A simple task

> "Add a `--version` flag to the server CLI that prints the app version and exits."

**Context.** The project is this repository, connected as the project `agentic-os` in the *Work copy* mode, with the checks `tests` (`npm test`) and `typecheck`. The server CLI parses its arguments in `apps/server/src/main.ts` (`parseArgs`). The version is `APP_VERSION` in `packages/core/src/version.ts`. There is no `--version` flag today.

### Stages 1–2. Intent and result

```jsonc
"intent": {
  "problem": "There is no quick way to see which version of the server is installed.",
  "goal": "Print the version from the command line.",
  "object": "The server command-line interface (apps/server).",
  "expected_result": "Running the CLI with --version prints the version and exits.",
  "audience": "People who run the server, for example when they report a bug.",
  "usage_context": "A terminal.",
  "user_statements": ["Add a `--version` flag to the server CLI", "prints the app version and exits"],
  "explicit_constraints": [],
  "implied_requirements": ["The printed version comes from the same place as the version the app reports elsewhere."],
  "missing_information": [],
  "ambiguities": []
},
"result": {
  "result_type": "feature",
  "purpose": "Let a user find out the installed version without starting the server.",
  "users": ["A person in a terminal"],
  "composition": ["Handling of --version in the CLI argument parser", "An automated test for the flag"],
  "behavior": ["When the CLI is started with --version, it prints the version and exits with code 0 without starting the server."],
  "inputs": ["The --version argument"],
  "outputs": ["The version string on standard output"],
  "constraint_ids": ["CON-001"],
  "quality_criteria": [],
  "verification_approach": "Project checks in a work copy, plus a review of the change.",
  "artifact_ids": ["ART-001", "ART-002"]
}
```

### Stage 4. Requirements

```jsonc
"requirements": [
  {
    "id": "REQ-001", "title": "The --version flag", "type": "functional", "priority": "must",
    "source": "user", "request_quote": "Add a `--version` flag to the server CLI", "status": "confirmed", "confirmed_by": "request",
    "description": "Starting the server CLI with --version prints the application version and exits with code 0. The server is not started.",
    "acceptance_criteria": [
      { "id": "AC-001", "condition": "A test runs the CLI argument handling with --version and gets the value of APP_VERSION and exit code 0.",
        "verification_method": "check_command", "check": { "source_id": "src_agentic_os", "name": "tests" }, "artifact_ids": ["ART-002"], "expected_evidence": "The tests check passes in the work copy." },
      { "id": "AC-002", "condition": "With --version, the code path that starts the HTTP server is not reached.",
        "verification_method": "review", "check": null, "artifact_ids": ["ART-001"], "expected_evidence": "The verifier points at the early exit in the changed file." }
    ], …
  },
  {
    "id": "REQ-002", "title": "One source of the version", "type": "non_functional", "priority": "should",
    "source": "agent_proposal", "request_quote": null, "status": "proposed", "confirmed_by": null,
    "description": "The flag reads APP_VERSION from packages/core/src/version.ts instead of duplicating the number.",
    "acceptance_criteria": [
      { "id": "AC-003", "condition": "The change does not add a second literal version string.", "verification_method": "review", "check": null, "artifact_ids": ["ART-001"], "expected_evidence": "The verifier quotes the import of APP_VERSION." }
    ], …
  }
],
"constraints": [
  { "id": "CON-001", "text": "Project \"agentic-os\" is in the Work copy mode: changes are prepared and checked in a work copy; applying them to the project needs the Apply mode, which only the user enables.", "kind": "policy", "source": "system" }
],
"expected_artifacts": [
  { "id": "ART-001", "kind": "file_change", "location": "apps/server/src/**", "description": "Argument handling for --version", "requirement_ids": ["REQ-001", "REQ-002"], "required": true },
  { "id": "ART-002", "kind": "file_change", "location": "apps/server/test/**", "description": "A test for the flag", "requirement_ids": ["REQ-001"], "required": true }
]
```

### Stages 5–8

- **Stage 5.** The validator finds no critical or major problems. `REQ-002` is an agent proposal, but its priority is `should`, so it does not block auto-approval. The specification lists it as a proposal.
- **Stage 6.** The plan:

| Step | Role | Requirements | Criteria | Artifacts | Depends on |
|---|---|---|---|---|---|
| S1 | implementer | REQ-001, REQ-002 | AC-001, AC-002, AC-003 | ART-001, ART-002 | — |
| S2 | verifier | — | (final verification) | — | S1 |

- **Stage 7.** The rendered specification is short. It contains: title, goal, expected result, scope, requirements with criteria, plan, verification, completion conditions.
- **Stage 8.** The task is simple, so the review is the deterministic validator only (design §4.3). The contract is auto-approved.

The one approval the user still sees is the existing permission to run the project checks `tests` and `typecheck` in a work copy.

### Execution, verification, outcome

- **The handoff of S1** contains:
  - REQ-001 and REQ-002;
  - AC-001 to AC-003;
  - `expected_outputs` ART-001 and ART-002;
  - `forbidden`: "Do not change files outside `apps/server/src/**`, `apps/server/test/**`", "Do not apply changes to the original project".
- **If the implementer changed `packages/core/src/version.ts`**, `propose_file_change` would be refused with `OUT_OF_STEP_SCOPE` (design §5.3).
- **`Completed` requires all of:**
  - the tests check passed (evidence for AC-001);
  - the verifier's review with a quote (AC-002, AC-003);
  - ART-001 and ART-002 present in the change set.

  The change set is prepared but not applied, so the summary says so, and the next step names the "Apply" mode.

---

## Example 2. An ambiguous task

> "Make search better."

**Context.** This is the user's knowledge system with notes in English. Search is SQLite FTS5 with the `unicode61` tokenizer, which has no stemming (backlog item "English stemming").

### Stage 1. Intent: the result is not defined

The first analysis cannot define the result. "Better" is vague, and nothing says what is wrong today.

```jsonc
"intent": {
  "problem": "The user is not satisfied with search, but the request does not say why.",
  "goal": "Improve search.",
  "object": "Full-text search over the notes of this system.",
  "expected_result": "Unknown: depends on what is wrong today.",
  "user_statements": ["Make search better."],
  "missing_information": ["Which search results are wrong or missing today"],
  "ambiguities": ["\"better\" may mean recall (word forms, typos), ranking, speed or the interface"], …
},
"requirements": [
  { "id": "REQ-001", "title": "Better search", "priority": "must", "source": "user", "request_quote": "Make search better.",
    "status": "needs_clarification", "acceptance_criteria": [], … }
],
"open_questions": [
  { "id": "Q-001", "blocking": true, "impact": "acceptance",
    "text": "What is wrong with search today?",
    "options": ["It misses other forms of a word (\"run\" does not find \"running\")", "The best results are not at the top", "It is slow", "It does not tolerate typos"],
    "default_assumption": null, "status": "open", "answer": null, "refs": ["REQ-001"] }
]
```

**Validator findings (version 1):**
- `blocking_question_open`: critical (gate);
- `missing_criteria` on REQ-001: major;
- `vague` ("better") on a `must` requirement: major.

**The gate stops the work before planning.** The user gets one question with options. This is MP §3 stage 5: the uncertainty decides the acceptance criteria, so the system asks instead of guessing.

### After the answer

The user answers: *"When I search 'run' I don't find notes that say 'running'."*

Analysis runs again with the answer. The new contract version (3) contains:

```jsonc
"requirements": [
  { "id": "REQ-001", "status": "superseded", … },                         // kept, never deleted; history: replaced by REQ-002
  { "id": "REQ-002", "title": "English word forms", "type": "functional", "priority": "must",
    "source": "user", "request_quote": "When I search 'run' I don't find notes that say 'running'",   // found in the user's answer
    "status": "confirmed", "confirmed_by": "request",
    "description": "A search term matches other English inflections of the same word (run, runs, running).",
    "acceptance_criteria": [
      { "id": "AC-001", "condition": "A query run finds a note whose text contains only the word running.", "verification_method": "check_command", "check": { "source_id": "src_app", "name": "tests" }, "artifact_ids": ["ART-002"], … }
    ], … },
  { "id": "REQ-003", "title": "Exact phrases stay exact", "type": "functional", "priority": "must",
    "source": "agent_proposal", "status": "proposed", "confirmed_by": null,
    "description": "A quoted phrase still matches only the exact words.",
    "acceptance_criteria": [ { "id": "AC-002", "condition": "The query \"running\" (in quotes) does not match a note that contains only run.", "verification_method": "check_command", … } ], … },
  { "id": "REQ-004", "title": "Offline and local", "type": "constraint", "priority": "must",
    "source": "project", "evidence_ids": ["EV-001"], "status": "confirmed", "confirmed_by": "decision",
    "description": "Stemming runs locally with no new network dependency.",
    "acceptance_criteria": [ { "id": "AC-003", "condition": "No new dependency performs network access; search works in offline mode.", "verification_method": "review", … } ], … },
  { "id": "REQ-005", "title": "Report the cost", "type": "non_functional", "priority": "should",
    "source": "agent_proposal", "status": "proposed",
    "description": "Indexing time and index size on the test corpus are measured before and after the change and reported.",
    "acceptance_criteria": [ { "id": "AC-004", "condition": "The step report contains both measurements.", "verification_method": "review", … } ], … }
],
"open_questions": [
  { "id": "Q-001", "status": "answered", "answer": "When I search 'run' I don't find notes that say 'running'.", … },
  { "id": "Q-002", "blocking": false, "impact": "cost", "text": "Is there a limit on how much slower indexing may become?",
    "default_assumption": "No limit is set; the measured difference is reported instead.", "status": "assumed", … }
],
"assumptions": [
  { "id": "ASM-001", "text": "No limit on the indexing slowdown; the difference is measured and reported.", "source": "default_answer", "status": "proposed", "impact": "If a limit exists, REQ-005 needs a threshold.", "refs": ["REQ-005", "Q-002"] }
]
```

Three points of the design show here:
1. **No invented threshold.** The analyst does not write "indexing must not be more than 20% slower". MP §3 stage 2 forbids invented norms. The cost is measured and reported, and the open question records that a threshold could be set (`invented_threshold` would flag a number from an agent proposal without evidence).
2. **The user's answer is a valid source** for `request_quote`. The quote is checked against the stored answer.
3. **REQ-003 is a `must` agent proposal**: preserving existing behaviour is MP §3 stage 7 section 21. It blocks auto-approval, so the user confirms it when approving the specification.

### Stage 8. Review (moderate task: one `spec-reviewer` round)

The reviewer reports a major defect: *"REQ-002 does not say what happens to notes in other languages"* (`stage=requirements`, target REQ-002).

- The `requirements` phase runs `requirements-analyst` with this feedback.
- Its patch updates the description of REQ-002 ("English only; other languages are tokenized as before").
- It adds AC-005: "The existing search tests for non-English text pass unchanged" (`check_command`).
- The validator is clean, and the contract goes to the user for approval: version 5, with REQ-003 and REQ-005 shown as proposals.

### Plan

| Step | Role | Requirements | Criteria | Artifacts |
|---|---|---|---|---|
| S1 | project-explorer | REQ-002, REQ-004 | — | — |
| S2 | implementer | REQ-002, REQ-003, REQ-004 | AC-001, AC-002, AC-003, AC-005 | ART-001 (`packages/core/src/search/**`), ART-002 (`packages/core/test/**`) |
| S3 | implementer | REQ-005 | AC-004 | ART-003 (report, `Missions/`) |
| S4 | verifier | — | final | — |

---

## Example 3. A complex task

> "Build a project knowledge base: graphs of the architecture, the files, the agents and the requirements, kept up to date, with a UI to explore them."

This is MP §15 in one sentence. The example shows the stages a complex task adds.

### Stages 1–3

- **Analysis:**
  - `complexity=complex`;
  - `needs`: project exploration, alternatives, independent review;
  - web research is not needed, and web access is off for this mission, so the code adds the system constraint CON-001 "Web access is not allowed".
- **Context:** `project-explorer` finds the existing graph module (`packages/core/src/graph`, edges with `origin` and `status`), the index of files and the agent catalog. These become evidence EV-001 … EV-004.
- **Strategy:** `solution-architect` compares three options:
  - O1: extend the existing graph tables with typed views ("lenses");
  - O2: a separate knowledge-base store;
  - O3: an external graph database.

  It selects O1. O3 is rejected because it adds a server process and a dependency, which contradicts local-first operation. The choice becomes:

```jsonc
"decisions": [
  { "id": "DEC-001", "text": "Build the lenses on the existing graph tables (O1).",
    "rationale": "Reuses the indexed edges, provenance (origin) and suggestion status; no new process or dependency.",
    "alternatives": ["O2 separate store: duplicates indexing", "O3 external graph database: a server process, against local-first"],
    "decided_by": "architect", "refs": ["REQ-001", "REQ-002"], "at": "…" }
]
```

### Stages 4–5: registry, contradiction, question

An excerpt of the registry after `requirements-analyst`:

| ID | Title | Type | Priority | Source | Status |
|---|---|---|---|---|---|
| REQ-001 | Four lenses: architecture, files, agents, requirements | functional | must | user | confirmed |
| REQ-002 | Typed relations with provenance and confidence | data | must | project (EV-001) | confirmed (decision) |
| REQ-003 | Kept up to date on file changes | functional | must | user | confirmed |
| REQ-004 | Incremental: one changed file updates only its nodes and edges | non_functional | must | agent_proposal | proposed |
| REQ-005 | A UI to explore a lens with filters | interface | must | user | confirmed |
| REQ-006 | Every node and edge has a source; nothing without one is shown as fact | security | must | agent_proposal | proposed |
| REQ-007 | Coverage report: which files and components are not in any lens | functional | should | agent_proposal | proposed |
| REQ-008 | User documentation of the lenses | documentation | should | agent_proposal | proposed |

- **REQ-004 is measurable without an invented number.** Its criterion AC-006 is: "A test changes one file and asserts that only that file's nodes and edges were rewritten (counted)". It is a `check_command` criterion with no time threshold.
- **The contradiction.** `contradiction-checker` reports ISS-001 (critical): REQ-003 "kept up to date" conflicts with CON-002 "no background processes without the user's consent" (`source=system`, from the security policy).
- **The question.** The user gets a `conflict` approval with two options:
  1. update on index events while the app is running;
  2. update only on a manual refresh.

  The user chooses (1). That becomes DEC-002, and REQ-003 gets the clarified description "while the app is running, updated from index events; no separate background process".
- **A non-blocking question** Q-001 ("Which lenses first?") is resolved by its default: the four lenses named in the request. It becomes ASM-001.

### Stage 6: plan with coverage

| Step | Role | Requirements | Criteria | Artifacts | Depends on |
|---|---|---|---|---|---|
| S1 | implementer | REQ-001, REQ-002, REQ-006 | AC-001 … AC-004, AC-008 | ART-001 `packages/core/src/graph/**`, ART-002 `packages/core/test/**` | — |
| S2 | implementer | REQ-003, REQ-004 | AC-005, AC-006 | ART-001, ART-002 | S1 |
| S3 | implementer | REQ-005 | AC-007 | ART-003 `apps/ui/src/**` | S1 |
| S4 | implementer | REQ-007 | AC-009 | ART-001, ART-002 | S1 |
| S5 | documenter | REQ-008 | AC-010 | ART-004 `docs/` | S1–S4 |
| S6 | verifier | — | final | — | S1–S5 |

The coverage check passes: every active `must` requirement appears in a step, and every required artifact has a producing step. S2 and S4 both change ART-001, and implementer steps run one at a time anyway (existing rule).

### Stage 8: review loop

- **Round 1 of `spec-reviewer`** reports two defects:
  1. *"REQ-005: 'a UI to explore' gives no criterion for what the user can do"*. This is major, with `stage=requirements`.
  2. *"ART-003 has no screen named"*. This is minor, with `stage=plan`.

  The first goes to `requirements-analyst`, which adds criteria: filter by relation type, open a node's card, show the provenance of an edge. The second goes to the planner, which names the screen.
- **Round 2 passes.**
- **The user approves version 9.** The approval also confirms the agent proposals REQ-004, REQ-006, REQ-007 and REQ-008, and each confirmation becomes a history entry with `confirmed_by=user`.

### Sections of the rendered specification

The specification of example 3 contains all 22 sections of MP §3 stage 7 except the ones without content:
- "Integrations and dependencies" is not rendered, because there are none beyond the existing modules;
- "Structure of the solution" is rendered from DEC-001 and the artifacts.

The specification of example 1 contains only these sections: title, goal, expected result, scope, requirements, criteria, plan, verification, completion conditions.

---

## What the examples check in the design

| Design point | Example |
|---|---|
| The user's words kept apart from interpretations; quotes checked | 1 (`user_statements`), 2 (quote from an answer) |
| The gate stops work on a blocking question | 2 |
| Vague wording turned into checkable criteria | 2 |
| No invented thresholds | 2 (REQ-005), 3 (REQ-004) |
| Agent proposals visible and confirmed by the user | 1 (`should`, no blocking), 2 and 3 (`must`, approval) |
| System constraints from facts | 1 (Work copy mode), 3 (no web, no background processes) |
| Decisions with alternatives and rationale | 3 (DEC-001, DEC-002) |
| Contradiction found before planning | 3 (ISS-001) |
| Coverage of requirements and artifacts by the plan | 1, 2, 3 |
| Step scope restriction | 1 (`OUT_OF_STEP_SCOPE`) |
| The minimal set of roles | 1 (no context, no model review) vs 3 (all roles) |
| Bounded spec review routed to the right stage | 2 (one round), 3 (two rounds) |
