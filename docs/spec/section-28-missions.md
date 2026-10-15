# Section 28 of the original specification (primary source)

> An English translation of the section as the client wrote it. The implementation is described in `docs/architecture/missions.md`. The 15 acceptance scenarios of 28.17 are covered by the tests with the same numbers in `packages/core/test/missions.test.ts`.

## 28. Carrying out natural-language specifications: an intelligent system of actions, research and problem solving

### 28.1. The main concept

Implement in the product a full system for carrying out specifications, where the user can describe in their own words what they want to get, and the application explores the context by itself, chooses a suitable way to solve the task, designs a new approach when needed, does the work and verifies the result.

The user must not be required to know in advance:
- Which agent the task needs.
- Which tools to use.
- Which execution stages are needed.
- Whether a ready solution exists.
- Where to look for information.
- Which architecture to choose.
- How to split the task into subtasks.
- Which files to create or change.
- How to check that the result is correct.

The system must determine all of this from the task, the available context, studying the project, the available tools and the quality criteria.

For example, the user writes:

"Study my project, find a good way to organize work with several knowledge systems, propose an architecture, implement it and check that existing data is not lost."

The system must by itself:
1. Understand what exactly is required.
2. Study the connected project and the existing architecture.
3. Determine which information is missing.
4. Find suitable existing solutions and libraries.
5. Compare the alternatives.
6. Decide whether an existing solution fits or an own one has to be developed.
7. Make an execution plan.
8. Carry out the necessary actions with suitable agents and tools.
9. Verify the result.
10. Fix the errors it finds.
11. Give the user the finished result, a report and information about the checks.

This is not just information search, not a recommendation generator and not an interface for chatting with AI. It is **a system that turns a natural-language specification into a verifiable result**.

### 28.2. Conversational features without an ordinary chat interface

Provide a way to set tasks in natural language, clarify requirements, discuss solution options and adjust the course of execution.

But do not turn the main interface of the product into an ordinary messenger with message bubbles, avatars and an endless feed.

Instead, create a full task workspace.

A sample structure:

```text
┌────────────────────────────────────────────────────────────────────┐
│ New task                                                           │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│ What needs to be done?                                             │
│                                                                    │
│ [ Study the project and implement a safe system for managing      │
│   several independent knowledge stores.                        ]   │
│                                                                    │
│ Context: [Current project ▾]                                       │
│                                                                    │
│ Attachments: files, documents, links, repositories                 │
│                                                                    │
│ [Research options] [Execute the task]                              │
├────────────────────────────────────────────────────────────────────┤
│ Execution plan                                                     │
│ ✓ Task analysis                                                    │
│ ✓ Project study                                                    │
│ ● Research of options                                              │
│ ○ Architecture choice                                              │
│ ○ Implementation                                                   │
│ ○ Result verification                                              │
├────────────────────────────────────────────────────────────────────┤
│ Results | Artifacts | Checks | Log | Discussion                    │
└────────────────────────────────────────────────────────────────────┘
```

This is a sample layout, not a mandatory fixed mockup.
The main idea: the user sets a task in plain text and then sees a structured work process, its results, the materials found, the decisions, the artifacts and the checks.

### 28.3. Natural language as the main way to set tasks

The user must be able to formulate tasks freely, without filling in complex forms.
Support requests such as:

* "Study this repository and explain how it works."
* "Find a good way to implement local search over documents."
* "Compare several approaches and choose the one that fits my project best."
* "Design the architecture of an agent system."
* "Implement this functionality in code."
* "Find the bugs and fix them."
* "Improve performance without breaking existing functionality."
* "Study the documentation and implement the integration."
* "Check which features are missing and propose a development plan."
* "Find a suitable library, evaluate it and integrate it if it really fits."
* "If there is no ready solution, develop your own."
* "Carry out the whole specification and tell me what came out."

The user may attach documents, source code, links, images, tables, specifications or point to a connected knowledge system.
The system must extract the requirements from these materials and take them into account.
Do not require the user to define the sequence of operations in advance if it can reasonably be derived from the task.

### 28.4. The system must not only find but also invent solutions

One of the most important principles: the absence of a ready solution must not stop the work.
If the user asks to implement a capability, the system must consider several scenarios:

1. A suitable ready solution already exists in the project.
2. The project has a library or component that can be extended.
3. A suitable external library or open project exists.
4. There are several options that need to be compared and adapted.
5. No ready option meets the requirements.
6. An own solution has to be designed and implemented.
7. The task needs a combination of ready components and own development.

The system must be able to move from research to independent design and implementation.
Do not stop at a recommendation such as "you can use library X". If the task implies implementation and the tools have the necessary permissions, the system must install, configure, integrate or implement the chosen option and then verify the result.
At the same time, it must not thoughtlessly create its own solution when a good, compatible and maintained ready solution already exists.
The choice between using an existing tool and developing a new one must be based on a comparison of:

