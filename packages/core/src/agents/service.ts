import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import semver from 'semver';
import type { SystemRuntime } from '../systems/runtime.ts';
import { AppError, toAppError } from '../util/errors.ts';
import { parseJson } from '../util/json.ts';
import { nowIso } from '../util/time.ts';
import { getPath } from '../util/json.ts';
import { readPackageDir, unzipPackage, validatePackageFiles, zipPackage, type AgentPackage, type AgentManifest } from './package.ts';
import { AgentCatalog, toEntry, writePackage, type AgentScope, type CatalogEntry } from './catalog.ts';
import { PermissionGuard, PERMISSIONS, type GrantScope, type PermissionId, type RunScope } from './permissions.ts';
import type { AgentConfig, AgentRunResult, AgentRuntime } from './runtime.ts';
import type { ModelPolicy } from '../ai/router.ts';

export interface InstalledAgent {
  id: string;
  scope: AgentScope;
  version: string;
  previousVersion: string | null;
  enabled: boolean;
  status: string;
  statusDetail: string | null;
  name: string;
  description: string;
  category: string;
  taskType: string;
  tools: string[];
  requestedPermissions: { permission: string; reason: string }[];
  grants: { permission: string; scope: GrantScope }[];
  config: AgentConfig;
  lastTestAt: string | null;
  lastTestResult: { ok: boolean; message: string; cases: { name: string; ok: boolean; problems: string[] }[] } | null;
  runs: number;
}

export interface CatalogItem extends CatalogEntry {
  installed: boolean;
  installedVersion: string | null;
  enabled: boolean;
}

export interface AgentDefinitionInput {
  id: string;
  name: string;
  description: string;
  category?: string;
  version?: string;
  instructions: string;
  tools: string[];
  permissions: { permission: PermissionId; reason: string }[];
  taskType: AgentManifest['model']['taskType'];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  tests?: { name: string; input: unknown; expect?: { requiredPaths?: string[]; minItems?: Record<string, number> } }[];
  readme?: string;
}

interface AgentRow {
  id: string;
  scope: AgentScope;
  active_version: string;
  previous_version: string | null;
  enabled: number;
  status: string;
  status_detail: string | null;
  last_test_at: string | null;
  last_test_result: string | null;
}

/** Agents of ONE system: which agents are installed/enabled here, with which permissions and model. */
export class AgentService {
  readonly guard: PermissionGuard;

  constructor(
    private readonly rt: SystemRuntime,
    private readonly catalogApp: AgentCatalog,
    private readonly runtime: AgentRuntime,
  ) {
    this.guard = new PermissionGuard(rt.db);
  }

  private rows(): AgentRow[] {
    return this.rt.db.all<AgentRow>('SELECT * FROM agents ORDER BY id');
  }

  private row(id: string): AgentRow {
    const r = this.rt.db.get<AgentRow>('SELECT * FROM agents WHERE id = ?', id);
    if (!r) throw new AppError('NOT_FOUND', `Агент «${id}» не установлен в этой системе.`);
    return r;
  }

  private systemRows(): { id: string; version: string; install_path: string }[] {
    return this.rt.db.all('SELECT id, version, install_path FROM system_agent_packages ORDER BY id, installed_at DESC');
  }

  /** Loads a package by scope/id/version (system packages live in the system folder and travel with it). */
  async package(scope: AgentScope, id: string, version?: string): Promise<AgentPackage> {
    if (scope === 'builtin') {
      const p = this.catalogApp.builtinPackage(id);
      if (!p) throw new AppError('NOT_FOUND', `Встроенный агент «${id}» не найден.`);
      return p;
    }
    if (scope === 'app') {
      const p = await this.catalogApp.sharedPackage(id, version);
      if (!p) throw new AppError('AGENT_PACKAGE_INVALID', `Общий пакет «${id}@${version ?? '*'}» не найден или повреждён.`);
      return p;
    }
    const row = this.systemRows().find((r) => r.id === id && (!version || r.version === version));
    if (!row) throw new AppError('NOT_FOUND', `Пакет «${id}@${version ?? '*'}» не найден в системе.`);
    const { pkg, report } = validatePackageFiles(await readPackageDir(join(this.rt.paths.root, row.install_path)));
    if (!pkg) throw new AppError('AGENT_PACKAGE_INVALID', report.errors.join('; '));
    return pkg;
  }

