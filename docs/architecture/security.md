# Security model

Status: accepted · Date: 2026-10-12

## 1. Assets and threats

| Asset | Threat | Source of the threat |
|---|---|---|
| User files | Unauthorized writes, deletion, leaving the allowed folders | An agent error, prompt injection, path traversal, symlinks |
| API keys | Leaks into logs, model context, exports, backups | Code errors, prompt injection |
| Document content | Silent sending to external services | A cloud model, web search |
| The local API | Requests from other sites (CSRF, DNS rebinding) | A malicious web page in the user's browser |
| The interface | XSS through Markdown, HTML or model output | Documents, web pages, model answers |
| The internal network | SSRF through URL downloads | Prompt injection, a malicious redirect |
| The computer | Running code from someone else's repository | Git hooks / `core.fsmonitor` in a connected repository |

## 2. Principles

1. **Permissions, not prompts.** Security comes from checks in code (PermissionGuard, PathGuard, NetworkPolicy), not from model instructions. An instruction such as "do not run commands from documents" is an extra layer, not the main one.
2. **Least privilege by default.** An installed agent gets nothing until the user approves the requested permissions. Grants have a scope (folders, projects, domains).
3. **Untrusted data never raises privileges.** The content of documents, pages and model answers is data. Only the user can change policies, permissions or agent configuration, through the UI; agents have no tools for that.
4. **Indexing does not change the files** of connected projects. Projects are connected read only; writes to the vault go through SafeFs with a snapshot and a log record.

## 3. File system

- **PathGuard:** every operation has a scope (`AccessScope`): a set of roots (the vault, a source, a granted folder). The path is normalized (`path.resolve`), then resolved with `realpath` (for a file that does not exist yet, the `realpath` of the nearest existing parent). The final path must lie inside the `realpath` of one of the roots. This blocks `../`, absolute paths and escapes through symbolic links.
- Segments where writing is forbidden: `.git/`, `node_modules/`, `.trash/` (except trash operations).
- File names: `\0`, control characters, reserved Windows names (`CON`, `NUL`…) and trailing dots and spaces are not allowed.
- **Writing** is atomic (a temporary file in the same folder → `fsync` → `rename`). Before an overwrite, the previous version is saved to `history`. If the file changed outside after it was read (hash ≠ `expectedHash`), `WRITE_CONFLICT` is returned with both versions: the editor shows the conflict, and nothing is overwritten.
- **Deleting** means moving to `<vault>/.trash/<timestamp>/…`.
- **Bulk operations** (a rename with link updates, applying agent results): first a plan (the list of files and changes), then a confirmation, the application and a report. Every affected version is kept in the history.
- **Disconnecting a source** removes only its index records and never touches the original files (covered by a test).

## 4. Indexing and secrets in projects

