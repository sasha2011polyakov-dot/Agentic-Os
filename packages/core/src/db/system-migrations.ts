import type { Migration } from './db.ts';

/**
 * Schema of <system>/.aos/system.db. One database per system: physical isolation means a query of
 * one system can never read or modify rows of another, and backup/export is a copy of one file.
 */
export const SYSTEM_MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'system-initial',
    sql: `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Sources: the system's own vault (writable) and connected folders/repositories (read-only by default)
CREATE TABLE sources (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('vault','project')),
  name              TEXT NOT NULL,
  root_path         TEXT NOT NULL UNIQUE,
  purpose           TEXT NOT NULL DEFAULT '',
  category          TEXT NOT NULL DEFAULT '',
  writable          INTEGER NOT NULL DEFAULT 0,
  confidential      INTEGER NOT NULL DEFAULT 0,
  include_globs     TEXT NOT NULL DEFAULT '[]',
  exclude_globs     TEXT NOT NULL DEFAULT '[]',
  respect_gitignore INTEGER NOT NULL DEFAULT 1,
  max_file_bytes    INTEGER NOT NULL DEFAULT 2097152,
  is_git            INTEGER NOT NULL DEFAULT 0,
  git_root          TEXT,
  watch             INTEGER NOT NULL DEFAULT 1,
  -- user-defined verification commands for missions: [{name, program, args, timeoutSec}] (agents can only run these by name)
  checks            TEXT NOT NULL DEFAULT '[]',
  -- access mode (section 29.2): read_only "Read only" (default) → prepare "Prepare changes"
  -- → workcopy "Work in a copy" → apply "Apply to the original project" (privileged, never set automatically)
  access_mode       TEXT NOT NULL DEFAULT 'read_only' CHECK (access_mode IN ('read_only','prepare','workcopy','apply')),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','indexing','ready','error','unavailable')),
  status_message    TEXT,
  last_indexed_at   TEXT,
  last_index_stats  TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

-- Every scanned file, including skipped ones (with reason) so the user can see what was not indexed and why
CREATE TABLE files (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  rel_path    TEXT NOT NULL,
  size        INTEGER NOT NULL,
  mtime_ms    INTEGER NOT NULL,
  hash        TEXT,
  kind        TEXT NOT NULL,
  language    TEXT,
  status      TEXT NOT NULL CHECK (status IN ('indexed','skipped','error')),
  skip_reason TEXT,
  error       TEXT,
  indexed_at  TEXT NOT NULL,
  UNIQUE (source_id, rel_path)
);
CREATE INDEX idx_files_source_status ON files(source_id, status);

-- Parsed documents. n is a stable INTEGER PRIMARY KEY used as FTS rowid; id survives renames.
CREATE TABLE documents (
  n            INTEGER PRIMARY KEY,
  id           TEXT NOT NULL UNIQUE,
  file_id      TEXT NOT NULL UNIQUE REFERENCES files(id) ON DELETE CASCADE,
  source_id    TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  rel_path     TEXT NOT NULL,
  title        TEXT NOT NULL,
  title_lower  TEXT NOT NULL,
  basename_lower TEXT NOT NULL,
  fm_id        TEXT,
  doc_type     TEXT,
  status       TEXT,
  aliases      TEXT NOT NULL DEFAULT '[]',
  frontmatter  TEXT NOT NULL DEFAULT '{}',
  headings     TEXT NOT NULL DEFAULT '[]',
  block_ids    TEXT NOT NULL DEFAULT '[]',
  outline      TEXT NOT NULL DEFAULT '[]',
  word_count   INTEGER NOT NULL DEFAULT 0,
  hash         TEXT NOT NULL,
  created_at   TEXT,
  updated_at   TEXT,
  review_after TEXT,
  indexed_at   TEXT NOT NULL
);
CREATE INDEX idx_documents_source_path ON documents(source_id, rel_path);
CREATE INDEX idx_documents_title ON documents(title_lower);
CREATE INDEX idx_documents_basename ON documents(basename_lower);
CREATE INDEX idx_documents_fm_id ON documents(fm_id);
CREATE INDEX idx_documents_type ON documents(doc_type);
CREATE INDEX idx_documents_hash ON documents(hash);

CREATE VIRTUAL TABLE documents_fts USING fts5(
  title, aliases, headings, body, path, tags,
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE VIRTUAL TABLE documents_trgm USING fts5(title, path, tokenize = 'trigram');

CREATE TABLE doc_aliases (
  doc_id      TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  alias_lower TEXT NOT NULL,
  alias       TEXT NOT NULL,
  PRIMARY KEY (doc_id, alias_lower)
);
CREATE INDEX idx_doc_aliases_alias ON doc_aliases(alias_lower);

CREATE TABLE doc_links (
  id              INTEGER PRIMARY KEY,
  src_doc_id      TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('wikilink','markdown','embed','frontmatter')),
  relation        TEXT NOT NULL DEFAULT 'references',
  target_raw      TEXT NOT NULL,
  target_key      TEXT NOT NULL,
  heading         TEXT,
  block_id        TEXT,
  alias           TEXT,
  line            INTEGER NOT NULL,
  col             INTEGER NOT NULL,
  is_external     INTEGER NOT NULL DEFAULT 0,
  context         TEXT,
  resolved_doc_id TEXT REFERENCES documents(id) ON DELETE SET NULL
);
CREATE INDEX idx_doc_links_src ON doc_links(src_doc_id);
CREATE INDEX idx_doc_links_resolved ON doc_links(resolved_doc_id);
CREATE INDEX idx_doc_links_target ON doc_links(target_key);

CREATE TABLE doc_tags (
  doc_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  display TEXT NOT NULL,
  PRIMARY KEY (doc_id, tag)
);
CREATE INDEX idx_doc_tags_tag ON doc_tags(tag);

CREATE TABLE doc_properties (
  doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  ord        INTEGER NOT NULL DEFAULT 0,
  value_type TEXT NOT NULL,
  value_text TEXT,
  value_num  REAL,
  PRIMARY KEY (doc_id, key, ord)
);
CREATE INDEX idx_doc_properties_key ON doc_properties(key, value_text);

CREATE TABLE property_types (
  key      TEXT PRIMARY KEY,
  type     TEXT NOT NULL,
  inferred INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE doc_checkboxes (
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  line   INTEGER NOT NULL,
  text   TEXT NOT NULL,
  done   INTEGER NOT NULL,
  PRIMARY KEY (doc_id, line)
);

CREATE TABLE chunks (
  id           INTEGER PRIMARY KEY,
  doc_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord          INTEGER NOT NULL,
  heading_path TEXT NOT NULL DEFAULT '',
  start_line   INTEGER NOT NULL,
  end_line     INTEGER NOT NULL,
  text         TEXT NOT NULL,
  hash         TEXT NOT NULL
);
CREATE INDEX idx_chunks_doc ON chunks(doc_id);
CREATE INDEX idx_chunks_hash ON chunks(hash);

-- Embeddings are keyed by chunk content hash + model: re-chunking does not lose them, models never mix
CREATE TABLE embeddings (
  hash       TEXT NOT NULL,
  model      TEXT NOT NULL,
  dim        INTEGER NOT NULL,
  vector     BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (hash, model)
);

-- Knowledge graph: typed nodes and typed edges with provenance
CREATE TABLE graph_nodes (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  label      TEXT NOT NULL,
  ref_id     TEXT,
  source_id  TEXT,
  props      TEXT NOT NULL DEFAULT '{}',
  derived_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_graph_nodes_type ON graph_nodes(type);
CREATE INDEX idx_graph_nodes_ref ON graph_nodes(ref_id);
CREATE INDEX idx_graph_nodes_source ON graph_nodes(source_id);

CREATE TABLE graph_edges (
  id          TEXT PRIMARY KEY,
  src         TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  dst         TEXT NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  relation    TEXT NOT NULL,
  origin      TEXT NOT NULL CHECK (origin IN ('explicit','extracted','ai_suggested','system')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suggested','confirmed','rejected')),
  confidence  REAL,
  evidence    TEXT,
  created_by  TEXT,
  derived_key TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (src, dst, relation, origin)
);
CREATE INDEX idx_graph_edges_src ON graph_edges(src);
CREATE INDEX idx_graph_edges_dst ON graph_edges(dst);
CREATE INDEX idx_graph_edges_derived ON graph_edges(derived_key);
CREATE INDEX idx_graph_edges_relation ON graph_edges(relation);

-- Explicit links from this system to objects of another system (never created automatically)
CREATE TABLE cross_links (
  id               TEXT PRIMARY KEY,
  src_node         TEXT NOT NULL,
  target_system_id TEXT NOT NULL,
  target_type      TEXT NOT NULL,
  target_id        TEXT NOT NULL,
  target_label     TEXT NOT NULL,
  relation         TEXT NOT NULL,
  note             TEXT,
  created_by       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE (src_node, target_system_id, target_id, relation)
);

-- Version history: content-addressed, gzip-compressed blobs
CREATE TABLE blobs (
  hash       TEXT PRIMARY KEY,
  size       INTEGER NOT NULL,
  content    BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE doc_versions (
  id         INTEGER PRIMARY KEY,
  source_id  TEXT NOT NULL,
  rel_path   TEXT NOT NULL,
  doc_id     TEXT,
  blob_hash  TEXT NOT NULL REFERENCES blobs(hash),
  reason     TEXT NOT NULL,
  actor      TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_doc_versions_path ON doc_versions(source_id, rel_path, created_at);
CREATE INDEX idx_doc_versions_doc ON doc_versions(doc_id, created_at);

-- Tasks
CREATE TABLE tasks (
  id                  TEXT PRIMARY KEY,
  key                 TEXT NOT NULL UNIQUE,
  title               TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  goal                TEXT NOT NULL DEFAULT '',
  rationale           TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL CHECK (status IN ('backlog','todo','in_progress','review','done','blocked','cancelled')),
  priority            TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('critical','high','medium','low')),
  parent_id           TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  project_id          TEXT REFERENCES sources(id) ON DELETE SET NULL,
  assignee_type       TEXT CHECK (assignee_type IN ('user','agent')),
  assignee_id         TEXT,
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  affected_modules    TEXT NOT NULL DEFAULT '[]',
  unknowns            TEXT NOT NULL DEFAULT '[]',
  requirement_ids     TEXT NOT NULL DEFAULT '[]',
  origin              TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','agent')),
  origin_run_id       TEXT,
  origin_doc_id       TEXT,
  completion_evidence TEXT,
  sort_order          REAL NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  completed_at        TEXT
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_parent ON tasks(parent_id);
CREATE INDEX idx_tasks_project ON tasks(project_id);

CREATE TABLE task_deps (
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on),
  CHECK (task_id <> depends_on)
);

CREATE TABLE task_comments (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE task_links (
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('document','url','requirement')),
  target_id   TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (task_id, target_type, target_id)
);

-- Agents usable in this system. scope=app rows reference shared packages; scope=system rows reference .aos/agents
CREATE TABLE system_agent_packages (
  id           TEXT NOT NULL,
  version      TEXT NOT NULL,
  manifest     TEXT NOT NULL,
  origin       TEXT NOT NULL CHECK (origin IN ('imported','created')),
  install_path TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);

CREATE TABLE agents (
  id               TEXT PRIMARY KEY,
  scope            TEXT NOT NULL CHECK (scope IN ('builtin','app','system')),
  active_version   TEXT NOT NULL,
  previous_version TEXT,
  enabled          INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'installed' CHECK (status IN ('installed','enabled','disabled','error')),
  status_detail    TEXT,
  last_test_at     TEXT,
  last_test_result TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE agent_configs (
  agent_id     TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  model_policy TEXT NOT NULL DEFAULT '{}',
  generation   TEXT NOT NULL DEFAULT '{}',
  updated_at   TEXT NOT NULL
);

CREATE TABLE agent_grants (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT '{}',
  granted_at TEXT NOT NULL,
  UNIQUE (agent_id, permission)
);

-- Workflows and runs
CREATE TABLE workflows (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  version     INTEGER NOT NULL DEFAULT 1,
  definition  TEXT NOT NULL,
  builtin     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE workflow_runs (
  id               TEXT PRIMARY KEY,
  workflow_id      TEXT NOT NULL,
  workflow_version INTEGER NOT NULL,
  definition       TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('pending','running','paused','waiting_for_approval','completed','failed','cancelled')),
  title            TEXT NOT NULL DEFAULT '',
  input            TEXT NOT NULL,
  scope            TEXT NOT NULL,
  limits           TEXT NOT NULL,
  totals           TEXT NOT NULL DEFAULT '{}',
  error            TEXT,
  status_reason    TEXT,
  result           TEXT,
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_runs_status ON workflow_runs(status);
CREATE INDEX idx_runs_created ON workflow_runs(created_at);

CREATE TABLE run_steps (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  node_id           TEXT NOT NULL,
  iteration         INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL CHECK (status IN ('pending','running','waiting_for_approval','completed','failed','cancelled','skipped')),
  agent_id          TEXT,
  agent_version     TEXT,
  model_config      TEXT,
  input             TEXT,
  output            TEXT,
  error             TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  transition_reason TEXT,
  approval          TEXT,
  started_at        TEXT,
  finished_at       TEXT,
  updated_at        TEXT NOT NULL,
  UNIQUE (run_id, node_id, iteration)
);
CREATE INDEX idx_run_steps_run ON run_steps(run_id);

CREATE TABLE run_events (
  id      INTEGER PRIMARY KEY,
  run_id  TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_id TEXT,
  ts      TEXT NOT NULL,
  level   TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
  type    TEXT NOT NULL,
  message TEXT NOT NULL,
  data    TEXT
);
CREATE INDEX idx_run_events_run ON run_events(run_id, id);

-- Missions: natural-language assignments executed end to end (analysis → … → verification → summary)
CREATE TABLE missions (
  id               TEXT PRIMARY KEY,
  key              TEXT NOT NULL UNIQUE,
  title            TEXT NOT NULL,
  original_request TEXT NOT NULL,
  attachments      TEXT NOT NULL DEFAULT '[]',
  normalized       TEXT,
  revision         INTEGER NOT NULL DEFAULT 0,
  mode             TEXT NOT NULL CHECK (mode IN ('plan','execute')),
  status           TEXT NOT NULL CHECK (status IN ('draft','analyzing','needs_input','researching','planning','awaiting_approval','ready','executing','paused','verifying','needs_fix','completed','partially_completed','failed','cancelled')),
  phase            TEXT NOT NULL DEFAULT 'analysis',
  priority         TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('critical','high','medium','low')),
  scope            TEXT NOT NULL,
  policy           TEXT NOT NULL,
  limits           TEXT NOT NULL,
  context          TEXT,
  research         TEXT,
  options          TEXT,
  strategy         TEXT,
  plan             TEXT,
  plan_stale       INTEGER NOT NULL DEFAULT 0,
  criteria         TEXT NOT NULL DEFAULT '[]',
  extra_requirements TEXT NOT NULL DEFAULT '[]',
  approved_checks  TEXT NOT NULL DEFAULT '[]',
  baseline         TEXT,
  limitations      TEXT NOT NULL DEFAULT '[]',
  pending          TEXT,
  fix_rounds       INTEGER NOT NULL DEFAULT 0,
  review           TEXT,
  summary          TEXT,
  report_doc_id    TEXT,
  totals           TEXT NOT NULL DEFAULT '{}',
  error            TEXT,
  status_reason    TEXT,
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_missions_status ON missions(status);

CREATE TABLE mission_steps (
  id              TEXT PRIMARY KEY,
  mission_id      TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  phase           TEXT NOT NULL,
  plan_step       TEXT,
  role            TEXT NOT NULL,
  agent_id        TEXT,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending','running','waiting_for_approval','completed','failed','cancelled','skipped')),
  depends_on      TEXT NOT NULL DEFAULT '[]',
  input           TEXT,
  output          TEXT,
  error           TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE,
  side_effects    TEXT NOT NULL DEFAULT '[]',
  started_at      TEXT,
  finished_at     TEXT,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_mission_steps ON mission_steps(mission_id, seq);

CREATE TABLE mission_events (
  id         INTEGER PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  step_id    TEXT,
  ts         TEXT NOT NULL,
  level      TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
  type       TEXT NOT NULL,
  message    TEXT NOT NULL,
  data       TEXT
);
CREATE INDEX idx_mission_events ON mission_events(mission_id, id);

CREATE TABLE mission_messages (
  id         TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('user','advisor','system')),
  body       TEXT NOT NULL,
  data       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_mission_messages ON mission_messages(mission_id, created_at);

CREATE TABLE mission_checks (
  id           TEXT PRIMARY KEY,
  mission_id   TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  step_id      TEXT,
  round        INTEGER NOT NULL DEFAULT 0,
  kind         TEXT NOT NULL CHECK (kind IN ('command','criterion','validator')),
  name         TEXT NOT NULL,
  source_id    TEXT,
  status       TEXT NOT NULL,
  exit_code    INTEGER,
  duration_ms  INTEGER,
  output       TEXT,
  evidence     TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_mission_checks ON mission_checks(mission_id, round);

-- Change sets: file changes proposed by agents. Nothing is written to disk until a user applies the set.
CREATE TABLE change_sets (
  id            TEXT PRIMARY KEY,
  mission_id    TEXT,
  run_id        TEXT,
  step_id       TEXT,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('proposed','applied','partially_applied','conflict','reverted','rejected')),
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  -- review (29.7): the user approves exactly this content; any later change makes the approval stale
  content_hash  TEXT,
  reviewed_hash TEXT,
  reviewed_at   TEXT,
  reviewed_by   TEXT,
  -- checks passed in a work copy for exactly this content
  verified_hash TEXT,
  verification  TEXT,
  work_copy_id  TEXT,
  backup_id     TEXT,
  applied_at    TEXT,
  applied_by    TEXT,
  reverted_at   TEXT,
  report        TEXT
);
CREATE INDEX idx_change_sets_mission ON change_sets(mission_id);

CREATE TABLE change_set_files (
  id            TEXT PRIMARY KEY,
  change_set_id TEXT NOT NULL REFERENCES change_sets(id) ON DELETE CASCADE,
  source_id     TEXT NOT NULL,
  rel_path      TEXT NOT NULL,
  op            TEXT NOT NULL CHECK (op IN ('create','modify','delete')),
  base_hash     TEXT,
  base_blob     TEXT REFERENCES blobs(hash),
  new_blob      TEXT REFERENCES blobs(hash),
  new_hash      TEXT,
  rationale     TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','conflict','reverted','skipped','failed')),
  status_detail TEXT,
  trash_path    TEXT,
  UNIQUE (change_set_id, source_id, rel_path)
);

-- Web research
CREATE TABLE web_sources (
  id            TEXT PRIMARY KEY,
  url           TEXT NOT NULL UNIQUE,
  canonical_url TEXT,
  title         TEXT,
  published_at  TEXT,
  retrieved_at  TEXT NOT NULL,
  verified_at   TEXT,
  status_code   INTEGER,
  content_hash  TEXT,
  content_blob  TEXT REFERENCES blobs(hash),
  provider      TEXT,
  error         TEXT
);

CREATE TABLE facts (
  id            TEXT PRIMARY KEY,
  statement     TEXT NOT NULL,
  subject       TEXT,
  source_kind   TEXT NOT NULL CHECK (source_kind IN ('web','document')),
  source_ref    TEXT NOT NULL,
  source_label  TEXT,
  quote         TEXT,
  quote_status  TEXT NOT NULL DEFAULT 'unchecked' CHECK (quote_status IN ('verified','not_found_in_source','unchecked')),
  status        TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','verified','stale','conflicted','rejected')),
  confidence    REAL,
  run_id        TEXT,
  project_id    TEXT,
  created_at    TEXT NOT NULL,
  verified_at   TEXT,
  review_after  TEXT
);
CREATE INDEX idx_facts_subject ON facts(subject);

CREATE TABLE project_profiles (
  source_id   TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
  profile     TEXT NOT NULL,
  files_hash  TEXT NOT NULL,
  computed_at TEXT NOT NULL
);

-- Isolated work copies of projects (29.3): physically separate folders in the app data directory
CREATE TABLE work_copies (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  mission_id  TEXT,
  root_path   TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL CHECK (status IN ('creating','ready','stale','discarded','error')),
  files       INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  excluded    TEXT NOT NULL DEFAULT '[]',
  applied_sets TEXT NOT NULL DEFAULT '[]',
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_work_copies_source ON work_copies(source_id, status);

-- Verified restore points taken before changes reach an original project (29.8)
CREATE TABLE change_backups (
  id            TEXT PRIMARY KEY,
  source_id     TEXT NOT NULL,
  change_set_id TEXT,
  mission_id    TEXT,
  path          TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL CHECK (status IN ('creating','verified','failed','restored','pruned')),
  files         TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL,
  verified_at   TEXT,
  restored_at   TEXT,
  error         TEXT
);

-- Security journal (29.15): append-only (triggers) and hash-chained, so history cannot be rewritten silently
CREATE TABLE security_log (
  id         INTEGER PRIMARY KEY,
  ts         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  outcome    TEXT NOT NULL CHECK (outcome IN ('ok','denied','error','warning')),
  source_id  TEXT,
  task_id    TEXT,
  resources  TEXT NOT NULL DEFAULT '[]',
  message    TEXT NOT NULL,
  details    TEXT,
  prev_hash  TEXT NOT NULL,
  hash       TEXT NOT NULL
);
CREATE INDEX idx_security_log_ts ON security_log(ts);
CREATE TRIGGER security_log_no_update BEFORE UPDATE ON security_log BEGIN SELECT RAISE(ABORT, 'security_log is append-only'); END;
CREATE TRIGGER security_log_no_delete BEFORE DELETE ON security_log BEGIN SELECT RAISE(ABORT, 'security_log is append-only'); END;

-- Audit journal of this system (every mutating operation, agent tool call, permission decision)
CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY,
  ts      TEXT NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','denied','error')),
  details TEXT,
  run_id  TEXT
);
CREATE INDEX idx_audit_ts ON audit_log(ts);
CREATE INDEX idx_audit_run ON audit_log(run_id);

CREATE TABLE error_log (
  id      INTEGER PRIMARY KEY,
  ts      TEXT NOT NULL,
  code    TEXT NOT NULL,
  message TEXT NOT NULL,
  context TEXT,
  details TEXT
);
CREATE INDEX idx_error_log_ts ON error_log(ts);
`,
  },
  {
    version: 2,
    name: 'missions-gaps',
    sql: `
-- Stages or capabilities a mission could not execute (no agent, tool, access, model…): they prevent "Completed" (28.15)
ALTER TABLE missions ADD COLUMN gaps TEXT NOT NULL DEFAULT '[]';
`,
  },
];