  async catalog(): Promise<CatalogItem[]> {
    const installed = new Map(this.rows().map((r) => [r.id, r]));
    const entries: CatalogEntry[] = [...this.catalogApp.builtinEntries(), ...(await this.catalogApp.sharedEntries())];
    for (const r of this.systemRows()) {
      try {
        const { pkg, report } = validatePackageFiles(await readPackageDir(join(this.rt.paths.root, r.install_path)));
        if (pkg) entries.push(toEntry(pkg, 'system', r.install_path, report));
      } catch {
        // broken package folder: surfaced through installed agent status
      }
    }
    return entries.map((e) => {
      const i = installed.get(e.id);
      return { ...e, installed: !!i && i.scope === e.scope, installedVersion: i && i.scope === e.scope ? i.active_version : null, enabled: !!i && i.scope === e.scope && !!i.enabled };
    });
  }

  config(id: string): AgentConfig {
    const r = this.rt.db.get<{ model_policy: string; generation: string }>('SELECT model_policy, generation FROM agent_configs WHERE agent_id = ?', id);
    return { modelPolicy: parseJson<ModelPolicy>(r?.model_policy, { mode: 'inherit' }), generation: parseJson(r?.generation, {}) };
  }

  async list(): Promise<InstalledAgent[]> {
    const out: InstalledAgent[] = [];
    for (const r of this.rows()) out.push(await this.describe(r));
    return out;
  }

  async get(id: string): Promise<InstalledAgent & { instructions: string; inputSchema: unknown; outputSchema: unknown; tests: unknown[]; readme: string; versions: string[] }> {
    const r = this.row(id);
    const info = await this.describe(r);
    let pkg: AgentPackage | null = null;
    try {
      pkg = await this.package(r.scope, id, r.active_version);
    } catch {
      pkg = null;
    }
    const versions = r.scope === 'system' ? this.systemRows().filter((x) => x.id === id).map((x) => x.version) : r.scope === 'app' ? this.catalogApp.sharedRows().filter((x) => x.id === id).map((x) => x.version) : [r.active_version];
    return { ...info, instructions: pkg?.instructions ?? '', inputSchema: pkg?.inputSchema ?? null, outputSchema: pkg?.outputSchema ?? null, tests: pkg?.tests ?? [], readme: pkg?.readme ?? '', versions };
  }

  private async describe(r: AgentRow): Promise<InstalledAgent> {
    let pkg: AgentPackage | null = null;
    let status = r.status;
    let statusDetail = r.status_detail;
    try {
      pkg = await this.package(r.scope, r.id, r.active_version);
    } catch (e) {
      status = 'error';
      statusDetail = toAppError(e).message;
    }
    const runs = this.rt.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM run_steps WHERE agent_id = ?', r.id)!.c;
    return {
      id: r.id,
      scope: r.scope,
      version: r.active_version,
      previousVersion: r.previous_version,
      enabled: !!r.enabled,
      status,
      statusDetail,
      name: pkg?.manifest.name ?? r.id,
      description: pkg?.manifest.description ?? '',
      category: pkg?.manifest.category ?? '',
      taskType: pkg?.manifest.model.taskType ?? 'generation',
      tools: pkg?.tools ?? [],
      requestedPermissions: pkg?.manifest.permissions.map((p) => ({ permission: p.permission, reason: p.reason })) ?? [],
      grants: this.guard.grants(r.id).map((g) => ({ permission: g.permission, scope: g.scope })),
      config: this.config(r.id),
      lastTestAt: r.last_test_at,
      lastTestResult: parseJson(r.last_test_result, null),
      runs,
    };
  }

