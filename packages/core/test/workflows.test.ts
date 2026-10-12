import { afterEach, describe, expect, it } from 'vitest';
import { services } from '../src/wiring.ts';
import { AppCore } from '../src/app.ts';
import { AppError } from '../src/util/errors.ts';
import { registerFunctions } from '../src/workflows/functions.ts';
import { checkDefinition, type WorkflowDefinition } from '../src/workflows/definition.ts';
import { evaluate, resolveMapping } from '../src/workflows/expr.ts';
import type { RunStatus, RunView, WorkflowEngine } from '../src/workflows/engine.ts';
import { registerTestResponder, resetTestProvider } from '../src/ai/providers/test.ts';
import { startTestApp, waitFor, type TestApp } from './helpers.ts';
import { installTestAgent } from './fixtures/agents.ts';

const ENV = { AOS_ENABLE_TEST_PROVIDER: '1' };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  resetTestProvider();
});

const noScope = { sourceIds: [], docIds: [], extraSystems: [], allowWeb: false };

registerFunctions([
  { name: 'test.echo', label: 'Эхо', description: 'Возвращает аргументы', run: (args) => ({ ...args, echoed: true }) },
  { name: 'test.boom', label: 'Ошибка', description: 'Всегда падает', run: () => { throw new AppError('VALIDATION_FAILED', 'Сломано специально'); } },
]);

async function setup(): Promise<{ t: TestApp; s: ReturnType<typeof services>; systemId: string }> {
  const t = await startTestApp({ env: ENV });
  cleanups.push(() => t.cleanup());
  const sys = await t.core.systems.create({ name: 'WF', storagePath: t.sysDir('wf'), template: 'empty' });
  const rt = await t.core.systems.runtime(sys.systemId);
  return { t, s: services(rt), systemId: sys.systemId };
}

function respond(agentName: string, fn: (input: Record<string, unknown>) => unknown | Promise<unknown>): () => void {
  return registerTestResponder(
    (req) => (req.system ?? '').includes(`агента «${agentName}»`),
    async (req) => {
      const m = /<untrusted_content source="input">\n([\s\S]*?)\n<\/untrusted_content>/.exec(req.messages[0]!.content);
      const input = m ? (JSON.parse(m[1]!) as Record<string, unknown>) : {};
      const out = await fn(input);
      return JSON.stringify(out);
    },
  );
}

async function waitRun(engine: WorkflowEngine, runId: string, statuses: RunStatus[], timeoutMs = 15_000): Promise<RunView> {
  return waitFor<RunView | null>(() => {
    const r = engine.get(runId);
    return statuses.includes(r.status) ? r : null;
  }, { timeoutMs, message: `run → ${statuses.join('|')}` }) as Promise<RunView>;
}

const agentDef = (nodes: WorkflowDefinition['nodes'], extra: Partial<WorkflowDefinition> = {}): WorkflowDefinition => ({
  id: 'demo',
  name: 'Демо',
  description: '',
  version: 1,
  inputSchema: { type: 'object', properties: { topic: { type: 'string' } } },
  nodes,
  ...extra,
});

