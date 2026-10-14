import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import semver from 'semver';
import { unzipSync } from 'fflate';
import type { AppServices } from '../systems/context.ts';
import type { SystemRuntime } from '../systems/runtime.ts';
import type { AgentCatalog } from '../agents/catalog.ts';
import type { RunScope } from '../agents/permissions.ts';
import type { SafeFetcher } from '../research/safe-fetch.ts';
import { services } from '../wiring.ts';
import { validator, formatErrors } from '../agents/schema.ts';
import { AppError, toAppError } from '../util/errors.ts';
import { parseJson } from '../util/json.ts';
import { nowIso } from '../util/time.ts';
import { SETTINGS } from '../settings/schema.ts';
import { APP_VERSION as APP_VERSION_FOR_EXTENSIONS } from '../version.ts';
import { validateExtension, type ExtensionKind, type ExtensionManifest, type ExtensionReport, type ExtPermissionId } from './manifest.ts';
import { sanitizeThemeCss, tokensCss, validateThemeTokens } from './theme.ts';
import { runPluginProcess, type PluginRunResult } from './host.ts';

export interface ExtGrant {
  permission: ExtPermissionId;
  domains?: string[];
  folders?: string[];
}

export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  previousVersion: string | null;
  kind: ExtensionKind;
  description: string;
  author: string | null;
  status: 'disabled' | 'enabled' | 'broken';
  statusDetail: string | null;
  requested: ExtensionManifest['permissions'];
  granted: ExtGrant[];
  contributes: { themes: { id: string; name: string; mode: string }[]; agents: string[]; templates: { id: string; name: string }[]; workflows: string[]; tools: { name: string; title: string; description: string }[] };
  installPath: string;
  installedAt: string;
  updatedAt: string;
}

interface ExtRow {
  id: string;
  version: string;
  previous_version: string | null;
  kind: ExtensionKind;
  name: string;
  manifest: string;
  install_path: string;
  file_hashes: string;
  status: 'disabled' | 'enabled' | 'broken';
  status_detail: string | null;
  granted: string;
  installed_at: string;
  updated_at: string;
}

const MAX_ZIP = 12 * 1024 * 1024;

