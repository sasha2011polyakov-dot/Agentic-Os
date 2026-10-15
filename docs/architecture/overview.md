# Agentic OS architecture

Status: accepted · Date: 2026-10-12

## 1. Stack decision (ADR-001)

### Context
The specification prefers TypeScript + React + Tauri + SQLite and requires: local execution, file system access, SQLite, separation of the UI from the domain logic, testable modules, and no mandatory cloud.

### Options considered

| Option | Pros | Cons |
|---|---|---|
| **A. Tauri + Rust core** | Small binary, strong permission model | All domain logic in Rust contradicts "TypeScript for the main logic"; two languages in every feature |
| **B. Tauri + TS core in the webview** | One language | The core runs in the webview, so the UI gets all the rights of the core (no separation); SQLite and the file system only through Tauri plugins; core tests need mocks of the Tauri API |
| **C. Tauri + Node sidecar with a TS core** | Process separation | A separate Node binary must be packaged for 3 OSes, IPC over stdio; twice the build complexity |
| **D. TS core in Node + a local HTTP API; Electron desktop shell** | One language; the core is a plain Node module, tested without the shell; `node:sqlite` is built in (FTS5 confirmed); the same server serves the browser mode and the e2e tests | Electron size (~100+ MB); the renderer security must be configured strictly |

### Decision: option D
- **Core** (`packages/core`): TypeScript, Node.js ≥ 22.13, where `node:sqlite` is available without a flag. Verified in the development environment: SQLite 3.50.4, FTS5, the `trigram` tokenizer, JSON functions.
- **Server** (`apps/server`): an HTTP API on `127.0.0.1` with a random port and a launch token (valid until the server stops); it serves the built UI; events go over SSE.
- **UI** (`apps/ui`): React 18 + TypeScript, built with esbuild. It works **only through the HTTP API** and has no direct access to the file system or the database.
  - *Update 2026-10-14:* esbuild is used instead of Vite: it already builds the server, so the interface adds no new build tools. Hot reload is not needed: `npm run dev:ui` rebuilds the interface on changes, and the server serves `apps/ui/dist`.
  - The interface does not use `innerHTML`: Markdown is turned into React elements, so HTML from notes and connected repositories is never executed; only `http(s)` and `mailto` links lead outside, and external images are not loaded.
- **Desktop** (`apps/desktop`): Electron. The main process starts the core and the server; the renderer is isolated (`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`). The preload exposes exactly three functions: choosing a folder (the system dialog), opening an external link (`https:` only) and platform information. Secrets go through `safeStorage` in the main process.
- **Browser mode** (`npx aos serve`): the same core without Electron. The server opens the system folder dialog with native OS tools (`zenity`/`kdialog` on Linux, `osascript` on macOS, PowerShell on Windows). If they are not available, a built-in directory browser is used. The differences between the modes are listed in section 7.

### Consequences
- In Node 22, `node:sqlite` is marked *experimental* (it prints an `ExperimentalWarning`). The risk is mitigated: all database access goes through the `Db` interface (`core/db`), which can be moved to `better-sqlite3` without changing the services.
- Building the desktop package (installers) is described for v1, but installer artifacts are not published.

## 2. Repository structure

```
packages/core/              domain logic (no UI, no HTTP)
  src/
    util/                   IDs, hashes, errors, time, redaction
    db/                     SQLite adapter, migrations, transactions
    events/                 typed event bus
    log/                    logger (JSONL) and audit log
    net/                    HttpClient + NetworkPolicy (the only way to the network)
    fs/                     PathGuard, SafeFs (atomic writes, conflicts), ignore rules, secret detector
    markdown/               frontmatter, links, tags, headings, tasks, blocks
    parsers/                parser registry by file type
    sources/                connecting folders and the vault, Git (read only), native dialog
    index/                  indexer (incremental), file system watcher, link resolver
    search/                 query parser, FTS5, vector search, RRF
    graph/                  nodes, typed edges, local graph, paths, cycles, integrity
    vault/                  documents, templates, daily notes, rename with a plan, history
    tasks/                  tasks, dependencies, statuses, export
    ai/                     AI Core: providers, Model Router, budgets, secrets, embeddings
    agents/                 package format, registry, permissions, agent runtime
    tools/                  tool registry and executor
    research/               web research: SafeFetcher, text extraction, search, grounding
    workflow/               definitions, state machine, engine, conditions
    pipelines/              built-in workflows: specification, web research
    backup/                 backups, restore, integrity checks
    app.ts                  composition root: wiring of all services
  agents-builtin/           built-in agent packages (declarative)
  test/                     unit + integration (vitest)
apps/server/                HTTP API, UI static files, the `aos` CLI
apps/ui/                    React interface + the built-in guide (guide/*.md)
apps/desktop/               Electron shell
e2e/                        Playwright end-to-end tests
docs/                       research, architecture, design, specification
```

## 3. Process model

```
 Desktop                                         Browser mode
 ┌─────────────── Electron main ──────────────┐  ┌──────── node aos serve ───────┐
 │ AppCore (core) + HTTP API on 127.0.0.1:P   │  │ AppCore + HTTP API 127.0.0.1:P │
 │ adapters: safeStorage, dialog, shell       │  │ adapters: OS keychain CLI,     │
 └──────────────┬─────────────────────────────┘  │ native dialog through the OS   │
                │ HTTP + cookie session          └──────────────┬─────────────────┘
 ┌──────────────▼──────────────┐                 ┌──────────────▼──────────────┐
 │ Renderer (sandbox): React   │                 │ Browser tab: React          │
 └─────────────────────────────┘                 └─────────────────────────────┘
```

