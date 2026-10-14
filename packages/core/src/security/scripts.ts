import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { isInside } from '../fs/guard.ts';
import { sha256 } from '../util/hash.ts';

export interface ScriptFinding {
  severity: 'high' | 'medium';
  text: string;
  where: string;
}

export interface ScriptVetting {
  /** May run without an extra, check-specific confirmation (still only in a work copy, still user-defined). */
  autoRun: boolean;
  /** What will actually execute: the program and every project script it triggers (npm pre/post hooks included). */
  executes: { label: string; command: string }[];
  findings: ScriptFinding[];
  /** Hash of everything that executes — an approval is only valid for exactly this content. */
  contentHash: string;
  notes: string[];
}

const PATTERNS: { re: RegExp; severity: 'high' | 'medium'; text: string }[] = [
  { re: /\b(sudo|doas|runas)\b|\bsu\s+-?\w/, severity: 'high', text: 'privilege escalation' },
  { re: /\brm\s+-[a-z]*[rf][a-z]*\s+(\/|~|\$HOME|\.\.|\*)|\bdel\s+\/[sq]|\brmdir\s+\/s|Remove-Item\b.*-Recurse/i, severity: 'high', text: 'mass file deletion' },
  { re: /\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|certutil|bitsadmin)\b/i, severity: 'high', text: 'downloading or sending data over the network' },
  { re: /\|\s*(sh|bash|zsh|dash|powershell|pwsh|python3?|node)\b/, severity: 'high', text: 'running downloaded or generated code through a pipe' },
  { re: /\b(nc|ncat|netcat|socat|ssh|scp|sftp|rsync|ftp|telnet)\b/, severity: 'high', text: 'remote access network tools' },
  { re: /\bchmod\s+(-R\s+)?(777|\+s)|\bchown\b|\bsetfacl\b|\bicacls\b/, severity: 'high', text: 'changing access rights' },
  { re: /\bmkfs\b|\bdd\s+if=|\bformat\s+[a-z]:|\bdiskpart\b|\bfdisk\b/i, severity: 'high', text: 'disk operations' },
  { re: /base64\s+(-d|--decode)|frombase64string/i, severity: 'high', text: 'decoding hidden code' },
  { re: /\.ssh\/|id_rsa|id_ed25519|\/etc\/(passwd|shadow)|\.aws\/credentials|\.npmrc|\.netrc|\.git-credentials|keychain/i, severity: 'high', text: 'access to credentials' },
  { re: /\bgit\s+(push|reset|clean|checkout|switch|rebase|commit|merge|remote|config|tag|stash|filter-branch|gc|prune|update-ref)\b/, severity: 'high', text: 'changing the Git repository' },
  { re: /\b(npm|pnpm|yarn|bun)\s+(publish|unpublish|deprecate|owner|token|login|adduser)\b|\bnpx\s+(-y|--yes)\b/, severity: 'high', text: 'publishing or downloading packages' },
  { re: /\b(shutdown|reboot|halt|systemctl|launchctl|service\s+\w+\s+(start|stop)|reg\s+(add|delete)|setx|crontab|schtasks)\b/i, severity: 'high', text: 'changing system settings or services' },
  { re: /\bdocker\s+(run|push|login|exec)\b|\bkubectl\b|\bterraform\s+(apply|destroy)\b|\baws\s|\bgcloud\s|\baz\s/, severity: 'high', text: 'actions on external infrastructure' },
  { re: /\beval\b|\bexec\s*\(|child_process|subprocess|os\.system|Function\s*\(/, severity: 'medium', text: 'dynamic code execution' },
  { re: /\b(npm|pnpm|yarn|bun|pip3?|poetry|gem|cargo|go)\s+(install|i|add|ci|get|update|upgrade)\b/, severity: 'medium', text: 'installing or updating dependencies (network, package scripts)' },
  { re: /\bprintenv\b|\benv\s*\||process\.env\b|os\.environ/, severity: 'medium', text: 'reading environment variables' },
  { re: /\bnode\s+-e\b|\bpython3?\s+-c\b|\bperl\s+-e\b|\bruby\s+-e\b/, severity: 'medium', text: 'one-line executable code' },
];

function scan(text: string, where: string): ScriptFinding[] {
  const out: ScriptFinding[] = [];
  for (const p of PATTERNS) if (p.re.test(text)) out.push({ severity: p.severity, text: p.text, where });
  return out;
}

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/**
 * Looks at what a user-defined check will really execute before it runs (29.9): the program, project scripts it
 * triggers (package.json scripts with pre/post hooks, project-local executables) and dangerous patterns in them.
 * Anything with high-risk findings or an unknown project binary never runs without a check-specific approval.
 */
export async function vetCheck(def: { program: string; args: string[] }, cwd: string): Promise<ScriptVetting> {
  const findings: ScriptFinding[] = [];
  const executes: { label: string; command: string }[] = [{ label: 'command', command: [def.program, ...def.args].join(' ') }];
  const notes: string[] = [];
  findings.push(...scan([def.program, ...def.args].join(' '), 'check command'));
  const prog = basename(def.program).replace(/\.(cmd|exe|bat)$/i, '').toLowerCase();

  // a program inside the project is a project script/binary: inspect its content
  if (def.program.includes('/') || def.program.includes('\\')) {
    const abs = isAbsolute(def.program) ? def.program : resolve(cwd, def.program);
    if (isInside(abs, cwd)) {
      try {
        const st = await stat(abs);
        const buf = await readFile(abs);
        const text = buf.subarray(0, 200_000).toString('utf8');
        const binary = buf.subarray(0, 8000).includes(0);
        if (binary) findings.push({ severity: 'high', text: 'an unknown executable file from the project', where: def.program });
        else {
          executes.push({ label: `project script ${def.program}`, command: text.slice(0, 4000) });
          findings.push(...scan(text, def.program));
        }
        if (st.size > 200_000) notes.push(`${def.program}: the first 200 KB were checked.`);
      } catch {
        findings.push({ severity: 'high', text: 'the program file was not found in the project', where: def.program });
      }
    }
  }

  if (prog === 'npx') findings.push({ severity: 'high', text: 'npx can download and run a package from the internet', where: 'check command' });

  if (PACKAGE_MANAGERS.has(prog)) {
    const a = def.args.filter((x) => !x.startsWith('-'));
    let script: string | null = null;
    if (a[0] === 'test' || a[0] === 't') script = 'test';
    else if (a[0] === 'run' || a[0] === 'run-script') script = a[1] ?? null;
    else if (prog !== 'npm' && a[0] && !['install', 'i', 'add', 'ci'].includes(a[0])) script = a[0]; // yarn <script>, pnpm <script>
    if (script) {
      try {
        const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
        const scripts = pkg.scripts ?? {};
        for (const name of [`pre${script}`, script, `post${script}`]) {
          if (scripts[name] === undefined) continue;
          executes.push({ label: `package.json script "${name}"`, command: scripts[name]! });
          findings.push(...scan(scripts[name]!, `package.json → ${name}`));
          // a script invoking a project file: inspect that file as well
          for (const m of scripts[name]!.matchAll(/(?:^|\s)(?:node|bash|sh|python3?)\s+([\w./-]+\.(?:js|mjs|cjs|sh|py))/g)) {
            try {
              const file = resolve(cwd, m[1]!);
              if (!isInside(file, cwd)) continue;
              const text = (await readFile(file, 'utf8')).slice(0, 200_000);
              executes.push({ label: `file ${m[1]}`, command: text.slice(0, 4000) });
              findings.push(...scan(text, m[1]!));
            } catch {
              notes.push(`The file ${m[1]} from the script "${name}" was not read.`);
            }
          }
        }
        if (scripts[script] === undefined) findings.push({ severity: 'medium', text: `package.json has no script "${script}"`, where: 'package.json' });
      } catch {
        notes.push('package.json was not found or cannot be read: the scripts are unknown.');
      }
      notes.push('The code of the tests and the dependencies is not fully analyzed: the check runs only in a work copy.');
    }
  }
  if (['pytest', 'python', 'python3', 'cargo', 'go', 'make', 'gradle', 'mvn', 'dotnet'].includes(prog)) notes.push('The content of tests and build files is not analyzed automatically: the check runs only in a work copy.');
  if (prog === 'make') {
    try {
      const mk = await readFile(join(cwd, 'Makefile'), 'utf8');
      executes.push({ label: 'Makefile', command: mk.slice(0, 4000) });
      findings.push(...scan(mk, 'Makefile'));
    } catch {
      // no Makefile
    }
  }
  const uniq = new Map(findings.map((f) => [`${f.where}|${f.text}`, f]));
  const list = [...uniq.values()];
  return { autoRun: !list.some((f) => f.severity === 'high'), executes, findings: list, contentHash: sha256(JSON.stringify(executes)), notes };
}
