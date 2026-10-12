# AI Core и Web Research — итоговая архитектура

Статус: принято · Дата: 2026-10-12 · Первоисточники API: см. раздел 6.

## 1. AI Core

```
                         AI Core (core/ai)
   ┌───────────────┬───────────────┬─────────────────┬──────────────┐
   │ ProviderRegistry│ ModelRouter  │ BudgetGuard      │ SecretStore  │
   │ (конфиги в БД)  │ (политики)   │ (лимиты, учёт)   │ (ключи вне БД)│
   └───────┬────────┴──────┬────────┴────────┬────────┴──────┬───────┘
           │               │                 │               │
   ┌───────▼───────┐ ┌─────▼──────┐   ┌──────▼──────┐  ┌─────▼─────┐
   │ OllamaProvider │ │ OpenAICompat│   │ Anthropic   │  │ Test (только│
   │ local          │ │ local|cloud │   │ cloud       │  │ при флаге)  │
   └───────┬───────┘ └─────┬──────┘   └──────┬──────┘  └───────────┘
           └───────────────┴──────┬──────────┘
                           HttpClient + NetworkPolicy (core/net)
```

### 1.1. Провайдеры

| Адаптер | Покрывает | Эндпоинты | Structured output | Эмбеддинги | Управление моделями |
|---|---|---|---|---|---|
| `ollama` | Ollama | `GET /api/version`, `GET /api/tags`, `POST /api/show`, `POST /api/chat` (`stream:false`), `POST /api/embed`, `POST /api/pull` (поток прогресса), `DELETE /api/delete`, `GET /api/ps` | `format: <JSON Schema>` | `/api/embed` | pull/delete; `capabilities` и `<arch>.context_length` из `/api/show` |
| `openai-compatible` | LM Studio (`http://localhost:1234/v1`), OpenAI, другие совместимые серверы | `GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/embeddings`; для LM Studio дополнительно `GET /api/v0/models` (`state`, `type`, `max_context_length`) | `response_format: {type:"json_schema", json_schema:{name, schema, strict}}` | `/v1/embeddings` | Нет (LM Studio управляет моделями сам) |
| `anthropic` | Anthropic Messages API | `POST /v1/messages` (заголовки `x-api-key`, `anthropic-version: 2023-06-01`), `GET /v1/models` | `output_config.format = {type:"json_schema", schema}` | Нет | Нет |
| `test` | Детерминированный провайдер для автотестов | — | Да | Да | — |

**Тестовый провайдер** регистрируется только при `AOS_ENABLE_TEST_PROVIDER=1`. В UI он подписан «Тестовый провайдер (для автоматических тестов)». В обычной работе приложения его нет, поэтому он не может подменить реальный результат.

### 1.2. Единый запрос

```ts
interface ChatRequest {
  model: string;
  system?: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  temperature?: number; maxOutputTokens?: number;
  jsonSchema?: { name: string; schema: JSONSchema };   // structured output, если модель умеет
  signal?: AbortSignal; purpose: string;                 // для аудита и бюджета
}
interface ChatResponse {
  text: string; json?: unknown; finishReason: 'stop' | 'length' | 'refusal' | 'error' | 'other';
  usage?: { inputTokens?: number; outputTokens?: number };
  model: string; providerId: string; latencyMs: number;
}
```

**Если модель не поддерживает structured output** (или провайдер вернул ошибку на параметр формата), рантайм переключается в режим «JSON по инструкции»: схема включается в системный промпт, JSON извлекается из ответа (первый сбалансированный объект), затем валидируется Ajv. При невалидном JSON выполняется до `repairAttempts` (по умолчанию 2) повторов, в которых модели передаются ошибки валидации.

**Совместимость схем со строгим режимом.** OpenAI strict требует `additionalProperties: false` и все поля в `required`; у Anthropic есть ограничения (например, `minItems` только 0 или 1). Поэтому для отправки провайдеру схема **упрощается** (`sanitizeSchemaForProvider`): удаляются неподдерживаемые ключевые слова, а **полная проверка всегда выполняется локально** через Ajv. Гарантию корректности даёт наша валидация, а не провайдер.

### 1.3. Model Router

Вход: `ModelPolicy` агента (из конфигурации, а не из инструкций) + требования шага (`needsStructured`, `minContext`, `taskType`) + свойства контекста (`containsConfidential`) + глобальный режим (`local` | `cloud` | `hybrid`, флаг `offline`).

Правила (в порядке проверки):
1. `offline = true` → разрешены только провайдеры с `locality = local` и loopback-адресом.
2. Режим `local` → только локальные провайдеры; автоматическое переключение на облако **запрещено**.
3. Контекст содержит фрагменты конфиденциального источника → только локальные провайдеры.
4. Политика агента указывает конкретные провайдер и модель → используются они, если доступны. Если недоступны и `allowFallback = false` → ошибка `MODEL_UNAVAILABLE` с подсказкой.
5. Режим `hybrid`: облако допускается, только если `cloudPolicy` разрешает этот `taskType` **и** у провайдера есть ключ. Повторная попытка в облаке после неудачи локальной модели **не выполняется автоматически** (п. 22.4), только с флагом политики `escalateToCloudOnFailure` и после подтверждения пользователя.
6. Иначе — модель по умолчанию для `taskType` из настроек маршрутизации, затем глобальная модель по умолчанию.