  /**
   * Installs an agent into this system. Only the permissions the user confirmed are granted — installation
   * never grants everything the package requests. The agent stays disabled until enabled explicitly.
   */
  async install(input: { id: string; scope: AgentScope; version?: string; grants: PermissionId[]; grantScopes?: Partial<Record<PermissionId, GrantScope>> }): Promise<InstalledAgent> {
    const pkg = await this.package(input.scope, input.id, input.version);
    const existing = this.rt.db.get<AgentRow>('SELECT * FROM agents WHERE id = ?', input.id);
    if (existing && existing.scope !== input.scope) throw new AppError('VALIDATION_FAILED', `Агент «${input.id}» уже установлен из другого источника (${existing.scope}). Удалите его сначала.`);
    for (const dep of pkg.manifest.dependencies) {
      const d = this.rt.db.get<AgentRow>('SELECT * FROM agents WHERE id = ?', dep.agent);
      if (!d) throw new AppError('VALIDATION_FAILED', `Требуется агент «${dep.agent}» (${dep.version}). Установите его сначала.`);
      if (!semver.satisfies(d.active_version, dep.version)) throw new AppError('AGENT_INCOMPATIBLE', `Агенту нужна версия «${dep.agent}» ${dep.version}, установлена ${d.active_version}.`);
    }
    const requested = new Set(pkg.manifest.permissions.map((p) => p.permission));
    for (const g of input.grants) if (!requested.has(g)) throw new AppError('VALIDATION_FAILED', `Пакет не запрашивает разрешение ${g}.`);
    const now = nowIso();
    this.rt.db.transaction(() => {
      if (existing) {
        this.rt.db.run('UPDATE agents SET previous_version = CASE WHEN active_version <> ? THEN active_version ELSE previous_version END, active_version = ?, status = ?, status_detail = NULL, updated_at = ? WHERE id = ?', pkg.manifest.version, pkg.manifest.version, existing.enabled ? 'enabled' : 'installed', now, input.id);
      } else {
        this.rt.db.run("INSERT INTO agents(id, scope, active_version, enabled, status, created_at, updated_at) VALUES (?, ?, ?, 0, 'installed', ?, ?)", input.id, input.scope, pkg.manifest.version, now, now);
        this.rt.db.run('INSERT INTO agent_configs(agent_id, model_policy, generation, updated_at) VALUES (?, ?, ?, ?)', input.id, JSON.stringify({ mode: 'inherit' }), JSON.stringify({}), now);
      }
      this.guard.revokeAll(input.id);
      for (const g of input.grants) {
        const manifestScope = pkg.manifest.permissions.find((p) => p.permission === g)?.scope ?? {};
        this.guard.grant(input.id, g, { ...manifestScope, ...(input.grantScopes?.[g] ?? {}) });
      }
    });
    this.rt.audit.record({ actor: 'user', action: 'agent.install', target: input.id, details: { scope: input.scope, version: pkg.manifest.version, grants: input.grants } });
    this.rt.emit('agents.changed', { agentId: input.id });
    return this.describe(this.row(input.id));
  }

  setGrants(id: string, grants: PermissionId[], scopes: Partial<Record<PermissionId, GrantScope>> = {}): void {
    this.row(id);
    this.rt.db.transaction(() => {
      this.guard.revokeAll(id);
      for (const g of grants) this.guard.grant(id, g, scopes[g] ?? {});
    });
    this.rt.audit.record({ actor: 'user', action: 'agent.grants', target: id, details: { grants, scopes } });
    this.rt.emit('agents.changed', { agentId: id });
  }

  configure(id: string, cfg: Partial<AgentConfig>): AgentConfig {
    this.row(id);
    const current = this.config(id);
    const next: AgentConfig = { modelPolicy: { ...current.modelPolicy, ...(cfg.modelPolicy ?? {}) }, generation: { ...current.generation, ...(cfg.generation ?? {}) } };
    const g = next.generation;
    if (g.temperature !== undefined && (g.temperature < 0 || g.temperature > 2)) throw new AppError('VALIDATION_FAILED', 'Температура должна быть от 0 до 2.');
    if (g.maxOutputTokens !== undefined && (g.maxOutputTokens < 64 || g.maxOutputTokens > 64000)) throw new AppError('VALIDATION_FAILED', 'Лимит ответа: от 64 до 64000 токенов.');
    this.rt.db.run('UPDATE agent_configs SET model_policy = ?, generation = ?, updated_at = ? WHERE agent_id = ?', JSON.stringify(next.modelPolicy), JSON.stringify(next.generation), nowIso(), id);
    this.rt.audit.record({ actor: 'user', action: 'agent.configure', target: id, details: next });
    this.rt.emit('agents.changed', { agentId: id });
    return next;
  }

  async setEnabled(id: string, enabled: boolean): Promise<InstalledAgent> {
    const r = this.row(id);
    if (enabled) await this.package(r.scope, id, r.active_version); // must be loadable and valid
    this.rt.db.run('UPDATE agents SET enabled = ?, status = ?, updated_at = ? WHERE id = ?', enabled ? 1 : 0, enabled ? 'enabled' : 'disabled', nowIso(), id);
    this.rt.audit.record({ actor: 'user', action: enabled ? 'agent.enable' : 'agent.disable', target: id });
    this.rt.emit('agents.changed', { agentId: id });
    return this.describe(this.row(id));
  }