* Fit to the requirements.
* Compatibility with the current architecture.
* Reliability.
* Security.
* Performance.
* Maintainability.
* License.
* Dependencies.
* Running cost.
* Limitations of the local mode.
* The ability to work without external APIs.
* The complexity of further development.

If a ready solution fits partially, explore adapting it instead of rejecting it automatically.

### 28.5. A universal algorithm for carrying out a specification

Create a central Task Execution Engine that manages the full lifecycle of a task.
Every task must go through the stages that suit it. Do not run every possible process without need: the depth of research, the number of agents and the amount of checking must depend on the complexity and the risk of the task.

**Stage 1. Request analysis.** The system analyzes the user's text and determines: the desired result; the problem to solve; the mandatory requirements; the constraints; the context and the source materials; the expected acceptance criteria; the risks; whether clarification is needed; which actions are really needed.
Turn the free-form request into a structured internal specification.
Do not show the user a complex form instead of their original request. The structuring happens inside the system, and a clear short summary can be shown in the interface for confirmation.
If the request is clear enough, move on to execution without extra questions.
If critical information is missing and cannot be safely derived from the context, ask a specific question.
If the missing details do not block the work, record reasonable assumptions and continue.

**Stage 2. Studying the context.** Before making decisions, the system studies the available information: connected projects; the repository structure; the source code; existing specifications; documentation; the application architecture; tests; dependencies; configurations; the knowledge base; the history of earlier decisions; suitable external sources.
Explore only the sources that relate to the task and are available under the permissions.
Do not conclude that a solution does not exist just because it was not found in the first document or the first search results.
When needed, go deeper, check related files and compare information from several sources.

**Stage 3. Researching ways to solve the task.** The system forms several realistic solution options by itself when that is useful.
For each option, assess: how it works; which requirements it covers; what limitations it has; what resources it needs; what risks it creates; how it integrates into the existing system; how to test it; why it is better or worse than the alternatives.
If the task is simple and obvious, do not create many options artificially.
If the task is complex, architectural or ambiguous, research it more deeply.
Use external sources to get evidence, not to copy other people's solutions unconditionally.

**Stage 4. Choosing a strategy.** Based on the collected data, choose the most suitable way to solve the task.
The system must be able to choose by itself between: using existing functionality; configuring a ready tool; integrating a library; changing the existing architecture; developing a new component; creating a completely new mechanism; a combined solution.
Record the reasons for the choice and the important trade-offs.
For risky decisions or decisions that significantly affect the architecture, show the user the plan and ask for confirmation before making changes, if the permission policy requires it.
For ordinary safe actions, do not create extra waiting points.

**Stage 5. Execution planning.** Turn the task into a sequence of concrete actions.
For each subtask define: a unique ID; the goal; the inputs; the expected result; the dependencies; the executor or agent; the tools needed; the acceptance criteria; the verification method; possible risks.
Take the dependencies between actions into account.
Independent research tasks can run in parallel. Changes to the same file or shared structure must be coordinated to avoid conflicts.

**Stage 6. Execution.** The system must really carry out the planned actions within the granted permissions.
Depending on the task this may include: reading and analyzing files; searching for information; studying documentation; exploring GitHub and other open sources; creating documents; changing existing files; writing code; creating tests; running the available checks; updating configurations; integrating libraries; creating new agents; creating workflows; indexing documents; updating the knowledge graph; writing reports; preparing architecture decisions.
If an operation requires a permission the system does not have, it must report the limitation and propose the next step.
Do not imitate execution. If a file was not changed, a test was not run or an external source is unavailable, do not claim otherwise.

**Stage 7. Verifying the result.** After execution the system checks whether the result matches the original task.
Depending on the type of task, use: checks of the file structure; checks of schemas and formats; automated tests; integration tests; build checks; static analysis; link checks; comparison with the requirements; checks for unwanted changes; security checks; comparison of the actual result with the expected one.
For research tasks, check the reliability of the conclusions and the quality of the sources.
For architecture tasks, check the completeness of the requirements, the consistency of the components and the description of the trade-offs.
For programming tasks, check the code and run the available tests.

**Stage 8. Fixing problems.** If verification found errors, the system must find their cause and fix them, if this is part of the task and allowed.
After the fixes, run the related checks again.
Use bounded fix loops, so as not to spend resources endlessly and not to allow uncontrolled changes.
If the problem is not fixed, record: what does not work; what was already tried; why the fix failed; which limitations get in the way; what is needed to continue.
Do not declare the task done just because the answer generation finished.

**Stage 9. Summary and saving the results.** When finished, write a clear summary: what was required; what was studied; which approach was chosen; what was actually done; which files were created or changed; which checks were run; which checks could not be run; which limitations remain; where the results are; which next actions are recommended.
Save the results in a suitable knowledge system or repository if this is part of the task and allowed.
Do not create many useless reports. Save only materials that are useful for further work.

