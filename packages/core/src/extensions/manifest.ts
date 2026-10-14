import semver from 'semver';
import { createHash } from 'node:crypto';
import { validatePackageFiles } from '../agents/package.ts';
import { checkDefinition } from '../workflows/definition.ts';
import { validateThemeTokens, sanitizeThemeCss } from './theme.ts';

/**
 * Extension packages (section 30). Every external package is UNTRUSTED: it is validated structurally, its requested
 * permissions are compared with what the platform supports, executable code is detected, and the user sees a plain
 * description of capabilities and risks before anything is installed. Kinds are deliberately separated: a theme can
 * never carry code or permissions (30.6); content (agent roles, templates, workflows) carries no code; only "tools"
 * plugins contain code and they run in a restricted child process through a controlled API.
 */
export type ExtensionKind = 'theme' | 'content' | 'tools';

export type ExtPermissionId = 'documents.read' | 'search.use' | 'network.fetch' | 'documents.create';

export const EXT_PERMISSIONS: { id: ExtPermissionId; label: string; description: string; risk: 'low' | 'medium' | 'high'; needs?: 'domains' | 'folders' }[] = [
  { id: 'documents.read', label: 'Read documents', description: 'The plugin can read documents of the system, only within the run scope chosen by the user.', risk: 'medium' },
  { id: 'search.use', label: 'Search the system', description: 'Full-text search in the documents of the system within the run scope.', risk: 'low' },
  { id: 'network.fetch', label: 'Download from the network', description: 'Download public pages only from the listed domains (local and internal addresses are blocked).', risk: 'medium', needs: 'domains' },
  { id: 'documents.create', label: 'Create documents', description: 'Create new documents only in the listed vault folders.', risk: 'medium', needs: 'folders' },
];
const EXT_PERMISSION_IDS = new Set(EXT_PERMISSIONS.map((p) => p.id));

/** Privileges the platform never gives to extensions (30.8): such a package is not installed. */
const DANGEROUS: Record<string, string> = {
  'files.read': 'direct reading of disk files',
  'files.write': 'writing files to disk',
  'commands.run': 'running commands and programs',
  'secrets.read': 'reading keys and secrets',
  'settings.write': 'changing settings and security policies',
  'permissions.manage': 'granting permissions',
  'agents.manage': 'installing and enabling agents',
  'projects.write': 'changing project files',
  'network.any': 'unrestricted network access',
  'core.modify': 'changing the application core',
  'systems.write': 'changing other knowledge systems',
};

export interface ExtensionManifest {
  formatVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  homepage?: string;
  kind: ExtensionKind;
  platform: string;
  contributes: {
    themes?: { id: string; name: string; mode: 'light' | 'dark'; tokens: Record<string, string>; css?: string }[];
    agents?: string[];
    templates?: { id: string; name: string; file: string; folder?: string }[];
    workflows?: string[];
    tools?: { name: string; title: string; description: string; entry: string; inputSchema: Record<string, unknown>; timeoutSec?: number }[];
  };
  permissions: { permission: string; reason: string; domains?: string[]; folders?: string[] }[];
  signature?: string;
}

export interface ExtFinding {
  severity: 'high' | 'medium' | 'low';
  text: string;
  where: string;
}

export interface ExtensionReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  findings: ExtFinding[];
  /** What the extension will be able to do, in plain words (shown before install). */
  capabilities: string[];
  executableCode: string[];
  permissions: { permission: string; label: string; reason: string; risk: string; scope: string; supported: boolean }[];
  fileHashes: Record<string, string>;
  totalBytes: number;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}(\.[a-z0-9][a-z0-9-]{0,40}){0,3}$/;