describe('workflow definitions and expressions', () => {
  it('validates structure: unknown deps, cycles, loops, functions, references', () => {
    const known = { agents: new Set(['a1']), functions: new Set(['test.echo']) };
    const ok = checkDefinition(agentDef([{ id: 'x', type: 'function', fn: 'test.echo', title: 'X', input: {} }]), known);
    expect(ok.ok).toBe(true);
    const bad = checkDefinition(
      agentDef([
        { id: 'a', type: 'function', fn: 'nope', title: 'A', input: {}, dependsOn: ['c'] },
        { id: 'b', type: 'agent', agent: 'a1', title: 'B', input: { x: { $path: 'nodes.ghost.output' } }, dependsOn: ['a'] },
        { id: 'c', type: 'function', fn: 'test.echo', title: 'C', input: {}, dependsOn: ['b'] },
        { id: 'l', type: 'loop', title: 'L', body: ['missing'], until: { path: 'x' }, maxIterations: 2 },
        { id: 'd', type: 'function', fn: 'test.echo', title: 'D', input: {}, dependsOn: ['unknown'] },
      ]),
      known,
    );
    const msgs = bad.errors.map((e) => e.message).join('\n');
    expect(bad.ok).toBe(false);
    expect(msgs).toContain('Неизвестная функция «nope»');
    expect(msgs).toContain('Циклическая зависимость');
    expect(msgs).toContain('неизвестный узел «missing»');
    expect(msgs).toContain('неизвестный узел «ghost»');
    expect(msgs).toContain('неизвестного узла «unknown»');
  });

  it('resolves mappings and conditions without evaluating code', () => {
    const ctx = { input: { goal: 'G' }, nodes: { r: { output: { defects: [{ stage: 'spec', description: 'd1' }, { stage: 'req', description: 'd2' }], verdict: 'pass', items: [] } } } };
    expect(resolveMapping({ a: { $path: 'input.goal' }, b: { $path: 'nodes.x.output', default: [] }, c: { $literal: { $path: 'raw' } } }, ctx)).toEqual({ a: 'G', b: [], c: { $path: 'raw' } });
    expect(resolveMapping({ $pluck: 'nodes.r.output.defects', where: { field: 'stage', equals: 'spec' }, field: 'description' }, ctx)).toEqual(['d1']);
    expect(resolveMapping({ $concat: [['a'], 'b', null, { $path: 'missing' }] }, ctx)).toEqual(['a', 'b']);
    expect(resolveMapping({ $template: 'Цель: {{input.goal}}; {{constructor}}' }, ctx)).toBe('Цель: G; ');
    expect(evaluate({ all: [{ path: 'nodes.r.output.verdict', equals: 'pass' }, { path: 'nodes.r.output.items', empty: true }] }, ctx)).toBe(true);
    expect(evaluate({ path: 'nodes.r.output.defects', some: { field: 'stage', equals: 'req' } }, ctx)).toBe(true);
    expect(evaluate({ not: { path: 'input.goal', exists: true } }, ctx)).toBe(false);
  });
});

