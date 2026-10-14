import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { services } from '../src/wiring.ts';
import { appAI } from '../src/ai/app-ai.ts';
import { registerTestResponder, resetTestProvider } from '../src/ai/providers/test.ts';
import type { ChatRequest } from '../src/ai/types.ts';
import type { MissionView } from '../src/missions/types.ts';
import type { MissionStatus } from '../src/missions/state.ts';
import { MISSION_AGENTS } from '../src/missions/plan.ts';
import { hashTree, startTestApp, waitFor, type TestApp } from './helpers.ts';
import { writeProject } from './fixtures/project.ts';

const ENV = { AOS_ENABLE_TEST_PROVIDER: '1' };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  resetTestProvider();
});

type Ctx = { call: number; round: number; req: ChatRequest };

/** Scripted built-in agent (matched by its display name). `fn` returns the raw model answer object. */
function agent(name: string, fn: (input: Record<string, unknown>, ctx: Ctx) => unknown): { calls: Record<string, unknown>[] } {
  let n = 0;
  const calls: Record<string, unknown>[] = [];
  cleanups.push(
    registerTestResponder(
      (req) => (req.system ?? '').includes(`агента «${name}»`),
      async (req) => {
        const m = /<untrusted_content source="input">\n([\s\S]*?)\n<\/untrusted_content>/.exec(req.messages[0]!.content);
        const input = m ? (JSON.parse(m[1]!) as Record<string, unknown>) : {};
        const round = Math.floor(req.messages.length / 2);
        if (round === 0) calls.push(input);
        return JSON.stringify(await fn(input, { call: n++, round, req }));
      },
    ),
  );
  return { calls };
}

const final = (result: unknown) => ({ action: 'final', tool_calls: [], result });
const toolCalls = (list: { tool: string; args: unknown }[]) => ({ action: 'tool_calls', tool_calls: list.map((c) => ({ tool: c.tool, arguments_json: JSON.stringify(c.args) })), result: null });

const NEEDS = { project_exploration: false, local_research: false, web_research: false, alternatives: false, implementation: false, independent_review: false };
function analysis(o: Record<string, unknown> & { needs?: Partial<typeof NEEDS> } = {}) {
  return {
    title: 'Задача',
    task_type: 'research',
    desired_outcome: 'Результат по задаче',
    problem: '',
    requirements: [{ id: 'R1', text: 'Сделать то, что просит пользователь', source: 'request' }],
    constraints: [],
    assumptions: [],
    acceptance_criteria: [{ id: 'AC1', text: 'Результат соответствует запросу', verification: 'review' }],
    risks: [],
    questions: [],
    complexity: 'simple',
    summary_for_user: 'Понял задачу.',
    ...o,
    needs: { ...NEEDS, ...(o.needs ?? {}) },
  };
}

function step(id: string, role: string, title: string, deps: string[] = [], extra: Record<string, unknown> = {}) {
  return { id, title, goal: title, role, inputs: [], expected_output: 'результат', depends_on: deps, tools: [], done_criteria: ['готово'], verification: 'проверка', risk: 'low', keep_existing: false, ...extra };
}

const verdict = (items: [string, string, string][], problems: unknown[] = []) => ({ criteria: items.map(([id, status, evidence]) => ({ id, status, evidence, notes: '' })), problems, regressions_suspected: [], overall: problems.length ? 'fail' : 'pass' });
const impl = (summary: string, target: string) => ({ summary, actions: [{ type: 'proposed_change', target, description: summary }], artifacts: [], problems: [], unverified: [], next_steps: [] });
const ev = (id: string, ref: string, quote: string, type = 'document') => ({ id, fact: quote, kind: 'fact', source: { type, ref, title: ref }, quote, relevance: 'high', confidence: 0.9, needs_verification: false });

/** Neutral defaults for every mission agent; each scenario overrides what it tests. */
function defaults(): void {
  agent('Аналитик поручения', () => analysis());
  agent('Исследователь проекта', () => final({ findings: [], relevant_files: [], existing_solutions: [], architecture_notes: [], unread: [], limitations: [] }));
  agent('Исследователь', () => final({ evidence: [], gaps: [] }));
  agent('Веб-исследователь', () => final({ sources: [], claims: [], conflicts: [], coverage: 0, gaps: [] }));
  agent('Архитектор решений', () => ({ options: [option('O1', 'reuse', 'Использовать существующее')], selected: 'O1', rationale: 'Самый простой путь', tradeoffs: [], needs_user_approval: false, approval_reason: null }));
  agent('Планировщик поручения', () => ({ steps: [step('S1', 'documenter', 'Подготовить материал'), step('S2', 'verifier', 'Проверка', ['S1'])], notes: [] }));
  agent('Исполнитель', () => final({ summary: 'ничего', actions: [], artifacts: [], problems: [], unverified: [], next_steps: [] }));
  agent('Проверяющий результат', (input) => final(verdict(((input.acceptance_criteria as { id: string }[]) ?? []).map((c) => [c.id, 'met', 'проверено по результатам шагов']))));
  agent('Ревьюер безопасности', () => ({ risks: [], verdict: 'ok' }));
  agent('Документатор', (input) => ({ title: 'Материал по задаче', markdown: `# Материал\n\n${String(input.objective)}\n`, target_folder: 'Reports' }));
  agent('Независимый ревьюер поручения', () => ({ verdict: 'pass', distortions: [], defects: [], notes: 'Смысл задачи сохранён.' }));
  agent('Консультант поручения', () => ({ answer: 'Ответ консультанта.', references: [], suggested_actions: [] }));
}

function option(id: string, kind: string, name: string) {
  return { id, name, kind, description: `${name}: описание`, covers_requirements: ['R1'], pros: ['быстро'], cons: ['ограничения'], risks: [], scores: { requirements: 4, compatibility: 4, reliability: 4, security: 4, performance: 4, maintainability: 4, license: 5, dependencies: 4, cost: 4, local_mode: 5, offline: 5, complexity: 3 }, evidence: [] };
}

async function setup(opts: { projects?: string[]; agents?: boolean } = {}) {
  const t: TestApp = await startTestApp({ env: ENV });
  cleanups.push(() => t.cleanup());
  const sys = await t.core.systems.create({ name: 'Работа', storagePath: t.sysDir('work'), template: 'empty' });
  const rt = await t.core.systems.runtime(sys.systemId);
  const s = services(rt);
  const projects: { id: string; dir: string }[] = [];
  for (const name of opts.projects ?? []) {
    const dir = join(t.root, name);
    await writeProject(dir);
    const id = (await s.sources.connect({ path: dir, name })).id;
    await waitFor(() => s.sources.get(id).status === 'ready', { message: `${name} indexed` });
    projects.push({ id, dir });
  }
  if (opts.agents !== false) await s.missions.setupAgents();
  return { t, rt, s, systemId: sys.systemId, projects };
}

