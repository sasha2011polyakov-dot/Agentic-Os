import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';

export interface DialogAvailability {
  native: boolean;
  tool: string | null;
}

function run(cmd: string, args: string[], timeoutMs = 10 * 60_000): Promise<{ code: number; stdout: string }> {
  return new Promise((r) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: false }, (err, stdout) => {
      const code = err ? ((err as { code?: number }).code ?? 1) : 0;
      r({ code: typeof code === 'number' ? code : 1, stdout: String(stdout ?? '') });
    });
  });
}

async function which(cmd: string): Promise<boolean> {
  const r = await run(platform() === 'win32' ? 'where' : 'which', [cmd], 3000);
  return r.code === 0 && r.stdout.trim().length > 0;
}

/**
 * Native "choose folder" dialog for browser mode (the desktop shell uses Electron's dialog instead):
 * zenity / kdialog on Linux, osascript on macOS, PowerShell FolderBrowserDialog on Windows.
 */
export class NativeDialog {
  private cached: DialogAvailability | null = null;

  async availability(): Promise<DialogAvailability> {
    if (this.cached) return this.cached;
    const os = platform();
    let tool: string | null = null;
    if (os === 'darwin') tool = 'osascript';
    else if (os === 'win32') tool = 'powershell';
    else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
      if (await which('zenity')) tool = 'zenity';
      else if (await which('kdialog')) tool = 'kdialog';
    }
    this.cached = { native: tool !== null, tool };
    return this.cached;
  }

  /** Returns the chosen absolute path, or null when the user cancelled. */
  async pickDirectory(title = 'Choose a folder'): Promise<string | null> {
    const { tool } = await this.availability();
    if (!tool) throw new Error('native dialog unavailable');
    let r: { code: number; stdout: string };
    switch (tool) {
      case 'zenity':
        r = await run('zenity', ['--file-selection', '--directory', `--title=${title}`]);
        break;
      case 'kdialog':
        r = await run('kdialog', ['--getexistingdirectory', homedir(), '--title', title]);
        break;
      case 'osascript':
        r = await run('osascript', ['-e', `POSIX path of (choose folder with prompt "${title.replace(/"/g, '')}")`]);
        break;
      default:
        r = await run('powershell', [
          '-NoProfile',
          '-STA',
          '-Command',
          'Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq "OK") { Write-Output $d.SelectedPath }',
        ]);
    }
    const path = r.stdout.trim().replace(/\/$/, '');
    return r.code === 0 && path ? resolve(path) : null;
  }
}

export interface DirListing {
  path: string;
  parent: string | null;
  entries: { name: string; path: string; isGit: boolean; isSystem: boolean }[];
  roots: string[];
}

/** In-app folder browser used when no native dialog is available: lists sub-folders only. */
export async function listDirectories(path?: string): Promise<DirListing> {
  const target = resolve(path || homedir());
  const st = await stat(target);
  if (!st.isDirectory()) throw new Error('not a directory');
  const entries = await readdir(target, { withFileTypes: true });
  const dirs = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const p = join(target, e.name);
    let isGit = false;
    let isSystem = false;
    try {
      isGit = (await stat(join(p, '.git'))).isDirectory();
    } catch {
      // not a repo
    }
    try {
      isSystem = (await stat(join(p, '.aos', 'system.json'))).isFile();
    } catch {
      // not a system
    }
    dirs.push({ name: e.name, path: p, isGit, isSystem });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(target) === target ? null : dirname(target);
  const roots = platform() === 'win32' ? [parse(target).root] : ['/', homedir()];
  return { path: target, parent, entries: dirs.slice(0, 2000), roots };
}
