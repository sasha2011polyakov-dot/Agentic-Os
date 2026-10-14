/**
 * Catalogue of known settings. `level` says where a value may be stored:
 *  - app:    only in registry.db (application-wide)
 *  - system: only in the system's own database
 *  - both:   app value is inherited by every system unless the system overrides it
 */
export type SettingLevel = 'app' | 'system' | 'both';

export interface SettingDef<T = unknown> {
  key: string;
  level: SettingLevel;
  default: T;
  label: string;
  description: string;
  validate?: (v: unknown) => boolean;
}

const isBool = (v: unknown) => typeof v === 'boolean';
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown) => typeof v === 'string';
const oneOf = (...vals: string[]) => (v: unknown) => typeof v === 'string' && vals.includes(v);
const isObj = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrArray = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');

export const SETTINGS: SettingDef[] = [
  // Application level
  { key: 'ui.theme', level: 'app', default: 'system', label: 'Theme', description: 'Light, dark or follow the system.', validate: oneOf('system', 'light', 'dark') },
  { key: 'ui.activeSystemId', level: 'app', default: null, label: 'Active system', description: 'The system open in the interface.', validate: (v) => v === null || isStr(v) },
  { key: 'ui.layout', level: 'app', default: { sidebarWidth: 232, contextWidth: 320, contextOpen: true }, label: 'Panel layout', description: 'Width and visibility of the side panels.', validate: isObj },
  { key: 'ui.density', level: 'app', default: 'comfortable', label: 'Interface density', description: 'Compact or comfortable.', validate: oneOf('comfortable', 'compact') },
  { key: 'net.offline', level: 'app', default: false, label: 'Offline mode', description: 'Blocks every network request except local ones (127.0.0.1). Systems cannot override it.', validate: isBool },
  { key: 'log.level', level: 'app', default: 'info', label: 'Log level', description: 'How detailed the application log is.', validate: oneOf('debug', 'info', 'warn', 'error') },
  { key: 'ai.budget', level: 'app', default: { monthlyCostUsd: null, maxCloudRequestsPerDay: null, maxConcurrentRequests: 2 }, label: 'Cloud AI limits', description: 'Monthly cost limit, requests per day and concurrent requests.', validate: isObj },
  { key: 'web.search', level: 'app', default: { provider: 'none', searxngUrl: '', braveSecretRef: null, githubSecretRef: null, allowHttp: false }, label: 'Web search', description: 'Search provider for research agents.', validate: isObj },
  { key: 'security.gitDetails', level: 'app', default: true, label: 'Detailed Git information', description: 'Run git status/log (read only, with protective flags).', validate: isBool },
  { key: 'security.workCopyMaxBytes', level: 'app', default: 2 * 1024 * 1024 * 1024, label: 'Maximum work copy size', description: 'Projects larger than this are not copied whole: dependencies are excluded, and if it is still too large no copy is created.', validate: isNum },
  { key: 'security.backupsKeep', level: 'app', default: 50, label: 'Restore points kept per project', description: 'Old backups of changes are deleted after a new one is created.', validate: isNum },
  { key: 'security.sandbox', level: 'app', default: 'auto', label: 'Check isolation', description: 'auto: use a sandbox (bubblewrap on Linux) when available; limited: limited mode only.', validate: oneOf('auto', 'limited') },

  // Both levels: app default, system may override
  { key: 'ui.extensionTheme', level: 'app', default: 'default', label: 'Theme from an extension', description: 'default: the standard look; otherwise a theme of an enabled extension ("extension:theme").', validate: (v) => typeof v === 'string' && /^(default|[a-z0-9.-]{1,170}:[a-z0-9-]{1,40})$/.test(v) },
  { key: 'ai.mode', level: 'both', default: 'local', label: 'AI mode', description: 'local: local models only; hybrid: cloud by policy; cloud: cloud allowed.', validate: oneOf('local', 'hybrid', 'cloud') },
  { key: 'ai.defaultModel', level: 'both', default: null, label: 'Default model', description: 'Provider and model used when an agent does not set its own.', validate: (v) => v === null || isObj(v) },
  { key: 'ai.routing', level: 'both', default: {}, label: 'Routing by task type', description: 'Model per task type: classification, extraction, generation, review, embedding.', validate: isObj },
  { key: 'ai.cloudPolicy', level: 'both', default: { allowedTaskTypes: [], escalateToCloudOnFailure: false }, label: 'Cloud policy', description: 'Which task types may be sent to the cloud in hybrid mode.', validate: isObj },
  { key: 'ai.embeddingModel', level: 'both', default: null, label: 'Embedding model', description: 'For semantic search (optional).', validate: (v) => v === null || isObj(v) },
  { key: 'workflow.defaultLimits', level: 'both', default: { maxModelCalls: 60, maxTokens: 400000, maxCostUsd: null, maxReviewIterations: 2, stepTimeoutMs: 300000, maxParallel: 2 }, label: 'Workflow limits', description: 'Default limits for workflow runs.', validate: isObj },

  // System level
  { key: 'docs.newNoteFolder', level: 'system', default: '', label: 'New notes folder', description: 'Relative to the system root; empty means the root.', validate: isStr },
  { key: 'docs.templatesFolder', level: 'system', default: 'Templates', label: 'Templates folder', description: 'User templates of the system.', validate: isStr },
  { key: 'docs.dailyFolder', level: 'system', default: 'Daily', label: 'Daily notes folder', description: 'Where daily notes are created.', validate: isStr },
  { key: 'docs.dailyFormat', level: 'system', default: 'YYYY-MM-DD', label: 'Daily note name format', description: 'Moment.js tokens: YYYY, MM, DD…', validate: isStr },
  { key: 'docs.dailyTemplate', level: 'system', default: 'builtin:daily', label: 'Daily note template', description: 'builtin:<id> or a path to a template.', validate: isStr },
  { key: 'docs.linkFormat', level: 'system', default: 'shortest', label: 'New link format', description: 'shortest: by name when unique; absolute: full path.', validate: oneOf('shortest', 'absolute') },
  { key: 'docs.researchFolder', level: 'system', default: 'Research', label: 'Research folder', description: 'Where agents save web research reports.', validate: isStr },
  { key: 'docs.specsFolder', level: 'system', default: 'Specs', label: 'Specifications folder', description: 'Where specifications and requirements are saved.', validate: isStr },
  { key: 'docs.requiredProperties', level: 'system', default: { requirement: ['id', 'status'], spec: ['status'], decision: ['status'] }, label: 'Required properties by type', description: 'Checked by the integrity report.', validate: isObj },
  { key: 'history.maxVersions', level: 'system', default: 100, label: 'Versions per document', description: 'How many versions to keep for each document.', validate: isNum },
  { key: 'index.defaultExcludes', level: 'system', default: [], label: 'Default exclusions', description: 'Glob patterns (as in .gitignore) for all sources of the system.', validate: isStrArray },
  { key: 'index.chunkEmbeddings', level: 'system', default: false, label: 'Build embeddings', description: 'Semantic search: requires an embedding model.', validate: isBool },
  { key: 'graph.defaults', level: 'system', default: { showSuggested: false, showTags: false, maxNodes: 1500 }, label: 'Graph defaults', description: 'Default graph filters.', validate: isObj },
  { key: 'backup.keep', level: 'system', default: 10, label: 'Backups kept', description: 'Old backups are deleted after a new one is created.', validate: isNum },
  { key: 'ui.state', level: 'system', default: {}, label: 'System interface state', description: 'Last document, graph view, filters.', validate: isObj },
];

export const SETTINGS_BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));
