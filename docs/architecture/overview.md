# Архитектура Agentic OS

Статус: принято · Дата: 2026-10-12

## 1. Решение по стеку (ADR-001)

### Контекст
ТЗ предпочитает TypeScript + React + Tauri + SQLite и требует: локальное выполнение, доступ к ФС, SQLite, отделение UI от доменной логики, тестируемость модулей, отсутствие обязательного облака.

### Рассмотренные варианты

| Вариант | Плюсы | Минусы |
|---|---|---|
| **A. Tauri + ядро на Rust** | Маленький бинарник, сильная модель разрешений | Вся доменная логика на Rust — противоречит «TypeScript для основной логики»; два языка в каждой фиче |
| **B. Tauri + ядро на TS в webview** | Один язык | Ядро работает в webview → UI получает все права ядра (нарушение разделения); SQLite и ФС только через плагины Tauri; тесты ядра требуют моков Tauri API |
| **C. Tauri + Node-sidecar с ядром на TS** | Разделение процессов | Упаковка отдельного Node-бинарника под 3 ОС, IPC через stdio; удвоенная сложность сборки |
| **D. Ядро на TS в Node + локальный HTTP API; desktop-оболочка Electron** | Один язык; ядро — обычный Node-модуль, тестируется без оболочки; `node:sqlite` встроен (FTS5 подтверждён); тот же сервер обслуживает браузерный режим и e2e-тесты | Размер Electron (~100+ МБ); нужно строго настроить безопасность renderer |

### Решение: вариант D
- **Ядро** (`packages/core`) — TypeScript, Node.js ≥ 22.13: в этой версии модуль `node:sqlite` доступен без флага. В среде разработки проверено: SQLite 3.50.4, FTS5, токенизатор `trigram`, JSON-функции.
- **Сервер** (`apps/server`) — HTTP API на `127.0.0.1` со случайным портом и одноразовым токеном; раздаёт собранный UI; события — через SSE.
- **UI** (`apps/ui`) — React 18 + Vite + TypeScript. Работает **только через HTTP API**, прямого доступа к ФС и БД не имеет.
- **Desktop** (`apps/desktop`) — Electron: main-процесс запускает ядро и сервер, renderer изолирован (`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`). Через preload доступны ровно три функции: выбор папки (системный диалог), открытие внешней ссылки (только `https:`), сведения о платформе. Секреты — через `safeStorage` в main-процессе.
- **Браузерный режим** (`npx aos serve`) — то же ядро без Electron. Системный диалог выбора папки вызывается сервером через нативные средства ОС (`zenity`/`kdialog` на Linux, `osascript` на macOS, PowerShell на Windows). Если они недоступны — встроенный обозреватель каталогов. Различия режимов перечислены в разделе 7.

### Последствия
- `node:sqlite` в Node 22 помечен как *experimental* (выводит `ExperimentalWarning`). Риск смягчён: весь доступ к БД идёт через интерфейс `Db` (`core/db`), который можно перевести на `better-sqlite3` без изменения сервисов.
- Сборка desktop-пакета (инсталляторов) в v1 описана, но артефакты установщиков не публикуются.

## 2. Структура репозитория