  async uninstall(id: string): Promise<void> {
    const r = this.row(id);
    this.rt.db.run('DELETE FROM agents WHERE id = ?', id);
    if (r.scope === 'system') {
      for (const p of this.systemRows().filter((x) => x.id === id)) await rm(join(this.rt.paths.root, p.install_path), { recursive: true, force: true });
      this.rt.db.run('DELETE FROM system_agent_packages WHERE id = ?', id);
    }
    this.rt.audit.record({ actor: 'user', action: 'agent.uninstall', target: id, details: { scope: r.scope } });
    this.rt.emit('agents.changed', { agentId: id });
  }

  async rollback(id: string): Promise<InstalledAgent> {
    const r = this.row(id);
    if (!r.previous_version) throw new AppError('VALIDATION_FAILED', 'Нет предыдущей версии для отката.');
    await this.package(r.scope, id, r.previous_version);
    this.rt.db.run('UPDATE agents SET active_version = ?, previous_version = ?, updated_at = ? WHERE id = ?', r.previous_version, r.active_version, nowIso(), id);
    this.rt.audit.record({ actor: 'user', action: 'agent.rollback', target: id, details: { from: r.active_version, to: r.previous_version } });
    this.rt.emit('agents.changed', { agentId: id });
    return this.describe(this.row(id));
  }

  /** Imports a package into THIS system (stored under .aos/agents, so it travels with the system). */
  async importSystemPackage(zip: Uint8Array): Promise<{ id: string; version: string; warnings: string[] }> {
    const files = unzipPackage(zip);
    const { report, pkg } = validatePackageFiles(files);
    if (!pkg) throw new AppError('AGENT_PACKAGE_INVALID', report.errors.join('; '), { details: report });
    await this.storeSystemPackage(pkg.manifest.id, pkg.manifest.version, files, 'imported');
    return { id: pkg.manifest.id, version: pkg.manifest.version, warnings: report.warnings };
  }

  private async storeSystemPackage(id: string, version: string, files: Map<string, Buffer>, origin: 'imported' | 'created'): Promise<void> {
    if (this.catalogApp.builtinPackage(id)) throw new AppError('AGENT_PACKAGE_INVALID', `Идентификатор «${id}» занят встроенным агентом.`);
    if (this.systemRows().some((r) => r.id === id && r.version === version)) throw new AppError('AGENT_PACKAGE_INVALID', `Версия ${version} агента «${id}» уже есть в системе. Увеличьте версию.`);
    const rel = join('.aos', 'agents', id, version);
    await writePackage(join(this.rt.paths.root, rel), files);
    this.rt.db.run('INSERT INTO system_agent_packages(id, version, manifest, origin, install_path, installed_at) VALUES (?, ?, ?, ?, ?, ?)', id, version, files.get('manifest.json')!.toString('utf8'), origin, rel, nowIso());
    this.rt.audit.record({ actor: 'user', action: `agent.package.${origin}`, target: id, details: { version } });
    this.rt.emit('agents.changed', { agentId: id });
  }

  /** Creates (or versions) a custom agent from the editor. Editing produces a new version; the old one is kept for rollback. */
  async saveDefinition(def: AgentDefinitionInput): Promise<{ id: string; version: string; warnings: string[] }> {
    const existingVersions = this.systemRows().filter((r) => r.id === def.id).map((r) => r.version);
    const latest = existingVersions.sort(semver.rcompare)[0];
    const version = def.version && (!latest || semver.gt(def.version, latest)) ? def.version : latest ? semver.inc(latest, 'patch')! : (def.version ?? '1.0.0');
    const manifest: AgentManifest = {
      formatVersion: 1,
      id: def.id,
      name: def.name,
      version,
      description: def.description,
      author: 'Пользователь',
      category: def.category ?? 'custom',
      entry: 'instructions.md',
      platform: '>=0.1.0 <1.0.0',
      schemas: { input: 'schemas/input.schema.json', output: 'schemas/output.schema.json' },
      tools: 'tools.json',
      permissions: def.permissions,
      dependencies: [],
      model: { taskType: def.taskType, structuredOutput: 'preferred' },
      defaults: { temperature: 0.2, maxOutputTokens: 4000, maxToolRounds: 4, repairAttempts: 2 },
    };
    const files = new Map<string, Buffer>([
      ['manifest.json', Buffer.from(JSON.stringify(manifest, null, 2))],
      ['instructions.md', Buffer.from(def.instructions)],
      ['tools.json', Buffer.from(JSON.stringify({ tools: def.tools }, null, 2))],
      ['schemas/input.schema.json', Buffer.from(JSON.stringify(def.inputSchema, null, 2))],
      ['schemas/output.schema.json', Buffer.from(JSON.stringify(def.outputSchema, null, 2))],
      ['tests/test-cases.json', Buffer.from(JSON.stringify({ cases: def.tests ?? [] }, null, 2))],
      ['README.md', Buffer.from(def.readme ?? `# ${def.name}\n\n${def.description}\n`)],
    ]);
    const { report } = validatePackageFiles(files);
    if (!report.ok) throw new AppError('AGENT_PACKAGE_INVALID', report.errors.join('; '), { details: report });
    await this.storeSystemPackage(def.id, version, files, 'created');
    const installed = this.rt.db.get<AgentRow>('SELECT * FROM agents WHERE id = ?', def.id);
    if (installed && installed.scope === 'system') {
      this.rt.db.run('UPDATE agents SET previous_version = active_version, active_version = ?, updated_at = ? WHERE id = ?', version, nowIso(), def.id);
    }
    return { id: def.id, version, warnings: report.warnings };
  }

