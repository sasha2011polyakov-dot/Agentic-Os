# Section 29 of the original specification (primary source)

> An English translation of the original specification; the meaning is unchanged and the lists are formatted as Markdown. Implementation: `docs/architecture/security.md` (the sections on access modes, work copies, backups, the sandbox and the security log). Tests: the numbered scenarios of 29.18 are covered by the tests with the same numbers in `packages/core/test/security.test.ts`.

## 29. Cybersecurity, repository protection and safe work with local projects

### 29.1. The main security goal

Implement a strict cybersecurity system in the application that lets AI agents study projects, analyze code, work with files, search for information and carry out specifications, while protecting the original project from accidental damage, data loss, unauthorized changes and dangerous actions.

The user may not know how Git, GitHub, branches, commits, access rights, the file system and build processes work. So the application must be secure by default instead of requiring technical knowledge from the user.

**The main principle: the system can study a project and prepare changes, but must not be able to rewrite, delete or destroy the original project without control.**

At the same time, do not turn the application into a fully passive viewer. It must be able to carry out specifications, create files, write code, run tests and propose improvements, but only within clearly defined permissions and with a reliable recovery mechanism.

Security must come from the architecture and technical restrictions, not only from instructions to the AI model.

### 29.2. Separate viewing a project from changing it

When a local folder or a downloaded repository is connected, the system must work in several modes.

**Mode 1. Read only.** This is the default mode for a new or not yet checked project.
Allowed: reading files; analyzing the project structure; studying the source code; reading documentation; searching; building the index and the knowledge graph in the internal storage of the application; writing specifications; proposing architecture decisions; preparing a change plan; analyzing potential vulnerabilities.
Forbidden: changing the original project files; deleting or moving files; renaming folders; overwriting configurations; installing dependencies into the original project; running scripts with side effects; running commands that change the state of the repository; pushing changes to a remote repository.
In this mode AI agents can explore the project fully, but cannot change its content.

**Mode 2. Preparing changes.** The system can create new versions of files, patches, proposed code changes and other results, but keeps them separately from the original project. The user can study the difference between the original and the proposed state.

**Mode 3. Safe execution.** The system can make allowed changes in a dedicated work copy of the project. The original files stay untouched.

**Mode 4. Applying changes to the original.** This is a separate privileged operation that is off by default. Changes can be applied to the original project only through a controlled process with a review of the changes, a backup and an explicit confirmation by the user.

Do not switch the application to a more privileged mode automatically, even if an AI agent thinks it is needed for the task.

### 29.3. Protecting the original project with work copies

Use the principle of a safe work copy.
When the user connects an existing project, the system must not automatically turn it into an object that agents can rewrite freely.
The recommended process:
1. The user chooses a local folder.
2. The application determines the project structure.
3. The original folder is registered as a source.
4. By default the application opens it in read mode.
5. When changes are needed, a separate work copy is created.
6. AI agents work only in this copy.
7. The changes are checked.
8. The application shows the result to the user.
9. The user can apply the changes, export them or reject them.

The work copy must be physically separate from the original project, so that an accidental command or an agent error does not damage the original files.
If a full copy is not practical for large projects, safe alternatives such as a separate Git branch, a Git worktree or another isolated workspace are acceptable. But such an option may be used only after the state of the repository has been checked and recovery is possible.
Do not consider a Git branch full protection against all damage: some operations can change shared files, the state of the repository or data outside the working branch.
If a safe work copy could not be created, do not let agents change the original. Explain the reason and offer a safe alternative scenario.

### 29.4. Protecting files and critical folders

Create a central file system access policy.
Every operation must check: in which system the task runs; which project is selected; which file is affected; whether reading is allowed; whether changing is allowed; whether deleting is allowed; whether the file is inside the allowed workspace; whether the operation is dangerous; whether an additional confirmation is needed.
Handle the following with special care: `.git/`; `.env` and similar secret files; private keys; security configuration files; build and deployment files; system folders; installation scripts; migration scripts; dependency files; package manifests; license files; CI/CD settings; publishing configurations; backup files.
Do not forbid reading all of these files unconditionally: some of them are needed to analyze the project. Instead, separate the permissions to read, change, execute and send content to external services.
For example, an agent may read the build configuration to understand the architecture, but must not automatically change how the application is published.
Secrets must be recognized and excluded from logs, reports, external requests and agent context unless they are needed for a specific allowed operation.