const RESERVED = [/^aos(\.|$)/, /^agentic-os/, /^core(\.|$)/, /^builtin(\.|$)/, /^system(\.|$)/, /^app(\.|$)/];
const MAX_FILES = 300;
const MAX_TOTAL = 5 * 1024 * 1024;
const MAX_FILE = 2 * 1024 * 1024;
const CODE_EXT = /\.(m?js|cjs|ts|tsx|jsx|wasm|node|so|dylib|dll|exe|bat|cmd|com|ps1|sh|bash|zsh|py|rb|pl|php|jar|class|bin|app|msi|deb|rpm|html?|svg|xhtml)$/i;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const FOLDER_RE = /^[\p{L}\p{N} _.-]{1,60}(\/[\p{L}\p{N} _.-]{1,60}){0,4}$/u;

/** Files allowed per kind. Everything else is rejected — the list is the whole supported integration surface. */
function allowedFile(kind: ExtensionKind, path: string): boolean {
  if (/^(manifest\.json|README\.md|LICENSE(\.md|\.txt)?|CHANGELOG\.md)$/.test(path)) return true;
  switch (kind) {
    case 'theme':
      return /^themes\/[A-Za-z0-9_.-]+\.css$/.test(path);
    case 'content':
      return /^agents\/[a-z0-9][a-z0-9-]*\/(manifest\.json|instructions\.md|tools\.json|README\.md|schemas\/[A-Za-z0-9_.-]+\.json|tests\/[A-Za-z0-9_.-]+\.json)$/.test(path) || /^templates\/[\p{L}\p{N} _.-]+\.md$/u.test(path) || /^workflows\/[A-Za-z0-9_.-]+\.json$/.test(path);
    case 'tools':
      return /^tools\/[A-Za-z0-9_./-]+\.(mjs|json)$/.test(path);
  }
}