describe('workflow engine', () => {
  it('runs functions and agents, waits for approval and completes; reject cancels and keeps results', async () => {
    const { s } = await setup();
    await installTestAgent(s, { id: 'writer', tools: [], permissions: [] });
    cleanups.push(respond('Тестовый агент writer', (input) => ({ summary: `ответ на ${String(input.task)}` })));
    s.workflows.save(
      agentDef(
        [
          { id: 'prep', type: 'function', fn: 'test.echo', title: 'Подготовка', input: { topic: { $path: 'input.topic' } } },
          { id: 'ask', type: 'agent', agent: 'writer', title: 'Ответ', dependsOn: ['prep'], input: { task: { $path: 'nodes.prep.output.topic' } } },
          { id: 'ok', type: 'approval', title: 'Проверка', dependsOn: ['ask'], prompt: { text: { $path: 'nodes.ask.output.summary' } } },
          { id: 'after', type: 'function', fn: 'test.echo', title: 'После', dependsOn: ['ok'], input: { decision: { $path: 'nodes.ok.output.decision' } } },
        ],
        { output: { answer: { $path: 'nodes.ask.output.summary' }, decision: { $path: 'nodes.after.output.decision' } } },
      ),
    );
    const run = await s.workflows.startRun('demo', { topic: 'тест' }, { scope: noScope });
    const waiting = await waitRun(s.workflows, run.id, ['waiting_for_approval']);
    expect(waiting.pendingApprovals[0]!.approval).toMatchObject({ prompt: { text: 'ответ на тест' } });
    await s.workflows.approve(run.id, waiting.pendingApprovals[0]!.id, { decision: 'approve', comment: 'хорошо' });
    const done = await waitRun(s.workflows, run.id, ['completed']);
    expect(done.result).toEqual({ answer: 'ответ на тест', decision: 'approve' });
    expect(done.totals.modelCalls).toBe(1);

    const run2 = await s.workflows.startRun('demo', { topic: 'второй' }, { scope: noScope });
    const w2 = await waitRun(s.workflows, run2.id, ['waiting_for_approval']);
    await s.workflows.approve(run2.id, w2.pendingApprovals[0]!.id, { decision: 'reject', comment: 'не то' });
    const r2 = s.workflows.get(run2.id);
    expect(r2.status).toBe('cancelled');
    expect(r2.steps.find((x) => x.nodeId === 'ask')!.output).toEqual({ summary: 'ответ на второй' }); // kept
    expect(r2.steps.find((x) => x.nodeId === 'after')).toBeUndefined();
  });

  it('runs independent steps in parallel up to maxParallel', async () => {
    const { s } = await setup();
    await installTestAgent(s, { id: 'slow', tools: [], permissions: [] });
    let current = 0;
    let peak = 0;
    cleanups.push(
      respond('Тестовый агент slow', async () => {
        current++;
        peak = Math.max(peak, current);
        await new Promise((r) => setTimeout(r, 150));
        current--;
        return { summary: 'ok' };
      }),
    );
    const nodes: WorkflowDefinition['nodes'] = ['a', 'b', 'c'].map((id) => ({ id, type: 'agent', agent: 'slow', title: id, input: {} }));
    s.workflows.save(agentDef(nodes));
    const r1 = await s.workflows.startRun('demo', {}, { scope: noScope, limits: { maxParallel: 2 } });
    await waitRun(s.workflows, r1.id, ['completed']);
    expect(peak).toBe(2);
    peak = 0;
    const r2 = await s.workflows.startRun('demo', {}, { scope: noScope, limits: { maxParallel: 1 } });
    await waitRun(s.workflows, r2.id, ['completed']);
    expect(peak).toBe(1);
  });

  it('retries retryable model errors, pauses on user-fixable ones and resumes', async () => {
    const { s } = await setup();
    s.workflows.retryDelayMs = 10;
    await installTestAgent(s, { id: 'flaky', tools: [], permissions: [] });
    let calls = 0;
    cleanups.push(
      respond('Тестовый агент flaky', () => {
        calls++;
        if (calls === 1) throw new AppError('PROVIDER_UNREACHABLE');
        return { summary: 'со второй попытки' };
      }),
    );
    s.workflows.save(agentDef([{ id: 'a', type: 'agent', agent: 'flaky', title: 'A', input: {}, retries: 2 }]));
    const r = await s.workflows.startRun('demo', {}, { scope: noScope });
    const done = await waitRun(s.workflows, r.id, ['completed']);
    expect(done.steps[0]!.attempts).toBe(2);
    expect(s.workflows.events(r.id).some((e) => e.type === 'step.retry')).toBe(true);

    // agent switched off → the run pauses with an actionable reason instead of failing
    await s.agents.setEnabled('flaky', false);
    const r2 = await s.workflows.startRun('demo', {}, { scope: noScope });
    const paused = await waitRun(s.workflows, r2.id, ['paused']);
    expect(paused.error?.code).toBe('AGENT_NOT_ENABLED');
    expect(paused.statusReason).toContain('Продолжить');
    await s.agents.setEnabled('flaky', true);
    await s.workflows.resume(r2.id);
    await waitRun(s.workflows, r2.id, ['completed']);
  });

  it('pauses at the budget limit and continues after the user raises it', async () => {
    const { s } = await setup();
    await installTestAgent(s, { id: 'cheap', tools: [], permissions: [] });
    cleanups.push(respond('Тестовый агент cheap', () => ({ summary: 'x' })));
    s.workflows.save(
      agentDef([
        { id: 'a', type: 'agent', agent: 'cheap', title: 'A', input: {} },
        { id: 'b', type: 'agent', agent: 'cheap', title: 'B', input: {}, dependsOn: ['a'] },
      ]),
    );
    const r = await s.workflows.startRun('demo', {}, { scope: noScope, limits: { maxModelCalls: 1 } });
    const paused = await waitRun(s.workflows, r.id, ['paused']);
    expect(paused.error?.code).toBe('BUDGET_EXCEEDED');
    expect(paused.steps.find((x) => x.nodeId === 'a')!.status).toBe('completed');
    s.workflows.updateLimits(r.id, { maxModelCalls: 5 });
    await s.workflows.resume(r.id);
    const done = await waitRun(s.workflows, r.id, ['completed']);
    expect(done.totals.modelCalls).toBe(2);
  });

  it('fails honestly on a non-retryable error and skips steps whose condition is false', async () => {
    const { s } = await setup();
    s.workflows.save(
      agentDef([
        { id: 'a', type: 'function', fn: 'test.echo', title: 'A', input: { flag: false } },
        { id: 'skip', type: 'function', fn: 'test.boom', title: 'Не нужен', dependsOn: ['a'], when: { path: 'nodes.a.output.flag', equals: true }, input: {} },
        { id: 'opt', type: 'function', fn: 'test.boom', title: 'Необязательный', dependsOn: ['a'], optional: true, input: {} },
        { id: 'end', type: 'function', fn: 'test.echo', title: 'Конец', dependsOn: ['skip', 'opt'], input: {} },
      ]),
    );
    const r = await s.workflows.startRun('demo', {}, { scope: noScope });
    const done = await waitRun(s.workflows, r.id, ['completed']);
    const by = Object.fromEntries(done.steps.map((x) => [x.nodeId, x.status]));
    expect(by).toEqual({ a: 'completed', skip: 'skipped', opt: 'failed', end: 'completed' });

    s.workflows.save(agentDef([{ id: 'boom', type: 'function', fn: 'test.boom', title: 'Сломан', input: {} }]));
    const r2 = await s.workflows.startRun('demo', {}, { scope: noScope });
    const failed = await waitRun(s.workflows, r2.id, ['failed']);
    expect(failed.error?.message).toBe('Сломано специально');
    expect(failed.statusReason).toContain('Сломан');
  });

  it('cancels a running step and never resumes a cancelled run', async () => {
    const { s } = await setup();
    await installTestAgent(s, { id: 'hang', tools: [], permissions: [] });
    cleanups.push(respond('Тестовый агент hang', () => new Promise(() => undefined)));
    s.workflows.save(agentDef([{ id: 'a', type: 'agent', agent: 'hang', title: 'A', input: {} }]));
    const r = await s.workflows.startRun('demo', {}, { scope: noScope });
    await waitFor(() => s.workflows.get(r.id).steps[0]?.status === 'running');
    const c = await s.workflows.cancel(r.id);
    expect(c.status).toBe('cancelled');
    expect(c.steps[0]!.status).toBe('cancelled');
    await expect(s.workflows.resume(r.id)).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
  });

  it('survives an app restart mid-step: the run is paused, the step re-runs only after the user continues', async () => {
    const t = await startTestApp({ env: ENV });
    cleanups.push(() => t.cleanup());
    const sys = await t.core.systems.create({ name: 'R', storagePath: t.sysDir('r'), template: 'empty' });
    let s = services(await t.core.systems.runtime(sys.systemId));
    await installTestAgent(s, { id: 'hang', tools: [], permissions: [] });
    const off = respond('Тестовый агент hang', () => new Promise(() => undefined));
    s.workflows.save(agentDef([{ id: 'a', type: 'agent', agent: 'hang', title: 'A', input: {} }, { id: 'b', type: 'function', fn: 'test.echo', title: 'B', dependsOn: ['a'], input: { from: { $path: 'nodes.a.output.summary' } } }]));
    const r = await s.workflows.startRun('demo', {}, { scope: noScope });
    await waitFor(() => s.workflows.get(r.id).steps[0]?.status === 'running');
    await t.core.stop();
    off();

    const core2 = await AppCore.start({ dataDir: t.dataDir, logLevel: 'warn', env: { ...process.env, ...ENV } });
    t.core = core2;
    s = services(await core2.systems.runtime(sys.systemId));
    const after = s.workflows.get(r.id);
    expect(after.status).toBe('paused');
    expect(after.steps[0]!.status).toBe('pending');
    cleanups.push(respond('Тестовый агент hang', () => ({ summary: 'после перезапуска' })));
    await s.workflows.resume(r.id);
    const done = await waitRun(s.workflows, r.id, ['completed']);
    expect(done.steps.find((x) => x.nodeId === 'b')!.output).toMatchObject({ from: 'после перезапуска' });

    // crash simulation: a run left "running" in the database is recovered as paused on the next start
    const rt = await core2.systems.runtime(sys.systemId);
    rt.db.run("UPDATE workflow_runs SET status = 'running' WHERE id = ?", r.id);
    rt.db.run("UPDATE run_steps SET status = 'running' WHERE run_id = ? AND node_id = 'b'", r.id);
    s.workflows.start();
    const recovered = s.workflows.get(r.id);
    expect(recovered.status).toBe('paused');
    expect(recovered.statusReason).toContain('Восстановлено');
    expect(recovered.steps.find((x) => x.nodeId === 'b')!.status).toBe('pending');
  });

  it('preflight reports missing agents, model routes and call estimates; setup installs them on request', async () => {
    const { s } = await setup();
    const pre = await s.workflows.preflight('spec-pipeline', noScope);
    expect(pre.ok).toBe(false);
    expect(pre.problems.join(' ')).toContain('не установлен');
    expect(pre.estimate.modelCallsMin).toBeGreaterThan(5);
    const setup1 = await s.workflows.setupAgents('spec-pipeline');
    expect(setup1.installed).toContain('spec-writer');
    const pre2 = await s.workflows.preflight('spec-pipeline', noScope);
    expect(pre2.problems).toEqual([]);
    expect(pre2.agents.every((a) => a.route?.providerId === 'test')).toBe(true);
    expect(pre2.ok).toBe(true);
  });
});

