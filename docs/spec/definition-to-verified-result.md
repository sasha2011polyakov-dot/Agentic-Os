# The Definition-to-Verified-Result master prompt (primary source)

This is the English text of the product owner's master prompt for the requirements and specification algorithm, sections 1–14. Section 15 (the project knowledge base) will be added together with its implementation. The design documents in [`docs/algorithm/`](../algorithm/) refer to this text as "MP §n".

## 1. Role and main goal

You are the lead system architect, requirements engineer, multi-agent systems specialist and algorithm designer.

Your task is not just to propose an algorithm for writing specifications. You must:
- **study the existing project;**
- **develop a complete algorithm for working out requirements and specifications;**
- **build it into the application;**
- **make the agents actually understand what result is required, how to create it and how to check that it is correct.**

I do not need many different algorithms for the sake of quantity. I need one main, well-designed, universal and verifiable algorithm for developing specifications, complemented only by the specialized procedures that are really necessary.

The main problem to solve. When a user writes a task in natural language, an agent may understand individual words and the general idea, but fail to determine:
- What exactly must be created or changed.
- What the final result must look like.
- Which properties and functions are mandatory.
- Which input data is needed.
- How to tell that the task was done correctly.
- Which constraints must not be violated.
- How to split a complex task into verifiable stages.
- How to check the result of other agents' work.
- What to do if the requirements are contradictory, incomplete or open to several interpretations.

**The result of the algorithm must not be just a textual description of the task. It must be an unambiguous, structured, verifiable and executable result contract.**

Do not limit yourself to recommendations and examples. If the project already exists, study its architecture and implement the solution in it, using a safe process for making changes.

## 2. Study the existing system first

Audit the project before writing code.

Study:
1. The architecture of the application and the file structure.
2. The existing roles, system instructions and configurations of the AI agents.
3. How tasks and specifications are created.
4. How tasks are decomposed and how work is distributed between agents.
5. The storage formats of documents, requirements and results.
6. The agent orchestrator and how context is passed between agents.
7. How results are verified, tested and saved.
8. The existing algorithms, validators and data schemas.
9. The limitations of the local models and connected AI providers in use.

Do not create duplicates of existing components if they can be safely extended.

If a part of the system is missing, record that and propose the minimal necessary architecture.

Do not assume that an agent named "Requirements analyst" means that requirements analysis is actually implemented. Check the real logic, inputs, output artifacts and verification criteria.

At the first stage, prepare a short audit:
- What already works.
- What works partially.
- What is missing.
- Where the understanding of the result is lost.
- Which changes are necessary.

Then move on to design and implementation.

## 3. Develop a single main algorithm

Create a central algorithm with the working name **Definition-to-Verified-Result: from the user's intent to a verified result**.

It must be the main process that tasks for creating, improving, analysing, researching and developing specifications go through.

Do not make it a set of independent algorithms competing with each other. Create a single sequence of stages with clear inputs, outputs, transition criteria and stop conditions.

### Stage 1. Interpreting the intent

Having received the user's request, the agent must determine:
- Which problem the user wants to solve.
- What the intended goal is.
- What the object of the work is.
- What result is expected.
- Who the result is for.
- Where it will be used.
- Which constraints are given explicitly.
- Which requirements are implied but not yet confirmed.
- Which information is missing.
- What could be understood ambiguously.

Keep the user's original wording separate from the agent's interpretations.

Do not turn an assumption into a confirmed requirement.

Produce a structured object of the initial understanding of the task.

### Stage 2. Defining the final result

This is the central stage of the algorithm.

The agent must describe the result so that another agent, who did not take part in the discussion, can understand what exactly must be created and how to check the finished result.

For each expected result, define:
1. **Type of result:** an application, a feature, a document, a specification, research, a bug fix, an integration, an automation or another artifact.
2. **Purpose:** which problem it solves.
3. **User of the result:** who will use it and in which conditions.
4. **Composition:** which files, components, functions, sections or data must exist.
5. **Behaviour:** what happens on specific actions or input conditions.
6. **Inputs:** what is needed for it to work.
7. **Outputs:** what the system must produce or change.
8. **Constraints:** what is forbidden, unacceptable or outside the scope of the task.
9. **Quality criteria:** which properties the result must have.
10. **Acceptance criteria:** which checks will prove that the result meets the requirements.
11. **Verification method:** an automated test, a manual check, a comparison, a run, a demonstration or another approach.
12. **Material artifacts:** which verifiable files, changes, reports or other results must remain after execution.