  async exportPackage(id: string, version?: string): Promise<{ fileName: string; bytes: Uint8Array }> {
    const r = this.rt.db.get<AgentRow>('SELECT * FROM agents WHERE id = ?', id);
    const scope: AgentScope = r?.scope ?? (this.catalogApp.builtinPackage(id) ? 'builtin' : this.systemRows().some((x) => x.id === id) ? 'system' : 'app');
    const pkg = await this.package(scope, id, version ?? r?.active_version);
    // Only package files — never grants, model configuration or keys of this system.
    return { fileName: `${pkg.manifest.id}-${pkg.manifest.version}.zip`, bytes: zipPackage(pkg.files, pkg.manifest.id) };
  }

  /** Resolves an enabled agent for execution (used by the workflow engine). */
  async forRun(id: string): Promise<{ pkg: AgentPackage; config: AgentConfig; version: string }> {
    const r = this.row(id);
    if (!r.enabled) throw new AppError('AGENT_NOT_ENABLED', `Агент «${id}» не включён в этой системе.`, { details: { agentId: id } });
    const pkg = await this.package(r.scope, id, r.active_version);
    return { pkg, config: this.config(id), version: r.active_version };
  }

  /** Runs the package's test cases (or a minimal input) and stores the outcome on the agent card. */
  async testRun(id: string, opts: { signal?: AbortSignal; scope?: Partial<RunScope> } = {}): Promise<{ ok: boolean; message: string; cases: { name: string; ok: boolean; problems: string[]; output?: unknown }[] }> {
    const r = this.row(id);
    const pkg = await this.package(r.scope, id, r.active_version);
    const cases = pkg.tests.length ? pkg.tests.slice(0, 3) : [{ name: 'минимальный вход', input: {} }];
    const results: { name: string; ok: boolean; problems: string[]; output?: unknown }[] = [];
    for (const c of cases) {
      const problems: string[] = [];
      let output: unknown;
      try {
        const res: AgentRunResult = await this.runtime.run(id, pkg, this.config(id), c.input, { scope: { sourceIds: [], docIds: [], extraSystems: [], allowWeb: false, ...opts.scope }, ...(opts.signal ? { signal: opts.signal } : {}) });
        output = res.output;
        for (const p of c.expect?.requiredPaths ?? []) if (getPath(res.output, p) === undefined) problems.push(`нет поля ${p}`);
        for (const [p, n] of Object.entries(c.expect?.minItems ?? {})) {
          const v = getPath(res.output, p);
          if (!Array.isArray(v) || v.length < n) problems.push(`${p}: ожидалось не меньше ${n} элементов`);
        }
      } catch (e) {
        problems.push(toAppError(e).message);
      }
      results.push({ name: c.name, ok: problems.length === 0, problems, ...(output !== undefined ? { output } : {}) });
    }
    const ok = results.every((x) => x.ok);
    const message = ok ? 'Все тестовые сценарии пройдены.' : `Не пройдено сценариев: ${results.filter((x) => !x.ok).length} из ${results.length}.`;
    this.rt.db.run('UPDATE agents SET last_test_at = ?, last_test_result = ? WHERE id = ?', nowIso(), JSON.stringify({ ok, message, cases: results.map(({ output: _o, ...rest }) => rest) }), id);
    this.rt.audit.record({ actor: 'user', action: 'agent.test', target: id, outcome: ok ? 'ok' : 'error', details: { message } });
    this.rt.emit('agents.changed', { agentId: id });
    return { ok, message, cases: results };
  }

  permissionCatalog() {
    return PERMISSIONS;
  }
}