Результат — `{providerId, model, reason}`. `reason` записывается в журнал шага («почему выбрана эта модель»).

### 1.4. Бюджеты и учёт
- Таблица `ai_usage`: провайдер, модель, агент, запуск, шаг, токены входа и выхода, длительность, стоимость (если для модели задана цена пользователем — USD за 1 млн токенов входа и выхода; иначе `NULL` = «неизвестно»).
- `BudgetGuard.check(scope)` перед каждым облачным вызовом: лимиты на запуск (вызовы, токены, стоимость) и глобальные (месячный лимит стоимости, запросов). При превышении — `BUDGET_EXCEEDED`, новые облачные запросы не отправляются, полученные результаты сохраняются.
- Ограничение параллелизма запросов — семафор на провайдера.

### 1.5. Секреты
`SecretStore` — цепочка бэкендов с явным выбором:

| Бэкенд | Когда доступен | Хранение |
|---|---|---|
| `electron-safe-storage` | Desktop, если `isEncryptionAvailable()` и бэкенд не `basic_text` | Зашифрованный blob в файле `secrets.json` (ключ шифрования — в Keychain/DPAPI/libsecret) |
| `macos-keychain` | macOS, есть `/usr/bin/security` | Keychain (`security add-generic-password`) |
| `linux-secret-service` | Linux, есть `secret-tool` и работающий Secret Service | libsecret |
| `env` | Всегда (только чтение) | `AOS_SECRET_<PROVIDER_ID>` |
| `session` | Всегда | Память процесса до перезапуска |

Самодельного шифрования нет (п. 22.7.8). Если постоянного защищённого бэкенда нет, UI предлагает переменную окружения или ключ на сессию и объясняет почему. Ключ никогда не возвращается в UI (только маска `sk-…abcd`), не пишется в логи (redaction по шаблонам и по известным значениям), не попадает в контекст агентов, экспорт пакетов и резервные копии.

## 2. Web Research

См. исследование `docs/research/web-research-agents.md`. Модули:

| Модуль | Ответственность |
|---|---|
| `research/safe-fetch.ts` | HTTPS-загрузка с проверкой DNS/IP, ручными редиректами, лимитами размера и времени, allowlist типов содержимого |
| `research/extract.ts` | HTML → текст и Markdown (htmlparser2), метаданные (title, published, canonical) |
| `research/search-providers.ts` | `SearxngProvider`, `BraveProvider`, `GithubSearch` (единый интерфейс `WebSearchProvider`) |
| `research/grounding.ts` | Проверка цитат по загруженному тексту (R1), группировка утверждений |
| `research/store.ts` | Таблицы `web_sources`, `facts`; кэш страниц |
| `tools/web-tools.ts` | Инструменты агентов: `web_search`, `open_url`, `extract_page_content`, `fetch_documentation`, `search_github`, `inspect_repository`, `compare_sources`, `save_research_note`, `create_source_links`, `verify_source_freshness` |
| `pipelines/research.ts` | Исполняемый workflow «Веб-исследование» |

Каждый инструмент требует разрешения `network.fetch` (и при необходимости `web.search`) у агента. Домены можно ограничить списком в гранте (`allowedDomains`). Запись заметки — разрешение `documents.create` в папке исследований.

## 3. Связь с оркестратором

Агенты не вызывают провайдеров напрямую: `AgentRuntime` получает `ModelRouter` и `ToolExecutor` через внедрение зависимостей. Модель меняется в конфигурации агента (`agent_configs.model_policy`) без изменения `instructions.md` (п. 22.10).

## 4. Офлайн-режим

`settings.offline = true` →
- `NetworkPolicy` отклоняет все не-loopback хосты **до** DNS-резолва (`OFFLINE_MODE`);
- инструменты веб-исследования недоступны (агенту возвращается структурированная ошибка, workflow помечает шаг `failed` с понятной причиной);
- локальные провайдеры (`127.0.0.1`/`localhost`) работают;
- детерминированные функции (индексация, граф, поиск, проверки, валидаторы) работают всегда.

## 5. Тесты готовности (п. 22.12)

Соответствие сценариев тестам — в `docs/spec/acceptance-matrix.md`.

## 6. Первоисточники API (проверены 2026-10-12)
- Ollama API: `github.com/ollama/ollama/blob/main/docs/api.md`.
- LM Studio: `lmstudio.ai/docs/developer/openai-compat`, `…/openai-compat/structured-output`, `…/rest/endpoints`.
- OpenAI Structured Outputs: `developers.openai.com/api/docs/guides/structured-outputs`.
- Anthropic: `platform.claude.com/docs/en/api/messages/create.md`, `…/build-with-claude/structured-outputs.md` (`output_config.format`; beta-заголовок не требуется, устаревший `output_format` требовал `structured-outputs-2025-11-13`).
- SearXNG Search API: `docs.searxng.org/dev/search_api.html`.
- Brave Search API: `brave.com/search/api/`.
- GitHub REST Search: `docs.github.com/en/rest/search/search`.
- Electron safeStorage: `electronjs.org/docs/latest/api/safe-storage`.
