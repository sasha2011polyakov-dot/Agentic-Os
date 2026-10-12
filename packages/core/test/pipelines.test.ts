import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { services } from '../src/wiring.ts';
import { appAI } from '../src/ai/app-ai.ts';
import { SafeFetcher } from '../src/research/safe-fetch.ts';
import { registerTestResponder, resetTestProvider } from '../src/ai/providers/test.ts';
import { workflowFunction } from '../src/workflows/functions.ts';
import type { RunStatus, RunView, WorkflowEngine } from '../src/workflows/engine.ts';
import { docNodeId } from '../src/graph/graph.ts';
import { startTestApp, waitFor, type TestApp } from './helpers.ts';
import { writeProject } from './fixtures/project.ts';

const ENV = { AOS_ENABLE_TEST_PROVIDER: '1' };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  resetTestProvider();
});

/** Scripted built-in agent: fn gets the parsed input and the 0-based call number. */
function agent(name: string, fn: (input: Record<string, unknown>, call: number, req: { messages: { content: string }[] }) => unknown): void {
  let n = 0;
  cleanups.push(
    registerTestResponder(
      (req) => (req.system ?? '').includes(`агента «${name}»`),
      (req) => {
        const m = /<untrusted_content source="input">\n([\s\S]*?)\n<\/untrusted_content>/.exec(req.messages[0]!.content);
        return JSON.stringify(fn(m ? JSON.parse(m[1]!) : {}, n++, req));
      },
    ),
  );
}

const final = (result: unknown) => ({ action: 'final', tool_calls: [], result });
const calls = (list: { tool: string; args: unknown }[]) => ({ action: 'tool_calls', tool_calls: list.map((c) => ({ tool: c.tool, arguments_json: JSON.stringify(c.args) })), result: null });