**Local API authentication.** At startup the server generates a 256-bit token. The client opens `/auth?token=…` once, gets the `aos_session` cookie (`HttpOnly`, `SameSite=Strict`, `Path=/`) and is redirected to `/`. In addition:
- the `Host` header is checked (only `127.0.0.1:P` and `localhost:P`) to protect against DNS rebinding;
- requests that change data need the `X-AOS-Request: 1` header and an `Origin` that matches the server address (CSRF protection);
- the UI CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`.

## 4. Layers and dependency rules

```
UI ──HTTP──▶ server(routes) ──▶ services(core) ──▶ db / fs / net
                                    │
                                    └──▶ events ──SSE──▶ UI
```
- The UI does not import the core (only the shared DTO **types** from `packages/core/src/api-types.ts`).
- Core services know nothing about HTTP.
- **File access goes only through `SafeFs` and `PathGuard`.** Network access goes only through `HttpClient` (`core/net`). A lint test enforces the rule by searching for direct imports of `node:fs`, `node:http(s)` and `fetch(` outside the allowed modules.
- All long operations (indexing, workflow runs) are asynchronous, cancellable through an `AbortSignal`, and report progress to the `EventBus`.

## 5. Key interfaces

```ts
// core/db
interface Db {
  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
  get<T>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T>(sql: string, ...params: SqlValue[]): T[];
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;            // BEGIN IMMEDIATE … COMMIT/ROLLBACK, supports nesting (SAVEPOINT)
}

// core/fs
interface SafeFs {
  readText(abs: string, scope: AccessScope): Promise<{ text: string; hash: string; mtimeMs: number }>;
  writeText(abs: string, text: string, opts: { scope: AccessScope; expectedHash?: string | null; reason: string }): Promise<WriteResult>;
  // atomic write (tmp + rename), a snapshot of the previous version in history, a conflict check by expectedHash
  move(from: string, to: string, opts): Promise<void>;
  trash(abs: string, opts): Promise<void>;   // moves to <vault>/.trash instead of deleting
}

// core/ai
interface AIProvider {
  readonly id: string; readonly kind: ProviderKind; readonly locality: 'local' | 'cloud';
  health(signal?: AbortSignal): Promise<ProviderHealth>;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  chat(req: ChatRequest): Promise<ChatResponse>;            // structured output when req.jsonSchema is set
  embed?(req: EmbedRequest): Promise<EmbedResponse>;
}
interface LocalModelProvider extends AIProvider {
  pullModel?(name: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void>;
  deleteModel?(name: string): Promise<void>;
  modelDetails?(name: string): Promise<ModelDetails>;       // context, size, capabilities
}

// core/tools
interface ToolDefinition<I, O> {
  name: string; description: string; inputSchema: JSONSchema; outputSchema?: JSONSchema;
  permissions(input: I, ctx: ToolContext): PermissionRequirement[];  // what THIS call needs
  execute(input: I, ctx: ToolContext): Promise<O>;
}

// core/workflow
interface WorkflowEngine {
  start(defId: string, input: unknown, opts: StartOptions): Promise<RunId>;
  cancel(runId: RunId): Promise<void>;
  pause(runId: RunId): Promise<void>; resume(runId: RunId): Promise<void>;
  approve(runId: RunId, stepId: string, decision: ApprovalDecision): Promise<void>;
  recover(): Promise<void>;   // at startup: recovers interrupted runs
}
```

## 6. Data flows

**Indexing.** `SourceService.connect` → `Indexer.scan(source)` → a walk with the ignore rules → `(size, mtime)` compared with `files` → a hash (SHA-256) for changed files → the parser for the file type → in one transaction: `documents`, `fts`, `links`, `tags`, `properties`, `chunks` → `GraphService.rebuildEdgesFor(docIds)` → the `index.progress` / `index.done` events. The file system watcher (recursive `fs.watch`, 300 ms debounce) puts changed paths into the same queue; the application's own writes are suppressed by hash so that no loops occur.

**Running an agent.** `WorkflowEngine` → `AgentRuntime.run(agent, input, scope)` → the messages are assembled (the platform preamble + the agent instructions + the input + untrusted context in `<untrusted_content>`) → `ModelRouter.select(policy, needs)` → `NetworkPolicy` → `AIProvider.chat` (structured output by the protocol schema) → on `tool_calls` the `ToolExecutor` runs (input validation → `PermissionGuard` → execution → audit) → the final result is validated by Ajv against `output.schema.json` → on an error, a repair loop (up to N times) → the step result.

## 7. Modes of operation

| Capability | Desktop (Electron) | Browser mode |
|---|---|---|
| Choosing a folder | The system dialog (`dialog.showOpenDialog`) | The system dialog through the OS (if available) or the built-in directory browser |
| Storing API keys | `safeStorage` (Keychain / DPAPI / libsecret). If `getSelectedStorageBackend() === 'basic_text'`, saving is refused with an explanation | OS keychain CLI (`security` on macOS, `secret-tool` on Linux), the `AOS_SECRET_*` environment variables, a key for the session only |
| Opening external links | The system browser (`shell.openExternal`, `https:` only) | A new tab (`rel=noopener noreferrer`) |
| Everything else | The same | The same |

## 8. Errors

Core errors are `AppError { code, message, hint, guide?, details?, retryable }`. The code is stable (for example `SOURCE_NOT_ACCESSIBLE`, `PERMISSION_DENIED`, `MODEL_UNAVAILABLE`, `OFFLINE_MODE`, `WRITE_CONFLICT`). `hint` says what to do; `guide` is the slug of the guide page the UI links with an "Open the guide" button. The stack trace goes only to the log and is never shown to the user.