### 28.6. Multi-agent execution

The Task Execution Engine must use specialized agents when this improves quality, speed or reliability.
Do not create a fixed chain of dozens of agents for every task.
First determine the set of roles needed.
Possible roles:

* Task Planner: analyzes the request and builds the plan.
* Project Explorer: studies the project and its architecture.
* Research Agent: looks for solutions and checks sources.
* Solution Architect: compares options and chooses the architecture.
* Requirements Analyst: checks that the requirements are complete.
* Implementation Agent: makes the changes.
* Testing Agent: verifies the result.
* Security Reviewer: assesses security risks.
* Documentation Agent: updates the documentation.
* Independent Reviewer: reviews the outcome independently.
* Coordinator: manages execution and collects the results.

For a simple task one agent may be enough.
For a complex task the Coordinator forms a team of suitable specialists.
Agents must get limited and relevant contexts, not the whole knowledge base automatically.
Every agent returns a structured result with evidence, references to sources, the actions performed, problems and recommendations.
The Coordinator combines the results, resolves contradictions and makes sure the original requirements are kept.
Do not treat the answers of several agents as independent confirmation if they all rely on the same unconfirmed source.

### 28.7. Support for different types of tasks

The system must determine the type of task and adapt the execution process.

* **Research:** study the question; find sources; compare the information; prepare conclusions with evidence; save useful materials.
* **Design:** study the context; formulate the requirements; compare architecture options; choose an approach; prepare a specification.
* **Development:** study the repository; make a change plan; implement the functionality; write or update tests; verify the result.
* **Bug fixing:** reproduce the problem if possible; find the cause; develop a fix; add a regression check; make sure the fix works.
* **Improving an existing system:** study the current state; find bottlenecks; compare improvement options; identify the risks; implement the agreed changes; compare the state before and after.
* **Creating informational material:** research the topic; study existing knowledge; build a structure; prepare the material; check completeness and sources; save the result.
* **A complex specification:** run the full cycle from analysis to verification; coordinate the subtasks; track the acceptance criteria; prepare the final report.

The type of task must shape the process but must not limit the system to predefined scenarios. If a new type of request appears, the system must be able to build a suitable plan from the available tools and safe operations.

### 28.8. Working with uncertainty and new tasks

Do not assume that a ready agent, library, instruction or template already exists for every task.
If there is no suitable agent, the system must be able to:

1. Determine the competences needed.
2. Choose existing tools.
3. Build a temporary work plan.
4. Create a specialized agent or workflow when needed.
5. Check its configuration.
6. Carry out the task.
7. Keep the created agent only if it will really be useful later and this is allowed.

If a task goes beyond the capabilities of the available models, tools or permissions, the system must state the limitation honestly.
Do not replace a missing capability with general reasoning that looks like finished work.

### 28.9. Planning and execution are different modes

Provide two main modes.

**"Research and plan" mode.** The system studies the task, researches the options and delivers a plan. It makes no changes beyond the actions allowed in this mode.

**"Execute the task" mode.** The system goes through the full cycle: research, planning, execution, verification and preparing the result.

The user must understand which mode is active.
If a task implies destructive, irreversible, externally significant or potentially dangerous actions, the system must ask for confirmation according to the security policy.
Such actions may include deleting data, mass overwriting of files, publishing changes, running unchecked scripts or sending information to external services.
For ordinary reversible operations, do not ask for permission for every small step if the user has already allowed them.

### 28.10. A structured task model

Store the internal representation of a task in a structured form.
Provide at least: `task_id`, `title`, `original_request`, `normalized_requirements`, `system_id`, `project_id` (if applicable), `status`, `priority`, `assumptions`, `constraints`, `acceptance_criteria`, `plan`, `subtasks`, `dependencies`, `selected_strategy`, `artifacts`, `source_references`, `verification_results`, `approval_requests`, `execution_log`, `errors`, `created_at`, `updated_at`, `completed_at` (if the task is finished).
Define typed schemas for plans, subtasks, results and checks.
Store the user's original request separately from the normalized requirements, so that it can be checked whether the system distorted the original meaning.
Do not make the internal task structure a mandatory complex form for the user. It is an execution model, not extra bureaucracy.

### 28.11. Task statuses and lifecycle

Implement a transparent state machine: draft; analyzing; researching; planning; awaiting approval; ready to run; running; paused; needs input; verifying; needs fixes; completed; partially completed; failed; cancelled.
Transitions between statuses must be explicit and validated.
If the application closes during execution, keep the task state, the log and the available results. After a restart, offer a safe continuation or recovery if possible.
Do not repeat irreversible actions just because the task was recovered after a crash.
Use idempotency where needed and record the steps that were done.

