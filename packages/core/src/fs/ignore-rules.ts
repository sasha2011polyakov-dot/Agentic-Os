import ignoreFactory, { type Ignore } from 'ignore';
import { isSecretFileName } from './secrets.ts';

export const DEFAULT_EXCLUDED_DIRS = [
  '.git', '.hg', '.svn', 'node_modules', 'vendor', 'bower_components', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.svelte-kit', '.cache', '.parcel-cache', '.turbo', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.venv', 'venv', '.tox', 'coverage', '.nyc_output', '.idea', '.vscode', '.gradle', '.terraform', '.aos', '.trash',
  '.obsidian',
];

const DEFAULT_EXCLUDED_FILES = ['*.min.js', '*.min.css', '*.map', '*.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '*.log', '*.tmp', '*.swp', '.DS_Store', 'Thumbs.db', '*.aos-tmp-*'];

export type SkipReason =
  | 'excluded-dir'
  | 'excluded-default'
  | 'excluded-user'
  | 'not-included'
  | 'gitignore'
  | 'secret-name'
  | 'secret-content'
  | 'too-large'
  | 'binary'
  | 'unsupported-format'
  | 'unreadable';

export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  'excluded-dir': 'служебная папка (исключена по умолчанию)',
  'excluded-default': 'служебный файл (исключён по умолчанию)',
  'excluded-user': 'исключён правилом пользователя',
  'not-included': 'не попадает под правила включения',
  gitignore: 'исключён .gitignore',
  'secret-name': 'похож на файл с секретами (по имени)',
  'secret-content': 'содержит похожие на секреты строки',
  'too-large': 'превышает лимит размера',
  binary: 'бинарный файл',
  'unsupported-format': 'формат пока не поддерживается',
  unreadable: 'нет прав на чтение',
};

export interface RuleSet {
  includeGlobs: string[];
  excludeGlobs: string[];
  respectGitignore: boolean;
}

/**
 * Evaluates static rules (defaults, user include/exclude, secret names). .gitignore files are
 * handled per directory by the walker because their patterns are relative to their own folder.
 */
export class IgnoreRules {
  private readonly defaults: Ignore;
  private readonly userExclude: Ignore;
  private readonly userInclude: Ignore | null;
  readonly respectGitignore: boolean;

  constructor(rules: RuleSet) {
    this.defaults = ignoreFactory().add(DEFAULT_EXCLUDED_FILES);
    this.userExclude = ignoreFactory().add(rules.excludeGlobs);
    this.userInclude = rules.includeGlobs.length ? ignoreFactory().add(rules.includeGlobs) : null;
    this.respectGitignore = rules.respectGitignore;
  }

  isExcludedDir(name: string, relDir: string): SkipReason | null {
    if (DEFAULT_EXCLUDED_DIRS.includes(name)) return 'excluded-dir';
    if (this.userExclude.ignores(relDir + '/')) return 'excluded-user';
    return null;
  }

  checkFile(relPath: string): SkipReason | null {
    if (this.defaults.ignores(relPath)) return 'excluded-default';
    if (this.userExclude.ignores(relPath)) return 'excluded-user';
    if (this.userInclude && !this.userInclude.ignores(relPath)) return 'not-included';
    if (isSecretFileName(relPath)) return 'secret-name';
    return null;
  }
}

export function createGitignore(content: string): Ignore {
  return ignoreFactory().add(content);
}