### 29.5. No dangerous changes without confirmation

Implement a list of operations that need a separate confirmation by the user: mass deletion of files; overwriting many files; deleting folders; changing security files; changing publishing configurations; changing the build system; changing dependencies with potentially dangerous consequences; running migrations that change data; changing Git branches and history; running potentially destructive commands; pushing changes to a remote repository; publishing a release; deleting a system or a database; sending confidential data to external services.
The confirmation must describe the specific operation in plain language. Do not use vague messages such as "Allow AI?".
Instead show: what exactly will change; which files are affected; what can go wrong; whether the action can be undone; whether there is a backup; what happens if the user refuses.
Do not treat a general agreement to carry out a specification as a permission for any destructive action.
If an action is outside the agreed scope of work, ask for a separate permission.

### 29.6. Protection around Git and GitHub

The user may connect a repository downloaded from GitHub without understanding how Git works inside. So the application must explain work with the repository in plain language and behave safely by default.
When a Git repository is found: determine whether the folder is a Git repository; check for uncommitted changes; determine the current branch if possible; check the state of the working directory; find untracked files; check for remotes without revealing secrets; show the user a short description of the repository state.
Do not automatically run `git reset --hard`, `git clean`, a forced checkout, history rewriting or other potentially destructive commands.
Do not delete untracked files and do not discard the user's existing changes.
If the working directory already has changes, keep them and warn the user before operations that may conflict with them.
For automated changes prefer: 1) an isolated work copy; 2) a separate branch or worktree, if it is safe and appropriate; 3) a reviewable change set; 4) viewing the diff; 5) testing; 6) exporting a patch or a controlled application.
Do not automatically run `git push`, publish commits or change a remote repository.
By default, interaction with GitHub must be limited to reading public information, analyzing repositories and preparing changes.
If the user explicitly connected an account and allowed specific actions, use the minimal rights needed. Publishing changes, creating a pull request or changing the settings of a remote repository requires an explicit confirmation of that operation.
Do not ask for a GitHub password or a personal token in a plain text field. Use secure authorization and keep credentials in the system secret store.

### 29.7. Review before applying changes

Create a change review screen. The user must see the changes before they reach the original project.
For every file show: the path; the type of operation (creation, change, deletion or rename); the original content, if applicable; the proposed content; a line-by-line comparison; the reason for the change; the related task; the test results.
For a large set of changes show a summary: the number of files, the types of operations and potentially risky changes.
Provide the actions: "Accept all allowed changes"; "Accept selected changes"; "Reject selected changes"; "Reject all"; "Download patch"; "Open file"; "Check again"; "Show explanation".
Do not apply changes that were not part of the reviewed set.
If an AI agent changed the files again after the review, mark the previous approval as outdated and ask for a new review of the affected changes.

### 29.8. Backups and recovery

Before applying changes to the original project, create a verifiable restore point.
The backup must allow restoring the original state of the files affected by the operation.
Do not rely on Git alone: the user may work with a plain folder without a repository, and Git does not guarantee the safety of all user data and untracked files.
Implement: a backup before risky changes; an integrity check of the backup; storing the metadata of the operation; linking the backup to the task; viewing the affected files; restoring the previous state; protecting backups against accidental overwriting; a clear retention and deletion policy for backups.
The backup must not be inside a folder that an agent could accidentally clean together with the working files.
If the application could not create and verify the required backup, forbid the matching risky operation.
For safe operations that do not touch the original, do not require extra backups.

### 29.9. A sandbox for running code

