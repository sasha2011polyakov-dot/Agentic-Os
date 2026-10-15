# AI Core and web research: final architecture

Status: accepted · Date: 2026-10-12 · Primary API sources: see section 6.

## 1. AI Core

```
                         AI Core (core/ai)
   ┌────────────────┬──────────────┬──────────────────┬───────────────┐
   │ ProviderRegistry│ ModelRouter  │ BudgetGuard      │ SecretStore   │
   │ (configs in DB) │ (policies)   │ (limits, usage)  │ (keys off DB) │
   └───────┬────────┴──────┬───────┴────────┬─────────┴──────┬────────┘
           │               │                │                │
   ┌───────▼───────┐ ┌─────▼──────┐   ┌──────▼──────┐  ┌─────▼──────┐
   │ OllamaProvider │ │ OpenAICompat│   │ Anthropic   │  │ Test (only  │
   │ local          │ │ local|cloud │   │ cloud       │  │ with a flag)│
   └───────┬───────┘ └─────┬──────┘   └──────┬──────┘  └────────────┘
           └───────────────┴──────┬──────────┘
                           HttpClient + NetworkPolicy (core/net)
```

### 1.1. Providers

| Adapter | Covers | Endpoints | Structured output | Embeddings | Model management |
|---|---|---|---|---|---|
| `ollama` | Ollama | `GET /api/version`, `GET /api/tags`, `POST /api/show`, `POST /api/chat` (`stream:false`), `POST /api/embed`, `POST /api/pull` (a progress stream), `DELETE /api/delete`, `GET /api/ps` | `format: <JSON Schema>` | `/api/embed` | pull/delete; `capabilities` and `<arch>.context_length` from `/api/show` |
| `openai-compatible` | LM Studio (`http://localhost:1234/v1`), OpenAI, other compatible servers | `GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/embeddings`; for LM Studio also `GET /api/v0/models` (`state`, `type`, `max_context_length`) | `response_format: {type:"json_schema", json_schema:{name, schema, strict}}` | `/v1/embeddings` | No (LM Studio manages models itself) |
| `anthropic` | Anthropic Messages API | `POST /v1/messages` (headers `x-api-key`, `anthropic-version: 2023-06-01`), `GET /v1/models` | `output_config.format = {type:"json_schema", schema}` | No | No |
| `test` | A deterministic provider for automated tests | — | Yes | Yes | — |

**The test provider** is registered only with `AOS_ENABLE_TEST_PROVIDER=1`. In the UI it is labeled "Test provider (for automated tests)". It does not exist in normal use of the application, so it cannot stand in for a real result.

### 1.2. One request format

```ts
interface ChatRequest {
  model: string;
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  temperature?: number; maxOutputTokens?: number;
  jsonSchema?: { name: string; schema: JSONSchema };   // structured output, if the model supports it
  signal?: AbortSignal; purpose: string;                 // for audit and budget
}
interface ChatResponse {
  text: string; json?: unknown; finishReason: 'stop' | 'length' | 'refusal' | 'error' | 'other';
  usage?: { inputTokens?: number; outputTokens?: number };
  model: string; providerId: string; latencyMs: number;
}
```

**If the model does not support structured output** (or the provider rejects the format parameter), the runtime switches to "JSON by instruction" mode: the schema goes into the system prompt, the JSON is extracted from the answer (the first balanced object) and validated with Ajv. On invalid JSON the runtime makes up to `repairAttempts` (2 by default) retries and passes the validation errors to the model.

**Schema compatibility with strict modes.** OpenAI strict mode requires `additionalProperties: false` and every field in `required`; Anthropic has its own limits (for example `minItems` only 0 or 1). So the schema sent to the provider is **simplified** (`sanitizeSchemaForProvider`): unsupported keywords are removed, and **the full check always runs locally** with Ajv. Correctness is guaranteed by our validation, not by the provider.

### 1.3. Model Router

Input: the agent's `ModelPolicy` (from its configuration, not from its instructions) + the step requirements (`needsStructured`, `minContext`, `taskType`) + context properties (`containsConfidential`) + the global mode (`local` | `cloud` | `hybrid`, the `offline` flag).

Rules (in the order they are checked):
1. `offline = true` → only providers with `locality = local` and a loopback address are allowed.
2. `local` mode → only local providers; an automatic switch to the cloud is **forbidden**.
3. The context contains fragments of a confidential source → only local providers.
4. The agent policy names a specific provider and model → they are used if available. If they are not available and `allowFallback = false` → the `MODEL_UNAVAILABLE` error with a hint.
5. `hybrid` mode: the cloud is allowed only if `cloudPolicy` allows this `taskType` **and** the provider has a key. A retry in the cloud after a local model failed is **not done automatically** (22.4); only with the `escalateToCloudOnFailure` policy flag and after the user confirms.
6. Otherwise: the default model for the `taskType` from the routing settings, then the global default model.

