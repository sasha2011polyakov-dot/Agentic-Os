import type { Migration } from './db.ts';

/**
 * Schema of registry.db — the only database shared between systems. It never stores system content,
 * only the list of systems, application-level settings, shared AI providers, usage accounting and
 * multi-step operation journal. Every row that concerns a system carries its system_id.
 */
export const REGISTRY_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'registry-initial',
    sql: `
CREATE TABLE systems (
  system_id      TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  icon           TEXT NOT NULL DEFAULT 'library',
  color          TEXT NOT NULL DEFAULT '#4f6bed',
  storage_path   TEXT NOT NULL UNIQUE,
  status         TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','disconnected','unavailable','error')),
  status_detail  TEXT,
  schema_version INTEGER NOT NULL DEFAULT 0,
  settings       TEXT NOT NULL DEFAULT '{}',
  sort_order     REAL NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  last_opened_at TEXT,
  last_checked_at TEXT
);

CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ai_providers (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('ollama','openai-compatible','anthropic','test')),
  name       TEXT NOT NULL,
  base_url   TEXT NOT NULL,
  locality   TEXT NOT NULL CHECK (locality IN ('local','cloud')),
  enabled    INTEGER NOT NULL DEFAULT 1,
  secret_ref TEXT,
  options    TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE ai_model_prices (
  provider_id     TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model           TEXT NOT NULL,
  input_per_mtok  REAL,
  output_per_mtok REAL,
  currency        TEXT NOT NULL DEFAULT 'USD',
  PRIMARY KEY (provider_id, model)
);

CREATE TABLE ai_models_cache (
  provider_id TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model       TEXT NOT NULL,
  info        TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (provider_id, model)
);

CREATE TABLE ai_usage (
  id            INTEGER PRIMARY KEY,
  ts            TEXT NOT NULL,
  system_id     TEXT,
  provider_id   TEXT NOT NULL,
  model         TEXT NOT NULL,
  locality      TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  agent_id      TEXT,
  run_id        TEXT,
  step_id       TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  latency_ms    INTEGER,
  cost_usd      REAL,
  status        TEXT NOT NULL CHECK (status IN ('ok','error','denied')),
  error_code    TEXT
);
CREATE INDEX idx_ai_usage_ts ON ai_usage(ts);
CREATE INDEX idx_ai_usage_run ON ai_usage(run_id);
CREATE INDEX idx_ai_usage_system ON ai_usage(system_id, ts);

CREATE TABLE app_agent_packages (
  id           TEXT NOT NULL,
  version      TEXT NOT NULL,
  manifest     TEXT NOT NULL,
  origin       TEXT NOT NULL CHECK (origin IN ('imported','created')),
  install_path TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE operations (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  system_id   TEXT,
  status      TEXT NOT NULL CHECK (status IN ('running','completed','failed','partial')),
  steps       TEXT NOT NULL DEFAULT '[]',
  details     TEXT NOT NULL DEFAULT '{}',
  error       TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_operations_system ON operations(system_id, started_at);

CREATE TABLE registry_audit (
  id        INTEGER PRIMARY KEY,
  ts        TEXT NOT NULL,
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL,
  system_id TEXT,
  outcome   TEXT NOT NULL CHECK (outcome IN ('ok','denied','error')),
  details   TEXT
);
CREATE INDEX idx_registry_audit_ts ON registry_audit(ts);
`,
  },
];