Do not let AI agents automatically run arbitrary code on the user's computer.
Tests, build scripts and other commands must run in a controlled environment.
When possible, use an isolated environment with: limited file system access; limited process rights; network restrictions; time limits; memory and CPU limits; control of the processes it creates; restrictions on changing system settings.
Before running unknown scripts, study their content and origin.
Do not automatically run: installation scripts from unchecked repositories; commands with elevated privileges; driver installers; deletion commands; unknown binaries; scripts that send local data to the network; commands that change system settings.
If a full sandbox is not available, do not claim that execution is fully isolated. Use a more limited mode, explain the limitations and ask for confirmation of potentially dangerous operations.

### 29.10. Protection against malicious instructions inside a project

The content of a repository cannot be considered trusted just because it is in a connected folder.
Project files, READMEs, comments, documentation, web pages and search results may contain instructions written specifically to manipulate AI agents. For example, a file may tell the agent to: ignore system restrictions; read secrets from `.env`; send files to an external server; delete other files; run an unknown command; change permissions; hide actions from the user.
Treat the content of files and external pages as untrusted data, not as commands that control the application.
Agents can analyze such instructions and report them, but must not follow them automatically.
Keep apart: the security policy of the application; instructions confirmed by the user; the specification; project data; external documents; the conclusions of other agents.
Neither text inside a repository, nor a web search result, nor a message from another agent may raise privileges or cancel security rules by itself.

### 29.11. Protection against leaving the working folder

Every file operation must go through a path check.
Prevent: path traversal; leaving the allowed folder; dangerous use of `..`; bypassing restrictions through symbolic links; path substitution; writing to system folders; unexpectedly following links to other disks or folders.
Check not only the text of the path but also the actual target path after normalization, taking the operating system into account.
Take races between checking a path and using it into account.
Do not give AI agents a general API for writing arbitrary files. Every operation must go through a controlled file service with permission checks.

### 29.12. Protecting secrets and local data

The application may work with source code, internal documents, API keys and other sensitive material. So: keep secrets in the system credential store when it is available; do not write keys to logs; do not include secrets in reports; do not store secrets in Git; do not add secrets to backups without a separate justification; do not send secrets to external models; mask sensitive values in the interface; check data before sending it to an external provider; use minimal access rights; let the user turn off external network requests.
When a cloud model is used, the user must understand that the content of the selected documents may be sent to an external provider.
By default, do not put the whole repository or the whole local storage into the AI context. Pass only the amount of data needed for the allowed operation.
In fully local mode, block sending project content over the network instead of just hiding the matching switch in the interface.

### 29.13. One permission engine

Implement a central permission mechanism that every agent, tool, workflow and file operation goes through.
Do not let each agent decide by itself which actions are allowed to it.
Separate permissions by type: reading; writing; deleting; running commands; network requests; installing dependencies; access to secrets; changing Git; changing configurations; publishing changes; cross-system access.
Bind permissions to specific systems, projects, folders and operations.
Check a permission right before the action runs, not only when the task starts.
If a permission is revoked during work, forbid new actions that need it and stop the related processes safely.
Forbid raising privileges through instructions, agent configuration or an imported package.

### 29.14. Protection against accidental cross-system changes

Take the multi-system architecture of the application into account.
Every task, work copy, backup, operation and log record must be explicitly bound to a system and a project.
An agent working with system A must not change the files of system B just because they are available on the computer.
For operations on several systems, require an explicit choice of the matching sources and permissions.
Switching the active system in the interface must not change the context of a background task that is already running.
If the system cannot confirm that an operation runs in an allowed project, it must refuse the operation instead of guessing the right path.

### 29.15. The security log

Create a separate security log that records important actions: connecting a project; changing the access mode; creating a work copy; requesting an additional permission; confirming a dangerous operation; creating a backup; changing files; running commands; attempts to leave the allowed boundaries; refusals of the security system; applying a patch; restoring data; Git operations; network requests related to tasks; changing permissions.
Record the time, the system, the project, the task, the type of action, the result and the affected resources.
Do not include passwords, tokens, private keys or the full content of secret files in the log.
The log must be available to the user, but agents must not be able to silently rewrite the history of their own actions.