```
packages/core/              доменная логика (без UI и HTTP)
  src/
    util/                   ID, хеши, ошибки, время, redaction
    db/                     адаптер SQLite, миграции, транзакции
    events/                 типизированная шина событий
    log/                    логгер (JSONL) и журнал аудита
    net/                    HttpClient + NetworkPolicy (единственный путь в сеть)
    fs/                     PathGuard, SafeFs (атомарная запись, конфликты), правила игнорирования, детектор секретов
    markdown/               frontmatter, ссылки, теги, заголовки, задачи, блоки
    parsers/                реестр парсеров по типам файлов
    sources/                подключение папок и vault, Git (только чтение), нативный диалог
    index/                  индексатор (инкрементальный), наблюдатель ФС, резолвер ссылок
    search/                 парсер запросов, FTS5, векторный поиск, RRF
    graph/                  узлы, типизированные рёбра, локальный граф, пути, циклы, целостность
    vault/                  документы, шаблоны, daily notes, переименование с планом, история
    tasks/                  задачи, зависимости, статусы, экспорт
    ai/                     AI Core: провайдеры, Model Router, бюджеты, секреты, эмбеддинги
    agents/                 формат пакетов, реестр, разрешения, рантайм агентов
    tools/                  реестр и исполнитель инструментов
    research/               веб-исследования: SafeFetcher, извлечение текста, поиск, grounding
    workflow/               определения, стейт-машина, движок, условия
    pipelines/              встроенные процессы: ТЗ, веб-исследование
    backup/                 резервные копии, восстановление, проверка целостности
    app.ts                  composition root: сборка всех сервисов
  agents-builtin/           встроенные пакеты агентов (декларативные)
  test/                     unit + integration (vitest)
apps/server/                HTTP API, статика UI, CLI `aos`
apps/ui/                    React-интерфейс + встроенное руководство (guide/*.md)
apps/desktop/               Electron-оболочка
e2e/                        сквозные тесты Playwright
docs/                       исследование, архитектура, дизайн, спецификация
```

## 3. Процессная модель

```
 Desktop                                         Браузерный режим
 ┌─────────────── Electron main ──────────────┐  ┌──────── node aos serve ───────┐
 │ AppCore (ядро) + HTTP API на 127.0.0.1:P   │  │ AppCore + HTTP API 127.0.0.1:P │
 │ адаптеры: safeStorage, dialog, shell       │  │ адаптеры: OS keychain CLI,     │
 └──────────────┬─────────────────────────────┘  │ нативный диалог через ОС       │
                │ HTTP + cookie-сессия           └──────────────┬─────────────────┘
 ┌──────────────▼──────────────┐                 ┌──────────────▼──────────────┐
 │ Renderer (sandbox) — React  │                 │ Вкладка браузера — React    │
 └─────────────────────────────┘                 └─────────────────────────────┘
```

**Аутентификация локального API.** При старте сервер генерирует 256-битный токен. Клиент один раз открывает `/auth?token=…`, получает cookie `aos_session` (`HttpOnly`, `SameSite=Strict`, `Path=/`) и перенаправляется на `/`. Дополнительно:
- проверка `Host` (только `127.0.0.1:P` и `localhost:P`) — защита от DNS rebinding;
- изменяющие запросы требуют заголовок `X-AOS-Request: 1` и `Origin`, совпадающий с адресом сервера (защита от CSRF);
- CSP для UI: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`.

## 4. Слои и правила зависимостей

```
UI ──HTTP──▶ server(routes) ──▶ services(core) ──▶ db / fs / net
                                    │
                                    └──▶ events ──SSE──▶ UI