If the user says "make a good application", "improve search", "work out the architecture" or "create a convenient interface", do not accept these wordings as a sufficient specification.

Turn them into concrete requirements.

For example, instead of the requirement "make a good search", verifiable conditions must appear:
- which data is indexed;
- which types of queries are supported;
- how results are displayed;
- how empty queries and errors are handled;
- which privacy constraints are respected;
- how the correctness of search is checked.

Set numeric performance targets only when the context justifies them or the user agreed to them. Do not invent arbitrary norms.

### Stage 3. Context analysis and research

Before the specification is finalized, study the available context:
- The connected project and its architecture.
- Existing documents and knowledge.
- Implemented functions.
- Technology constraints.
- Dependencies and integrations.
- Previous decisions and agreements.
- Known bugs and technical debt.
- Possible ready-made solutions, libraries and tools.

If the task requires research, carry it out before architectural decisions are made.

Do not assume in advance that a solution exists, and do not conclude prematurely that it does not.

Compare reasonable options by:
- fit to the requirements;
- security;
- maintenance cost;
- implementation complexity;
- compatibility;
- the constraints of local operation.

Keep confirmed facts separate from assumptions and recommendations.

If access to the project, the internet or necessary tools is missing, state it explicitly. Do not claim that research or verification was done if it was not actually carried out.

### Stage 4. Forming the complete set of requirements

Turn the initial request and the results of the research into a requirements registry.

Each requirement must have:
- A unique stable identifier.
- A short title.
- A full description.
- A rationale or source.
- A type: functional, non-functional, constraint, security, interface, data, integration or another suitable type.
- A priority.
- A confirmation status.
- Related requirements.
- Acceptance criteria.
- A verification method.
- Dependencies.
- An implementation status, when an existing project is being changed.

Distinguish:
- The user's requirements.
- Conclusions drawn from the project.
- The agent's proposals.
- Confirmed decisions.
- Unconfirmed assumptions.
- Open questions.

For each requirement, make it possible to trace the path from the original request to implementation and verification.

Do not add features just because they seem useful. Any extension of the scope of the task must be justified and marked as a proposal.

### Stage 5. Finding ambiguities, gaps and contradictions

Check the requirements registry for:
- Ambiguous wording.
- Missing acceptance criteria.
- Incompatible requirements.
- Duplication.
- Hidden dependencies.
- Impossible or technically doubtful conditions.
- Conflicts between convenience, security, cost and performance.
- A lack of data for implementation.
- Uncertain boundaries of the task.
- Unverifiable claims about quality.

For each problem found, record it, its potential impact and the possible solutions.

Ask the user questions only when the uncertainty significantly affects the architecture, security, cost, reversibility of actions or the acceptance criteria.

If the uncertainty does not block the work, use a reasonable assumption, record it explicitly and continue.

Do not invent answers for the user where their decision is required.

### Stage 6. Decomposition and execution plan

Split the task into stages and subtasks.

Each subtask must contain:
- An identifier.
- A goal.
- Inputs.
- Concrete actions.
- An expected result.
- A list of artifacts created or changed.
- Dependencies.
- Acceptance criteria.
- A verification method.
- Constraints and necessary permissions.
- Completion conditions.
- Escalation or stop conditions.

Decompose the task down to the level at which the executor understands what to do and the reviewer can tell whether the work was done.

Do not split the work mechanically into dozens of small steps. The size of a subtask must match its complexity and keep the result verifiable.

Take dependencies into account and determine which actions can run in parallel and which must run sequentially.

### Stage 7. Forming the final specification

Gather all previous results into one document that can be handed to another team of agents or a developer without having to reconstruct the original conversation.

