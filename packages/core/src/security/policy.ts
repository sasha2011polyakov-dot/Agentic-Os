import { isSecretFileName } from '../fs/secrets.ts';

/** Access modes of a connected project (29.2). Higher modes include the lower ones. */
export type AccessMode = 'read_only' | 'prepare' | 'workcopy' | 'apply';

export const ACCESS_MODES: { id: AccessMode; label: string; short: string; allows: string[]; forbids: string[] }[] = [
  {
    id: 'read_only',
    label: 'Только изучение',
    short: 'Агенты читают и анализируют проект. Файлы проекта не меняются.',
    allows: ['чтение файлов и документации', 'поиск и индексация (во внутреннем хранилище приложения)', 'анализ архитектуры и уязвимостей', 'план изменений и технические задания'],
    forbids: ['изменение, удаление и перемещение файлов', 'подготовка изменений файлов', 'запуск команд и скриптов', 'установка зависимостей', 'операции Git, отправка изменений'],
  },
  {
    id: 'prepare',
    label: 'Подготовить изменения',
    short: 'Агенты готовят предложения изменений. Они хранятся отдельно; исходные файлы не меняются.',
    allows: ['всё из «Только изучение»', 'предложения изменений файлов (diff, patch)', 'просмотр и скачивание патча'],
    forbids: ['изменение исходных файлов', 'запуск команд и проверок', 'операции Git'],
  },
  {
    id: 'workcopy',
    label: 'Работать в копии',
    short: 'Изменения применяются к отдельной рабочей копии в папке приложения; там же запускаются проверки. Исходный проект не меняется.',
    allows: ['всё из «Подготовить изменения»', 'рабочая копия проекта', 'применение изменений к рабочей копии', 'запуск проверок, заданных пользователем, в рабочей копии'],
    forbids: ['изменение исходных файлов', 'операции Git', 'установка зависимостей автоматически'],
  },
  {
    id: 'apply',
    label: 'Применить к исходному проекту',
    short: 'Разрешает переносить проверенные изменения в исходный проект — только после вашей проверки, прохождения проверок и создания резервной копии.',
    allows: ['всё из «Работать в копии»', 'применение просмотренных и проверенных изменений к исходным файлам с резервной копией и возможностью восстановления'],
    forbids: ['применение без вашего подтверждения', 'применение непросмотренных или изменившихся после просмотра наборов', 'операции Git (commit, push, reset) — не выполняются никогда'],
  },
];

const RANK: Record<AccessMode, number> = { read_only: 0, prepare: 1, workcopy: 2, apply: 3 };

export function modeAtLeast(mode: AccessMode, needed: AccessMode): boolean {
  return RANK[mode] >= RANK[needed];
}

export function modeLabel(mode: AccessMode): string {
  return ACCESS_MODES.find((m) => m.id === mode)?.label ?? mode;
}

export type FileCategory = 'git' | 'secret' | 'ci' | 'deploy' | 'build' | 'dependencies' | 'migration' | 'install_script' | 'license' | 'security_config' | 'backup' | 'executable';