### 28.12. The task execution interface

Create a dedicated task screen that lets the user understand not only what the system is doing but also what it arrived at.
Main areas:
1. **Task description:** the original request, the refined requirements, the assumptions and the acceptance criteria.
2. **Execution plan:** the sequence of stages, the dependencies, the current stage and the progress.
3. **Research:** the solutions found, the sources, the alternatives and the reasons for the choice.
4. **Results:** created documents, changed files, code, specifications, reports and other artifacts.
5. **Checks:** the list of checks, the actual results, errors and limitations.
6. **Action log:** what was done, by which agent, when, in which context and with which result.
7. **Task discussion:** a way to clarify requirements, ask to explain a choice, change priorities or give an additional instruction.

The discussion must be tied to the specific task and its context. It is not a separate messenger and not a replacement for the structured execution process.

### 28.13. The ability to intervene in the process

The user must stay in control of the execution.
Provide the actions: pause; resume; cancel; change the plan; add a requirement; refine the acceptance criteria; ask to research an additional option; forbid a specific tool; choose another way to solve the task; view the current results; retry a failed stage; review changes before applying them.
If the user changes the original requirements during execution, the system must determine which parts of the plan are outdated and recalculate the dependencies.
Do not discard completed stages without need.
If a new requirement conflicts with an earlier one, explain the conflict and propose a resolution.

### 28.14. Carrying out tasks across several systems

Integrate the execution mechanism with the multi-system architecture of the product.
Every task must have an explicit scope: the current system; a selected project; several explicitly selected systems; public sources only, without access to local data.
When a task is set, the interface must show where it will run.
If the user writes "study all my projects", the system must offer the available connected projects or use every system it has permission for that matches the request.
Do not merge the data of different systems without need.
In cross-system research, keep references to the original sources and the origin of every result.
By default, save the result in the system where the task was created, unless the user chose another place.
If a task implies changing files in several repositories, list them and respect the permissions of each.

### 28.15. Local AI and execution without API keys

The task execution mechanism must work with local models without a mandatory paid external API.
Support the available local models through the adapter chosen by the architecture, for example Ollama or LM Studio, and provide an extensible interface for other engines.
Before execution, assess the availability of the models and the required tools.
If a local model cannot handle a specific stage:

* Try another available local option, if it fits.
* Split the task into simpler verifiable stages, if that is acceptable.
* Offer to connect an external provider as an optional choice, if allowed.
* Report the real limitation if it is impossible to continue.

In local mode, do not send data to external services and do not switch to a cloud model automatically.
Do not claim that a task is fully done if some stages did not run for lack of a model, a tool or access.

### 28.16. Quality control and completion criteria

Do not consider a task done just because an agent returned an answer.
Before finishing, compare the actual result with the acceptance criteria.
For every criterion keep a status: met; partially met; not met; could not be verified; not applicable.
For technical tasks also check: consistency with the project architecture; correctness of the changed files; the presence of the required tests; the absence of obvious regressions; correctness of the documentation; the safety of existing data; compliance with the permissions.
For research tasks check: the quality of the sources; confirmation of the key conclusions; separation of facts and assumptions; the presence of alternatives; the freshness of information when it matters; the absence of invented sources and claims.
If the criteria are not fully met, show the partial result and the specific reasons. Do not hide failed checks behind a general success message.

### 28.17. Acceptance criteria

The functionality is done when the user can write a specification in plain language and get a full, controllable process of carrying it out.
Check the following scenarios:

1. The user asks to research a question and prepare a report.
2. The user asks to find an existing solution and compare alternatives.
3. The user asks to implement a feature in a connected repository.
4. The user asks to fix a bug.
5. The user asks to create a new feature for which the project has no ready component.
6. The user asks to improve the existing architecture.
7. The user sets an ambiguous task that needs clarification.
8. The user sets a task that needs several agents.
9. The user pauses the execution and resumes it later.
10. The user changes the requirements during execution.
11. One of the checks fails, and the system tries to fix the problem.
12. A required tool is unavailable.
13. A local AI model is available, but there is no external API key.
14. The task uses data from several systems.
15. The application closes during execution and restores the state of the task.

In every scenario the system must honestly show the actual execution status, keep the results and never report successful completion without sufficient grounds.

### 28.18. The final principle

The user formulates the desired result. The system explores the context by itself, chooses a strategy, plans the actions, uses suitable agents and tools, does the work, verifies the result and explains what came out.
The system must be able to find ready solutions, adapt existing approaches and create new ones if no suitable option exists.
The main goal is not just to answer the user's questions but to carry out their tasks well.
The interface must stay a working environment for managing tasks and results and must not turn into an ordinary chat. Natural language is a convenient way to set a task and manage the process, not the only form of interaction with the product.
