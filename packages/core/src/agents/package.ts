import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import semver from 'semver';
import { unzipSync, zipSync } from 'fflate';
import { AppError } from '../util/errors.ts';
import { PERMISSION_IDS, type PermissionId } from './permissions.ts';
import { createAjv } from './schema.ts';
import type { TaskType } from '../ai/types.ts';

export const PACKAGE_FORMAT_VERSION = 1;
export const PLATFORM_VERSION = '0.1.0';

export interface AgentManifest {
  formatVersion: number;
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  category: string;
  /** Declarative entry point: the instructions file. Packages never contain executable code. */
  entry: string;
  platform: string;
  schemas: { input: string; output: string };
  tools: string;
  permissions: { permission: PermissionId; reason: string; scope?: { folders?: string[]; domains?: string[] } }[];
  dependencies: { agent: string; version: string }[];
  model: { taskType: TaskType; minContext?: number; structuredOutput: 'required' | 'preferred'; notes?: string };
  defaults: { temperature?: number; maxOutputTokens?: number; maxToolRounds?: number; repairAttempts?: number };
}

export interface AgentTestCase {
  name: string;
  input: unknown;
  expect?: { requiredPaths?: string[]; minItems?: Record<string, number> };
}

export interface AgentPackage {
  manifest: AgentManifest;
  instructions: string;
  tools: string[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  tests: AgentTestCase[];
  readme: string;
  files: Map<string, Buffer>;
}

export interface ValidationReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const ALLOWED_FILE = /^(manifest\.json|instructions\.md|tools\.json|README\.md|schemas\/[a-z0-9._-]+\.json|tests\/[a-z0-9._-]+\.json)$/i;
const MAX_FILES = 200;
const MAX_TOTAL = 5 * 1024 * 1024;

const MANIFEST_SCHEMA = {
  type: 'object',
  required: ['formatVersion', 'id', 'name', 'version', 'description', 'entry', 'platform', 'schemas', 'tools', 'permissions', 'model'],
  properties: {
    formatVersion: { type: 'integer', minimum: 1 },
    id: { type: 'string', pattern: '^[a-z][a-z0-9-]{2,63}$' },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    version: { type: 'string', minLength: 5, maxLength: 40 },
    description: { type: 'string', maxLength: 2000 },
    author: { type: 'string', maxLength: 200 },
    category: { type: 'string', maxLength: 60 },
    entry: { const: 'instructions.md' },
    platform: { type: 'string', maxLength: 100 },
    schemas: { type: 'object', required: ['input', 'output'], properties: { input: { type: 'string' }, output: { type: 'string' } } },
    tools: { type: 'string' },
    permissions: {
      type: 'array',
      items: { type: 'object', required: ['permission', 'reason'], properties: { permission: { type: 'string' }, reason: { type: 'string' }, scope: { type: 'object' } } },
    },
    dependencies: { type: 'array', items: { type: 'object', required: ['agent', 'version'], properties: { agent: { type: 'string' }, version: { type: 'string' } } } },
    model: {
      type: 'object',
      required: ['taskType', 'structuredOutput'],
      properties: {
        taskType: { enum: ['classification', 'extraction', 'generation', 'review', 'planning', 'research', 'embedding', 'chat'] },
        minContext: { type: 'integer', minimum: 0 },
        structuredOutput: { enum: ['required', 'preferred'] },
        notes: { type: 'string' },
      },
    },
    defaults: { type: 'object' },
  },
};

/** Permissions each tool may require (the exact requirement can depend on the call, e.g. the vault needs none for propose). */
export const TOOL_PERMISSIONS: Record<string, PermissionId[]> = {
  search_documents: ['search.use', 'documents.read'], read_document: ['documents.read'], list_documents: ['documents.read'],
  project_inventory: ['projects.read'], list_project_files: ['projects.read'], read_project_file: ['projects.read'], graph_neighbors: ['graph.read'],
  create_document: ['documents.create'], web_search: ['web.search', 'network.fetch'], open_url: ['network.fetch'], extract_page_content: ['network.fetch'],
  fetch_documentation: ['network.fetch'], search_github: ['external.api', 'network.fetch'], inspect_repository: ['external.api', 'network.fetch'],
  save_research_note: ['documents.create'], create_source_links: ['graph.write'], verify_source_freshness: ['network.fetch'], compare_sources: [],
  propose_file_change: ['changes.propose'], run_check: ['commands.run'], create_agent_definition: ['agents.create'],
};

/** Tool names a package may request. Kept in sync with tools/registry.ts (checked by a test). */
export const KNOWN_TOOLS = new Set([
  'search_documents', 'read_document', 'list_documents', 'project_inventory', 'list_project_files', 'read_project_file', 'graph_neighbors',
  'create_document', 'web_search', 'open_url', 'extract_page_content', 'fetch_documentation', 'search_github', 'inspect_repository',
  'compare_sources', 'save_research_note', 'create_source_links', 'verify_source_freshness',
  'propose_file_change', 'run_check', 'create_agent_definition',
]);

function parseJsonFile(files: Map<string, Buffer>, path: string, errors: string[]): unknown {
  const buf = files.get(path);
  if (!buf) {
    errors.push(`Нет файла ${path}`);
    return undefined;
  }
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    errors.push(`${path}: некорректный JSON (${e instanceof Error ? e.message : String(e)})`);
    return undefined;
  }
}