The result is `{providerId, model, reason}`. `reason` is written to the step log ("why this model was chosen").

### 1.4. Budgets and accounting
- The `ai_usage` table: provider, model, agent, run, step, input and output tokens, duration, cost (if the user set a price for the model, in USD per 1 million input and output tokens; otherwise `NULL` = "unknown").
- `BudgetGuard.check(scope)` before every cloud call: per-run limits (calls, tokens, cost) and global ones (the monthly cost limit, requests). When a limit is exceeded: `BUDGET_EXCEEDED`, no new cloud requests are sent, and the results received so far are kept.
- Request concurrency is limited by a semaphore per provider.

### 1.5. Secrets
`SecretStore` is a chain of backends with an explicit choice:

| Backend | When available | Storage |
|---|---|---|
| `electron-safe-storage` | Desktop, if `isEncryptionAvailable()` and the backend is not `basic_text` | An encrypted blob in `secrets.json` (the encryption key is in Keychain/DPAPI/libsecret) |
| `macos-keychain` | macOS with `/usr/bin/security` | Keychain (`security add-generic-password`) |
| `linux-secret-service` | Linux with `secret-tool` and a running Secret Service | libsecret |
| `env` | Always (read only) | `AOS_SECRET_<PROVIDER_ID>` |
| `session` | Always | Process memory until a restart |

There is no home-made encryption (22.7.8). If no persistent protected backend exists, the UI offers an environment variable or a session-only key and explains why. A key is never returned to the UI (only a mask such as `sk-…abcd`), is never written to logs (redaction by patterns and by known values), and never gets into agent context, package exports or backups.

## 2. Web research

See the research note `docs/research/web-research-agents.md`. Modules:

| Module | Responsibility |
|---|---|
| `research/safe-fetch.ts` | HTTPS downloads with DNS/IP checks, manual redirects, size and time limits, an allowlist of content types |
| `research/extract.ts` | HTML → text and Markdown (htmlparser2), metadata (title, published, canonical) |
| `research/search-providers.ts` | `SearxngProvider`, `BraveProvider`, `GithubSearch` (one `WebSearchProvider` interface) |
| `research/grounding.ts` | Verifying quotes against the downloaded text (R1), grouping claims |
| `research/store.ts` | The `web_sources` and `facts` tables; the page cache |
| `tools/web-tools.ts` | Agent tools: `web_search`, `open_url`, `extract_page_content`, `fetch_documentation`, `search_github`, `inspect_repository`, `compare_sources`, `save_research_note`, `create_source_links`, `verify_source_freshness` |
| `pipelines/research.ts` | The executable "Web research" workflow |

Every tool requires the `network.fetch` permission (and `web.search` where needed) for the agent. Domains can be limited by a list in the grant (`allowedDomains`). Writing a note requires the `documents.create` permission in the research folder.

## 3. Relation to the orchestrator

Agents do not call providers directly: `AgentRuntime` gets the `ModelRouter` and the `ToolExecutor` through dependency injection. The model is changed in the agent configuration (`agent_configs.model_policy`) without changing `instructions.md` (22.10).

## 4. Offline mode

`settings.offline = true` →
- `NetworkPolicy` rejects every non-loopback host **before** DNS resolution (`OFFLINE_MODE`);
- web research tools are unavailable (the agent gets a structured error, and the workflow marks the step `failed` with a clear reason);
- local providers (`127.0.0.1`/`localhost`) work;
- deterministic functions (indexing, the graph, search, checks, validators) always work.

## 5. Readiness tests (22.12)

A document that maps each scenario to its tests is not written yet; the scenarios are covered in `packages/core/test/ai-agents.test.ts` and `packages/core/test/pipelines.test.ts`.

## 6. Primary API sources (checked 2026-10-12)
- Ollama API: `github.com/ollama/ollama/blob/main/docs/api.md`.
- LM Studio: `lmstudio.ai/docs/developer/openai-compat`, `…/openai-compat/structured-output`, `…/rest/endpoints`.
- OpenAI Structured Outputs: `developers.openai.com/api/docs/guides/structured-outputs`.
- Anthropic: `platform.claude.com/docs/en/api/messages/create.md`, `…/build-with-claude/structured-outputs.md` (`output_config.format`; no beta header is needed; the deprecated `output_format` required `structured-outputs-2025-11-13`).
- SearXNG Search API: `docs.searxng.org/dev/search_api.html`.
- Brave Search API: `brave.com/search/api/`.
- GitHub REST Search: `docs.github.com/en/rest/search/search`.
- Electron safeStorage: `electronjs.org/docs/latest/api/safe-storage`.