The specification must include:
1. Title and identifier.
2. Goal and problem description.
3. Project context.
4. Definition of the final result.
5. Scope of work.
6. Functional requirements.
7. Non-functional requirements.
8. User scenarios.
9. Inputs and outputs.
10. Architectural and technological constraints.
11. Security and privacy requirements.
12. Integrations and dependencies.
13. The structure of the solution, if it is defined.
14. The implementation plan.
15. The subtask registry.
16. Acceptance criteria.
17. The testing and verification plan.
18. Known risks.
19. Open questions and assumptions.
20. Documentation requirements.
21. Requirements for preserving existing functionality.
22. Completion and handover conditions.

Adapt the composition of the document to the scale of the task. Do not create a huge formal document for a simple task, but never omit information that is necessary for an unambiguous understanding of the result.

### Stage 8. Independent review of the specification

Before handing the task to executors, run an independent review.

The reviewing agent must not simply retell the document. It must try to find reasons why the specification could lead to a wrong result.

Check:
- Can the final result be understood without access to the original conversation?
- Can it be determined which artifacts must be created?
- Are the requirements specific enough?
- Does every significant requirement have a verifiable criterion?
- Are there contradictions?
- Are mandatory constraints missing?
- Are the existing components of the project taken into account?
- Is anything unnecessary proposed?
- Is the plan realistic?
- Can the result be checked objectively?
- Is there protection against losing user data and breaking existing functionality?

If the review found a problem, fix the document and repeat the review within the set number of iterations.

If a significant defect cannot be fixed, do not mark the specification as fully ready. State the blocking questions and the reasons.

## 4. The mandatory model of the final result

Create a single formal result contract used by all agents.

The minimal structure:

```json
{
  "task_id": "TASK-001",
  "title": "Short task title",
  "original_request": "The user's original request",
  "problem_statement": "Which problem must be solved",
  "objective": "What must be obtained",
  "result_type": "software",
  "target_users": [],
  "scope": {
    "in_scope": [],
    "out_of_scope": []
  },
  "assumptions": [],
  "constraints": [],
  "requirements": [
    {
      "id": "REQ-001",
      "description": "A concrete requirement",
      "type": "functional",
      "priority": "must",
      "status": "confirmed",
      "source": "user",
      "acceptance_criteria": [
        {
          "id": "AC-001",
          "condition": "An observable completion condition",
          "verification_method": "test"
        }
      ],
      "dependencies": []
    }
  ],
  "expected_artifacts": [],
  "implementation_plan": [],
  "risks": [],
  "open_questions": [],
  "verification_plan": [],
  "completion_conditions": [],
  "status": "draft"
}
```

This is a base model, not a rigid template for all task types. Extend it with typed fields where that is really necessary.

Provide:
- Validation of the structure.
- A check of required fields.
- Uniqueness of identifiers.
- A check of references between requirements and subtasks.
- A check that acceptance criteria are present.
- Versioning of the schema.
- Preservation of the original request.
- Preservation of the change history.
- The ability to reconstruct why a particular decision was made.

Do not let an agent change the data structure arbitrarily and thereby bypass the checks.

## 5. Teach the agents to work with the result contract

It is not enough to add the algorithm to the documentation. All relevant agents must actually use it in their work.

Define and implement the following agent functions:
- **Coordinator.** Receives the user's request, starts the main algorithm, chooses the necessary stages, manages dependencies and keeps the result consistent.
- **Requirements analyst.** Turns the original request into a requirements registry, separates facts from assumptions, finds ambiguities and forms acceptance criteria.
- **Researcher.** Studies the existing project, the documentation, available technologies and alternative solutions. Returns verifiable information with sources.
- **Architect.** Determines the implementation approach, takes the project's constraints into account, chooses components and records architectural decisions.
- **Decomposer.** Splits the approved goal into executable subtasks with concrete inputs, outputs and completion criteria.
- **Implementer.** Works only within the assigned subtask, respects the constraints and returns the actual result with a list of changed artifacts.
- **Verifier.** Checks that the result matches the contract, runs the available checks and reports proven mismatches.
- **Independent reviewer.** Checks the quality of the final specification or result, finds gaps, contradictions and unjustified decisions.

Do not run all agents for every task. The coordinator must choose the minimal sufficient set of roles while keeping the mandatory checks.

## 6. The standard for handing tasks between agents