```
- UI не импортирует ядро (только общие **типы** DTO из `packages/core/src/api-types.ts`).
- Сервисы ядра не знают об HTTP.
- **Доступ к файлам — только через `SafeFs` и `PathGuard`.** Доступ к сети — только через `HttpClient` (`core/net`). Правило проверяется тестом-линтом: поиск прямых импортов `node:fs`, `node:http(s)` и `fetch(` вне разрешённых модулей.
- Все долгие операции (индексация, запуск workflow) асинхронны, отменяемы через `AbortSignal` и сообщают прогресс в `EventBus`.

## 5. Ключевые интерфейсы

```ts
// core/db
interface Db {
  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
  get<T>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T>(sql: string, ...params: SqlValue[]): T[];
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;            // BEGIN IMMEDIATE … COMMIT/ROLLBACK, поддерживает вложенность (SAVEPOINT)
}

// core/fs
interface SafeFs {
  readText(abs: string, scope: AccessScope): Promise<{ text: string; hash: string; mtimeMs: number }>;
  writeText(abs: string, text: string, opts: { scope: AccessScope; expectedHash?: string | null; reason: string }): Promise<WriteResult>;
  // атомарная запись (tmp + rename), снапшот прежней версии в history, проверка конфликта по expectedHash
  move(from: string, to: string, opts): Promise<void>;
  trash(abs: string, opts): Promise<void>;   // перенос в <vault>/.trash, а не удаление
}

// core/ai
interface AIProvider {
  readonly id: string; readonly kind: ProviderKind; readonly locality: 'local' | 'cloud';
  health(signal?: AbortSignal): Promise<ProviderHealth>;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  chat(req: ChatRequest): Promise<ChatResponse>;            // structured output при req.jsonSchema
  embed?(req: EmbedRequest): Promise<EmbedResponse>;
}
interface LocalModelProvider extends AIProvider {
  pullModel?(name: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void>;
  deleteModel?(name: string): Promise<void>;
  modelDetails?(name: string): Promise<ModelDetails>;       // контекст, размер, capabilities
}

// core/tools
interface ToolDefinition<I, O> {
  name: string; description: string; inputSchema: JSONSchema; outputSchema?: JSONSchema;
  permissions(input: I, ctx: ToolContext): PermissionRequirement[];  // что нужно для ЭТОГО вызова
  execute(input: I, ctx: ToolContext): Promise<O>;
}

// core/workflow
interface WorkflowEngine {
  start(defId: string, input: unknown, opts: StartOptions): Promise<RunId>;
  cancel(runId: RunId): Promise<void>;
  pause(runId: RunId): Promise<void>; resume(runId: RunId): Promise<void>;
  approve(runId: RunId, stepId: string, decision: ApprovalDecision): Promise<void>;
  recover(): Promise<void>;   // при старте: восстановление прерванных запусков
}
```

## 6. Потоки данных

**Индексация.** `SourceService.connect` → `Indexer.scan(source)` → обход с правилами игнорирования → сравнение `(size, mtime)` с `files` → хеш (SHA-256) для изменившихся → парсер по типу → транзакционно: `documents`, `fts`, `links`, `tags`, `properties`, `chunks` → `GraphService.rebuildEdgesFor(docIds)` → событие `index.progress` / `index.done`. Наблюдатель ФС (`fs.watch` recursive, debounce 300 мс) ставит изменённые пути в ту же очередь; собственные записи приложения подавляются по хешу, чтобы не возникали циклы.

**Запуск агента.** `WorkflowEngine` → `AgentRuntime.run(agent, input, scope)` → сборка сообщений (системная преамбула платформы + инструкции агента + вход + недоверенный контекст в `<untrusted_content>`) → `ModelRouter.select(policy, needs)` → `NetworkPolicy` → `AIProvider.chat` (structured output по схеме протокола) → при `tool_calls` вызывается `ToolExecutor` (валидация входа → `PermissionGuard` → выполнение → аудит) → итог валидируется Ajv по `output.schema.json` → при ошибке цикл repair (до N раз) → результат шага.

## 7. Режимы работы

| Возможность | Desktop (Electron) | Браузерный режим |
|---|---|---|
| Выбор папки | Системный диалог (`dialog.showOpenDialog`) | Системный диалог через ОС (если доступен) или встроенный обозреватель каталогов |
| Хранение API-ключей | `safeStorage` (Keychain / DPAPI / libsecret). Если `getSelectedStorageBackend() === 'basic_text'`, сохранение запрещается с объяснением | OS keychain CLI (`security` на macOS, `secret-tool` на Linux), переменные окружения `AOS_SECRET_*`, ключ только на сессию |
| Открытие внешних ссылок | Системный браузер (`shell.openExternal`, только `https:`) | Новая вкладка (`rel=noopener noreferrer`) |
| Всё остальное | Одинаково | Одинаково |

## 8. Ошибки

Ошибки ядра — `AppError { code, message, hint, guide?, details?, retryable }`. Код стабилен (например, `SOURCE_NOT_ACCESSIBLE`, `PERMISSION_DENIED`, `MODEL_UNAVAILABLE`, `OFFLINE_MODE`, `WRITE_CONFLICT`). `hint` — что сделать; `guide` — slug руководства, на которое UI ставит кнопку «Открыть инструкцию». Стек-трейс уходит только в лог, пользователю не показывается.