async function waitRun(engine: WorkflowEngine, runId: string, statuses: RunStatus[]): Promise<RunView> {
  return waitFor<RunView | null>(() => {
    const r = engine.get(runId);
    if (r.status === 'failed') throw new Error(`run failed: ${JSON.stringify(r.error)} ${r.statusReason} STEPS: ${r.steps.map((x) => `${x.nodeId}#${x.iteration}=${x.status}`).join(", ")}`);
    return statuses.includes(r.status) ? r : null;
  }, { timeoutMs: 20_000, message: statuses.join('|') }) as Promise<RunView>;
}

async function setup(): Promise<{ t: TestApp; s: ReturnType<typeof services>; projectId: string; rt: Awaited<ReturnType<TestApp['core']['systems']['runtime']>> }> {
  const t = await startTestApp({ env: ENV });
  cleanups.push(() => t.cleanup());
  const sys = await t.core.systems.create({ name: 'Spec', storagePath: t.sysDir('spec'), template: 'starter' });
  const rt = await t.core.systems.runtime(sys.systemId);
  const s = services(rt);
  await s.indexer.indexSource(rt.primaryVaultId());
  const dir = join(t.root, 'demo-shop');
  await writeProject(dir);
  const projectId = (await s.sources.connect({ path: dir, name: 'Demo Shop' })).id;
  await waitFor(() => s.sources.get(projectId).status === 'ready');
  return { t, s, projectId, rt };
}

describe('specification pipeline (end to end with scripted agents)', () => {
  it('grounds evidence, validates, asks the user, iterates on review and saves a traceable spec', async () => {
    const { s, projectId, rt } = await setup();
    await s.workflows.setupAgents('spec-pipeline');
    const authDoc = rt.db.get<{ id: string }>("SELECT id FROM documents WHERE rel_path = 'docs/requirements/auth.md'")!.id;
    const sessDoc = rt.db.get<{ id: string }>("SELECT id FROM documents WHERE rel_path = 'docs/requirements/sessions.md'")!.id;

    agent('Координатор', () => ({
      task_type: 'change',
      summary: 'Доработка авторизации',
      ready: false,
      missing_information: [{ question: 'Какой срок жизни сессии верный?', why: 'В документах 30 минут и 24 часа', blocking: true }, { question: 'Нужен ли вход через соцсети?', why: 'не указано', blocking: false }],
      plan: [{ stage: 'исследование', purpose: 'собрать требования' }],
      required_sources: [authDoc],
      completion_criteria: ['ТЗ утверждено'],
    }));
    agent('Инвентаризатор проекта', () => final({ project_map: [{ area: 'auth', paths: ['src/auth.ts'], purpose: 'вход' }], key_files: [{ path: 'src/auth.ts', source_id: projectId, why: 'сервис входа' }], architecture_notes: ['Node.js'], entry_points: ['src/index.ts'], limitations: [], unread_but_relevant: [] }));
    agent('Исследователь', (input, call) => {
      expect(input.answers).toEqual([{ question: 'Какой срок жизни сессии верный?', answer: '30 минут' }]);
      if (call === 0) return calls([{ tool: 'read_document', args: { docId: authDoc } }]);
      return final({
        evidence: [
          { id: 'E1', fact: 'Вход по email и паролю', kind: 'fact', source: { type: 'document', ref: authDoc, title: 'auth' }, quote: 'Система должна позволять пользователю входить по email и паролю', relevance: 'high', confidence: 0.9, needs_verification: false },
          { id: 'E2', fact: 'Сессия 30 минут', kind: 'fact', source: { type: 'document', ref: authDoc, title: 'auth' }, quote: 'Сессия должна истекать через 30 минут бездействия', relevance: 'high', confidence: 0.9, needs_verification: false },
          { id: 'E3', fact: 'Сессия 24 часа', kind: 'fact', source: { type: 'document', ref: sessDoc, title: 'sessions' }, quote: 'Сессия должна истекать через 24 часа бездействия', relevance: 'high', confidence: 0.9, needs_verification: false },
          { id: 'E4', fact: 'Пароли хранятся в bcrypt', kind: 'fact', source: { type: 'document', ref: authDoc, title: 'auth' }, quote: 'Пароли хранятся с использованием bcrypt', relevance: 'medium', confidence: 0.5, needs_verification: true },
          { id: 'E5', fact: 'Есть метод login', kind: 'fact', source: { type: 'project_file', ref: `${projectId}:src/auth.ts`, title: 'src/auth.ts' }, quote: 'login(email: string, password: string)', relevance: 'high', confidence: 0.9, needs_verification: false },
        ],
        gaps: ['нет требований к восстановлению пароля'],
      });
    });
    agent('Аналитик требований', (input) => {
      const revised = (input.feedback as string[] | undefined)?.length;
      return {
        requirements: [
          { id: 'REQ-001', statement: 'Пользователь входит по email и паролю', type: 'functional', rationale: 'E1', sources: ['E1', 'E5'], priority: 'must', acceptance_criteria: ['при верных данных создаётся сессия', 'при неверных — ошибка без раскрытия причины'], depends_on: [], status: 'confirmed', clarifications: [] },
          { id: 'REQ-002', statement: 'Сессия истекает через 30 минут бездействия', type: 'non_functional', rationale: 'ответ пользователя', sources: ['E2', 'E3'], priority: 'must', acceptance_criteria: ['через 30 минут без запросов требуется повторный вход'], depends_on: ['REQ-001'], status: 'confirmed', clarifications: [] },
          revised
            ? { id: 'REQ-003', statement: 'Вход выполняется не более чем за 2 секунды', type: 'non_functional', rationale: 'ревью', sources: ['E4'], priority: 'should', acceptance_criteria: ['p95 времени входа ≤ 2 с'], depends_on: ['REQ-001'], status: 'assumption', clarifications: [] }
            : { id: 'REQ-003', statement: 'Вход должен быть быстрым и удобным', type: 'non_functional', rationale: 'E4', sources: ['E4'], priority: 'should', acceptance_criteria: ['пользователю удобно'], depends_on: ['REQ-001'], status: 'confirmed', clarifications: [] },
        ],
        open_questions: ['Нужна ли двухфакторная аутентификация?'],
      };
    });
    agent('Проверяющий противоречия', (_i, call) => ({
      issues: call === 0 ? [{ id: 'C1', type: 'contradiction', severity: 'critical', description: 'E2 и E3 задают разный срок сессии', refs: ['E2', 'E3', 'REQ-002'], options: ['30 минут', '24 часа'], recommendation: 'принять 30 минут по ответу пользователя', question: 'Какой срок оставить?' }] : [],
    }));
    agent('Декомпозитор', () => ({
      tasks: [
        { id: 'T-001', title: 'Реализовать вход', description: 'API и форма входа', goal: 'вход', rationale: 'REQ-001', requirement_ids: ['REQ-001'], depends_on: [], acceptance_criteria: ['тесты входа проходят'], affected_modules: ['src/auth.ts'], unknowns: [], parent_id: null, priority: 'high' },
        { id: 'T-002', title: 'Тайм-аут сессии', description: 'истечение через 30 минут', goal: 'безопасность', rationale: 'REQ-002', requirement_ids: ['REQ-002'], depends_on: ['T-001'], acceptance_criteria: ['сессия истекает'], affected_modules: [], unknowns: [], parent_id: null, priority: 'high' },
        { id: 'T-003', title: 'Замер скорости входа', description: 'нагрузочный тест', goal: 'скорость', rationale: 'REQ-003', requirement_ids: ['REQ-003'], depends_on: ['T-001'], acceptance_criteria: ['отчёт p95'], affected_modules: [], unknowns: ['целевая нагрузка'], parent_id: null, priority: 'medium' },
      ],
    }));
    agent('Генератор технического задания', (input) => ({
      title: String(input.title),
      summary: 'ТЗ на доработку авторизации',
      sections: [
        { key: 'scope', heading: 'Границы', content: 'Входит: вход и сессии. Не входит: соцсети.' },
        { key: 'goal', heading: 'Цель', content: 'Надёжный вход по email и паролю (REQ-001).' },
        ...((input.feedback as string[] | undefined)?.some((f) => f.includes('тестирован')) ? [{ key: 'testing', heading: 'Тестирование', content: 'Модульные и нагрузочные тесты.' }] : []),
      ],
      assumptions: ['Пароли хранятся безопасно (E4 не подтверждено)'],
      open_questions: ['Двухфакторная аутентификация?'],
      omitted_sections: [{ key: 'glossary', reason: 'терминов немного' }],
    }));
    agent('Независимый ревьюер ТЗ', (_i, call) =>
      call === 0
        ? { verdict: 'needs_changes', summary: 'REQ-003 не проверяемо', scores: { completeness: 3, consistency: 4, traceability: 4, testability: 2 }, defects: [{ id: 'D1', severity: 'major', stage: 'requirements', location: 'REQ-003', description: 'REQ-003: нет измеримого критерия', recommendation: 'добавить p95' }] }
        : { verdict: 'pass', summary: 'Замечаний нет', scores: { completeness: 5, consistency: 5, traceability: 5, testability: 4 }, defects: [] },
    );

    const run = await s.workflows.startRun('spec-pipeline', { title: 'Авторизация v2', goal: 'Доработать вход и сессии по документам проекта' }, { scope: { sourceIds: [projectId], docIds: [authDoc, sessDoc], extraSystems: [], allowWeb: false } });

    // 1) blocking question from the coordinator
    let r = await waitRun(s.workflows, run.id, ['waiting_for_approval']);
    const clarify = r.pendingApprovals[0]!;
    expect(clarify.nodeId).toBe('clarify');
    expect((clarify.approval as { questions: unknown[] }).questions).toHaveLength(1);
    await expect(s.workflows.approve(run.id, clarify.id, { decision: 'approve' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await s.workflows.approve(run.id, clarify.id, { decision: 'approve', answers: [{ question: 'Какой срок жизни сессии верный?', answer: '30 минут' }] });

    // 2) critical contradiction must be resolved by the user
    r = await waitRun(s.workflows, run.id, ['waiting_for_approval']);
    const resolve = r.pendingApprovals[0]!;
    expect(resolve.nodeId).toBe('resolve');
    expect((resolve.approval as { prompt: { issues: { id: string }[] } }).prompt.issues[0]!.id).toBe('C1');
    await s.workflows.approve(run.id, resolve.id, { decision: 'approve', choices: [{ id: 'C1', value: '30 минут' }] });

    // 3) review fails on iteration 1 → automatic revision; iteration 2 passes → final approval
    r = await waitRun(s.workflows, run.id, ['waiting_for_approval']);
    let fin = r.pendingApprovals[0]!;
    expect(fin.nodeId).toBe('final');
    expect(fin.iteration).toBe(1);
    const prompt = fin.approval as { prompt: { markdown: string; metrics: Record<string, number> } };
    expect(prompt.prompt.markdown).toContain('## Матрица трассировки');
    expect(prompt.prompt.markdown).toContain('✖ не найдена в источнике'); // E4 fabricated quote
    expect(prompt.prompt.metrics.coveragePct).toBe(100);

    const ground = r.steps.find((x) => x.nodeId === 'ground')!.output as { evidence: { id: string; quote_verified: boolean }[]; stats: { verified: number } };
    expect(Object.fromEntries(ground.evidence.map((e) => [e.id, e.quote_verified]))).toEqual({ E1: true, E2: true, E3: true, E4: false, E5: true });
    const firstCheck = r.steps.find((x) => x.nodeId === 'req_check' && x.iteration === 0)!.output as { findings: { type: string; refs: string[] }[] };
    expect(firstCheck.findings.map((f) => f.type)).toEqual(expect.arrayContaining(['vague', 'unverified_source']));
    expect(firstCheck.findings.find((f) => f.type === 'vague')!.refs).toEqual(['REQ-003']);
    expect(r.steps.find((x) => x.nodeId === 'final' && x.iteration === 0)!.status).toBe('skipped');

    // 4) the user asks for one more revision (beyond the automatic limit) and then approves
    await expect(s.workflows.approve(run.id, fin.id, { decision: 'revise' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await s.workflows.approve(run.id, fin.id, { decision: 'revise', comment: 'Добавьте раздел о тестировании' });
    r = await waitRun(s.workflows, run.id, ['waiting_for_approval']);
    fin = r.pendingApprovals[0]!;
    expect(fin.iteration).toBe(2);
    expect((fin.approval as { prompt: { markdown: string } }).prompt.markdown).toContain('## Тестирование');
    await s.workflows.approve(run.id, fin.id, { decision: 'approve' });
    r = await waitRun(s.workflows, run.id, ['completed']);

    // 5) saved: spec + requirement docs (renumbered after REQ-001/002 of the project) + tasks + graph
    const result = r.result as { specDocId: string; specPath: string; requirementDocs: { id: string; docId: string }[]; tasks: { key: string; id: string; localId: string }[] };
    expect(result.requirementDocs.map((d) => d.id)).toEqual(['REQ-003', 'REQ-004', 'REQ-005']);
    const spec = await s.docs.get(result.specDocId);
    expect(spec.relPath).toBe('Specs/Авторизация v2.md');
    expect(spec.frontmatter.status).toBe('approved');
    expect(spec.content).toContain('|REQ-003]]');
    expect(spec.content).not.toMatch(/\bREQ-001\b.*Пользователь входит/); // local ids were replaced
    expect(result.tasks.map((t) => t.key)).toEqual(['T-001', 'T-002', 'T-003']);
    const t2 = s.tasks.get(result.tasks[1]!.id);
    expect(t2.requirementIds).toEqual(['REQ-004']);
    expect(t2.dependsOn.map((d) => d.key)).toEqual(['T-001']);
    expect(t2.origin).toBe('agent');
    expect(t2.originRunId).toBe(run.id);
    const reqDoc = await s.docs.get(result.requirementDocs[0]!.docId);
    expect(reqDoc.frontmatter.id).toBe('REQ-003');
    const implementsEdges = s.graph.edgesOf(docNodeId(reqDoc.id)).incoming.filter((e) => e.relation === 'implements');
    expect(implementsEdges.map((e) => e.src)).toContain(`task:${result.tasks[0]!.id}`);
    expect(s.graph.edgesOf(docNodeId(reqDoc.id)).outgoing.some((e) => e.relation === 'part_of' && e.dst === docNodeId(spec.id))).toBe(true);

    // 6) re-running the save step (e.g. after a crash) creates no duplicates
    const before = { docs: rt.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM documents')!.c, tasks: s.tasks.list().total };
    const saveStep = r.steps.find((x) => x.nodeId === 'save')!;
    await workflowFunction('spec.save')!.run(saveStep.input as Record<string, unknown>, { rt, runId: run.id, stepId: saveStep.id, nodeId: 'save', iteration: 0, scope: r.scope, runInput: {}, signal: new AbortController().signal, log: () => {} });
    expect(rt.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM documents')!.c).toBe(before.docs);
    expect(s.tasks.list().total).toBe(before.tasks);
    expect(rt.audit.list({ action: 'workflow.approval' })).toHaveLength(4); // clarify, resolve, revise, approve (invalid attempts are not recorded)
  });
});

describe('web research pipeline', () => {
  it('reads sources through the safe fetcher, verifies quotes in code and saves a report with dates and links', async () => {
    const { t, s, rt } = await setup();
    await s.workflows.setupAgents('web-research');
    const pages: Record<string, string> = {
      'https://docs.example.org/sqlite': '<html><head><title>SQLite в Node.js</title><meta property="article:published_time" content="2026-05-01"></head><body><main><h1>node:sqlite</h1><p>Модуль node:sqlite встроен в Node.js начиная с версии 22.5.</p><p>Он остаётся экспериментальным.</p></main></body></html>',
      'https://blog.example.net/post': '<html><head><title>Обзор</title></head><body><article><p>Для персональных приложений SQLite обычно достаточно.</p></article></body></html>',
    };
    const fetched: string[] = [];
    const web = appAI(t.core.services).web;
    Object.defineProperty(web, 'fetcher', {
      value: new SafeFetcher(t.core.services.policy, async (url) => {
        fetched.push(url.toString());
        const body = pages[url.toString()];
        return Object.assign(Readable.from([Buffer.from(body ?? 'not found')]), { statusCode: body ? 200 : 404, headers: { 'content-type': 'text/html; charset=utf-8' } }) as never;
      }),
    });
    agent('Планировщик исследования', (input) => ({ question: String(input.question), subquestions: ['статус модуля'], queries: ['node:sqlite stability'], preferred_sources: ['официальная документация'], done_criteria: ['два независимых источника'] }));
    agent('Веб-исследователь', (_i, _call, req) => {
      if (req.messages.length === 1) return calls([{ tool: 'open_url', args: { url: 'https://docs.example.org/sqlite' } }, { tool: 'open_url', args: { url: 'https://blog.example.net/post' } }]);
      return final({
        sources: [
          { url: 'https://docs.example.org/sqlite', title: 'SQLite в Node.js', published_at: '2026-05-01', why_selected: 'документация', is_primary: true },
          { url: 'https://blog.example.net/post', title: 'Обзор', published_at: null, why_selected: 'мнение практиков', is_primary: false },
        ],
        claims: [
          { id: 'K1', statement: 'node:sqlite встроен с Node 22.5', quote: 'Модуль node:sqlite встроен в Node.js начиная с версии 22.5', source_url: 'https://docs.example.org/sqlite', confidence: 0.9, kind: 'fact' },
          { id: 'K2', statement: 'SQLite достаточно для персональных приложений', quote: 'Для персональных приложений SQLite обычно достаточно', source_url: 'https://blog.example.net/post', confidence: 0.6, kind: 'opinion' },
          { id: 'K3', statement: 'node:sqlite стабилен', quote: 'Модуль node:sqlite объявлен стабильным', source_url: 'https://docs.example.org/sqlite', confidence: 0.7, kind: 'fact' },
        ],
        conflicts: [],
        coverage: 0.8,
        gaps: [],
      });
    });
    agent('Автор отчёта исследования', (input) => {
      const claims = input.claims as { id: string; quote_status: string }[];
      expect(claims.find((c) => c.id === 'K3')!.quote_status).toBe('not_found_in_source');
      return { title: 'Статус node:sqlite', summary: 'Модуль встроен, но экспериментален.', findings: [{ statement: 'встроен с 22.5', claim_ids: ['K1'] }], limitations: ['утверждение K3 не подтверждено источником и исключено'], open_questions: [], markdown_body: '## Выводы\n\nМодуль встроен с Node 22.5 [K1].' };
    });
    agent('Ревьюер исследования', () => ({ verdict: 'pass', defects: [], unsupported_statements: [] }));

    const run = await s.workflows.startRun('web-research', { question: 'Насколько стабилен node:sqlite?', maxSources: 3 }, { scope: { sourceIds: [], docIds: [], extraSystems: [], allowWeb: true } });
    const r = await waitRun(s.workflows, run.id, ['completed']);
    expect(fetched).toEqual(['https://docs.example.org/sqlite', 'https://blog.example.net/post']);
    const res = r.result as { docId: string; stats: { verified: number; unverified: number; independentDomains: number } };
    expect(res.stats).toMatchObject({ verified: 2, unverified: 1, independentDomains: 2 });
    const doc = await s.docs.get(res.docId);
    expect(doc.relPath.startsWith('Research/')).toBe(true);
    expect(doc.content).toContain('[SQLite в Node.js](https://docs.example.org/sqlite) — первоисточник; опубликовано: 2026-05-01; получено: ');
    expect(doc.content).toMatch(/\| K3 \| .* \| ✖ не найдена \|/);
    expect(rt.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM facts WHERE status = 'verified'")!.c).toBe(2);
    const sourcesOfDoc = s.graph.edgesOf(docNodeId(doc.id)).outgoing.filter((e) => e.relation === 'uses_source');
    expect(sourcesOfDoc).toHaveLength(2);

    // without web permission for the run, the same agent cannot fetch anything — and nothing is "verified"
    fetched.length = 0;
    const run2 = await s.workflows.startRun('web-research', { question: 'Насколько стабилен node:sqlite?', save: false }, { scope: { sourceIds: [], docIds: [], extraSystems: [], allowWeb: false } });
    const r2 = await waitRun(s.workflows, run2.id, ['completed']);
    expect(fetched).toEqual([]);
    const search2 = r2.steps.find((x) => x.nodeId === 'search')!;
    expect(s.workflows.events(run2.id).filter((e) => e.stepId === search2.id && e.type === 'tool.denied')).toHaveLength(2);
    expect(r2.steps.find((x) => x.nodeId === 'save')!.status).toBe('skipped');
  });
});