const CATEGORY_RULES: { category: FileCategory; test: (p: string, name: string) => boolean }[] = [
  { category: 'git', test: (p) => /(^|\/)\.git(\/|$)/.test(p) || /(^|\/)\.git(attributes|modules|ignore)$/.test(p) },
  { category: 'secret', test: (p) => isSecretFileName(p) },
  { category: 'ci', test: (p, n) => /(^|\/)\.github\/workflows\//.test(p) || /(^|\/)\.circleci\//.test(p) || /^(\.gitlab-ci\.ya?ml|jenkinsfile|azure-pipelines\.ya?ml|\.travis\.ya?ml|bitbucket-pipelines\.yml|appveyor\.yml)$/i.test(n) },
  { category: 'deploy', test: (p, n) => /^(dockerfile|docker-compose\.ya?ml|compose\.ya?ml|procfile|vercel\.json|netlify\.toml|fly\.toml|app\.ya?ml|serverless\.ya?ml|render\.yaml)$/i.test(n) || /\.tf$|\.tfvars$/i.test(n) || /(^|\/)(k8s|kubernetes|helm|charts|deploy|deployment|\.github\/actions)\//i.test(p) || /(^|\/)(electron-builder|forge\.config)\./i.test(n) },
  { category: 'build', test: (_p, n) => /^(makefile|cmakelists\.txt|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|pom\.xml|webpack\.config\.\w+|vite\.config\.\w+|rollup\.config\.\w+|esbuild\.\w+|babel\.config\.\w+|tsconfig(\.\w+)?\.json|build\.(mjs|js|ts|sh|ps1)|setup\.cfg|meson\.build|bazel|workspace|build)$/i.test(n) },
  { category: 'dependencies', test: (_p, n) => /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|requirements(-\w+)?\.txt|pipfile(\.lock)?|poetry\.lock|pyproject\.toml|go\.mod|go\.sum|cargo\.toml|cargo\.lock|gemfile(\.lock)?|composer\.(json|lock)|packages\.config|.*\.csproj|directory\.packages\.props)$/i.test(n) },
  { category: 'migration', test: (p) => /(^|\/)(migrations?|migrate|db\/migrate|alembic|flyway|liquibase)\//i.test(p) },
  { category: 'install_script', test: (_p, n) => /^(install|setup|bootstrap|postinstall|preinstall|init)(\.(sh|ps1|bat|cmd|py|js|mjs))?$/i.test(n) || /^setup\.py$/i.test(n) },
  { category: 'license', test: (_p, n) => /^(license|licence|copying|notice)(\.\w+)?$/i.test(n) },
  { category: 'security_config', test: (p, n) => /^(security\.md|codeowners|\.npmrc|\.yarnrc(\.yml)?|\.pypirc|\.htaccess|nginx\.conf|sudoers|policy\.json|\.?auth.*\.(json|ya?ml|toml)|cors.*\.(json|ya?ml)|csp.*\.(json|ya?ml))$/i.test(n) || /(^|\/)\.github\/(codeowners|dependabot\.yml)$/i.test(p) },
  { category: 'backup', test: (_p, n) => /\.(bak|backup|orig|old|swp)$/i.test(n) || /^backup/i.test(n) },
  { category: 'executable', test: (_p, n) => /\.(sh|bash|ps1|bat|cmd|exe|dll|so|dylib|bin|command)$/i.test(n) },
];

export const CATEGORY_TEXT: Record<FileCategory, { label: string; risk: string }> = {
  git: { label: 'служебные файлы Git', risk: 'Изменение может повредить историю и состояние репозитория.' },
  secret: { label: 'файлы с секретами', risk: 'Файлы с ключами и паролями не изменяются приложением.' },
  ci: { label: 'настройки CI/CD', risk: 'Изменит автоматическую сборку и публикацию: может запустить или сломать процессы на сервере.' },
  deploy: { label: 'конфигурация развёртывания', risk: 'Может изменить то, как и куда публикуется приложение.' },
  build: { label: 'система сборки', risk: 'Может сломать сборку или изменить состав итогового приложения.' },
  dependencies: { label: 'зависимости и манифест пакета', risk: 'Может добавить или обновить сторонний код; при установке выполнятся его скрипты.' },
  migration: { label: 'миграции данных', risk: 'Запуск миграции может изменить или удалить данные в базе.' },
  install_script: { label: 'скрипты установки', risk: 'Такие скрипты выполняются с правами пользователя при установке.' },
  license: { label: 'лицензия', risk: 'Изменение лицензии имеет юридические последствия.' },
  security_config: { label: 'настройки безопасности', risk: 'Может ослабить защиту проекта или изменить права доступа.' },
  backup: { label: 'резервные копии', risk: 'Изменение или удаление может лишить возможности восстановления.' },
  executable: { label: 'исполняемые файлы и скрипты', risk: 'Изменённый скрипт может выполнить произвольные действия при запуске.' },
};

/** Categories that are never written by the application (any mode). */
export const NEVER_WRITE: FileCategory[] = ['git', 'secret'];

export function categorize(relPath: string): FileCategory[] {
  const p = relPath.replace(/\\/g, '/');
  const name = p.split('/').pop() ?? p;
  return CATEGORY_RULES.filter((r) => r.test(p, name)).map((r) => r.category);
}

export interface RiskItem {
  id: string;
  title: string;
  /** What exactly changes (plain language). */
  what: string;
  files: string[];
  /** What can go wrong. */
  danger: string;
  reversible: string;
  backup: string;
  onRefuse: string;
  severity: 'high' | 'medium';
}

export const MASS_DELETE_THRESHOLD = 5;
export const MASS_WRITE_THRESHOLD = 30;

/**
 * Risk analysis of a set of file operations (29.5). Each risk needs its own explicit confirmation; general
 * consent to a task is never treated as consent to these operations.
 */
export function analyzeRisks(files: { path: string; op: 'create' | 'modify' | 'delete' }[], ctx: { original: boolean; dirFileCounts?: Map<string, number> }): RiskItem[] {
  const risks: RiskItem[] = [];
  const backup = ctx.original ? 'Перед применением будет создана и проверена резервная копия затронутых файлов.' : 'Изменения применяются к рабочей копии, исходный проект не затрагивается.';
  const reversible = ctx.original ? 'Да: можно восстановить из резервной копии (раздел «Резервные копии»).' : 'Да: рабочую копию можно удалить или пересоздать.';
  const onRefuse = 'Эти файлы не будут изменены; остальные изменения можно применить отдельно (выборочно).';
  const deletes = files.filter((f) => f.op === 'delete');
  if (deletes.length >= MASS_DELETE_THRESHOLD) {
    risks.push({ id: 'mass_delete', title: `Удаление ${deletes.length} файлов`, what: `Будут удалены файлы: ${deletes.slice(0, 10).map((f) => f.path).join(', ')}${deletes.length > 10 ? ` и ещё ${deletes.length - 10}` : ''}.`, files: deletes.map((f) => f.path), danger: 'Если файлы нужны, проект может перестать работать.', reversible, backup, onRefuse, severity: 'high' });
  }
  // a folder disappears when every file it contains is deleted (counts come from the project index)
  if (ctx.dirFileCounts) {
    const byDir = new Map<string, string[]>();
    for (const d of deletes) {
      const dir = d.path.includes('/') ? d.path.slice(0, d.path.lastIndexOf('/')) : '';
      if (dir) byDir.set(dir, [...(byDir.get(dir) ?? []), d.path]);
    }
    const emptied = [...byDir].filter(([dir, list]) => (ctx.dirFileCounts!.get(dir) ?? Infinity) <= list.length);
    if (emptied.length) {
      risks.push({ id: 'dir_delete', title: `Удаление папок: ${emptied.map(([d]) => d).slice(0, 5).join(', ')}`, what: `Будут удалены все файлы в папках ${emptied.map(([d]) => d).join(', ')}.`, files: emptied.flatMap(([, l]) => l), danger: 'Папка исчезнет целиком вместе с содержимым.', reversible, backup, onRefuse, severity: 'high' });
    }
  }
  const writes = files.filter((f) => f.op !== 'delete');
  if (writes.length >= MASS_WRITE_THRESHOLD) {
    risks.push({ id: 'mass_write', title: `Перезапись ${writes.length} файлов`, what: `Будет создано или изменено ${writes.length} файлов.`, files: writes.map((f) => f.path), danger: 'Массовая правка затрудняет проверку: ошибки легко пропустить.', reversible, backup, onRefuse, severity: 'medium' });
  }
  const byCat = new Map<FileCategory, string[]>();
  for (const f of files) for (const c of categorize(f.path)) {
    if (c === 'executable' && f.op === 'create') continue; // new scripts are flagged below only when modified/deleted
    const list = byCat.get(c) ?? [];
    list.push(f.path);
    byCat.set(c, list);
  }
  for (const [cat, paths] of byCat) {
    const t = CATEGORY_TEXT[cat];
    risks.push({ id: `cat_${cat}`, title: `Изменение: ${t.label}`, what: `Затрагиваются ${t.label}: ${paths.slice(0, 8).join(', ')}${paths.length > 8 ? ` и ещё ${paths.length - 8}` : ''}.`, files: paths, danger: t.risk, reversible, backup, onRefuse, severity: ['ci', 'deploy', 'migration', 'install_script', 'security_config', 'git', 'secret'].includes(cat) ? 'high' : 'medium' });
  }
  return risks;
}
