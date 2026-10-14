import { isSecretFileName } from '../fs/secrets.ts';

/** Access modes of a connected project (29.2). Higher modes include the lower ones. */
export type AccessMode = 'read_only' | 'prepare' | 'workcopy' | 'apply';

export const ACCESS_MODES: { id: AccessMode; label: string; short: string; allows: string[]; forbids: string[] }[] = [
  {
    id: 'read_only',
    label: 'Read only',
    short: 'Agents read and analyze the project. Project files do not change.',
    allows: ['reading files and documentation', 'search and indexing (in the internal storage of the application)', 'architecture and vulnerability analysis', 'change plans and specifications'],
    forbids: ['changing, deleting and moving files', 'preparing file changes', 'running commands and scripts', 'installing dependencies', 'Git operations, pushing changes'],
  },
  {
    id: 'prepare',
    label: 'Prepare changes',
    short: 'Agents prepare proposed changes. They are kept separately; the original files do not change.',
    allows: ['everything in "Read only"', 'proposed file changes (diff, patch)', 'viewing and downloading the patch'],
    forbids: ['changing the original files', 'running commands and checks', 'Git operations'],
  },
  {
    id: 'workcopy',
    label: 'Work in a copy',
    short: 'Changes are applied to a separate work copy in the application folder; the checks run there too. The original project does not change.',
    allows: ['everything in "Prepare changes"', 'a work copy of the project', 'applying changes to the work copy', 'running the checks set by the user in the work copy'],
    forbids: ['changing the original files', 'Git operations', 'installing dependencies automatically'],
  },
  {
    id: 'apply',
    label: 'Apply to the original project',
    short: 'Allows moving verified changes into the original project: only after your review, passed checks and a backup.',
    allows: ['everything in "Work in a copy"', 'applying reviewed and checked changes to the original files with a backup and the option to restore'],
    forbids: ['applying without your confirmation', 'applying sets that were not reviewed or changed after the review', 'Git operations (commit, push, reset): never performed'],
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
  git: { label: 'Git service files', risk: 'The change can damage the history and the state of the repository.' },
  secret: { label: 'files with secrets', risk: 'Files with keys and passwords are not changed by the application.' },
  ci: { label: 'CI/CD settings', risk: 'Changes the automatic build and publishing: it can trigger or break processes on the server.' },
  deploy: { label: 'deployment configuration', risk: 'Can change how and where the application is published.' },
  build: { label: 'build system', risk: 'Can break the build or change what goes into the final application.' },
  dependencies: { label: 'dependencies and the package manifest', risk: 'Can add or update third-party code; its scripts run on installation.' },
  migration: { label: 'data migrations', risk: 'Running a migration can change or delete data in the database.' },
  install_script: { label: 'installation scripts', risk: 'Such scripts run with the user\'s rights on installation.' },
  license: { label: 'license', risk: 'Changing the license has legal consequences.' },
  security_config: { label: 'security settings', risk: 'Can weaken the protection of the project or change access rights.' },
  backup: { label: 'backups', risk: 'Changing or deleting them can make a restore impossible.' },
  executable: { label: 'executable files and scripts', risk: 'A changed script can perform arbitrary actions when it runs.' },
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
  const backup = ctx.original ? 'A verified backup of the affected files is created before applying.' : 'The changes are applied to a work copy; the original project is not touched.';
  const reversible = ctx.original ? 'Yes: it can be restored from the backup ("Backups").' : 'Yes: the work copy can be deleted or recreated.';
  const onRefuse = 'These files will not change; the other changes can be applied separately (selectively).';
  const deletes = files.filter((f) => f.op === 'delete');
  if (deletes.length >= MASS_DELETE_THRESHOLD) {
    risks.push({ id: 'mass_delete', title: `Deleting ${deletes.length} files`, what: `These files will be deleted: ${deletes.slice(0, 10).map((f) => f.path).join(', ')}${deletes.length > 10 ? ` and ${deletes.length - 10} more` : ''}.`, files: deletes.map((f) => f.path), danger: 'If the files are needed, the project may stop working.', reversible, backup, onRefuse, severity: 'high' });
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
      risks.push({ id: 'dir_delete', title: `Deleting folders: ${emptied.map(([d]) => d).slice(0, 5).join(', ')}`, what: `All files in the folders ${emptied.map(([d]) => d).join(', ')} will be deleted.`, files: emptied.flatMap(([, l]) => l), danger: 'The folder disappears entirely together with its content.', reversible, backup, onRefuse, severity: 'high' });
    }
  }
  const writes = files.filter((f) => f.op !== 'delete');
  if (writes.length >= MASS_WRITE_THRESHOLD) {
    risks.push({ id: 'mass_write', title: `Overwriting ${writes.length} files`, what: `${writes.length} files will be created or changed.`, files: writes.map((f) => f.path), danger: 'A mass edit is hard to review: mistakes are easy to miss.', reversible, backup, onRefuse, severity: 'medium' });
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
    risks.push({ id: `cat_${cat}`, title: `Change: ${t.label}`, what: `Affected ${t.label}: ${paths.slice(0, 8).join(', ')}${paths.length > 8 ? ` and ${paths.length - 8} more` : ''}.`, files: paths, danger: t.risk, reversible, backup, onRefuse, severity: ['ci', 'deploy', 'migration', 'install_script', 'security_config', 'git', 'secret'].includes(cat) ? 'high' : 'medium' });
  }
  return risks;
}