/** Validates a package given as path → bytes. Rejects anything that is not declarative data. */
export function validatePackageFiles(files: Map<string, Buffer>): { report: ValidationReport; pkg: AgentPackage | null } {
  const errors: string[] = [];
  const warnings: string[] = [];
  let total = 0;
  if (files.size > MAX_FILES) errors.push(`Слишком много файлов (${files.size} > ${MAX_FILES}).`);
  for (const [path, buf] of files) {
    total += buf.length;
    if (!ALLOWED_FILE.test(path)) errors.push(`Недопустимый файл в пакете: ${path}. Пакет агента может содержать только manifest.json, instructions.md, tools.json, README.md, schemas/*.json и tests/*.json — исполняемый код запрещён.`);
  }
  if (total > MAX_TOTAL) errors.push('Пакет больше 5 МБ.');
  const ajv = createAjv();
  const manifest = parseJsonFile(files, 'manifest.json', errors) as AgentManifest | undefined;
  if (manifest) {
    const validate = ajv.compile(MANIFEST_SCHEMA);
    if (!validate(manifest)) for (const e of validate.errors ?? []) errors.push(`manifest.json${e.instancePath}: ${e.message}`);
    if (manifest.formatVersion > PACKAGE_FORMAT_VERSION) errors.push(`Формат пакета ${manifest.formatVersion} новее поддерживаемого (${PACKAGE_FORMAT_VERSION}).`);
    if (manifest.version && !semver.valid(manifest.version)) errors.push(`Версия «${manifest.version}» не соответствует semver.`);
    if (manifest.platform && !semver.validRange(manifest.platform)) errors.push(`Некорректный диапазон совместимости platform: ${manifest.platform}`);
    else if (manifest.platform && !semver.satisfies(PLATFORM_VERSION, manifest.platform)) errors.push(`Пакет несовместим с платформой ${PLATFORM_VERSION} (требуется ${manifest.platform}).`);
    for (const p of manifest.permissions ?? []) if (!PERMISSION_IDS.has(p.permission)) errors.push(`Неизвестное разрешение: ${p.permission}`);
  }
  const instructions = files.get('instructions.md')?.toString('utf8') ?? '';
  if (!instructions.trim()) errors.push('instructions.md отсутствует или пуст.');
  if (instructions.length > 100_000) errors.push('instructions.md длиннее 100 000 символов.');
  const toolsJson = manifest ? (parseJsonFile(files, manifest.tools ?? 'tools.json', errors) as { tools?: unknown } | undefined) : undefined;
  const tools = Array.isArray(toolsJson?.tools) ? (toolsJson!.tools as unknown[]).filter((t): t is string => typeof t === 'string') : [];
  if (toolsJson && !Array.isArray(toolsJson.tools)) errors.push('tools.json: ожидается {"tools": [...]}');
  for (const t of tools) if (!KNOWN_TOOLS.has(t)) errors.push(`Неизвестный инструмент: ${t}. Пакеты не могут объявлять собственные исполняемые инструменты.`);
  let inputSchema: Record<string, unknown> = {};
  let outputSchema: Record<string, unknown> = {};
  if (manifest?.schemas) {
    inputSchema = (parseJsonFile(files, manifest.schemas.input, errors) as Record<string, unknown>) ?? {};
    outputSchema = (parseJsonFile(files, manifest.schemas.output, errors) as Record<string, unknown>) ?? {};
    for (const [label, s] of [['input', inputSchema], ['output', outputSchema]] as const) {
      try {
        ajv.compile(s);
      } catch (e) {
        errors.push(`Схема ${label} некорректна: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (outputSchema.type !== 'object') errors.push('Схема выхода должна описывать объект (type: object).');
  }
  let tests: AgentTestCase[] = [];
  const testFile = files.get('tests/test-cases.json');
  if (testFile) {
    const parsed = parseJsonFile(files, 'tests/test-cases.json', errors) as { cases?: AgentTestCase[] } | undefined;
    tests = Array.isArray(parsed?.cases) ? parsed!.cases : [];
    if (!Array.isArray(parsed?.cases)) errors.push('tests/test-cases.json: ожидается {"cases": [...]}');
  } else warnings.push('Нет тестовых сценариев (tests/test-cases.json): тестовый запуск будет выполняться на минимальном входе.');
  if (manifest && tools.length) {
    const needed = new Set<string>();
    for (const t of tools) for (const p of TOOL_PERMISSIONS[t] ?? []) needed.add(p);
    const requested = new Set((manifest.permissions ?? []).map((p) => p.permission));
    for (const p of needed) if (!requested.has(p as PermissionId)) warnings.push(`Инструменты требуют разрешение ${p}, но пакет его не запрашивает: вызовы будут отклонены.`);
  }
  const ok = errors.length === 0 && !!manifest;
  return {
    report: { ok, errors, warnings },
    pkg: ok ? { manifest: { ...manifest!, dependencies: manifest!.dependencies ?? [], defaults: manifest!.defaults ?? {}, author: manifest!.author ?? '', category: manifest!.category ?? 'other' }, instructions, tools, inputSchema, outputSchema, tests, readme: files.get('README.md')?.toString('utf8') ?? '', files } : null,
  };
}

export async function readPackageDir(dir: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  async function walk(d: string): Promise<void> {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) throw new AppError('AGENT_PACKAGE_INVALID', 'Символические ссылки в пакете запрещены.');
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        if ((await stat(p)).size > MAX_TOTAL) throw new AppError('AGENT_PACKAGE_INVALID', 'Файл пакета слишком большой.');
        files.set(relative(dir, p).split(sep).join('/'), await readFile(p));
      }
      if (files.size > MAX_FILES) throw new AppError('AGENT_PACKAGE_INVALID', 'Слишком много файлов в пакете.');
    }
  }
  await walk(dir);
  return files;
}

/** Unzips with traversal/size protection. A single top-level folder (id/...) is stripped. */
export function unzipPackage(zip: Uint8Array): Map<string, Buffer> {
  if (zip.length > MAX_TOTAL * 2) throw new AppError('AGENT_PACKAGE_INVALID', 'Архив слишком большой.');
  let total = 0;
  let count = 0;
  const raw = unzipSync(zip, {
    filter: (f) => {
      count++;
      total += f.originalSize;
      if (count > MAX_FILES || total > MAX_TOTAL) throw new AppError('AGENT_PACKAGE_INVALID', 'Архив содержит слишком много данных.');
      return !f.name.endsWith('/');
    },
  });
  const names = Object.keys(raw);
  for (const n of names) {
    if (n.includes('..') || n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.includes('\\')) throw new AppError('AGENT_PACKAGE_INVALID', `Недопустимый путь в архиве: ${n}`);
  }
  const prefixes = new Set(names.map((n) => (n.includes('/') ? n.slice(0, n.indexOf('/')) : '')));
  const strip = prefixes.size === 1 && !prefixes.has('') && !names.includes('manifest.json') ? `${[...prefixes][0]}/` : '';
  const out = new Map<string, Buffer>();
  for (const n of names) out.set(n.slice(strip.length), Buffer.from(raw[n]!));
  return out;
}

export function zipPackage(files: Map<string, Buffer>, rootFolder: string): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [p, buf] of files) entries[`${rootFolder}/${p}`] = new Uint8Array(buf);
  return zipSync(entries, { level: 6 });
}