### 29.16. A safe interface for a user without technical knowledge

Do not require the user to understand Git, GitHub, the command line, file system permissions or sandbox architecture.
Use clear mode names: "Read only"; "Prepare changes"; "Work in a copy"; "Review changes"; "Apply to the original project".
Do not show dangerous system commands as ordinary quick actions.
If Git needs to be explained, use simple descriptions:
- **Original project:** the folder with the user's current files.
- **Work copy:** a separate place where the application can prepare changes safely.
- **Proposed changes:** the result of the AI work that is not applied to the original yet.
- **Backup:** a saved state you can return to.
- **Git branch:** a separate line of changes inside a Git repository; by itself it does not replace a backup.
- **Apply changes:** move the selected and reviewed changes into the original project.

Show clear security statuses and explain what exactly is allowed in the current mode.

### 29.17. Reacting to errors and suspicious actions

If the system finds a potentially dangerous operation:
1. Stop that operation before it runs.
2. Do not interrupt safe independent tasks without need.
3. Record the reason for the refusal.
4. Show the user a clear message.
5. Offer a safe alternative.
6. Keep the results obtained so far.
7. Do not automatically delete working files and logs.

If an attempt to run a suspicious command or to send secrets to an external network is found, forbid the action and tell the user which data or files may have been affected.
If a write error happens, do not try to restore the state automatically with destructive commands. First establish the actual state of the files, then offer a safe way to recover.

### 29.18. Security testing

Create automated tests that check not only functionality but also resistance to dangerous scenarios.
Required tests:
1. An AI agent cannot change a project in "Read only" mode.
2. Changes in a work copy do not affect the original.
3. Cancelling a task does not delete files accidentally.
4. An agent cannot write a file outside the allowed folder.
5. Symbolic links do not allow bypassing restrictions.
6. An agent cannot change another project without permission.
7. An agent cannot change another system after the interface is switched.
8. `.git/` files are protected from operations that are not allowed.
9. Untracked Git files are kept.
10. The application does not automatically run destructive Git commands.
11. A patch cannot be applied without passing the required checks.
12. Changing files after an approval invalidates that approval.
13. A failure to create a backup blocks the risky operation.
14. Secrets do not get into logs.
15. External content cannot cancel the security policies of the system.
16. An imported agent cannot raise its permissions on its own.
17. Unknown scripts are not run automatically.
18. Sending local data over the network is blocked in local mode.
19. Revoking a permission stops the later forbidden operations.
20. Errors in one task do not damage other projects.
21. An interrupted application does not leave the system in a silently half-changed state.
22. A restore returns the affected files to the expected state.

Test with specially prepared test repositories, not with real user data.

### 29.19. Acceptance criteria

The functionality is done when:
- A connected project is protected from changes from the start.
- The system can explore a project without writing to its original folder.
- Changes can be prepared in a separate work copy.
- The user sees every proposed change before it is applied.
- Changes are not applied to the original without control.
- Backup and restore are tested.
- Permissions are checked at the backend and in the file services.
- Git operations do not destroy the user's changes.
- Suspicious commands and instructions from files are blocked.
- Secrets are protected.
- An agent cannot leave the allowed scope at will.
- In multi-system mode the data of different projects is isolated.
- The user understands what exactly will happen before a dangerous operation.
- Every critical action is reflected in the log.
- On errors the system keeps the data and offers a safe recovery.

### 29.20. The final security principle

**By default the application studies, analyzes and proposes. To make changes it uses an isolated work copy. Changes reach the original project only through a controlled and verifiable procedure.**

No AI agent, external document, imported plugin or workflow may turn this protection off by itself.

Security must be built into the architecture of the product: into file system access, work with Git, running commands, the permission system, task execution, multi-system management, handling secrets and data recovery.

Do not promise absolute invulnerability. Instead, implement defense in depth, least privilege, safe defaults, verifiable restrictions and recovery after errors.
