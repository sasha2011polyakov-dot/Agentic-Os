import semver from 'semver';
import { createHash } from 'node:crypto';
import { validatePackageFiles } from '../agents/package.ts';
import { checkDefinition } from '../workflows/definition.ts';
import { validateThemeTokens, sanitizeThemeCss } from './theme.ts';

/**
 * Extension packages (section 30). Every external package is UNTRUSTED: it is validated structurally, its requested
 * permissions are compared with what the platform supports, executable code is detected, and the user sees a plain
 * description of capabilities and risks before anything is installed. Kinds are deliberately separated: a theme can
 * never carry code or permissions (30.6); content (agent roles, templates, workflows) carries no code; only «tools»
 * plugins contain code and they run in a restricted child process through a controlled API.
 */
export type ExtensionKind = 'theme' | 'content' | 'tools';

export type ExtPermissionId = 'documents.read' | 'search.use' | 'network.fetch' | 'documents.create';

export const EXT_PERMISSIONS: { id: ExtPermissionId; label: string; description: string; risk: 'low' | 'medium' | 'high'; needs?: 'domains' | 'folders' }[] = [
  { id: 'documents.read', label: 'Чтение документов', description: 'Плагин может читать документы системы — только в пределах области запуска, выбранной пользователем.', risk: 'medium' },
  { id: 'search.use', label: 'Поиск по системе', description: 'Полнотекстовый поиск по документам системы в пределах области запуска.', risk: 'low' },
  { id: 'network.fetch', label: 'Загрузка из сети', description: 'Загрузка публичных страниц только с перечисленных доменов (локальные и внутренние адреса запрещены).', risk: 'medium', needs: 'domains' },
  { id: 'documents.create', label: 'Создание документов', description: 'Создание новых документов только в перечисленных папках хранилища.', risk: 'medium', needs: 'folders' },
];
const EXT_PERMISSION_IDS = new Set(EXT_PERMISSIONS.map((p) => p.id));