Every handover must go through a structured object, not an arbitrary message like "have a look and do it".

A handover states:
- The identifier of the task and the subtask.
- The goal.
- The context needed by this particular agent.
- The confirmed requirements.
- The allowed assumptions.
- The inputs.
- The expected outputs.
- The result format.
- The acceptance criteria.
- The constraints and forbidden actions.
- The necessary permissions.
- The dependencies.
- The verification method.
- The completion conditions.
- The format of the execution report.

Every agent must return a structured report:
- What was done.
- Which artifacts were created or changed.
- Which requirements were met.
- Which checks were actually carried out.
- What the results of the checks are.
- What remains undone.
- Which problems were found.
- Which decisions need approval.
- Which facts are confirmed and which remain assumptions.

The next agent must not consider the task done just because the previous agent reported success. It must check that the result and the necessary evidence exist.

## 7. A critical distinction: description, implementation and proof

Introduce three separate notions into the system:
1. **The expected result:** what must exist after the task is done.
2. **The actual result:** what was really created, changed or obtained.
3. **The evidence of conformity:** what confirms that the requirements are met.

For example, if the task is to create search over local documents:
- Expected result: working search with defined capabilities.
- Actual result: the implemented components, the index and the user interface.
- Evidence: test results, example queries, checks of edge cases and confirmation that no forbidden data transfer happens.

Substituting one level for another is forbidden.
- The existence of a specification does not prove that a feature is implemented.
- The existence of code does not prove that it works.
- A successful build does not prove that all requirements are met.

If some requirement cannot be verified, mark it as unverified, not as successfully completed.

## 8. Implement a controlled fix loop

After a subtask is executed:
1. Compare the actual result with the contract.
2. Find the unmet criteria.
3. Determine the cause of the mismatch.
4. Decide whether the problem can be fixed automatically.
5. Create a bounded fix task.
6. Repeat the necessary checks.
7. Record the result of the re-check.

The loop must be limited in the number of iterations and in time, as defined by configuration.

Do not allow endless fix attempts or a spontaneous widening of the scope of work.

If a fix requires changing the original requirements, the architecture, the permissions or the agreed scope of the task, stop and request the necessary decision.

## 9. Build the algorithm into the existing application

After the design, implement the algorithm in the existing architecture.

Implement the necessary components:
- The main requirements-processing engine.
- A typed model of the task and the result.
- A validator of requirements and acceptance criteria.
- A decomposition mechanism.
- The handover contract for agents.
- Verification of results.
- The bounded fix loop.
- Storage of specification versions.
- Links between requirements, subtasks, artifacts and checks.
- Logging of execution stages.
- Recovery of unfinished tasks after a restart.

Use existing components where they fit. Do not rewrite the whole system without need.

If the application uses local AI models, take their limitations into account: a small context, a tendency to omit things, unstable following of long instructions and possible errors in structured output.

To increase reliability:
- Split long tasks into manageable stages.
- Pass agents only the relevant context.
- Use schemas and programmatic validation.
- Check required fields and references.
- Save intermediate results.
- Do not rely solely on system instructions.
- Use ordinary code for checks that can be done deterministically.

If a local model failed at a stage, the system must report the problem, not create the appearance of a successful result.

## 10. The user interface of the algorithm

The user must see not only a dialogue with the AI, but a clear process of turning the request into a result.

For each task, show:
1. The original request.
2. How the system understood the task.
3. The intended final result.
4. Requirements and acceptance criteria.
5. Ambiguities and open questions.
6. Research results.
7. The plan and subtasks.
8. The assigned agents.
9. The current stage.
10. Created and changed artifacts.
11. Verification results.
12. Mismatches found.
13. The change history of the specification.

The user must be able to:
- Correct the understanding of the task.
- Confirm or reject an assumption.
- Change a requirement.
- Add a constraint.
- Exclude an unnecessary feature.
- Approve the specification.
- Pause execution.
- View the actual changes.
- Start a re-check.

Do not turn the interface into an endless feed of messages. Use a task workspace with separate sections for requirements, the plan, results, artifacts and checks.

## 11. Mandatory test scenarios

Create automated tests for the algorithm and integration tests for the interaction of agents.