describe('task tracker', () => {
  it('creates tasks, prevents dependency cycles, requires evidence for done and exports safely', async () => {
    const { s } = await setup();
    const a = s.tasks.create({ title: 'Схема БД', priority: 'high', acceptanceCriteria: ['миграция применяется'] });
    const b = s.tasks.create({ title: 'API входа', dependsOn: [a.id] });
    const c = s.tasks.create({ title: '=HYPERLINK("http://evil")', dependsOn: [b.id] });
    expect([a.key, b.key, c.key]).toEqual(['T-001', 'T-002', 'T-003']);
    expect(() => s.tasks.addDependency(a.id, c.id)).toThrowError(expect.objectContaining({ code: 'DEPENDENCY_CYCLE' }));
    expect(() => s.tasks.setStatus(b.id, 'in_progress')).toThrowError(/зависимости/);
    expect(() => s.tasks.setStatus(a.id, 'done')).toThrowError(expect.objectContaining({ code: 'CONFIRMATION_REQUIRED' }));
    expect(() => s.tasks.setStatus(a.id, 'done', { actor: 'agent:x', confirm: true })).toThrowError(/подтверждением/);
    const doneA = s.tasks.setStatus(a.id, 'done', { evidence: 'миграция 003 применена, тест schema.test.ts зелёный' });
    expect(doneA.completionEvidence).toContain('schema.test.ts');
    expect(s.tasks.setStatus(b.id, 'in_progress').status).toBe('in_progress');
    expect(s.tasks.get(c.id).openDependencies).toBe(1);
    const board = s.tasks.board();
    expect(board.columns.find((col) => col.status === 'done')!.tasks.map((t) => t.key)).toEqual(['T-001']);
    const csv = s.tasks.export('csv').body;
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(s.tasks.export('md').body).toContain('- [x] **T-001** Схема БД');
    const node = s.graph.getNode(`task:${b.id}`);
    expect(node?.label).toBe('T-002 API входа');
    expect(s.graph.edgesOf(`task:${b.id}`).outgoing.map((e) => e.relation)).toEqual(['depends_on']);
    s.tasks.remove(c.id);
    expect(s.tasks.list().total).toBe(2);
  });
});
