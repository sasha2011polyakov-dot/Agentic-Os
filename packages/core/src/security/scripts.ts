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
  { re: /\b(sudo|doas|runas)\b|\bsu\s+-?\w/, severity: 'high', text: 'повышение привилегий' },
  { re: /\brm\s+-[a-z]*[rf][a-z]*\s+(\/|~|\$HOME|\.\.|\*)|\bdel\s+\/[sq]|\brmdir\s+\/s|Remove-Item\b.*-Recurse/i, severity: 'high', text: 'массовое удаление файлов' },
  { re: /\b(curl|wget|Invoke-WebRequest|iwr|Invoke-RestMethod|certutil|bitsadmin)\b/i, severity: 'high', text: 'загрузка или отправка данных по сети' },
  { re: /\|\s*(sh|bash|zsh|dash|powershell|pwsh|python3?|node)\b/, severity: 'high', text: 'выполнение загруженного или сгенерированного кода через конвейер' },
  { re: /\b(nc|ncat|netcat|socat|ssh|scp|sftp|rsync|ftp|telnet)\b/, severity: 'high', text: 'сетевые утилиты удалённого доступа' },
  { re: /\bchmod\s+(-R\s+)?(777|\+s)|\bchown\b|\bsetfacl\b|\bicacls\b/, severity: 'high', text: 'изменение прав доступа' },
  { re: /\bmkfs\b|\bdd\s+if=|\bformat\s+[a-z]:|\bdiskpart\b|\bfdisk\b/i, severity: 'high', text: 'операции с дисками' },
  { re: /base64\s+(-d|--decode)|frombase64string/i, severity: 'high', text: 'декодирование скрытого кода' },
  { re: /\.ssh\/|id_rsa|id_ed25519|\/etc\/(passwd|shadow)|\.aws\/credentials|\.npmrc|\.netrc|\.git-credentials|keychain/i, severity: 'high', text: 'обращение к учётным данным' },
  { re: /\bgit\s+(push|reset|clean|checkout|switch|rebase|commit|merge|remote|config|tag|stash|filter-branch|gc|prune|update-ref)\b/, severity: 'high', text: 'изменение Git-репозитория' },
  { re: /\b(npm|pnpm|yarn|bun)\s+(publish|unpublish|deprecate|owner|token|login|adduser)\b|\bnpx\s+(-y|--yes)\b/, severity: 'high', text: 'публикация или загрузка пакетов' },
  { re: /\b(shutdown|reboot|halt|systemctl|launchctl|service\s+\w+\s+(start|stop)|reg\s+(add|delete)|setx|crontab|schtasks)\b/i, severity: 'high', text: 'изменение системных настроек или служб' },
  { re: /\bdocker\s+(run|push|login|exec)\b|\bkubectl\b|\bterraform\s+(apply|destroy)\b|\baws\s|\bgcloud\s|\baz\s/, severity: 'high', text: 'действия с внешней инфраструктурой' },
  { re: /\beval\b|\bexec\s*\(|child_process|subprocess|os\.system|Function\s*\(/, severity: 'medium', text: 'динамическое выполнение кода' },
  { re: /\b(npm|pnpm|yarn|bun|pip3?|poetry|gem|cargo|go)\s+(install|i|add|ci|get|update|upgrade)\b/, severity: 'medium', text: 'установка или обновление зависимостей (сеть, скрипты пакетов)' },
  { re: /\bprintenv\b|\benv\s*\||process\.env\b|os\.environ/, severity: 'medium', text: 'чтение переменных окружения' },
  { re: /\bnode\s+-e\b|\bpython3?\s+-c\b|\bperl\s+-e\b|\bruby\s+-e\b/, severity: 'medium', text: 'однострочный исполняемый код' },
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
  const executes: { label: string; command: string }[] = [{ label: 'команда', command: [def.program, ...def.args].join(' ') }];
  const notes: string[] = [];
  findings.push(...scan([def.program, ...def.args].join(' '), 'команда проверки'));
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
        if (binary) findings.push({ severity: 'high', text: 'неизвестный исполняемый файл из проекта', where: def.program });
        else {
          executes.push({ label: `скрипт проекта ${def.program}`, command: text.slice(0, 4000) });
          findings.push(...scan(text, def.program));
        }
        if (st.size > 200_000) notes.push(`${def.program}: проверены первые 200 КБ.`);
      } catch {
        findings.push({ severity: 'high', text: 'файл программы не найден в проекте', where: def.program });
      }
    }
  }

  if (prog === 'npx') findings.push({ severity: 'high', text: 'npx может загрузить и выполнить пакет из интернета', where: 'команда проверки' });

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
          executes.push({ label: `скрипт package.json «${name}»`, command: scripts[name]! });
          findings.push(...scan(scripts[name]!, `package.json → ${name}`));
          // a script invoking a project file: inspect that file as well
          for (const m of scripts[name]!.matchAll(/(?:^|\s)(?:node|bash|sh|python3?)\s+([\w./-]+\.(?:js|mjs|cjs|sh|py))/g)) {
            try {
              const file = resolve(cwd, m[1]!);
              if (!isInside(file, cwd)) continue;
              const text = (await readFile(file, 'utf8')).slice(0, 200_000);
              executes.push({ label: `файл ${m[1]}`, command: text.slice(0, 4000) });
              findings.push(...scan(text, m[1]!));
            } catch {
              notes.push(`Файл ${m[1]} из скрипта «${name}» не прочитан.`);
            }
          }
        }
        if (scripts[script] === undefined) findings.push({ severity: 'medium', text: `в package.json нет скрипта «${script}»`, where: 'package.json' });
      } catch {
        notes.push('package.json не найден или не читается: состав скриптов неизвестен.');
      }
      notes.push('Код тестов и зависимостей не анализируется полностью: проверка выполняется только в рабочей копии.');
    }
  }
  if (['pytest', 'python', 'python3', 'cargo', 'go', 'make', 'gradle', 'mvn', 'dotnet'].includes(prog)) notes.push('Содержимое тестов и сборочных файлов не анализируется автоматически: проверка выполняется только в рабочей копии.');
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