/** Privileges the platform never gives to extensions (30.8): such a package is not installed. */
const DANGEROUS: Record<string, string> = {
  'files.read': 'прямое чтение файлов диска',
  'files.write': 'запись файлов на диск',
  'commands.run': 'запуск команд и программ',
  'secrets.read': 'чтение ключей и секретов',
  'settings.write': 'изменение настроек и политик безопасности',
  'permissions.manage': 'выдача разрешений',
  'agents.manage': 'установка и включение агентов',
  'projects.write': 'изменение файлов проектов',
  'network.any': 'неограниченный доступ к сети',
  'core.modify': 'изменение ядра приложения',
  'systems.write': 'изменение других систем знаний',
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
  { re: /child_process|\bspawn\(|\bexecSync\(|\bexecFile\(/, severity: 'high', text: 'запуск процессов (будет заблокирован)' },
  { re: /['"]node:(net|http|https|http2|tls|dgram|dns)['"]|['"](net|http|https|http2|tls|dgram|dns)['"]/, severity: 'high', text: 'прямой сетевой доступ в обход API (будет заблокирован)' },
  { re: /process\.binding|internalBinding|getBuiltinModule/, severity: 'high', text: 'обращение к внутренним модулям среды (будет заблокировано)' },
  { re: /\beval\s*\(|new\s+Function\s*\(/, severity: 'medium', text: 'динамическое выполнение кода' },
  { re: /writeFile|appendFile|createWriteStream|\bunlink|\brmSync|\brm\(|renameSync|mkdirSync/, severity: 'high', text: 'запись или удаление файлов (будет заблокировано)' },
  { re: /process\.env/, severity: 'medium', text: 'чтение переменных окружения (секреты в окружение плагина не передаются)' },
  { re: /['"]node:(module|vm|worker_threads|cluster|inspector|v8|sqlite)['"]/, severity: 'high', text: 'служебные модули среды выполнения (будут заблокированы)' },
  { re: /WebAssembly/, severity: 'medium', text: 'WebAssembly' },
  { re: /fetch\s*\(|WebSocket|XMLHttpRequest/, severity: 'high', text: 'сетевые запросы в обход API (будут заблокированы)' },
];

function scanCode(path: string, text: string): ExtFinding[] {
  const out: ExtFinding[] = [];
  for (const p of CODE_PATTERNS) if (p.re.test(text)) out.push({ severity: p.severity, text: p.text, where: path });
  return out;
}

function parseJson(files: Map<string, Buffer>, path: string, errors: string[]): unknown {
  const b = files.get(path);
  if (!b) {
    errors.push(`Нет файла ${path}.`);
    return undefined;
  }
  try {
    return JSON.parse(b.toString('utf8'));
  } catch {
    errors.push(`${path}: некорректный JSON.`);
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
  if (files.size > MAX_FILES) errors.push(`Слишком много файлов (${files.size} > ${MAX_FILES}).`);
  const manifest = parseJson(files, 'manifest.json', errors) as ExtensionManifest | undefined;
  const kind = manifest?.kind;
  for (const [path, buf] of files) {
    total += buf.length;
    if (normalizeExtPath(path) !== path) {
      errors.push(`Недопустимый путь в пакете: «${path}» (выход за пределы пакета, скрытые или абсолютные пути запрещены).`);
      continue;
    }
    if (buf.length > MAX_FILE) errors.push(`${path}: файл больше 2 МБ.`);
    fileHashes[path] = sha256(buf);
    const head = buf.subarray(0, 4);
    const binary = head[0] === 0x7f && head[1] === 0x45 ? 'ELF' : head[0] === 0x4d && head[1] === 0x5a ? 'PE' : head[0] === 0xcf && head[1] === 0xfa ? 'Mach-O' : buf.subarray(0, 2).toString() === '#!' ? 'скрипт' : null;
    if (binary) {
      executableCode.push(path);
      errors.push(`${path}: исполняемый файл (${binary}) — не поддерживается.`);
      continue;
    }
    if (CODE_EXT.test(path)) {
      executableCode.push(path);
      if (kind !== 'tools' || !/\.mjs$/.test(path)) errors.push(kind === 'theme' ? `${path}: тема оформления не может содержать исполняемый код (JavaScript, HTML, SVG и т. п.).` : `${path}: исполняемый код не поддерживается для расширений вида «${kind ?? '?'}».`);
    }
    if (kind && !allowedFile(kind, path) && !CODE_EXT.test(path)) errors.push(`${path}: файл не относится к поддерживаемым точкам интеграции расширения вида «${kind}».`);
    if (kind === 'tools' && /\.mjs$/.test(path)) findings.push(...scanCode(path, buf.toString('utf8')));
  }
  if (total > MAX_TOTAL) errors.push('Пакет больше 5 МБ.');
  const permissions: ExtensionReport['permissions'] = [];
  if (manifest) {
    if (manifest.formatVersion !== 1) errors.push('formatVersion должен быть 1.');
    if (typeof manifest.id !== 'string' || !ID_RE.test(manifest.id)) errors.push('Идентификатор: латиница в нижнем регистре, цифры, «-», части через точку (например, acme.ocean-theme).');
    else if (RESERVED.some((r) => r.test(manifest.id))) errors.push(`Идентификатор «${manifest.id}» зарезервирован за приложением: расширение не может выдавать себя за часть ядра.`);
    if (typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 80) errors.push('Укажите название (до 80 символов).');
    if (typeof manifest.version !== 'string' || !semver.valid(manifest.version)) errors.push('Версия должна быть в формате semver (например, 1.0.0).');
    if (typeof manifest.description !== 'string' || manifest.description.length > 2000) errors.push('Описание — строка до 2000 символов.');
    if (!['theme', 'content', 'tools'].includes(manifest.kind)) errors.push('Вид расширения: theme, content или tools.');
    if (typeof manifest.platform !== 'string' || !semver.validRange(manifest.platform)) errors.push('Укажите совместимые версии приложения (platform), например ">=0.1.0 <1.0.0".');
    else if (!semver.satisfies(opts.appVersion, manifest.platform)) errors.push(`Расширение несовместимо с этой версией приложения (${opts.appVersion}; требуется ${manifest.platform}).`);
    if (manifest.homepage && !/^https:\/\//.test(manifest.homepage)) warnings.push('Ссылка на сайт расширения не использует https.');
    if (manifest.signature) warnings.push('Пакет содержит подпись, но инфраструктура проверки подписей не настроена: подпись не проверена и не считается гарантией безопасности.');
    const c = manifest.contributes ?? {};
    if (typeof c !== 'object' || Array.isArray(c)) errors.push('contributes — объект.');
    // permissions
    for (const p of Array.isArray(manifest.permissions) ? manifest.permissions : []) {
      const id = String(p?.permission ?? '');
      if (DANGEROUS[id]) {
        errors.push(`Запрошена опасная привилегия «${id}» (${DANGEROUS[id]}). Расширения её не получают — пакет не будет установлен. Безопасный вариант: работать через API приложения (документы, поиск, загрузка с перечисленных доменов).`);
        permissions.push({ permission: id, label: DANGEROUS[id]!, reason: String(p?.reason ?? ''), risk: 'high', scope: '—', supported: false });
        continue;
      }
      const def = EXT_PERMISSIONS.find((x) => x.id === id);
      if (!def || !EXT_PERMISSION_IDS.has(id as ExtPermissionId)) {
        errors.push(`Неподдерживаемое разрешение «${id}».`);
        permissions.push({ permission: id, label: 'неизвестное разрешение', reason: String(p?.reason ?? ''), risk: 'high', scope: '—', supported: false });
        continue;
      }
      let scope = 'в пределах области запуска';
      if (def.needs === 'domains') {
        const d = (p.domains ?? []).map((x) => String(x).toLowerCase());
        if (!d.length) errors.push('network.fetch: перечислите домены — неограниченный доступ к сети расширениям не выдаётся.');
        for (const x of d) if (!DOMAIN_RE.test(x)) errors.push(`network.fetch: «${x}» не является доменом.`);
        scope = `домены: ${d.join(', ') || '—'}`;
      }
      if (def.needs === 'folders') {
        const f = (p.folders ?? []).map(String);
        if (!f.length) errors.push('documents.create: перечислите папки хранилища.');
        for (const x of f) if (!FOLDER_RE.test(x)) errors.push(`documents.create: недопустимая папка «${x}».`);
        scope = `папки: ${f.join(', ') || '—'}`;
      }
      if (!String(p.reason ?? '').trim()) warnings.push(`Разрешение ${id}: не указано, зачем оно нужно.`);
      permissions.push({ permission: id, label: def.label, reason: String(p.reason ?? ''), risk: def.risk, scope, supported: true });
    }
    if (manifest.kind !== 'tools' && permissions.length) errors.push(manifest.kind === 'theme' ? 'Тема оформления не может запрашивать разрешения: она меняет только внешний вид (30.6).' : 'Расширение с ролями, шаблонами и процессами не запрашивает разрешений: права агентам выдаёт пользователь при установке агента в систему.');
    // contributions per kind
    const only = (allowed: string[]) => {
      for (const k of Object.keys(c)) if (!allowed.includes(k) && (c as Record<string, unknown>)[k] !== undefined) errors.push(`Расширение вида «${manifest.kind}» не может добавлять «${k}».`);
    };
    if (manifest.kind === 'theme') {
      only(['themes']);
      if (!c.themes?.length) errors.push('Тема должна описывать хотя бы одно оформление (contributes.themes).');
      for (const t of c.themes ?? []) {
        if (!/^[a-z0-9-]{1,40}$/.test(String(t.id))) errors.push(`Тема: недопустимый id «${t.id}».`);
        if (t.mode !== 'light' && t.mode !== 'dark') errors.push(`Тема «${t.id}»: mode — light или dark.`);
        const tok = validateThemeTokens(t.tokens ?? {});
        errors.push(...tok.errors.map((e) => `Тема «${t.id}»: ${e}`));
        if (t.css) {
          const css = files.get(t.css);
          if (!css) errors.push(`Тема «${t.id}»: нет файла ${t.css}.`);
          else {
            const s = sanitizeThemeCss(css.toString('utf8'), t.id);
            for (const r of s.removed) findings.push({ severity: r.severity, text: r.text, where: t.css });
          }
        }
        capabilities.push(`Меняет внешний вид: оформление «${t.name}» (${t.mode === 'dark' ? 'тёмное' : 'светлое'}). Доступа к файлам, ключам и данным нет.`);
      }
    }
    if (manifest.kind === 'content') {
      only(['agents', 'templates', 'workflows']);
      for (const dir of c.agents ?? []) {
        const prefix = `${String(dir).replace(/\/+$/, '')}/`;
        if (!/^agents\/[a-z0-9][a-z0-9-]*\/$/.test(prefix)) {
          errors.push(`Роль агента: недопустимая папка «${dir}».`);
          continue;
        }
        const sub = new Map<string, Buffer>();
        for (const [p, b] of files) if (p.startsWith(prefix)) sub.set(p.slice(prefix.length), b);
        const { report, pkg } = validatePackageFiles(sub);
        if (!pkg) errors.push(...report.errors.map((e) => `Роль ${dir}: ${e}`));
        else {
          if (opts.knownAgents?.has(pkg.manifest.id)) errors.push(`Роль «${pkg.manifest.id}»: идентификатор занят встроенным агентом — расширение не может подменить его.`);
          capabilities.push(`Добавляет роль агента «${pkg.manifest.name}». Права роль не получает сама: их выдаёте вы при установке агента в систему (запрашивает: ${pkg.manifest.permissions.map((p) => p.permission).join(', ') || 'ничего'}).`);
          if (pkg.manifest.permissions.some((p) => ['commands.run', 'changes.propose', 'systems.read', 'documents.modify'].includes(p.permission))) findings.push({ severity: 'medium', text: `Роль «${pkg.manifest.id}» запрашивает чувствительные права агента (${pkg.manifest.permissions.map((p) => p.permission).join(', ')}) — при установке их можно не выдавать.`, where: dir });
        }
      }
      for (const t of c.templates ?? []) {
        if (!files.has(String(t.file))) errors.push(`Шаблон «${t.id}»: нет файла ${t.file}.`);
        else capabilities.push(`Добавляет шаблон документа «${t.name}» (копируется в систему только по вашему действию).`);
      }
      for (const w of c.workflows ?? []) {
        const def = parseJson(files, String(w), errors);
        if (def === undefined) continue;
        const chk = checkDefinition(def, { agents: opts.knownAgents ?? new Set(), functions: opts.knownFunctions ?? new Set() });
        if (chk.errors.length) warnings.push(...chk.errors.map((e) => `Процесс ${w}: ${e.message}`));
        capabilities.push(`Добавляет процесс «${(def as { name?: string }).name ?? w}» (импортируется в систему по вашему действию и выполняется движком приложения со всеми его ограничениями).`);
      }
      if (!c.agents?.length && !c.templates?.length && !c.workflows?.length) errors.push('Расширение не добавляет ни ролей, ни шаблонов, ни процессов.');
    }
    if (manifest.kind === 'tools') {
      only(['tools']);
      if (!c.tools?.length) errors.push('Плагин должен описывать хотя бы один инструмент (contributes.tools).');
      for (const t of c.tools ?? []) {
        if (!/^[a-z][a-z0-9_]{1,40}$/.test(String(t.name))) errors.push(`Инструмент: недопустимое имя «${t.name}».`);
        if (!files.has(String(t.entry)) || !/^tools\/.+\.mjs$/.test(String(t.entry))) errors.push(`Инструмент «${t.name}»: точка входа должна быть файлом tools/*.mjs внутри пакета.`);
        if (!t.inputSchema || typeof t.inputSchema !== 'object') errors.push(`Инструмент «${t.name}»: нужна схема входа (inputSchema).`);
        if (t.timeoutSec !== undefined && (!Number.isInteger(t.timeoutSec) || t.timeoutSec < 1 || t.timeoutSec > 120)) errors.push(`Инструмент «${t.name}»: тайм-аут от 1 до 120 секунд.`);
        capabilities.push(`Инструмент «${t.title ?? t.name}»: ${t.description ?? ''}`.trim());
      }
      capabilities.push('Содержит исполняемый код: он запускается в отдельном процессе без доступа к диску (кроме собственных файлов), без запуска программ и без прямой сети; данные — только через API приложения в пределах выданных разрешений.');
    }
    if (opts.installedIds?.has(manifest.id)) warnings.push('Расширение с таким идентификатором уже установлено — это будет обновление (новые разрешения потребуют вашего подтверждения).');
  }
  if (findings.some((f) => f.severity === 'high')) warnings.push('Найдены потенциально опасные операции в коде — они будут заблокированы средой выполнения, но говорят о намерениях автора.');
  return { report: { ok: errors.length === 0, errors, warnings, findings, capabilities, executableCode, permissions, fileHashes, totalBytes: total }, manifest: errors.length === 0 && manifest ? manifest : null };
}