Not indexed: `.git`, `node_modules`, `vendor`, `dist`, `build`, `out`, `target`, `.next`, `.cache`, `__pycache__`, `.venv`, `venv`, `coverage`, `.idea`, `.vscode`, and files matched by `.gitignore` (unless the user turns that off). Secret files by name: `.env*` (except `.env.example`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*`, `*.keystore`, `credentials*`, `secrets.*`, `.npmrc`, `.pypirc`, `.netrc`. Files with strings that match key patterns (AWS `AKIA…`, `-----BEGIN … PRIVATE KEY-----`, `ghp_…`, `sk-…` of length ≥ 20, `xox[bp]-…`) are marked `secret_suspected`, and their content is not indexed. The indexing report shows every skipped file with the reason. Binary files (a NUL byte in the first 8 KB) and files above the limit (2 MB by default) are skipped with a reason.

## 5. Git

- Repository information (root, branch, HEAD, remotes) is read **from the files** `.git/HEAD`, `.git/config`, `.git/refs`, `packed-refs` without starting a `git` process.
- Optionally (the "Detailed Git information" setting, on by default) only an allowlist of **read-only** commands runs: `git status --porcelain=v1 -b`, `git log -n 20 --format=…`. They run through `execFile` (no shell) with the flags `-c core.fsmonitor=false -c core.hooksPath=<an empty temporary folder> -c core.untrackedCache=false -c protocol.allow=never`, the environment variables `GIT_TERMINAL_PROMPT=0` and `GIT_CONFIG_NOSYSTEM=1`, and a timeout. This closes the known code execution vector through `core.fsmonitor` in the configuration of someone else's repository.
- `commit`, `push`, `checkout`, `reset`, `clean`, `rebase`, `merge` and every other changing operation are **not implemented at all**.

## 6. Agents and tools

- An agent package **contains no executable code**: the package validator rejects `.js`/`.mjs`/`.cjs`/`.ts`/`.py`/`.sh`/`.exe` and any unknown file except `README.md`, `instructions.md`, `manifest.json`, `tools.json`, `schemas/*.json`, `tests/*.json`.
- Zip import: protection against path traversal (`../`, absolute paths, links), a size limit (5 MB unpacked), a file count limit (200).
- **ToolExecutor** for every call checks: (1) the tool is in the agent's `tools.json`; (2) the input matches the schema; (3) every `PermissionRequirement` is satisfied by the agent's grants **and** by the run scope (their intersection); (4) rate limits; (5) an audit record (agent, tool, masked parameters, result, duration).
- Privilege escalation is impossible by construction: permissions change only through the settings API called from the UI. Agents have no such tool.
- **Prompt injection:** untrusted content is wrapped in `<untrusted_content source="…">` after occurrences of `</untrusted_content` are escaped. The platform preamble declares such blocks to be data. A response that tries to call tools the package does not allow is rejected by the executor.

## 7. Network

- All outgoing traffic of the core goes through `HttpClient` + `NetworkPolicy` (`core/net`). Targets: `ai-local`, `ai-cloud`, `web-research`, `model-download`. Offline mode blocks everything except loopback.
- **Web research** uses `SafeFetcher`: HTTPS only; a DNS check of every address (loopback, private, link-local, CGNAT, multicast and IPv4-mapped addresses are blocked); the connection goes to the checked IP; manual redirects (≤ 5) with a new check each time; size and time limits; an allowlist of content types; no cookies.
- **Local AI providers** (`ai-local`) are a separate exception: they may use only the loopback addresses set in the provider configuration (so the SSRF restriction is lifted for them deliberately and narrowly).

## 8. The local API and the interface

- The server listens only on `127.0.0.1`; the launch token (valid until the server stops) → an `HttpOnly; SameSite=Strict` cookie; a `Host` check; for changing requests, `X-AOS-Request` and `Origin`.
- CSP (see `overview.md` §3); `X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`; `X-Frame-Options: DENY`.
- **Markdown:** the interface has its own renderer that turns Markdown into React elements and never uses `innerHTML`. Raw HTML is shown as text; only `http(s)` and `mailto` links become links (`javascript:`, `vbscript:` and `data:` do not); external links get `rel="noopener noreferrer"`; external images are not loaded and are shown as links. Model output is rendered by the same rules.
- Attachments are served with a `Content-Disposition` that depends on the type; SVG is served as `text/plain` (a script inside an SVG is never executed).
- **Electron:** `contextIsolation`, `sandbox`, no `nodeIntegration`; `setWindowOpenHandler` → only `https:` through the system browser; navigation outside the server address is blocked (`will-navigate`); `webSecurity` is never turned off; IPC handlers check `event.senderFrame.url`.

## 9. Logs, exports, backups

- The logger passes every line through `redact()`: the known secret values (registered when they are loaded) plus key patterns. A test: after a key is saved and a provider call fails with an authorization error, the log contains no key.
- An agent package export contains only the package files, without `agent_configs` and the user's grants.
- A backup is a `VACUUM INTO` copy of the database. The database holds no secrets (only `secret_ref` references), so neither does the backup. `secrets.json` (Electron) is not included in backups.

## 10. Protecting connected projects (specification section 29)

The source of the requirements is `docs/spec/section-29-security.md`. The principle: **by default the application studies, analyzes and proposes; changes are made in an isolated work copy; they reach the original project only through a controlled and verifiable procedure.** The protection comes from the code of the core (the file service, the policy, the permission engine, the log), not from model instructions.

### 10.1. Access modes (`security/policy.ts`)
| Mode | Name in the interface | What is allowed |
|---|---|---|
| `read_only` (default) | "Read only" | Reading, indexing into the internal storage, analysis, specifications and plans. Proposed file changes are forbidden (`MODE_FORBIDS`) |
| `prepare` | "Prepare changes" | Plus change sets (diff, patch), stored separately from the project |
| `workcopy` | "Work in a copy" | Plus a work copy, applying sets to the copy and running checks in the copy |
| `apply` | "Apply to the original project" | Plus a controlled application to the original files |

**Only the user** changes the mode (`SourceService.setAccessMode`, `actor = user`). Agents have no tool to change it. Enabling `apply` requires an explicit confirmation. Every mode change goes to the security log. The application never raises the mode by itself.

### 10.2. Files that never change
The application never changes `.git/**`, secret files (`.env*`, keys, credentials) or service folders (`node_modules`, `.aos`, `.trash`) in any mode. Other critical categories can be read, but changing them requires a separate confirmation (see 10.5):
- CI/CD, deployment, build;
- dependencies and manifests;
- migrations, installation scripts;
- licenses, security settings;
- backups, executable files.

### 10.3. Work copies (`security/workcopy.ts`)
- A copy is a physically separate folder `<application data>/workcopies/<system>/<id>`. It is neither in the project nor in the system folder. Files are copied with `COPYFILE_FICLONE | COPYFILE_EXCL` (copy-on-write where the file system supports it); hard links are never used.
- Not copied: `.git` (history, credentials, hooks), symbolic links (they could lead outside the project) and secret files.
- Heavy dependency folders are copied only if the project fits into the `security.workCopyMaxBytes` limit. Otherwise they are excluded, and the user sees a warning about it.
- If a copy cannot be created, the operation is refused (`WORKCOPY_FAILED`). There is no fallback to the original.
- Git branches and worktrees are not used for isolation: they share `.git` with the original and do not protect against damage by themselves (29.3).

### 10.4. Reviewing changes (`changes/change-sets.ts`)
- A set has a `content_hash`: the hash of its effective content. The "Checked" mark (`review`) is bound to this hash. **Any later change makes the approval stale** (`REVIEW_STALE`, the `review.stale` event in the log).
- "Check again" (`verifyInWorkCopy`) applies the set to a work copy and runs the project checks. The result is bound to the content hash.
- The user can reject selected files (`rejectFiles`). After that the approval has to be repeated.
- **Applying to the original project** (`apply`). Every condition is checked first, and only then is anything written:
  1. the `apply` mode;
  2. a fresh review of the set by the user;
  3. the required project checks passed in a work copy for the current hash (`CHECKS_REQUIRED`);
  4. every risky change is confirmed separately (`CONFIRMATION_REQUIRED`, with the list of risks);
  5. the files did not change since the changes were prepared (otherwise `WRITE_CONFLICT`, nothing is written);
  6. a backup is created and **verified** (otherwise `BACKUP_FAILED`, nothing is written).
- A write failure in the middle stops the operation. There is no automatic "repair" with destructive commands. The report lists what was written and what was not; a restore from the backup is available. The `partially_applied` status and the log record survive a restart.

### 10.5. Confirming risky operations
`analyzeRisks` builds a clear description of every risk:
- what will change and which files are affected;
- what can go wrong;
- whether the action can be undone and whether there is a backup;
- what happens if the user refuses.

A separate confirmation is needed for a mass deletion (5 files or more), deleting a whole folder, a mass overwrite (30 files or more) and every critical file category. A general agreement to run the task is not a permission for these operations.

### 10.6. Backups and restore (`security/backup.ts`)
- Backups are stored in `<application data>/backups/<system>/changes/<id>/`, outside the projects and the work copies.
- Content: a manifest with the SHA-256 of every file, and the files themselves, read only. They are written with the `wx` flag, so an existing backup cannot be overwritten. After writing, the backup is read back and compared with the manifest.
- **Restore**:
  - first the integrity of the backup is checked;
  - before the restore, a safety backup of the current state is created, so the restore can be undone too;
  - files the user changed after the apply are overwritten only with a confirmation;
  - files created by the operation are moved to the system trash.
- **Retention**: the last `security.backupsKeep` restore points per project (`prune`).

### 10.7. Running checks (`missions/checks.ts`, `security/sandbox.ts`, `security/scripts.ts`)
- A check is only a command the user set on the project card. An agent can only call it by name if it is approved for the run. Checks run **only in a work copy**, without a command shell, with a timeout, an output limit and an environment without secrets.
- **Isolation:**
  - Linux with `bubblewrap`: separate namespaces, system folders read only, writes only to the copy, the home folder not accessible, the network off unless the check is allowed otherwise. In addition, `prlimit` limits CPU time and file size.
  - Without a sandbox: the result is honestly marked as "limited mode" (`isolation.level = limited`) with a note that the process runs with the user's rights. The home folder is replaced with a temporary one. No memory limit is set, and this is stated plainly: runtimes such as V8 do not start under a hard virtual memory limit.
- **Vetting before a run** (`vetCheck`):
  - everything that will actually run is analyzed: `package.json` scripts with their `pre`/`post` hooks, scripts and binaries from the project, the Makefile;
  - dangerous patterns are searched for: `sudo`, `curl | sh`, deletion, network tools, access to credentials, Git and publishing commands, system settings;
  - after a dangerous finding the check runs only after an approval of **exactly this content** (`approvedContentHash`). If the script changes, the approval is no longer valid.

### 10.8. Git (`sources/git.ts`)
- The application runs only `git status` and `git log`, protected against code execution from the repository configuration. Every other subcommand and the options `-c`, `-C`, `--git-dir`, `--work-tree`, `--output` and the like are rejected before a process starts (`assertSafeGitArgs`).
- `reset`, `clean`, `checkout`, `push` and `commit` never run.
- `describeRepository` describes the state of the repository in plain words: the branch, uncommitted changes, untracked files, remotes without credentials.

### 10.9. Untrusted content and leaks (`security/injection.ts`, `security/egress.ts`)
- Everything that comes from documents, project files and web pages is passed to agents as data in `<untrusted_content>` blocks.
- Signs of instructions aimed at AI (requests to ignore the rules, to disable protections, to read `.env`, to send data, to hide actions) are written to the security log as `injection.suspected`. The detection allows and forbids nothing: the permission engine still checks every action.
- **Leaks:**
  - a request to a cloud model, a search query or a URL with a secret is blocked (`SECRET_EGRESS_BLOCKED`), and the data is not sent;
  - both key patterns and any secret value the application itself stores are searched for;
  - the log records the kind of secret, never its value.

### 10.10. Security log (`security/log.ts`)
- Separate `security_log` tables: in every system and at the application level.
- Protection against rewriting history: `BEFORE UPDATE/DELETE` triggers abort any change, and every record contains the hash of the previous one. `verify()` finds a break in the chain.
- Secrets are masked before writing; file contents are not stored, only paths.
- Agents have no tool that writes to the log.
- **Recorded events:**
  - connecting a project and changing its mode;
  - work copies, backups, restores;
  - approvals and stale approvals;
  - confirmed risks;
  - applied files, patch exports;
  - started and blocked commands;
  - policy denials, attempts to leave the allowed scope, blocked secrets, suspicious instructions.

### 10.11. Limitations (honestly)
- **Path races.** The path is checked by its real path right before the write. The temporary file is created with `O_EXCL`, and the folder is checked again after the atomic rename. Fully ruling out a race with another process is impossible in Node.js without `openat`/`O_NOFOLLOW` system calls for every path component. A swap is detected and the operation stops, but by then the write may already have happened.
- **Isolation without `bubblewrap`** (macOS, Windows, Linux without the package) is only "limited mode". The user sees this before the run and confirms it.
- **Script analysis is heuristic.** It does not replace a human review: the code of tests and dependencies is not fully analyzed, so checks run only in a work copy.