Check the following cases:
1. The user gives a short and clear task.
2. The user gives a vague task without a defined result.
3. The user lists features but gives no acceptance criteria.
4. The user gives contradictory requirements.
5. The task depends on unknown characteristics of the existing project.
6. Solving it requires researching several alternatives.
7. The task requires several specialized agents.
8. A local model returns an invalid data structure.
9. An agent reports success, but the artifact is missing.
10. Code was created, but the tests did not pass.
11. Part of the requirements is met and part is not.
12. The task is interrupted and resumed after the application restarts.
13. The user changes a requirement during execution.
14. Two requirements conflict after the change.
15. Continuing requires the user's permission.
16. A necessary tool or data source is unavailable.
17. An agent tries to go beyond the boundaries of its subtask.
18. The specification lacks verification criteria.
19. Requirements and subtasks contain broken references or duplicate identifiers.
20. The independent reviewer finds an error the implementer missed.

For each scenario, record the expected behaviour of the system and the criteria for passing.

## 12. Checking the quality of the algorithm itself

Do not consider the algorithm ready just because it is implemented and passes a few tests.

Evaluate it by these criteria:
- **Completeness:** the necessary requirements and constraints are not lost along the way.
- **Unambiguity:** the final result is clear to the executor without reconstructing the context of the conversation.
- **Verifiability:** every significant requirement has acceptance criteria.
- **Traceability:** the link between the request, the requirement, the subtask, the artifact and the check can be established.
- **Consistency:** contradictions are found before execution.
- **Executability:** tasks are concrete enough for the chosen agent and the available tools.
- **Economy:** no unnecessary agents are run and no unnecessary documentation is created.
- **Robustness:** model errors and unfinished stages do not lead to a false success status.
- **Security:** agents do not gain additional permissions through the contents of the specification.
- **Context preservation:** after a restart, the system can continue work from the correct stage.

If possible, run a comparative test. Process the same test requests before and after the algorithm is introduced, and compare:
- the completeness of the requirements;
- the number of ambiguities;
- the correctness of the acceptance criteria;
- the success of the subsequent execution.

Do not claim a quality improvement without measurement results. If the original version does not exist or cannot be run, record that limitation.

## 13. The order of work

Work sequentially.

- **Phase A. Audit.** Study the existing project and find the real causes of the loss of understanding of the result.
- **Phase B. Design.** Define the architecture of the algorithm, the data structure, the stages, the agent contracts and the validation rules.
- **Phase C. Demonstration on examples.** Take at least three different requests:
  - a simple task;
  - an ambiguous task;
  - a complex multi-stage task.

  Show how the algorithm turns each request into a verifiable specification. Use the examples to check the architecture, not instead of the implementation.
- **Phase D. Implementation.** Add the algorithm to the application and integrate it with the existing agents and the interface.
- **Phase E. Testing.** Run the available automated, integration and scenario tests. Fix the errors found within the agreed scope.
- **Phase F. Documentation.** Create documentation:
  - How the algorithm works.
  - Which stages it goes through.
  - Which data is passed between agents.
  - How acceptance criteria are formed.
  - How the final result is checked.
  - How to add new agent roles.
  - How to diagnose errors.
  - Which limitations exist so far.
- **Phase G. Final report.** Report:
  - What was found in the original project.
  - Which algorithm was developed.
  - Which components were implemented.
  - Which files were changed.
  - Which tests were run and what the results are.
  - Which problems remain.
  - Which limitations could not be removed.
  - How to check the algorithm manually.

Do not present a work plan as completed work. If you do not have access to the necessary tools, say so explicitly and prepare a concrete plan of further actions.

## 14. The main rule

The whole solution must be built around one principle:

**Every task must have a defined final result, formalized requirements, verifiable acceptance criteria and evidence of actual completion.**

Agents must understand not only what they need to do, but also why they do it, what exactly they must pass on and under which conditions their work will be accepted.

Do not create complexity for the sake of complexity. Do not add dozens of algorithms if one main process with a small number of specialized checks solves the problem.

First make the system reliably turn natural language into clear, complete and verifiable specifications. Then make sure that all agents use these specifications in planning, execution and verification of results.
