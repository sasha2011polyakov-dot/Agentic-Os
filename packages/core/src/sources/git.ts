import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface GitInfo {
  isRepo: boolean;
  root: string | null;
  gitDir: string | null;
  branch: string | null;
  head: string | null;
  detached: boolean;
  remotes: { name: string; url: string }[];
  status?: { branchLine: string; changed: number; untracked: number; entries: string[] } | null;
  recentCommits?: { hash: string; date: string; author: string; subject: string }[] | null;
  detailsError?: string | null;
}

/** Finds the repository root by walking up for a .git entry (file for worktrees/submodules, or folder). */
export async function findGitRoot(start: string): Promise<{ root: string; gitDir: string } | null> {
  let cur = resolve(start);
  for (let i = 0; i < 64; i++) {
    const candidate = join(cur, '.git');
    try {
      const st = await stat(candidate);
      if (st.isDirectory()) return { root: cur, gitDir: candidate };
      if (st.isFile()) {
        const content = await readFile(candidate, 'utf8');
        const m = /^gitdir:\s*(.+)$/m.exec(content);
        if (m) return { root: cur, gitDir: resolve(cur, m[1]!.trim()) };
      }
    } catch {
      // keep walking up
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

/**
 * Reads basic repository facts straight from files in .git — no git process is started, so nothing in a
 * possibly untrusted repository configuration can execute.
 */
export async function readGitInfo(path: string): Promise<GitInfo> {
  const found = await findGitRoot(path);
  if (!found) return { isRepo: false, root: null, gitDir: null, branch: null, head: null, detached: false, remotes: [] };
  let branch: string | null = null;
  let head: string | null = null;
  let detached = false;
  try {
    const headText = (await readFile(join(found.gitDir, 'HEAD'), 'utf8')).trim();
    const ref = /^ref:\s*(.+)$/.exec(headText);
    if (ref) {
      branch = ref[1]!.replace(/^refs\/heads\//, '');
      head = await resolveRef(found.gitDir, ref[1]!);
    } else {
      detached = true;
      head = headText.slice(0, 40);
    }
  } catch {
    // incomplete repository
  }
  const remotes: { name: string; url: string }[] = [];
  try {
    const config = await readFile(join(found.gitDir, 'config'), 'utf8');
    let current: string | null = null;
    for (const line of config.split('\n')) {
      const section = /^\s*\[remote\s+"([^"]+)"\]/.exec(line);
      if (section) {
        current = section[1]!;
        continue;
      }
      if (/^\s*\[/.test(line)) current = null;
      const url = /^\s*url\s*=\s*(.+)$/.exec(line);
      if (current && url) remotes.push({ name: current, url: stripCredentials(url[1]!.trim()) });
    }
  } catch {
    // no config
  }
  return { isRepo: true, root: found.root, gitDir: found.gitDir, branch, head, detached, remotes };
}

async function resolveRef(gitDir: string, ref: string): Promise<string | null> {
  try {
    return (await readFile(join(gitDir, ref), 'utf8')).trim().slice(0, 40);
  } catch {
    try {
      const packed = await readFile(join(gitDir, 'packed-refs'), 'utf8');
      const line = packed.split('\n').find((l) => l.endsWith(` ${ref}`));
      return line ? line.slice(0, 40) : null;
    } catch {
      return null;
    }
  }
}

function stripCredentials(url: string): string {
  return url.replace(/\/\/[^/@]+@/, '//');
}

let emptyHooksDir: string | null = null;

/**
 * Runs an allow-listed READ-ONLY git command with hardening against repository-controlled code execution:
 * fsmonitor disabled, hooks pointed at an empty folder, no system config, no prompts, no protocols.
 */
async function gitReadOnly(cwd: string, args: string[], timeoutMs = 8000): Promise<string> {
  const ALLOWED = new Set(['status', 'log']);
  if (!ALLOWED.has(args[0]!)) throw new Error(`git ${args[0]} is not allowed`);
  emptyHooksDir ??= await mkdtemp(join(tmpdir(), 'aos-nohooks-'));
  const hardened = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${emptyHooksDir}`, '-c', 'core.untrackedCache=false', '-c', 'protocol.allow=never', '-c', 'diff.external=', '-c', 'core.pager=cat', '--no-optional-locks', ...args];
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      hardened,
      { cwd, timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env: { ...pickEnv(), GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } },
      (err, stdout) => (err ? reject(err) : resolvePromise(stdout)),
    );
  });
}

function pickEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TMP', 'TEMP', 'TMPDIR'];
  const out: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k]) out[k] = process.env[k];
  return out;
}

export async function readGitDetails(root: string): Promise<Pick<GitInfo, 'status' | 'recentCommits' | 'detailsError'>> {
  try {
    const statusOut = await gitReadOnly(root, ['status', '--porcelain=v1', '-b']);
    const lines = statusOut.split('\n').filter(Boolean);
    const branchLine = lines[0]?.startsWith('##') ? lines.shift()!.slice(3) : '';
    const status = { branchLine, changed: lines.filter((l) => !l.startsWith('??')).length, untracked: lines.filter((l) => l.startsWith('??')).length, entries: lines.slice(0, 200) };
    const logOut = await gitReadOnly(root, ['log', '-n', '20', '--date=iso-strict', '--format=%H%x1f%ad%x1f%an%x1f%s']).catch(() => '');
    const recentCommits = logOut
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [hash, date, author, subject] = l.split('\x1f');
        return { hash: hash ?? '', date: date ?? '', author: author ?? '', subject: subject ?? '' };
      });
    return { status, recentCommits, detailsError: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: null, recentCommits: null, detailsError: /ENOENT/.test(msg) ? 'Git не установлен: доступны только базовые сведения из папки .git.' : `Не удалось получить сведения Git: ${msg.split('\n')[0]}` };
  }
}