/** Unpacks without trusting names: suspicious paths are kept so the validator can report them (nothing is written). */
export function unzipExtension(zip: Uint8Array): Map<string, Buffer> {
  if (zip.length > MAX_ZIP) throw new AppError('EXTENSION_INVALID', 'The extension archive is too large.');
  let total = 0;
  let count = 0;
  let raw: Record<string, Uint8Array>;
  try {
    raw = unzipSync(zip, {
      filter: (f) => {
        count++;
        total += f.originalSize;
        if (count > 400 || total > 8 * 1024 * 1024) throw new AppError('EXTENSION_INVALID', 'The extension archive contains too much data.');
        return !f.name.endsWith('/');
      },
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError('EXTENSION_INVALID', 'The file is not a zip archive of an extension.');
  }
  const names = Object.keys(raw);
  const prefixes = new Set(names.map((n) => (n.includes('/') ? n.slice(0, n.indexOf('/')) : '')));
  const strip = prefixes.size === 1 && !prefixes.has('') && !names.includes('manifest.json') ? `${[...prefixes][0]}/` : '';
  const out = new Map<string, Buffer>();
  for (const n of names) out.set(n.startsWith(strip) ? n.slice(strip.length) : n, Buffer.from(raw[n]!));
  return out;
}

function sha(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

function hostAllowed(host: string, domains: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * Extensions of the application (section 30). They live in `<dataDir>/extensions/<id>/<version>` — never inside the
 * application's own files — and reach the core only through controlled interfaces: agent roles through the agent
 * catalog (permissions are granted per system by the user, never by the role text), templates and workflows by an
 * explicit import into a system, themes through sanitized tokens/CSS, and plugin tools through a restricted process
 * whose every API call is checked against the CURRENT grants. Nothing is enabled or granted without the user.
 */
export class ExtensionService {
  constructor(
    private readonly app: AppServices,
    private readonly catalog: AgentCatalog,
    private readonly fetcher: SafeFetcher,
  ) {}

  root(): string {
    return join(this.app.paths.dataDir, 'extensions');
  }

  private rowOrNull(id: string): ExtRow | null {
    return this.app.registryDb.get<ExtRow>('SELECT * FROM extensions WHERE id = ?', id) ?? null;
  }

  private row(id: string): ExtRow {
    const r = this.rowOrNull(id);
    if (!r) throw new AppError('NOT_FOUND', `The extension "${id}" is not installed.`);
    return r;
  }

  private manifestOf(r: ExtRow): ExtensionManifest {
    return parseJson<ExtensionManifest>(r.manifest, null as unknown as ExtensionManifest);
  }

  private grantsOf(r: ExtRow): ExtGrant[] {
    return parseJson<ExtGrant[]>(r.granted, []);
  }

  private log(actor: string, action: string, outcome: 'ok' | 'denied' | 'error' | 'warning', message: string, resources: string[] = [], details?: unknown): void {
    this.app.security.record({ actor, action, outcome, resources, message, ...(details !== undefined ? { details } : {}) });
  }

  private info(r: ExtRow): ExtensionInfo {
    const m = this.manifestOf(r);
    const c = m.contributes ?? {};
    return {
      id: r.id,
      name: r.name,
      version: r.version,
      previousVersion: r.previous_version,
      kind: r.kind,
      description: m.description,
      author: m.author ?? null,
      status: r.status,
      statusDetail: r.status_detail,
      requested: m.permissions ?? [],
      granted: this.grantsOf(r),
      contributes: {
        themes: (c.themes ?? []).map((t) => ({ id: t.id, name: t.name, mode: t.mode })),
        agents: c.agents ?? [],
        templates: (c.templates ?? []).map((t) => ({ id: t.id, name: t.name })),
        workflows: c.workflows ?? [],
        tools: (c.tools ?? []).map((t) => ({ name: t.name, title: t.title, description: t.description })),
      },
      installPath: r.install_path,
      installedAt: r.installed_at,
      updatedAt: r.updated_at,
    };
  }

  list(): ExtensionInfo[] {
    return this.app.registryDb.all<ExtRow>('SELECT * FROM extensions ORDER BY name').map((r) => this.info(r));
  }

  get(id: string): ExtensionInfo {
    return this.info(this.row(id));
  }

  private knownAgents(): Set<string> {
    return new Set(this.catalog.builtinEntries().map((e) => e.id));
  }

  /** Step 1–4 of 30.5: structure, manifest, compatibility, permissions, executable code, plain-language risks. */
  inspect(zip: Uint8Array): { report: ExtensionReport; manifest: Pick<ExtensionManifest, 'id' | 'name' | 'version' | 'kind' | 'description' | 'author'> | null; update: { from: string } | null } {
    const files = unzipExtension(zip);
    const installed = new Set(this.app.registryDb.all<{ id: string }>('SELECT id FROM extensions').map((r) => r.id));
    const { report, manifest } = validateExtension(files, { appVersion: APP_VERSION_FOR_EXTENSIONS, knownAgents: this.knownAgents(), installedIds: installed });
    const existing = manifest ? this.rowOrNull(manifest.id) : null;
    return { report, manifest: manifest ? { id: manifest.id, name: manifest.name, version: manifest.version, kind: manifest.kind, description: manifest.description, ...(manifest.author ? { author: manifest.author } : {}) } : null, update: existing ? { from: existing.version } : null };
  }

  private normalizeGrants(manifest: ExtensionManifest, grants: ExtGrant[]): ExtGrant[] {
    const out: ExtGrant[] = [];
    for (const g of grants) {
      const req = (manifest.permissions ?? []).find((p) => p.permission === g.permission);
      if (!req) throw new AppError('VALIDATION_FAILED', `The extension does not request the permission "${g.permission}", so it cannot be granted.`);
      const entry: ExtGrant = { permission: g.permission };
      if (req.domains) {
        const domains = (g.domains ?? req.domains).map((d) => d.toLowerCase());
        for (const d of domains) if (!req.domains.map((x) => x.toLowerCase()).includes(d)) throw new AppError('VALIDATION_FAILED', `The extension did not request the domain "${d}".`);
        entry.domains = domains;
      }
      if (req.folders) {
        const folders = g.folders ?? req.folders;
        for (const f of folders) if (!req.folders.includes(f)) throw new AppError('VALIDATION_FAILED', `The extension did not request the folder "${f}".`);
        entry.folders = folders;
      }
      out.push(entry);
    }
    return out;
  }

  private async writeFiles(dir: string, files: Map<string, Buffer>): Promise<void> {
    const root = resolve(this.root());
    const target = resolve(dir);
    if (!target.startsWith(root + sep)) throw new AppError('PATH_OUTSIDE_SCOPE', 'The extension folder is outside the extensions directory.');
    if (existsSync(target)) throw new AppError('EXTENSION_INVALID', 'This extension version is already unpacked. Increase the package version.');
    for (const [rel, buf] of files) {
      const p = resolve(target, rel);
      if (!p.startsWith(target + sep)) throw new AppError('PATH_OUTSIDE_SCOPE', `The path "${rel}" leaves the extension folder.`);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, buf, { flag: 'wx', mode: 0o444 });
    }
  }

  /**
   * Installs (or updates) an extension. It is DISABLED unless the user asked to enable it right away; only the
   * permissions the user confirmed are granted; an update never inherits permissions the new version newly requests.
   */
  async install(zip: Uint8Array, opts: { grants?: ExtGrant[]; enable?: boolean; actor?: string } = {}): Promise<ExtensionInfo> {
    const actor = opts.actor ?? 'user';
    if (actor !== 'user') {
      this.log(actor, 'extension.install', 'denied', 'Only the user installs extensions.');
      throw new AppError('PERMISSION_DENIED', 'Only the user can install extensions.');
    }
    const files = unzipExtension(zip);
    const installed = new Set(this.app.registryDb.all<{ id: string }>('SELECT id FROM extensions').map((r) => r.id));
    const { report, manifest } = validateExtension(files, { appVersion: APP_VERSION_FOR_EXTENSIONS, knownAgents: this.knownAgents(), installedIds: installed });
    if (!manifest || !report.ok) {
      this.log(actor, 'extension.install', 'denied', `The extension was not installed: ${report.errors.slice(0, 3).join('; ')}`, [], { errors: report.errors });
      throw new AppError('EXTENSION_INVALID', report.errors.slice(0, 5).join(' '), { details: report });
    }
    const existing = this.rowOrNull(manifest.id);
    if (existing && !semver.gt(manifest.version, existing.version)) throw new AppError('EXTENSION_INVALID', `Version ${existing.version} is installed; an update is possible only to a newer version (package: ${manifest.version}).`);
    let grants = this.normalizeGrants(manifest, opts.grants ?? []);
    if (existing && !opts.grants) {
      // update: keep only previously granted permissions that are still requested, narrowed to the new request
      const prev = this.grantsOf(existing);
      grants = prev.flatMap((g) => {
        const req = manifest.permissions.find((p) => p.permission === g.permission);
        if (!req) return [];
        return [{ permission: g.permission, ...(g.domains ? { domains: g.domains.filter((d) => req.domains?.includes(d)) } : {}), ...(g.folders ? { folders: g.folders.filter((f) => req.folders?.includes(f)) } : {}) }];
      });
    }
    const dir = join(this.root(), manifest.id, manifest.version);
    await this.writeFiles(dir, files);
    const now = nowIso();
    const newlyRequested = manifest.permissions.filter((p) => !grants.some((g) => g.permission === p.permission)).map((p) => p.permission);
    if (existing) {
      if (existing.status === 'enabled') await this.deactivate(existing);
      this.app.registryDb.run('UPDATE extensions SET version = ?, previous_version = ?, kind = ?, name = ?, manifest = ?, install_path = ?, file_hashes = ?, status = ?, status_detail = ?, granted = ?, updated_at = ? WHERE id = ?', manifest.version, existing.version, manifest.kind, manifest.name, JSON.stringify(manifest), dir, JSON.stringify(report.fileHashes), 'disabled', newlyRequested.length ? `The new version requests permissions: ${newlyRequested.join(', ')}; only you can grant them.` : null, JSON.stringify(grants), now, manifest.id);
      this.log(actor, 'extension.update', 'ok', `The extension "${manifest.name}" was updated ${existing.version} → ${manifest.version}`, [manifest.id], { granted: grants, notGranted: newlyRequested });
      if (existing.status === 'enabled' || opts.enable) await this.enable(manifest.id, actor);
    } else {
      this.app.registryDb.run('INSERT INTO extensions(id, version, previous_version, kind, name, manifest, install_path, file_hashes, status, status_detail, granted, installed_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)', manifest.id, manifest.version, manifest.kind, manifest.name, JSON.stringify(manifest), dir, JSON.stringify(report.fileHashes), 'disabled', JSON.stringify(grants), now, now);
      this.log(actor, 'extension.install', 'ok', `Installed the extension "${manifest.name}" ${manifest.version} (${manifest.kind}); disabled until the user enables it`, [manifest.id], { granted: grants, notGranted: newlyRequested, findings: report.findings });
      if (opts.enable) await this.enable(manifest.id, actor);
    }
    this.app.events.emit('extensions.changed', { id: manifest.id });
    return this.get(manifest.id);
  }

  /** Files on disk must match the hashes recorded at installation (tampering ⇒ the extension is blocked). */
  async verifyIntegrity(id: string): Promise<{ ok: boolean; changed: string[]; missing: string[]; extra: string[] }> {
    const r = this.row(id);
    const expected = parseJson<Record<string, string>>(r.file_hashes, {});
    const changed: string[] = [];
    const missing: string[] = [];
    const extra: string[] = [];
    const seen = new Set<string>();
    const walk = async (d: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(d, e.name);
        const rel = relative(r.install_path, p).split(sep).join('/');
        if (e.isSymbolicLink()) extra.push(rel);
        else if (e.isDirectory()) await walk(p);
        else if (e.isFile()) {
          seen.add(rel);
          if (!expected[rel]) extra.push(rel);
          else if ((await stat(p)).size > 3 * 1024 * 1024 || sha(await readFile(p)) !== expected[rel]) changed.push(rel);
        }
      }
    };
    await walk(r.install_path);
    for (const k of Object.keys(expected)) if (!seen.has(k)) missing.push(k);
    const ok = !changed.length && !missing.length && !extra.length;
    if (!ok && r.status !== 'broken') {
      await this.deactivate(r);
      this.app.registryDb.run("UPDATE extensions SET status = 'broken', status_detail = ?, updated_at = ? WHERE id = ?", `Files changed after installation: ${[...changed, ...missing.map((m) => `${m} (deleted)`), ...extra.map((x) => `${x} (added)`)].slice(0, 10).join(', ')}`, nowIso(), id);
      this.log('system', 'extension.integrity', 'denied', `The extension "${r.name}" was blocked: its files do not match the ones verified at installation`, [id], { changed, missing, extra });
    }
    return { ok, changed, missing, extra };
  }

  /** Makes contributions available (agent roles to the catalog). Nothing is granted to agents here. */
  private async activate(r: ExtRow): Promise<void> {
    const m = this.manifestOf(r);
    if (r.kind !== 'content') return;
    const builtin = this.knownAgents();
    for (const dir of m.contributes.agents ?? []) {
      const path = join(r.install_path, dir.replace(/\/+$/, ''));
      const manifest = parseJson<{ id: string; version: string }>((await readFile(join(path, 'manifest.json'), 'utf8').catch(() => '')) || null, null as never);
      if (!manifest || builtin.has(manifest.id)) continue;
      const clash = this.app.registryDb.get('SELECT 1 AS x FROM app_agent_packages WHERE id = ? AND version = ?', manifest.id, manifest.version);
      if (clash) continue;
      this.app.registryDb.run('INSERT OR REPLACE INTO extension_agent_packages(extension_id, id, version, install_path, installed_at) VALUES (?, ?, ?, ?, ?)', r.id, manifest.id, manifest.version, path, nowIso());
    }
  }

  private async deactivate(r: ExtRow): Promise<void> {
    this.app.registryDb.run('DELETE FROM extension_agent_packages WHERE extension_id = ?', r.id);
    const theme = this.app.appSettings.get<string>('ui.extensionTheme');
    if (theme.startsWith(`${r.id}:`)) this.app.appSettings.reset('ui.extensionTheme');
  }

  async enable(id: string, actor = 'user'): Promise<ExtensionInfo> {
    if (actor !== 'user') {
      this.log(actor, 'extension.enable', 'denied', 'Only the user can enable extensions.', [id]);
      throw new AppError('PERMISSION_DENIED', 'Only the user can enable extensions.');
    }
    const r = this.row(id);
    const integrity = await this.verifyIntegrity(id);
    if (!integrity.ok) throw new AppError('EXTENSION_BROKEN', undefined, { details: integrity });
    await this.activate(r);
    // permissions the package requests but the user has not granted stay visible on the card
    const notGranted = (this.manifestOf(r).permissions ?? []).map((p) => p.permission).filter((p) => !this.grantsOf(r).some((g) => g.permission === p));
    this.app.registryDb.run("UPDATE extensions SET status = 'enabled', status_detail = ?, updated_at = ? WHERE id = ?", notGranted.length ? `Permissions not granted: ${notGranted.join(', ')}; the matching operations will be denied.` : null, nowIso(), id);
    this.log(actor, 'extension.enable', 'ok', `The extension "${r.name}" was enabled`, [id]);
    return this.get(id);
  }

  async disable(id: string, actor = 'user'): Promise<ExtensionInfo> {
    const r = this.row(id);
    await this.deactivate(r);
    this.app.registryDb.run("UPDATE extensions SET status = CASE WHEN status = 'broken' THEN 'broken' ELSE 'disabled' END, updated_at = ? WHERE id = ?", nowIso(), id);
    this.log(actor, 'extension.disable', 'ok', `The extension "${r.name}" was disabled`, [id]);
    return this.get(id);
  }

  /**
   * Removes the extension's own files and registration only. Documents and workflows the user imported from it stay
   * (they are user data now); other extensions and the core are not touched.
   */
  async uninstall(id: string, actor = 'user'): Promise<void> {
    const r = this.row(id);
    await this.deactivate(r);
    const root = resolve(this.root());
    const dir = resolve(join(this.root(), id));
    if (!dir.startsWith(root + sep)) throw new AppError('PATH_OUTSIDE_SCOPE');
    await rm(dir, { recursive: true, force: true });
    this.app.registryDb.run('DELETE FROM extensions WHERE id = ?', id);
    this.log(actor, 'extension.uninstall', 'ok', `The extension "${r.name}" was removed`, [id]);
  }

  /** "Revoke permissions": takes effect for the very next API call of a running plugin. */
  setGrants(id: string, grants: ExtGrant[], actor = 'user'): ExtensionInfo {
    if (actor !== 'user') {
      this.log(actor, 'extension.grants', 'denied', 'An attempt to change extension permissions by someone other than the user.', [id]);
      throw new AppError('PERMISSION_DENIED', 'Only the user changes extension permissions.');
    }
    const r = this.row(id);
    const normalized = this.normalizeGrants(this.manifestOf(r), grants);
    const before = this.grantsOf(r).map((g) => g.permission);
    this.app.registryDb.run('UPDATE extensions SET granted = ?, updated_at = ? WHERE id = ?', JSON.stringify(normalized), nowIso(), id);
    const revoked = before.filter((p) => !normalized.some((g) => g.permission === p));
    this.log(actor, 'extension.grants', 'ok', `Permissions of the extension "${r.name}": ${normalized.map((g) => g.permission).join(', ') || 'none'}${revoked.length ? `; revoked: ${revoked.join(', ')}` : ''}`, [id], { granted: normalized, revoked });
    return this.get(id);
  }

  // ------------------------------------------------------------------ themes

  themes(): { key: string; extensionId: string; name: string; mode: string }[] {
    return this.app.registryDb
      .all<ExtRow>("SELECT * FROM extensions WHERE kind = 'theme' AND status = 'enabled' ORDER BY name")
      .flatMap((r) => (this.manifestOf(r).contributes.themes ?? []).map((t) => ({ key: `${r.id}:${t.id}`, extensionId: r.id, name: t.name, mode: t.mode })));
  }

  private themeScope(key: string): string {
    return key.replace(/[^a-z0-9-]/g, '_');
  }

  /** CSS of an enabled theme: tokens + sanitized rules, re-checked at serve time (defence in depth). */
  async themeCss(key: string): Promise<string> {
    const [extId, themeId] = key.split(':');
    const r = this.row(extId ?? '');
    if (r.kind !== 'theme' || r.status !== 'enabled') throw new AppError('EXTENSION_DISABLED');
    const t = (this.manifestOf(r).contributes.themes ?? []).find((x) => x.id === themeId);
    if (!t) throw new AppError('NOT_FOUND', 'Theme not found.');
    const integrity = await this.verifyIntegrity(r.id);
    if (!integrity.ok) throw new AppError('EXTENSION_BROKEN');
    const scope = this.themeScope(key);
    const parts = [tokensCss(scope, validateThemeTokens(t.tokens ?? {}).tokens)];
    if (t.css) parts.push(sanitizeThemeCss(await readFile(join(r.install_path, t.css), 'utf8'), scope).css);
    return parts.join('\n');
  }

  activeTheme(): { key: string; scope: string | null } {
    const key = this.app.appSettings.get<string>('ui.extensionTheme');
    if (key === 'default' || !this.themes().some((t) => t.key === key)) return { key: 'default', scope: null };
    return { key, scope: this.themeScope(key) };
  }

  setTheme(key: string, actor = 'user'): { key: string; scope: string | null } {
    if (key !== 'default' && !this.themes().some((t) => t.key === key)) throw new AppError('NOT_FOUND', 'The theme was not found among the enabled extensions.');
    if (key === 'default') this.app.appSettings.reset('ui.extensionTheme');
    else this.app.appSettings.set('ui.extensionTheme', key);
    this.log(actor, 'theme.set', 'ok', `Theme: ${key === 'default' ? 'standard' : key}`);
    return this.activeTheme();
  }

  /** "Return to the standard theme". */
  resetTheme(actor = 'user'): { key: string; scope: string | null } {
    return this.setTheme('default', actor);
  }

  /** "Restore application settings": every application-level setting returns to its default value. */
  resetAppSettings(actor = 'user'): { reset: string[] } {
    const reset: string[] = [];
    for (const d of SETTINGS) {
      if (d.level === 'system') continue;
      if (this.app.appSettings.stored(d.key).found) {
        this.app.appSettings.reset(d.key);
        reset.push(d.key);
      }
    }
    this.log(actor, 'settings.reset', 'ok', `The application settings were restored to their defaults (${reset.length})`, reset);
    return { reset };
  }

  // ------------------------------------------------------------------ templates & workflows (explicit import into a system)

  private enabledContent(id: string): ExtRow {
    const r = this.row(id);
    if (r.status !== 'enabled') throw new AppError('EXTENSION_DISABLED');
    if (r.kind !== 'content') throw new AppError('VALIDATION_FAILED', 'This extension contains no templates or workflows.');
    return r;
  }

  async importTemplate(rt: SystemRuntime, extId: string, templateId: string, actor = 'user'): Promise<{ docId: string; path: string }> {
    const r = this.enabledContent(extId);
    if (!(await this.verifyIntegrity(extId)).ok) throw new AppError('EXTENSION_BROKEN');
    const t = (this.manifestOf(r).contributes.templates ?? []).find((x) => x.id === templateId);
    if (!t) throw new AppError('NOT_FOUND', 'Template not found.');
    const content = await readFile(join(r.install_path, t.file), 'utf8');
    const d = await services(rt).docs.create({ title: t.name, folder: t.folder && /^[\p{L}\p{N} _.-]{1,60}$/u.test(t.folder) ? t.folder : 'Templates', content, properties: { source_extension: `${r.id}@${r.version}` }, actor });
    this.log(actor, 'extension.template.import', 'ok', `The template "${t.name}" from "${r.name}" was added to the system`, [rt.systemId, d.relPath]);
    return { docId: d.id, path: d.relPath };
  }

  async importWorkflow(rt: SystemRuntime, extId: string, file: string, actor = 'user'): Promise<{ workflowId: string; errors: string[] }> {
    const r = this.enabledContent(extId);
    if (!(await this.verifyIntegrity(extId)).ok) throw new AppError('EXTENSION_BROKEN');
    if (!(this.manifestOf(r).contributes.workflows ?? []).includes(file)) throw new AppError('NOT_FOUND', 'The workflow was not found in the extension.');
    const def = JSON.parse(await readFile(join(r.install_path, file), 'utf8')) as Record<string, unknown>;
    // saved as an ordinary user workflow of THIS system: the engine validates it and runs it with all its limits
    const res = services(rt).workflows.save(def, actor);
    this.log(actor, 'extension.workflow.import', 'ok', `The workflow "${res.definition.name}" from "${r.name}" was added to the system`, [rt.systemId, res.definition.id]);
    return { workflowId: res.definition.id, errors: res.check.errors.map((e) => e.message) };
  }

  // ------------------------------------------------------------------ plugin tools

  /**
   * Runs a plugin tool. Permissions are checked right before every sensitive operation (30.8) — a revoked grant
   * blocks the next call even of a plugin that is already running. Denials go to the security journal.
   */
  async runTool(extId: string, toolName: string, input: unknown, ctx: { rt: SystemRuntime | null; scope: Pick<RunScope, 'sourceIds' | 'docIds' | 'allowWeb'> | null; actor: string; signal?: AbortSignal }): Promise<PluginRunResult & { logs: string[] }> {
    const r = this.row(extId);
    if (r.status === 'broken') throw new AppError('EXTENSION_BROKEN');
    if (r.status !== 'enabled') throw new AppError('EXTENSION_DISABLED');
    if (r.kind !== 'tools') throw new AppError('VALIDATION_FAILED', 'The extension contains no tools.');
    const integrity = await this.verifyIntegrity(extId);
    if (!integrity.ok) throw new AppError('EXTENSION_BROKEN', undefined, { details: integrity });
    const tool = (this.manifestOf(r).contributes.tools ?? []).find((t) => t.name === toolName);
    if (!tool) throw new AppError('NOT_FOUND', `The tool "${toolName}" was not found in the extension.`);
    const check = validator(tool.inputSchema);
    if (!check(input)) throw new AppError('VALIDATION_FAILED', `Tool input: ${formatErrors(check.errors).join('; ')}`);
    const logs: string[] = [];
    const deny = (method: string, why: string): never => {
      this.log(`extension:${extId}`, 'extension.denied', 'denied', `The extension "${r.name}" was denied (${method}): ${why}`, [extId, method]);
      if (ctx.rt) ctx.rt.security.record({ actor: `extension:${extId}`, action: 'extension.denied', outcome: 'denied', resources: [extId, method], message: `The extension "${r.name}" was denied (${method}): ${why}` });
      throw new AppError('PERMISSION_DENIED', `Denied: ${why}.`);
    };
    const grant = (p: ExtPermissionId): ExtGrant | null => {
      const cur = this.rowOrNull(extId);
      if (!cur || cur.status !== 'enabled') return null;
      return this.grantsOf(cur).find((g) => g.permission === p) ?? null;
    };
    const readable = (rt: SystemRuntime, sourceId: string): boolean => {
      if (!ctx.scope || !ctx.scope.sourceIds.length) return true;
      return [...ctx.scope.sourceIds, rt.primaryVaultId()].includes(sourceId);
    };
    const handle = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
      switch (method) {
        case 'log':
          if (logs.length < 100) logs.push(String(params.message ?? '').slice(0, 500));
          return null;
        case 'documents.read': {
          if (!grant('documents.read')) return deny(method, 'the "Read documents" permission is not granted or was revoked');
          if (!ctx.rt) return deny(method, 'the tool runs outside a system');
          const docId = String(params.docId ?? '');
          const row = ctx.rt.db.get<{ source_id: string }>('SELECT source_id FROM documents WHERE id = ?', docId);
          if (!row) throw new AppError('NOT_FOUND', 'Document not found.');
          if (!readable(ctx.rt, row.source_id)) return deny(method, 'the document is outside the run scope');
          const d = await services(ctx.rt).docs.get(docId);
          return { docId: d.id, title: d.title, path: d.relPath, content: d.content.slice(0, 50_000) };
        }
        case 'search': {
          if (!grant('search.use')) return deny(method, 'the "Search the system" permission is not granted or was revoked');
          if (!ctx.rt) return deny(method, 'the tool runs outside a system');
          const rt = ctx.rt;
          const res = services(rt).search.search(String(params.query ?? '').slice(0, 300), { limit: Math.min(Number(params.limit) || 10, 30) });
          return res.hits.filter((h) => readable(rt, h.sourceId)).map((h) => ({ docId: h.docId, title: h.title, path: h.relPath, snippet: (h.snippet ?? '').replace(/\u0002|\u0003/g, '') }));
        }
        case 'network.fetch': {
          const g = grant('network.fetch');
          if (!g) return deny(method, 'the "Download from the network" permission is not granted or was revoked');
          if (ctx.scope && !ctx.scope.allowWeb) return deny(method, 'web access is not allowed for this run');
          let url: URL;
          try {
            url = new URL(String(params.url ?? ''));
          } catch {
            throw new AppError('VALIDATION_FAILED', 'Invalid address.');
          }
          if (!hostAllowed(url.hostname, g.domains ?? [])) return deny(method, `the domain ${url.hostname} is not among the allowed ones (${(g.domains ?? []).join(', ')})`);
          const page = await this.fetcher.fetch(url.href, { maxBytes: 2 * 1024 * 1024, timeoutMs: 20_000, ...(ctx.signal ? { signal: ctx.signal } : {}) });
          if (!hostAllowed(new URL(page.finalUrl).hostname, g.domains ?? [])) return deny(method, `a redirect to a domain that is not allowed: ${new URL(page.finalUrl).hostname}`);
          return { url: page.url, finalUrl: page.finalUrl, status: page.status, contentType: page.contentType, text: page.body.toString('utf8').slice(0, 200_000), truncated: page.truncated };
        }
        case 'documents.create': {
          const g = grant('documents.create');
          if (!g) return deny(method, 'the "Create documents" permission is not granted or was revoked');
          if (!ctx.rt) return deny(method, 'the tool runs outside a system');
          const folder = String(params.folder ?? '').replace(/^\/+|\/+$/g, '');
          if (!(g.folders ?? []).some((f) => folder === f || folder.startsWith(`${f}/`))) return deny(method, `the folder "${folder || '/'}" is outside the allowed ones (${(g.folders ?? []).join(', ')})`);
          const d = await services(ctx.rt).docs.create({ title: String(params.title ?? 'Document').slice(0, 200), folder, content: String(params.content ?? '').slice(0, 500_000), properties: { source_extension: `${r.id}@${r.version}` }, actor: `extension:${extId}` });
          return { docId: d.id, path: d.relPath };
        }
        default:
          // there is no API to change permissions, settings, agents, files or secrets: anything else is refused
          return deny(method, 'there is no such API: an extension cannot change permissions, settings, agents or files, or read secrets');
      }
    };
    const res = await runPluginProcess({ extDir: r.install_path, entry: join(r.install_path, tool.entry), input, timeoutMs: (tool.timeoutSec ?? 30) * 1000, handle, ...(ctx.signal ? { signal: ctx.signal } : {}), mode: this.app.appSettings.get<'auto' | 'limited'>('security.sandbox') });
    this.log(ctx.actor, 'extension.tool', res.ok ? 'ok' : 'error', `Tool "${toolName}" of the extension "${r.name}": ${res.ok ? 'done' : res.error?.message ?? 'error'} (isolation: ${res.isolation.level === 'isolated' ? 'OS sandbox' : 'runtime restrictions'})`, [extId, toolName], { calls: res.calls });
    return { ...res, logs };
  }

  /** For the guide/UI: where extension files live and that they never mix with the application's own files. */
  layout(): { root: string; appFiles: string } {
    return { root: this.root(), appFiles: 'extensions do not change the application files' };
  }
}

export function appExtensions(app: AppServices): ExtensionService {
  const v = app.ext.extensions as ExtensionService | undefined;
  if (!v) throw new AppError('INTERNAL', 'The extension service is not initialized.');
  return v;
}

export { toAppError };
