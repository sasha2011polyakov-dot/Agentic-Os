import { existsSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/db.ts';
import { AppError } from '../util/errors.ts';
import { nowIso } from '../util/time.ts';
import { readPackageDir, unzipPackage, validatePackageFiles, type AgentPackage, type ValidationReport } from './package.ts';

export type AgentScope = 'builtin' | 'app' | 'system';

export interface CatalogEntry {
  id: string;
  version: string;
  scope: AgentScope;
  name: string;
  description: string;
  category: string;
  author: string;
  taskType: string;
  tools: string[];
  permissions: { permission: string; reason: string }[];
  path: string;
  report: ValidationReport;
}

function builtinDirCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    process.env.AOS_BUILTIN_AGENTS_DIR ?? '',
    join(here, '..', '..', 'agents-builtin'), // source tree: packages/core/src/agents → packages/core/agents-builtin
    join(here, 'agents-builtin'), // bundled: dist/agents-builtin next to the bundle
    join(here, '..', 'agents-builtin'),
  ].filter(Boolean);
}

export function builtinAgentsDir(): string {
  for (const c of builtinDirCandidates()) if (existsSync(join(c, 'coordinator', 'manifest.json'))) return c;
  throw new AppError('INTERNAL', 'The built-in agents folder (agents-builtin) was not found.');
}

export function toEntry(pkg: AgentPackage, scope: AgentScope, path: string, report: ValidationReport): CatalogEntry {
  return {
    id: pkg.manifest.id,
    version: pkg.manifest.version,
    scope,
    name: pkg.manifest.name,
    description: pkg.manifest.description,
    category: pkg.manifest.category,
    author: pkg.manifest.author,
    taskType: pkg.manifest.model.taskType,
    tools: pkg.tools,
    permissions: pkg.manifest.permissions.map((p) => ({ permission: p.permission, reason: p.reason })),
    path,
    report,
  };
}

/**
 * Application-level agent packages: built-in (shipped with the app, read-only) and shared imported ones
 * (data dir). Systems decide individually whether to install/enable them and with which permissions.
 */
export class AgentCatalog {
  private builtin = new Map<string, { pkg: AgentPackage; path: string; report: ValidationReport }>();
  private loaded = false;

  constructor(
    private readonly registryDb: Db,
    private readonly sharedDir: string,
  ) {}

  async load(): Promise<void> {
    const dir = builtinAgentsDir();
    const map = new Map<string, { pkg: AgentPackage; path: string; report: ValidationReport }>();
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const path = join(dir, e.name);
      const { report, pkg } = validatePackageFiles(await readPackageDir(path));
      if (!pkg) throw new AppError('AGENT_PACKAGE_INVALID', `The built-in agent ${e.name} is damaged: ${report.errors.join('; ')}`);
      map.set(pkg.manifest.id, { pkg, path, report });
    }
    this.builtin = map;
    this.loaded = true;
  }

  private ensure(): void {
    if (!this.loaded) throw new AppError('INTERNAL', 'The agent catalog is not loaded.');
  }

  builtinEntries(): CatalogEntry[] {
    this.ensure();
    return [...this.builtin.values()].map((b) => toEntry(b.pkg, 'builtin', b.path, b.report));
  }

  builtinPackage(id: string): AgentPackage | null {
    this.ensure();
    return this.builtin.get(id)?.pkg ?? null;
  }

  sharedRows(): { id: string; version: string; install_path: string }[] {
    // imported/created shared packages + agent roles of enabled extensions (they never override built-ins)
    return this.registryDb.all('SELECT id, version, install_path, installed_at FROM app_agent_packages UNION ALL SELECT id, version, install_path, installed_at FROM extension_agent_packages ORDER BY id, installed_at DESC');
  }

  async sharedEntries(): Promise<CatalogEntry[]> {
    const out: CatalogEntry[] = [];
    for (const r of this.sharedRows()) {
      try {
        const { report, pkg } = validatePackageFiles(await readPackageDir(r.install_path));
        if (pkg) out.push(toEntry(pkg, 'app', r.install_path, report));
      } catch {
        // missing folder: skip (shown as broken in the system view)
      }
    }
    return out;
  }

  async sharedPackage(id: string, version?: string): Promise<AgentPackage | null> {
    const row = this.sharedRows().find((r) => r.id === id && (!version || r.version === version));
    if (!row) return null;
    const { pkg } = validatePackageFiles(await readPackageDir(row.install_path));
    return pkg;
  }

  /** Imports a package zip as a shared (application-level) agent. Existing versions are never overwritten. */
  async importShared(zip: Uint8Array): Promise<{ entry: CatalogEntry; report: ValidationReport }> {
    const files = unzipPackage(zip);
    const { report, pkg } = validatePackageFiles(files);
    if (!pkg) throw new AppError('AGENT_PACKAGE_INVALID', report.errors.join('; '), { details: report });
    if (this.builtin.has(pkg.manifest.id)) throw new AppError('AGENT_PACKAGE_INVALID', `The identifier "${pkg.manifest.id}" is taken by a built-in agent.`);
    if (this.sharedRows().some((r) => r.id === pkg.manifest.id && r.version === pkg.manifest.version)) {
      throw new AppError('AGENT_PACKAGE_INVALID', `Version ${pkg.manifest.version} of the agent "${pkg.manifest.id}" is already installed. Increase the package version.`);
    }
    const dir = join(this.sharedDir, pkg.manifest.id, pkg.manifest.version);
    await writePackage(dir, files);
    this.registryDb.run('INSERT INTO app_agent_packages(id, version, manifest, origin, install_path, installed_at) VALUES (?, ?, ?, ?, ?, ?)', pkg.manifest.id, pkg.manifest.version, JSON.stringify(pkg.manifest), 'imported', dir, nowIso());
    return { entry: toEntry(pkg, 'app', dir, report), report };
  }

  async removeShared(id: string, version: string): Promise<void> {
    const row = this.registryDb.get<{ install_path: string }>('SELECT install_path FROM app_agent_packages WHERE id = ? AND version = ?', id, version);
    if (!row) throw new AppError('NOT_FOUND', 'Package not found (extension roles are removed together with the extension).');
    await rm(row.install_path, { recursive: true, force: true });
    this.registryDb.run('DELETE FROM app_agent_packages WHERE id = ? AND version = ?', id, version);
  }
}

export async function writePackage(dir: string, files: Map<string, Buffer>): Promise<void> {
  if (existsSync(dir)) throw new AppError('AGENT_PACKAGE_INVALID', 'The package version folder already exists.');
  for (const [rel, buf] of files) {
    const p = join(dir, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, buf);
  }
}