type S = ReturnType<typeof services>;

async function waitMission(s: S, id: string, statuses: MissionStatus[], timeoutMs = 20_000): Promise<MissionView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const m = s.missions.get(id);
    if (statuses.includes(m.status)) return m;
    if (['needs_input', 'failed', 'cancelled', 'completed', 'partially_completed'].includes(m.status) && !statuses.includes(m.status)) {
      // fail fast with the whole story instead of waiting for the timeout
      throw new Error(`mission is ${m.status}: ${m.statusReason} | pending=${JSON.stringify(m.pending?.message)} | error=${JSON.stringify(m.error)} | steps=${m.steps.map((x) => `${x.planStep ?? x.role}:${x.status}${x.error ? `(${x.error.message})` : ''}`).join(',')}`);
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${statuses.join('|')}: now ${m.status}/${m.phase} ${m.statusReason ?? ''} steps=${m.steps.map((x) => `${x.planStep ?? x.role}:${x.status}`).join(',')}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

const original = (dir: string) => hashTree(dir, { skip: (r) => r.startsWith('.git/') });

describe('28.17 missions: natural-language assignments end to end', () => {
  it('1. research a question and prepare a report: quotes verified in code, one useful document', async () => {
    const { s } = await setup();
    const d1 = await s.docs.create({ title: 'Сессии', folder: 'Notes', content: '# Сессии\n\nСессия должна истекать через 30 минут бездействия.\n' });
    const d2 = await s.docs.create({ title: 'Хранилище сессий', folder: 'Notes', content: '# Хранилище\n\nСессии хранятся в Redis с репликацией между узлами.\n' });
    defaults();
    agent('Аналитик поручения', () => analysis({ task_type: 'research', title: 'Хранение сессий', needs: { local_research: true }, acceptance_criteria: [{ id: 'AC1', text: 'Отчёт сохранён в базе знаний', verification: 'artifact_exists' }, { id: 'AC2', text: 'Выводы подтверждены источниками', verification: 'source_verification' }] }));
    const researcher = agent('Исследователь', (_i, { round }) =>
      round === 0
        ? toolCalls([{ tool: 'search_documents', args: { query: 'сессии' } }])
        : final({ evidence: [ev('E1', d1.id, 'Сессия должна истекать через 30 минут бездействия'), ev('E2', d2.id, 'Сессии хранятся в Redis с репликацией между узлами'), ev('E3', d2.id, 'Сессии шифруются алгоритмом из 2031 года')], gaps: ['нет данных о шифровании'] }),
    );
    const documenter = agent('Документатор', () => ({ title: 'Отчёт о хранении сессий', markdown: '# Отчёт о хранении сессий\n\nСессия живёт 30 минут, данные лежат в Redis.\n', target_folder: 'Reports' }));
    agent('Проверяющий результат', () => final(verdict([['AC1', 'met', 'Документ Reports/Отчёт о хранении сессий.md создан'], ['AC2', 'met', 'E1 и E2 подтверждены цитатами']])));

    const m0 = await s.missions.create({ request: 'Исследуй, как в наших заметках описаны хранение и срок жизни сессий, и подготовь отчёт.' });
    expect(m0.originalRequest).toContain('срок жизни сессий');
    const m = await waitMission(s, m0.id, ['completed', 'partially_completed']);
    expect(m.status, m.statusReason ?? '').toBe('completed');
    expect(m.normalized?.task_type).toBe('research');
    expect(m.originalRequest).toBe('Исследуй, как в наших заметках описаны хранение и срок жизни сессий, и подготовь отчёт.'); // kept verbatim, separate from the model
    expect(researcher.calls.length).toBe(1);
    const evidence = (m.context as { local: { evidence: { id: string; verified: boolean; kind: string }[] } }).local.evidence;
    expect(evidence.find((e) => e.id === 'E1')!.verified).toBe(true);
    // an invented quote is not a fact
    expect(evidence.find((e) => e.id === 'E3')).toMatchObject({ verified: false, kind: 'assumption' });
    expect(m.criteria.map((c) => c.status)).toEqual(['met', 'met']);
    expect(documenter.calls.length).toBe(1);
    const docs = s.docs.list({ folder: 'Reports' }).items;
    expect(docs.map((d) => d.title)).toEqual(['Отчёт о хранении сессий']);
    // the documenter's document is the result: no second, duplicate report
    expect(m.reportDocId).toBeNull();
    expect(s.docs.list({ folder: 'Missions' }).total).toBe(0);
    expect(m.summary?.documents[0]?.path).toContain('Reports/');
    expect(m.progress.phases.map((p) => p.phase)).toEqual(['analysis', 'context', 'planning', 'execution', 'verification', 'summary']);
    expect(m.progress.phases.every((p) => p.state === 'done')).toBe(true);
  });

  it('2. find an existing solution and compare alternatives (plan mode, nothing changed)', async () => {
    const { s, projects } = await setup({ projects: ['shop'] });
    const p = projects[0]!;
    const before = await original(p.dir);
    defaults();
    agent('Аналитик поручения', () => analysis({ task_type: 'design', title: 'Восстановление пароля', needs: { project_exploration: true, alternatives: true }, acceptance_criteria: [{ id: 'AC1', text: 'Есть сравнение вариантов', verification: 'review' }] }));
    const explorer = agent('Исследователь проекта', (input, { round }) =>
      round === 0
        ? toolCalls([{ tool: 'read_project_file', args: { sourceId: p.id, path: 'src/auth.ts' } }])
        : final({ findings: [{ id: 'F1', text: 'Есть AuthService.login', evidence: [] }], relevant_files: [{ source_id: (input.projects as { sourceId: string }[])[0]!.sourceId, path: 'src/auth.ts', why: 'сервис входа' }], existing_solutions: [{ description: 'AuthService можно расширить', location: 'src/auth.ts', fit: 'partial' }], architecture_notes: ['Node.js'], unread: [], limitations: [] }),
    );
    const architect = agent('Архитектор решений', (input) => {
      expect((input.findings as { kind: string }[]).some((f) => f.kind === 'existing_solution')).toBe(true);
      return { options: [option('O1', 'extend', 'Расширить AuthService'), option('O2', 'integrate_library', 'Подключить библиотеку'), option('O3', 'new_component', 'Новый сервис')], selected: 'O1', rationale: 'Существующий сервис покрывает большую часть требований', tradeoffs: ['меньше гибкости'], needs_user_approval: false, approval_reason: null };
    });
    agent('Планировщик поручения', (input) => {
      expect(input.mode).toBe('plan');
      return { steps: [step('S1', 'project-explorer', 'Уточнить точки интеграции'), step('S2', 'documenter', 'Описать решение', ['S1'])], notes: [] };
    });
    const m0 = await s.missions.create({ request: 'Найди, есть ли у нас готовое решение для восстановления пароля, и сравни варианты.', mode: 'plan', scope: { sourceIds: [p.id] } });
    const m = await waitMission(s, m0.id, ['completed', 'partially_completed']);
    expect(m.status, m.statusReason ?? '').toBe('completed');
    expect(explorer.calls.length).toBe(1);
    expect(architect.calls.length).toBe(1);
    expect(m.options.map((o) => o.kind)).toEqual(['extend', 'integrate_library', 'new_component']);
    expect(m.strategy).toMatchObject({ selected: 'O1', selectedBy: 'architect' });
    expect(m.plan.map((x) => x.id)).toEqual(['S1', 'S2']);
    // plan mode: nothing executed, criteria are about the future implementation
    expect(m.steps.filter((x) => x.phase === 'execution').every((x) => x.status === 'pending')).toBe(true);
    expect(m.criteria.every((c) => c.status === 'not_applicable')).toBe(true);
    expect(m.artifacts.filter((a) => a.type === 'change_set')).toEqual([]);
    expect(await original(p.dir)).toEqual(before);
    // one report with the comparison
    const report = await s.docs.get(m.reportDocId!);
    expect(report.relPath.startsWith('Missions/')).toBe(true);
    expect(report.content).toContain('Рассмотренные варианты');
    expect(report.content).toContain('O1. Расширить AuthService — выбран');
    expect(report.content).toContain('Подключить библиотеку');
  });

  it('3. implement a function in a connected repository: checks in a work copy, apply only by decision', async () => {
    const { s, projects } = await setup({ projects: ['shop'] });
    const p = projects[0]!;
    s.sources.setAccessMode(p.id, 'apply', { actor: 'user', confirm: true });
    await s.sources.update(p.id, { checks: [{ name: 'reset', program: process.execPath, args: ['-e', "const t=require('fs').readFileSync('src/auth.ts','utf8'); process.exit(t.includes('resetPassword')?0:1)"] }] });
    defaults();
    agent('Аналитик поручения', () => analysis({ task_type: 'implementation', title: 'Сброс пароля', needs: { project_exploration: true, implementation: true }, acceptance_criteria: [{ id: 'AC1', text: 'Метод resetPassword добавлен и проверка проходит', verification: 'check_command' }, { id: 'AC2', text: 'Вход не сломан', verification: 'review' }] }));
    agent('Исследователь проекта', () => final({ findings: [{ id: 'F1', text: 'AuthService в src/auth.ts', evidence: [] }], relevant_files: [{ source_id: p.id, path: 'src/auth.ts', why: 'сюда добавить метод' }], existing_solutions: [], architecture_notes: [], unread: [], limitations: [] }));
    agent('Планировщик поручения', () => ({ steps: [step('S1', 'implementer', 'Добавить resetPassword', [], { risk: 'medium' }), step('S2', 'verifier', 'Проверка', ['S1'])], notes: [] }));
    const newAuth = `// Implements REQ-001: login by email and password\nexport class AuthService {\n  login(email: string, password: string) {\n    return email.length > 0 && password.length > 0;\n  }\n\n  resetPassword(email: string) {\n    return email.includes('@');\n  }\n}\n\nexport function logout(): void {}\n`;
    const implementer = agent('Исполнитель', (input, { round }) => {
      expect((input.context_files as { path: string }[]).map((f) => f.path)).toContain('src/auth.ts');
      return round === 0 ? toolCalls([{ tool: 'propose_file_change', args: { sourceId: p.id, path: 'src/auth.ts', op: 'modify', content: newAuth, rationale: 'метод сброса пароля' } }]) : final(impl('Добавлен resetPassword', 'src/auth.ts'));
    });
    agent('Проверяющий результат', (input) => {
      const checks = input.check_results as { name: string; status: string }[];
      expect(checks.find((c) => c.name === 'reset')?.status).toBe('passed');
      return final(verdict([['AC1', 'met', 'проверка reset пройдена в рабочей копии'], ['AC2', 'met', 'login не изменён (diff)']]));
    });
    const before = await original(p.dir);
    const m0 = await s.missions.create({ request: 'Добавь в AuthService метод resetPassword.', scope: { sourceIds: [p.id] }, policy: { preapprovedChecks: [{ sourceId: p.id, name: 'reset' }] } });
    let m = await waitMission(s, m0.id, ['awaiting_approval']);
    expect(m.pending?.kind).toBe('apply_changes');
    expect(implementer.calls.length).toBe(1);
    expect(m.checks.find((c) => c.kind === 'command' && c.name === 'reset')?.status).toBe('passed');
    expect(m.criteria.map((c) => c.status)).toEqual(['met', 'met']);
    // nothing reached the original project before the explicit decision
    expect(await original(p.dir)).toEqual(before);
    m = await s.missions.decide(m.id, { decision: 'apply', pendingId: m.pending!.id });
    m = await waitMission(s, m.id, ['completed', 'partially_completed']);
    expect(m.status, m.statusReason ?? '').toBe('completed');
    expect(await readFile(join(p.dir, 'src/auth.ts'), 'utf8')).toContain('resetPassword');
    const set = m.artifacts.find((a) => a.type === 'change_set')!;
    expect(set.status).toBe('applied');
    expect(s.changes.get(set.ref).backupId).toBeTruthy();
    expect(m.summary?.files).toEqual([{ path: 'src/auth.ts', source: 'shop', op: 'modify', status: 'применено к проекту' }]);
  });

  it('4. fix a bug: failing regression check → bounded fix round → passing check (original untouched)', async () => {
    const { s, projects } = await setup({ projects: ['shop'] });
    const p = projects[0]!;
    s.sources.setAccessMode(p.id, 'workcopy', { actor: 'user' });
    await s.sources.update(p.id, { checks: [{ name: 'tests', program: process.execPath, args: ['-e', "const t=require('fs').readFileSync('src/auth.ts','utf8'); if(!t.includes('password.length >= 8')){console.error('FAIL: короткий пароль принимается'); process.exit(1)}"] }] });
    defaults();
    agent('Аналитик поручения', () => analysis({ task_type: 'bugfix', title: 'Короткие пароли', needs: { project_exploration: true, implementation: true }, acceptance_criteria: [{ id: 'AC1', text: 'Пароль короче 8 символов отклоняется (регрессионная проверка проходит)', verification: 'check_command' }] }));
    agent('Планировщик поручения', () => ({ steps: [step('S1', 'implementer', 'Исправить проверку пароля'), step('S2', 'verifier', 'Проверка', ['S1'])], notes: [] }));
    const fixed = (cond: string) => `export class AuthService {\n  login(email: string, password: string) {\n    return email.length > 0 && ${cond};\n  }\n}\n`;
    const implementer = agent('Исполнитель', (input, { round }) => {
      const isFix = (input.step as { id: string }).id === 'FIX1';
      if (isFix) expect((input.feedback as string[]).join(' ')).toContain('короткий пароль принимается');
      return round === 0 ? toolCalls([{ tool: 'propose_file_change', args: { sourceId: p.id, path: 'src/auth.ts', op: 'modify', content: fixed(isFix ? 'password.length >= 8' : 'password.length > 0'), rationale: 'исправление' } }]) : final(impl(isFix ? 'Исправлена граница' : 'Исправлено', 'src/auth.ts'));
    });
    agent('Проверяющий результат', (input) => {
      const passed = (input.check_results as { name: string; status: string }[]).some((c) => c.name === 'tests' && c.status === 'passed');
      return final(passed ? verdict([['AC1', 'met', 'tests пройдена']]) : verdict([['AC1', 'not_met', 'tests не пройдена']], [{ severity: 'major', description: 'Регрессионная проверка падает', step_id: 'S1', fix_hint: 'проверять длину ≥ 8' }]));
    });
    const before = await original(p.dir);
    const m0 = await s.missions.create({ request: 'Исправь ошибку: система принимает пароли короче 8 символов.', scope: { sourceIds: [p.id] }, policy: { preapprovedChecks: [{ sourceId: p.id, name: 'tests' }] } });
    const m = await waitMission(s, m0.id, ['completed', 'partially_completed', 'failed']);
    expect(m.status, m.statusReason ?? '').toBe('completed');
    expect(m.fixRounds).toBe(1);
    expect(implementer.calls.length).toBe(2);
    const cmd = m.checks.filter((c) => c.kind === 'command' && c.name === 'tests');
    expect(cmd.map((c) => `${c.round}:${c.status}`)).toEqual(['0:failed', '1:passed']);
    expect(m.progress.phases.map((x) => x.phase)).toContain('fix');
    // the fix lives in the work copy and the change set; the original project is untouched
    expect(await original(p.dir)).toEqual(before);
    const wc = s.workcopies.list(p.id)[0]!;
    expect(await readFile(join(wc.rootPath, 'src/auth.ts'), 'utf8')).toContain('password.length >= 8');
    expect(m.summary?.nextSteps.join(' ')).toContain('не применены');
    expect(m.pending).toBeNull(); // mode «Работать в копии» never offers to write the original
  });

  it('5. a new function with no existing component: honest partial result when checks cannot run', async () => {
    const { s, projects } = await setup({ projects: ['shop'] });
    const p = projects[0]!;
    s.sources.setAccessMode(p.id, 'prepare', { actor: 'user' });
    await s.sources.update(p.id, { checks: [{ name: 'tests', program: process.execPath, args: ['-e', 'process.exit(0)'] }] });
    defaults();
    agent('Аналитик поручения', () => analysis({ task_type: 'implementation', title: 'Экспорт заказов', needs: { project_exploration: true, implementation: true, alternatives: true }, acceptance_criteria: [{ id: 'AC1', text: 'Модуль экспорта создан', verification: 'artifact_exists' }, { id: 'AC2', text: 'Экспорт проходит тесты', verification: 'check_command' }] }));
    agent('Исследователь проекта', () => final({ findings: [{ id: 'F1', text: 'Экспорта нет', evidence: [] }], relevant_files: [], existing_solutions: [], architecture_notes: [], unread: [], limitations: [] }));
    agent('Архитектор решений', () => ({ options: [option('O1', 'new_component', 'Новый модуль export.ts'), option('O2', 'integrate_library', 'Библиотека CSV')], selected: 'O1', rationale: 'Готового компонента нет, задача небольшая', tradeoffs: ['свой код поддерживать'], needs_user_approval: false, approval_reason: null }));
    agent('Планировщик поручения', () => ({ steps: [step('S1', 'implementer', 'Создать модуль экспорта'), step('S2', 'verifier', 'Проверка', ['S1'])], notes: [] }));
    agent('Исполнитель', (_i, { round }) => (round === 0 ? toolCalls([{ tool: 'propose_file_change', args: { sourceId: p.id, path: 'src/export.ts', op: 'create', content: 'export function exportOrders(): string { return "id\\n"; }\n', rationale: 'новый модуль' } }]) : final(impl('Создан src/export.ts', 'src/export.ts'))));
    // the verifier over-claims: the guard does not accept «met» without checks that actually ran
    agent('Проверяющий результат', () => final(verdict([['AC1', 'met', 'файл создан'], ['AC2', 'met', 'тесты наверняка проходят']])));
    const m0 = await s.missions.create({ request: 'Сделай экспорт заказов в CSV — такого в проекте ещё нет.', scope: { sourceIds: [p.id] } });
    const m = await waitMission(s, m0.id, ['completed', 'partially_completed', 'failed']);
    expect(m.status).toBe('partially_completed');
    expect(m.strategy?.option?.kind).toBe('new_component');
    const c2 = m.criteria.find((c) => c.id === 'AC2')!;
    expect(c2.status).toBe('unverifiable');
    expect(c2.notes).toContain('не запускались');
    expect(m.criteria.find((c) => c.id === 'AC1')!.status).toBe('partially_met'); // prepared, not applied anywhere
    expect(m.summary?.checksNotRun.some((x) => x.reason.includes('не позволяет рабочую копию'))).toBe(true);
    expect(m.fixRounds).toBe(0); // nothing a fix round could change
    expect(m.summary?.statusReason).toContain('AC2');
    expect(m.reportDocId).toBeNull(); // implementation task: the change set is the result
  });

  it('6. improve the architecture: strategy choice by the user, risky plan confirmed with checks, independent review', async () => {
    const { s, projects } = await setup({ projects: ['shop'] });
    const p = projects[0]!;
    s.sources.setAccessMode(p.id, 'workcopy', { actor: 'user' });
    await s.sources.update(p.id, { checks: [{ name: 'tests', program: process.execPath, args: ['-e', 'process.exit(0)'] }] });
    defaults();
    agent('Аналитик поручения', () => analysis({ task_type: 'improvement', title: 'Слой сессий', complexity: 'complex', needs: { project_exploration: true, implementation: true, alternatives: true, independent_review: true }, acceptance_criteria: [{ id: 'AC1', text: 'Проверки проходят после изменения', verification: 'check_command' }] }));
    const architect = agent('Архитектор решений', () => ({ options: [option('O1', 'extend', 'Расширить AuthService'), option('O2', 'new_component', 'Отдельный SessionService')], selected: 'O1', rationale: 'меньше изменений', tradeoffs: [], needs_user_approval: true, approval_reason: 'Меняется архитектура модуля авторизации' }));
    const planner = agent('Планировщик поручения', (input) => {
      expect((input.strategy as { selected: string }).selected).toBe('O2');
      return { steps: [step('S1', 'implementer', 'Выделить SessionService', [], { risk: 'high' }), step('S2', 'verifier', 'Проверка', ['S1'])], notes: [] };
    });
    agent('Исполнитель', (_i, { round }) => (round === 0 ? toolCalls([{ tool: 'propose_file_change', args: { sourceId: p.id, path: 'src/session.ts', op: 'create', content: 'export class SessionService {}\n', rationale: 'новый сервис' } }]) : final(impl('Выделен SessionService', 'src/session.ts'))));
    const reviewer = agent('Независимый ревьюер поручения', (input) => {
      expect(input.original_request).toContain('Улучши архитектуру');
      return { verdict: 'pass', distortions: [], defects: [], notes: 'ок' };
    });
    const m0 = await s.missions.create({ request: 'Улучши архитектуру работы с сессиями в проекте.', scope: { sourceIds: [p.id] } });
    let m = await waitMission(s, m0.id, ['awaiting_approval']);
    expect(m.pending?.kind).toBe('strategy');
    expect(planner.calls.length).toBe(0); // nothing is planned before the user decides
    m = await s.missions.decide(m.id, { decision: 'approve', optionId: 'O2', pendingId: m.pending!.id });
    m = await waitMission(s, m.id, ['awaiting_approval']);
    expect(m.pending?.kind).toBe('plan');
    expect(m.strategy).toMatchObject({ selected: 'O2', selectedBy: 'user' });
    expect(m.pending!.message).toContain('высокий риск');
    expect((m.pending!.data.checks as { name: string }[]).map((c) => c.name)).toEqual(['tests']);
    m = await s.missions.decide(m.id, { decision: 'approve', approvedChecks: [{ sourceId: p.id, name: 'tests' }] });
    m = await waitMission(s, m.id, ['completed', 'partially_completed']);
    expect(m.status, m.statusReason ?? '').toBe('completed');
    expect(architect.calls.length).toBe(1);
    expect(reviewer.calls.length).toBe(1);
    expect(m.progress.phases.map((x) => x.phase)).toEqual(['analysis', 'context', 'strategy', 'planning', 'execution', 'verification', 'review', 'summary']);
    expect(m.checks.find((c) => c.kind === 'command')?.status).toBe('passed');
    expect(m.reportDocId).toBeTruthy(); // complex task: one report
  });

  it('7. an ambiguous task asks one concrete question and continues with the answer', async () => {
    const { s } = await setup();
    defaults();
    const analyst = agent('Аналитик поручения', (input) => {
      const answers = (input.answers as { question: string; answer: string }[] | undefined) ?? [];
      if (!answers.length) return analysis({ questions: [{ text: 'Для кого отчёт: для разработчиков или для руководства?', blocking: true, default_assumption: null }, { text: 'Нужны ли графики?', blocking: false, default_assumption: 'без графиков' }] });
      expect(answers[0]).toEqual({ question: 'Для кого отчёт: для разработчиков или для руководства?', answer: 'для руководства' });
      return analysis({ title: 'Отчёт для руководства', questions: [{ text: 'Нужны ли графики?', blocking: false, default_assumption: 'без графиков' }] });
    });
    const m0 = await s.missions.create({ request: 'Сделай отчёт по проекту.', mode: 'plan' });
    let m = await waitMission(s, m0.id, ['needs_input']);
    expect(m.pending).toMatchObject({ kind: 'questions', message: 'Для кого отчёт: для разработчиков или для руководства?' });
    await expect(s.missions.decide(m.id, { decision: 'approve', answers: [] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    m = await s.missions.decide(m.id, { decision: 'approve', answers: [{ question: 'Для кого отчёт: для разработчиков или для руководства?', answer: 'для руководства' }] });
    m = await waitMission(s, m.id, ['completed', 'partially_completed']);
    expect(analyst.calls.length).toBe(2);
    expect(m.title).toBe('Отчёт для руководства');
    expect(m.assumptions.some((a) => a.includes('без графиков'))).toBe(true); // non-blocking: a stated assumption
    expect(s.missions.messages(m.id).some((x) => x.role === 'user' && x.body === 'для руководства')).toBe(true);
  });

  it('8. a task for several agents: independent steps run in parallel, results are combined', async () => {
    const { s, projects } = await setup({ projects: ['shop'] });
    const p = projects[0]!;
    defaults();
    agent('Аналитик поручения', () => analysis({ task_type: 'analysis', title: 'Обзор авторизации' }));
    agent('Планировщик поручения', () => ({ steps: [step('S1', 'researcher', 'Изучить требования'), step('S2', 'project-explorer', 'Изучить код'), step('S3', 'documenter', 'Свести результаты', ['S1', 'S2']), step('S4', 'verifier', 'Проверка', ['S3'])], notes: [] }));
    let started = 0;
    let overlapped = false;
    const both = gate();
    const parallelStep = async () => {
      started++;
      if (started === 2) {
        overlapped = true;
        both.open();
      }
      await Promise.race([both.wait, new Promise((r) => setTimeout(r, 3000))]);
    };
    agent('Исследователь', async () => {
      await parallelStep();
      return final({ evidence: [], gaps: ['требования неполные'] });
    });
    agent('Исследователь проекта', async () => {
      await parallelStep();
      return final({ findings: [{ id: 'F1', text: 'login без ограничения попыток', evidence: [] }], relevant_files: [], existing_solutions: [], architecture_notes: [], unread: [], limitations: [] });
    });
    const documenter = agent('Документатор', (input) => {
      const results = input.results as { step_id: string }[];
      expect(results.map((r) => r.step_id).sort()).toEqual(['S1', 'S2']);
      return { title: 'Обзор авторизации', markdown: '# Обзор\n\nНет ограничения попыток входа.\n', target_folder: 'Reports' };
    });
    const m0 = await s.missions.create({ request: 'Сделай обзор авторизации: требования и фактический код.', scope: { sourceIds: [p.id] } });
    const m = await waitMission(s, m0.id, ['completed', 'partially_completed']);
    expect(overlapped).toBe(true);
    expect(documenter.calls.length).toBe(1);
    const exec = m.steps.filter((x) => x.phase === 'execution');
    expect(exec.map((x) => `${x.planStep}:${x.role}:${x.status}`)).toEqual(['S1:researcher:completed', 'S2:project-explorer:completed', 'S3:documenter:completed', 'S4:verifier:skipped']);
    expect(new Set(exec.map((x) => x.agentId)).size).toBe(4);
  });

  it('9. pause and continue later: no new work starts while paused', async () => {
    const { s } = await setup();
    defaults();
    const g = gate();
    agent('Аналитик поручения', async () => {
      await g.wait;
      return analysis({ title: 'Пауза' });
    });
    const planner = agent('Планировщик поручения', () => ({ steps: [step('S1', 'documenter', 'Материал')], notes: [] }));
    const m0 = await s.missions.create({ request: 'Подготовь план работ по документации.', mode: 'plan' });
    await waitFor(() => s.missions.get(m0.id).steps.some((x) => x.status === 'running'));
    let m = await s.missions.pause(m0.id);
    expect(m.status).toBe('paused');
    g.open();
    await waitFor(() => s.missions.get(m0.id).steps.find((x) => x.role === 'mission-analyst')?.status === 'completed');
    await new Promise((r) => setTimeout(r, 300));
    m = s.missions.get(m0.id);
    expect(m.status).toBe('paused');
    expect(m.phase).toBe('planning'); // the cursor moved, the work did not
    expect(planner.calls.length).toBe(0);
    m = await s.missions.resume(m0.id);
    m = await waitMission(s, m.id, ['completed', 'partially_completed']);
    expect(planner.calls.length).toBe(1);
    expect(s.missions.events(m.id).some((e) => e.message.includes('Приостановлена'))).toBe(true);
  });

  it('10a. requirements change during execution: the plan is recalculated, completed steps are kept', async () => {
    const { s } = await setup();
    defaults();
    const g = gate();
    agent('Аналитик поручения', () => analysis({ task_type: 'research', title: 'Отчёт' }));
    const planner = agent('Планировщик поручения', (input, { call }) => {
      if (call === 0) return { steps: [step('S1', 'researcher', 'Собрать сведения'), step('S2', 'documenter', 'Написать отчёт', ['S1']), step('S3', 'verifier', 'Проверка', ['S2'])], notes: [] };
      expect((input.feedback as string[]).join(' ')).toContain('раздел о рисках');
      expect((input.completed_steps as { id: string }[]).map((x) => x.id)).toEqual(['S1']);
      return { steps: [step('S1', 'researcher', 'Собрать сведения', [], { keep_existing: true }), step('S2', 'documenter', 'Написать отчёт с разделом о рисках', ['S1']), step('S3', 'verifier', 'Проверка', ['S2'])], notes: [] };
    });
    const researcher = agent('Исследователь', async () => {
      await g.wait;
      return final({ evidence: [], gaps: [] });
    });
    const documenter = agent('Документатор', (input) => ({ title: 'Отчёт', markdown: `# Отчёт\n\n${String(input.objective)}\n\n## Риски\n\nНет.\n`, target_folder: 'Reports' }));
    const m0 = await s.missions.create({ request: 'Подготовь отчёт о состоянии документации.' });
    await waitFor(() => researcher.calls.length === 1);
    let m = s.missions.addRequirement(m0.id, { text: 'В отчёте должен быть раздел о рисках' });
    expect(m.planStale).toBe(true);
    expect(m.normalized?.requirements.some((r) => r.id === 'U1' && r.source === 'user')).toBe(true);
    g.open();
    m = await waitMission(s, m0.id, ['completed', 'partially_completed']);
    expect(planner.calls.length).toBe(2);
    expect(researcher.calls.length).toBe(1); // S1 was not repeated
    expect(documenter.calls.length).toBe(1);
    expect(documenter.calls[0]!.objective).toBe('Написать отчёт с разделом о рисках');
    expect(m.plan.find((x) => x.id === 'S2')?.title).toBe('Написать отчёт с разделом о рисках');
    expect(m.extraRequirements.map((x) => x.id)).toEqual(['U1']);
  });

  it('10b. a requirement that contradicts an earlier one is explained; the user decides', async () => {
    const { s } = await setup();
    defaults();
    agent('Аналитик поручения', () => analysis({ title: 'Хранение паролей', requirements: [{ id: 'R1', text: 'Пароли хранятся только в виде хеша', source: 'request' }] }));
    const g = gate();
    let plannerCalls = 0;
    agent('Планировщик поручения', async (input) => {
      plannerCalls++;
      if (plannerCalls === 1) {
        await g.wait;
        return { steps: [step('S1', 'documenter', 'Описать хранение')], notes: [] };
      }
      const fb = ((input.feedback as string[] | undefined) ?? []).join(' ');
      if (fb.includes('отменено пользователем')) return { steps: [step('S1', 'documenter', 'Описать хранение')], notes: [] };
      return { steps: [step('S1', 'documenter', 'Описать хранение')], notes: ['Конфликт: U1 (хранить пароли открытым текстом) противоречит R1 (только хеш). Предлагаю оставить R1.'] };
    });
    const m0 = await s.missions.create({ request: 'Опиши, как хранить пароли.', mode: 'plan' });
    await waitFor(() => plannerCalls === 1);
    s.missions.addRequirement(m0.id, { text: 'Хранить пароли открытым текстом для поддержки' });
    g.open();
    let m = await waitMission(s, m0.id, ['needs_input']);
    expect(m.pending?.kind).toBe('conflict');
    expect(m.pending?.message).toContain('противоречит R1');
    m = await s.missions.decide(m.id, { decision: 'reject', pendingId: m.pending!.id });
    m = await waitMission(s, m.id, ['completed', 'partially_completed']);
    expect(m.extraRequirements).toEqual([]);
    expect(m.normalized?.requirements.map((r) => r.id)).toEqual(['R1']);
  });

  it('11. a failing check triggers fix attempts; when they are exhausted the result is not reported as success', async () => {
    const { s, projects } = await setup({ projects: ['shop'] });
    const p = projects[0]!;
    s.sources.setAccessMode(p.id, 'workcopy', { actor: 'user' });
    await s.sources.update(p.id, { checks: [{ name: 'tests', program: process.execPath, args: ['-e', "console.error('1 test failed: login rejects empty email'); process.exit(1)"] }] });
    defaults();
    agent('Аналитик поручения', () => analysis({ task_type: 'bugfix', needs: { implementation: true }, acceptance_criteria: [{ id: 'AC1', text: 'Тесты проходят', verification: 'check_command' }] }));
    agent('Планировщик поручения', () => ({ steps: [step('S1', 'implementer', 'Исправить'), step('S2', 'verifier', 'Проверка', ['S1'])], notes: [] }));
    const implementer = agent('Исполнитель', (input, { round }) => (round === 0 ? toolCalls([{ tool: 'propose_file_change', args: { sourceId: p.id, path: 'src/auth.ts', op: 'modify', content: `export const attempt = "${String((input.step as { id: string }).id)}";\n`, rationale: 'попытка' } }]) : final(impl('Попытка исправления', 'src/auth.ts'))));
    // the verifier claims success in the second round — the failed check wins
    agent('Проверяющий результат', (_i, { call }) => final(call === 0 ? verdict([['AC1', 'not_met', 'tests падает']], [{ severity: 'major', description: 'tests падает', step_id: null, fix_hint: 'исправить login' }]) : verdict([['AC1', 'met', 'теперь всё хорошо']])));
    const m0 = await s.missions.create({ request: 'Почини падающий тест входа.', scope: { sourceIds: [p.id] }, policy: { maxFixRounds: 1, preapprovedChecks: [{ sourceId: p.id, name: 'tests' }] } });
    const m = await waitMission(s, m0.id, ['completed', 'partially_completed', 'failed']);
    expect(m.status).toBe('failed');
    expect(m.fixRounds).toBe(1);
    expect(implementer.calls.length).toBe(2);
    expect(m.checks.filter((c) => c.kind === 'command').map((c) => c.status)).toEqual(['failed', 'failed']);
    const c1 = m.criteria.find((c) => c.id === 'AC1')!;
    expect(c1.status).toBe('not_met');
    expect(c1.notes).toContain('Проверки не пройдены');
    expect(m.limitations.some((l) => l.includes('После 1 циклов исправления остались проблемы'))).toBe(true);
    expect(m.summary?.checksRun).toEqual([{ name: 'tests', status: 'failed', detail: 'код 1' }]);
  });

  it('12a. a required tool is unavailable: stated as a limitation, never imitated', async () => {
    const { s } = await setup();
    defaults();
    agent('Аналитик поручения', () => analysis({ title: 'Обзор библиотек', needs: { web_research: true }, acceptance_criteria: [{ id: 'AC1', text: 'Выводы подтверждены источниками', verification: 'source_verification' }] }));
    agent('Веб-исследователь', (_i, { round }) => (round === 0 ? toolCalls([{ tool: 'web_search', args: { query: 'node session libraries' } }]) : final({ sources: [], claims: [], conflicts: [], coverage: 0, gaps: ['поиск недоступен'] })));
    const m0 = await s.missions.create({ request: 'Найди в интернете библиотеки для сессий и сравни.', mode: 'plan', scope: { allowWeb: true } });
    const m = await waitMission(s, m0.id, ['completed', 'partially_completed', 'failed']);
    expect(m.status).toBe('partially_completed');
    expect(m.limitations.some((l) => l.startsWith('Инструмент web_search недоступен'))).toBe(true);
    expect(m.summary?.statusReason).toContain('Ограничения');
  });

  it('12b. a required agent is missing: the mission asks, and continues only after the user prepares agents', async () => {
    const { s } = await setup({ agents: false });
    defaults();
    const m0 = await s.missions.create({ request: 'Подготовь короткий план.', mode: 'plan' });
    let m = await waitMission(s, m0.id, ['needs_input']);
    expect(m.pending?.kind).toBe('setup_agents');
    expect((await s.agents.list()).length).toBe(0); // nothing installed behind the user's back
    m = await s.missions.decide(m.id, { decision: 'approve' });
    m = await waitMission(s, m.id, ['completed', 'partially_completed']);
    expect((await s.agents.list()).filter((a) => a.enabled).map((a) => a.id).sort()).toEqual([...MISSION_AGENTS].sort());
  });

  it('12c. a tool forbidden by the user is denied to agents and reported', async () => {
    const { s, projects } = await setup({ projects: ['shop'] });
    const p = projects[0]!;
    defaults();
    agent('Аналитик поручения', () => analysis({ task_type: 'analysis', needs: { project_exploration: true } }));
    agent('Исследователь проекта', (_i, { round }) => (round === 0 ? toolCalls([{ tool: 'read_project_file', args: { sourceId: p.id, path: 'src/auth.ts' } }]) : final({ findings: [], relevant_files: [], existing_solutions: [], architecture_notes: [], unread: ['src/auth.ts'], limitations: ['чтение файлов запрещено'] })));
    const m0 = await s.missions.create({ request: 'Изучи код входа.', mode: 'plan', scope: { sourceIds: [p.id] }, policy: { deniedTools: ['read_project_file'] } });
    const m = await waitMission(s, m0.id, ['completed', 'partially_completed']);
    expect(m.limitations.some((l) => l.includes('read_project_file') && l.includes('запрещён пользователем'))).toBe(true);
    // later denial applies to the running mission as well
    s.missions.denyTool(m.id, 'search_documents');
    expect(s.missions.get(m.id).policy.deniedTools).toEqual(['read_project_file', 'search_documents']);
  });

  it('13. a local model without any external API key; a failing local model falls back to another local one, never to the cloud', async () => {
    const { s, rt } = await setup();
    defaults();
    await appCloudProvider(rt);
    await s.agents.configure('mission-analyst', { modelPolicy: { mode: 'local', providerId: 'test', model: 'weak-model' } });
    agent('Аналитик поручения', () => analysis({ title: 'Локально' }));
    cleanups.push(registerTestResponder((req) => req.model === 'weak-model', () => 'это не JSON'));
    const pf = await s.missions.preflight({ mode: 'plan' });
    expect(pf.ok).toBe(true);
    expect(pf.aiMode).toBe('local');
    expect(pf.agents.every((a) => !a.route || a.route.locality === 'local')).toBe(true);
    const m0 = await s.missions.create({ request: 'Составь план без интернета.', mode: 'plan' });
    const m = await waitMission(s, m0.id, ['completed', 'partially_completed']);
    expect(s.missions.events(m.id).some((e) => e.type === 'model.fallback' && e.message.includes('test-model'))).toBe(true);
    const usage = rt.app.registryDb.all<{ locality: string; provider_id: string }>('SELECT locality, provider_id FROM ai_usage WHERE system_id = ?', rt.systemId);
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((u) => u.locality === 'local' && u.provider_id === 'test')).toBe(true);
  });

  it('14. a task that uses data of several systems keeps provenance and saves results in the home system', async () => {
    const { t, s, rt } = await setup();
    const archive = await t.core.systems.create({ name: 'Архив', storagePath: t.sysDir('archive'), template: 'empty' });
    const art = await t.core.systems.runtime(archive.systemId);
    const as = services(art);
    const old = await as.docs.create({ title: 'Решение 2024', folder: 'Notes', content: '# Решение 2024\n\nРешено: сессии хранятся 30 минут, затем удаляются.\n' });
    const archiveDocs = as.docs.list({}).total;
    defaults();
    agent('Аналитик поручения', () => analysis({ task_type: 'research', title: 'Срок хранения сессий', needs: { local_research: true }, acceptance_criteria: [{ id: 'AC1', text: 'Вывод подтверждён источником', verification: 'source_verification' }] }));
    const researcher = agent('Исследователь', (_i, { round }) => (round === 0 ? toolCalls([{ tool: 'read_document', args: { docId: old.id, systemId: archive.systemId } }]) : final({ evidence: [ev('E1', old.id, 'сессии хранятся 30 минут, затем удаляются')], gaps: [] })));
    const m0 = await s.missions.create({ request: 'Какое решение по сроку хранения сессий мы принимали раньше? Посмотри и в архиве.', scope: { systemIds: [archive.systemId] } });
    expect(m0.scope.kind).toBe('systems');
    const m = await waitMission(s, m0.id, ['completed', 'partially_completed']);
    expect(m.status, m.statusReason ?? '').toBe('completed');
    expect(researcher.calls.length).toBe(1);
    const ref = m.sourceReferences.find((r) => r.ref === old.id)!;
    expect(ref).toMatchObject({ systemId: archive.systemId, verified: true });
    // results live in the home system; the other system is only read
    expect(m.systemId).toBe(rt.systemId);
    expect(s.docs.list({ folder: 'Reports' }).total).toBe(1);
    expect(as.docs.list({}).total).toBe(archiveDocs);
    expect(art.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM missions')!.c).toBe(0);
  });

  it('15a. the app closes during execution: state is kept; an interrupted step with side effects is not repeated silently', async () => {
    const { t, s, systemId, projects } = await setup({ projects: ['shop'] });
    const p = projects[0]!;
    s.sources.setAccessMode(p.id, 'workcopy', { actor: 'user' });
    defaults();
    const analyst = agent('Аналитик поручения', () => analysis({ task_type: 'implementation', needs: { implementation: true }, acceptance_criteria: [{ id: 'AC1', text: 'Файл подготовлен', verification: 'artifact_exists' }] }));
    agent('Планировщик поручения', () => ({ steps: [step('S1', 'researcher', 'Собрать требования'), step('S2', 'implementer', 'Подготовить изменения', ['S1']), step('S3', 'verifier', 'Проверка', ['S2'])], notes: [] }));
    const researcher = agent('Исследователь', () => final({ evidence: [], gaps: [] }));
    const hold = gate();
    let implCalls = 0;
    agent('Исполнитель', async (_i, { round }) => {
      if (round === 0) {
        implCalls++;
        if (implCalls === 1) await hold.wait; // the first attempt hangs until the app closes
        return toolCalls([{ tool: 'propose_file_change', args: { sourceId: p.id, path: 'docs/notes.md', op: 'create', content: '# Заметки\n', rationale: 'r' } }]);
      }
      return final(impl('Подготовлено', 'docs/notes.md'));
    });
    const m0 = await s.missions.create({ request: 'Подготовь файл заметок в проекте.', scope: { sourceIds: [p.id] } });
    await waitFor(() => implCalls === 1);
    await t.core.systems.closeRuntime(systemId);
    hold.open();
    const rt2 = await t.core.systems.runtime(systemId);
    const s2 = services(rt2);
    let m = s2.missions.get(m0.id);
    expect(m.status).toBe('paused');
    const s2step = m.steps.find((x) => x.planStep === 'S2')!;
    expect(s2step.status).toBe('failed');
    expect(s2step.error?.message).toContain('автоматически он не повторяется');
    expect(m.steps.find((x) => x.planStep === 'S1')!.status).toBe('completed');
    m = await s2.missions.resume(m.id);
    expect(m.status).toBe('needs_input');
    expect(m.pending?.kind).toBe('error');
    m = await s2.missions.decide(m.id, { decision: 'retry' });
    m = await waitMission(s2, m.id, ['completed', 'partially_completed']);
    expect(implCalls).toBe(2);
    expect(analyst.calls.length).toBe(1); // finished stages are not repeated after the restart
    expect(researcher.calls.length).toBe(1);
    expect(s2.missions.events(m.id).some((e) => e.message.includes('Прервано закрытием системы'))).toBe(true);
  });

  it('15b. crash recovery: running missions are paused, read-only steps resume, others wait for the user', async () => {
    const { s, rt } = await setup();
    defaults();
    const m0 = await s.missions.create({ request: 'Тест восстановления после сбоя.', start: false });
    const now = new Date().toISOString();
    rt.db.run("UPDATE missions SET status = 'executing', phase = 'execution', normalized = ?, plan = ? WHERE id = ?", JSON.stringify(analysis()), JSON.stringify([step('S1', 'researcher', 'Чтение'), step('S2', 'implementer', 'Изменения')]), m0.id);
    rt.db.run("INSERT INTO mission_steps(id, mission_id, seq, phase, plan_step, role, agent_id, title, status, attempts, updated_at) VALUES ('st-r', ?, 1, 'execution', 'S1', 'researcher', 'researcher', 'Чтение', 'running', 1, ?)", m0.id, now);
    rt.db.run("INSERT INTO mission_steps(id, mission_id, seq, phase, plan_step, role, agent_id, title, status, attempts, side_effects, updated_at) VALUES ('st-i', ?, 2, 'execution', 'S2', 'implementer', 'implementer', 'Изменения', 'running', 1, ?, ?)", m0.id, JSON.stringify([{ tool: 'propose_file_change', target: 'a.ts' }]), now);
    s.missions.start(); // what happens on the next launch of the app
    const m = s.missions.get(m0.id);
    expect(m.status).toBe('paused');
    expect(m.statusReason).toContain('Восстановлено после перезапуска');
    expect(m.steps.find((x) => x.id === 'st-r')!.status).toBe('pending');
    const i = m.steps.find((x) => x.id === 'st-i')!;
    expect(i.status).toBe('failed');
    expect(i.error?.message).toContain('propose_file_change: a.ts');
  });

  it('state machine: invalid transitions are refused; a finished mission is continued only explicitly', async () => {
    const { s } = await setup();
    defaults();
    const m0 = await s.missions.create({ request: 'Короткий план работ.', mode: 'plan' });
    const m = await waitMission(s, m0.id, ['completed']);
    await expect(s.missions.pause(m.id)).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    await expect(s.missions.resume(m.id)).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    await expect(s.missions.decide(m.id, { decision: 'approve' })).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    const c = await s.missions.cancel((await s.missions.create({ request: 'Ещё одна задача.', start: false })).id);
    expect(c.status).toBe('cancelled');
    expect(() => s.missions.addRequirement(c.id, { text: 'новое требование' })).toThrowError(expect.objectContaining({ code: 'INVALID_STATE_TRANSITION' }));
  });

  it('discussion: the advisor answers from the mission state; its suggestions apply only on the user action', async () => {
    const { s } = await setup();
    defaults();
    agent('Консультант поручения', (input) => {
      expect((input.mission_state as { key: string }).key).toBe('M-001');
      return { answer: 'Вариант O1 выбран как самый простой.', references: ['strategy'], suggested_actions: [{ action: 'add_requirement', detail: 'Добавить раздел с примерами' }] };
    });
    const m0 = await s.missions.create({ request: 'Сделай план документации.', mode: 'plan' });
    await waitMission(s, m0.id, ['completed']);
    const r = await s.missions.discuss(m0.id, 'Почему выбран этот вариант?');
    expect(r.answer.answer).toContain('O1');
    expect(s.missions.get(m0.id).extraRequirements).toEqual([]); // nothing applied automatically
    const m = await s.missions.applySuggestion(m0.id, r.messageId, 0);
    expect(m.extraRequirements.map((x) => x.text)).toEqual(['Добавить раздел с примерами']);
  });
});

/** A configured cloud provider without a key: in local mode it must never be used. */
async function appCloudProvider(rt: { app: Parameters<typeof appAI>[0] }): Promise<void> {
  try {
    await appAI(rt.app).providers.create({ kind: 'anthropic', name: 'Облако без ключа', baseUrl: 'https://api.anthropic.com', locality: 'cloud' });
  } catch {
    // creating a cloud provider without a key may be refused — that is fine for this test
  }
}