export function normalizeExtPath(p: string): string | null {
  if (!p || p.includes('\\') || p.includes('\0') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  const parts = p.split('/');
  if (parts.length > 8 || parts.some((x) => !x || x === '.' || x === '..' || x.startsWith('.'))) return null;
  return parts.join('/');
}

function sha256(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

/** Static scan of plugin code: informational findings shown to the user; enforcement is the runtime's job. */
const CODE_PATTERNS: { re: RegExp; severity: ExtFinding['severity']; text: string }[] = [
  { re: /child_process|\bspawn\(|\bexecSync\(|\bexecFile\(/, severity: 'high', text: 'starting processes (will be blocked)' },
  { re: /['"]node:(net|http|https|http2|tls|dgram|dns)['"]|['"](net|http|https|http2|tls|dgram|dns)['"]/, severity: 'high', text: 'direct network access bypassing the API (will be blocked)' },
  { re: /process\.binding|internalBinding|getBuiltinModule/, severity: 'high', text: 'access to internal runtime modules (will be blocked)' },
  { re: /\beval\s*\(|new\s+Function\s*\(/, severity: 'medium', text: 'dynamic code execution' },
  { re: /writeFile|appendFile|createWriteStream|\bunlink|\brmSync|\brm\(|renameSync|mkdirSync/, severity: 'high', text: 'writing or deleting files (will be blocked)' },
  { re: /process\.env/, severity: 'medium', text: 'reading environment variables (secrets are not passed into the plugin environment)' },
  { re: /['"]node:(module|vm|worker_threads|cluster|inspector|v8|sqlite)['"]/, severity: 'high', text: 'internal runtime modules (will be blocked)' },
  { re: /WebAssembly/, severity: 'medium', text: 'WebAssembly' },
  { re: /fetch\s*\(|WebSocket|XMLHttpRequest/, severity: 'high', text: 'network requests bypassing the API (will be blocked)' },
];

function scanCode(path: string, text: string): ExtFinding[] {
  const out: ExtFinding[] = [];
  for (const p of CODE_PATTERNS) if (p.re.test(text)) out.push({ severity: p.severity, text: p.text, where: path });
  return out;
}

function parseJson(files: Map<string, Buffer>, path: string, errors: string[]): unknown {
  const b = files.get(path);
  if (!b) {
    errors.push(`Missing file ${path}.`);
    return undefined;
  }
  try {
    return JSON.parse(b.toString('utf8'));
  } catch {
    errors.push(`${path}: invalid JSON.`);
    return undefined;
  }
}

/** Full validation of an extension package (files already unpacked, nothing written anywhere). */
export function validateExtension(files: Map<string, Buffer>, opts: { appVersion: string; knownAgents?: Set<string>; knownFunctions?: Set<string>; installedIds?: Set<string> } = { appVersion: '0.0.0' }): { report: ExtensionReport; manifest: ExtensionManifest | null } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const findings: ExtFinding[] = [];
  const capabilities: string[] = [];
  const executableCode: string[] = [];
  const fileHashes: Record<string, string> = {};
  let total = 0;
  if (files.size > MAX_FILES) errors.push(`Too many files (${files.size} > ${MAX_FILES}).`);
  const manifest = parseJson(files, 'manifest.json', errors) as ExtensionManifest | undefined;
  const kind = manifest?.kind;
  for (const [path, buf] of files) {
    total += buf.length;
    if (normalizeExtPath(path) !== path) {
      errors.push(`Path not allowed in the package: "${path}" (leaving the package, hidden or absolute paths are not allowed).`);
      continue;
    }
    if (buf.length > MAX_FILE) errors.push(`${path}: the file is larger than 2 MB.`);
    fileHashes[path] = sha256(buf);
    const head = buf.subarray(0, 4);
    const binary = head[0] === 0x7f && head[1] === 0x45 ? 'ELF' : head[0] === 0x4d && head[1] === 0x5a ? 'PE' : head[0] === 0xcf && head[1] === 0xfa ? 'Mach-O' : buf.subarray(0, 2).toString() === '#!' ? 'script' : null;
    if (binary) {
      executableCode.push(path);
      errors.push(`${path}: an executable file (${binary}) is not supported.`);
      continue;
    }
    if (CODE_EXT.test(path)) {
      executableCode.push(path);
      if (kind !== 'tools' || !/\.mjs$/.test(path)) errors.push(kind === 'theme' ? `${path}: a theme cannot contain executable code (JavaScript, HTML, SVG and the like).` : `${path}: executable code is not supported for "${kind ?? '?'}" extensions.`);
    }
    if (kind && !allowedFile(kind, path) && !CODE_EXT.test(path)) errors.push(`${path}: the file does not belong to any supported integration point of a "${kind}" extension.`);
    if (kind === 'tools' && /\.mjs$/.test(path)) findings.push(...scanCode(path, buf.toString('utf8')));
  }
  if (total > MAX_TOTAL) errors.push('The package is larger than 5 MB.');
  const permissions: ExtensionReport['permissions'] = [];
  if (manifest) {
    if (manifest.formatVersion !== 1) errors.push('formatVersion must be 1.');
    if (typeof manifest.id !== 'string' || !ID_RE.test(manifest.id)) errors.push('Identifier: lowercase Latin letters, digits, "-", parts separated by dots (for example acme.ocean-theme).');
    else if (RESERVED.some((r) => r.test(manifest.id))) errors.push(`The identifier "${manifest.id}" is reserved for the application: an extension cannot pose as part of the core.`);
    if (typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 80) errors.push('Enter a name (up to 80 characters).');
    if (typeof manifest.version !== 'string' || !semver.valid(manifest.version)) errors.push('The version must use the semver format (for example 1.0.0).');
    if (typeof manifest.description !== 'string' || manifest.description.length > 2000) errors.push('The description must be a string of up to 2000 characters.');
    if (!['theme', 'content', 'tools'].includes(manifest.kind)) errors.push('Extension kind: theme, content or tools.');
    if (typeof manifest.platform !== 'string' || !semver.validRange(manifest.platform)) errors.push('Enter the compatible application versions (platform), for example ">=0.1.0 <1.0.0".');
    else if (!semver.satisfies(opts.appVersion, manifest.platform)) errors.push(`The extension is not compatible with this application version (${opts.appVersion}; requires ${manifest.platform}).`);
    if (manifest.homepage && !/^https:\/\//.test(manifest.homepage)) warnings.push('The extension website link does not use https.');
    if (manifest.signature) warnings.push('The package contains a signature, but signature verification is not set up: the signature was not verified and is not a guarantee of safety.');
    const c = manifest.contributes ?? {};
    if (typeof c !== 'object' || Array.isArray(c)) errors.push('contributes must be an object.');
    // permissions
    for (const p of Array.isArray(manifest.permissions) ? manifest.permissions : []) {
      const id = String(p?.permission ?? '');
      if (DANGEROUS[id]) {
        errors.push(`A dangerous privilege "${id}" (${DANGEROUS[id]}) was requested. Extensions never get it, so the package will not be installed. The safe alternative is to use the application API (documents, search, downloading from listed domains).`);
        permissions.push({ permission: id, label: DANGEROUS[id]!, reason: String(p?.reason ?? ''), risk: 'high', scope: '—', supported: false });
        continue;
      }
      const def = EXT_PERMISSIONS.find((x) => x.id === id);
      if (!def || !EXT_PERMISSION_IDS.has(id as ExtPermissionId)) {
        errors.push(`Unsupported permission "${id}".`);
        permissions.push({ permission: id, label: 'unknown permission', reason: String(p?.reason ?? ''), risk: 'high', scope: '—', supported: false });
        continue;
      }
      let scope = 'within the run scope';
      if (def.needs === 'domains') {
        const d = (p.domains ?? []).map((x) => String(x).toLowerCase());
        if (!d.length) errors.push('network.fetch: list the domains; extensions never get unrestricted network access.');
        for (const x of d) if (!DOMAIN_RE.test(x)) errors.push(`network.fetch: "${x}" is not a domain.`);
        scope = `domains: ${d.join(', ') || '—'}`;
      }
      if (def.needs === 'folders') {
        const f = (p.folders ?? []).map(String);
        if (!f.length) errors.push('documents.create: list the vault folders.');
        for (const x of f) if (!FOLDER_RE.test(x)) errors.push(`documents.create: invalid folder "${x}".`);
        scope = `folders: ${f.join(', ') || '—'}`;
      }
      if (!String(p.reason ?? '').trim()) warnings.push(`Permission ${id}: the reason is not given.`);
      permissions.push({ permission: id, label: def.label, reason: String(p.reason ?? ''), risk: def.risk, scope, supported: true });
    }
    if (manifest.kind !== 'tools' && permissions.length) errors.push(manifest.kind === 'theme' ? 'A theme cannot request permissions: it only changes the look (30.6).' : 'An extension with roles, templates and workflows requests no permissions: the user grants agent rights when installing the agent into a system.');
    // contributions per kind
    const only = (allowed: string[]) => {
      for (const k of Object.keys(c)) if (!allowed.includes(k) && (c as Record<string, unknown>)[k] !== undefined) errors.push(`A "${manifest.kind}" extension cannot add "${k}".`);
    };
    if (manifest.kind === 'theme') {
      only(['themes']);
      if (!c.themes?.length) errors.push('A theme must describe at least one look (contributes.themes).');
      for (const t of c.themes ?? []) {
        if (!/^[a-z0-9-]{1,40}$/.test(String(t.id))) errors.push(`Theme: invalid id "${t.id}".`);
        if (t.mode !== 'light' && t.mode !== 'dark') errors.push(`Theme "${t.id}": mode is light or dark.`);
        const tok = validateThemeTokens(t.tokens ?? {});
        errors.push(...tok.errors.map((e) => `Theme "${t.id}": ${e}`));
        if (t.css) {
          const css = files.get(t.css);
          if (!css) errors.push(`Theme "${t.id}": the file ${t.css} is missing.`);
          else {
            const s = sanitizeThemeCss(css.toString('utf8'), t.id);
            for (const r of s.removed) findings.push({ severity: r.severity, text: r.text, where: t.css });
          }
        }
        capabilities.push(`Changes the look: the "${t.name}" theme (${t.mode === 'dark' ? 'dark' : 'light'}). No access to files, keys or data.`);
      }
    }
    if (manifest.kind === 'content') {
      only(['agents', 'templates', 'workflows']);
      for (const dir of c.agents ?? []) {
        const prefix = `${String(dir).replace(/\/+$/, '')}/`;
        if (!/^agents\/[a-z0-9][a-z0-9-]*\/$/.test(prefix)) {
          errors.push(`Agent role: invalid folder "${dir}".`);
          continue;
        }
        const sub = new Map<string, Buffer>();
        for (const [p, b] of files) if (p.startsWith(prefix)) sub.set(p.slice(prefix.length), b);
        const { report, pkg } = validatePackageFiles(sub);
        if (!pkg) errors.push(...report.errors.map((e) => `Role ${dir}: ${e}`));
        else {
          if (opts.knownAgents?.has(pkg.manifest.id)) errors.push(`Role "${pkg.manifest.id}": the identifier is taken by a built-in agent; an extension cannot replace it.`);
          capabilities.push(`Adds the agent role "${pkg.manifest.name}". The role gets no rights by itself: you grant them when you install the agent into a system (it requests: ${pkg.manifest.permissions.map((p) => p.permission).join(', ') || 'nothing'}).`);
          if (pkg.manifest.permissions.some((p) => ['commands.run', 'changes.propose', 'systems.read', 'documents.modify'].includes(p.permission))) findings.push({ severity: 'medium', text: `The role "${pkg.manifest.id}" requests sensitive agent rights (${pkg.manifest.permissions.map((p) => p.permission).join(', ')}); you can leave them out when installing.`, where: dir });
        }
      }
      for (const t of c.templates ?? []) {
        if (!files.has(String(t.file))) errors.push(`Template "${t.id}": the file ${t.file} is missing.`);
        else capabilities.push(`Adds the document template "${t.name}" (it is copied into a system only by your action).`);
      }
      for (const w of c.workflows ?? []) {
        const def = parseJson(files, String(w), errors);
        if (def === undefined) continue;
        const chk = checkDefinition(def, { agents: opts.knownAgents ?? new Set(), functions: opts.knownFunctions ?? new Set() });
        if (chk.errors.length) warnings.push(...chk.errors.map((e) => `Workflow ${w}: ${e.message}`));
        capabilities.push(`Adds the workflow "${(def as { name?: string }).name ?? w}" (it is imported into a system by your action and runs on the application engine with all its limits).`);
      }
      if (!c.agents?.length && !c.templates?.length && !c.workflows?.length) errors.push('The extension adds no roles, templates or workflows.');
    }
    if (manifest.kind === 'tools') {
      only(['tools']);
      if (!c.tools?.length) errors.push('A plugin must describe at least one tool (contributes.tools).');
      for (const t of c.tools ?? []) {
        if (!/^[a-z][a-z0-9_]{1,40}$/.test(String(t.name))) errors.push(`Tool: invalid name "${t.name}".`);
        if (!files.has(String(t.entry)) || !/^tools\/.+\.mjs$/.test(String(t.entry))) errors.push(`Tool "${t.name}": the entry point must be a tools/*.mjs file inside the package.`);
        if (!t.inputSchema || typeof t.inputSchema !== 'object') errors.push(`Tool "${t.name}": an input schema (inputSchema) is required.`);
        if (t.timeoutSec !== undefined && (!Number.isInteger(t.timeoutSec) || t.timeoutSec < 1 || t.timeoutSec > 120)) errors.push(`Tool "${t.name}": the timeout is 1 to 120 seconds.`);
        capabilities.push(`Tool "${t.title ?? t.name}": ${t.description ?? ''}`.trim());
      }
      capabilities.push('Contains executable code: it runs in a separate process without disk access (except its own files), without starting programs and without direct network access; data flows only through the application API within the granted permissions.');
    }
    if (opts.installedIds?.has(manifest.id)) warnings.push('An extension with this identifier is already installed: this will be an update (new permissions need your confirmation).');
  }
  if (findings.some((f) => f.severity === 'high')) warnings.push('Potentially dangerous operations were found in the code: the runtime will block them, but they show the intent of the author.');
  return { report: { ok: errors.length === 0, errors, warnings, findings, capabilities, executableCode, permissions, fileHashes, totalBytes: total }, manifest: errors.length === 0 && manifest ? manifest : null };
}
