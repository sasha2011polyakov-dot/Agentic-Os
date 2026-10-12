import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowFunction, FunctionContext } from '../workflows/functions.ts';
import { services } from '../wiring.ts';
import { projectInventory } from '../sources/inventory.ts';
import { verifyQuote } from '../research/grounding.ts';
import { sanitizeFileName } from '../vault/documents.ts';
import { parseJson } from '../util/json.ts';
import { nowIso } from '../util/time.ts';
import { AppError, toAppError } from '../util/errors.ts';
import { countBlocking, validateRequirements, validateTasks, type Evidence, type Finding, type Requirement, type SpecTask } from './validators.ts';
import { renderSpec, renumber, requirementDocMarkdown, shortText, type ContradictionIssue, type SpecData, type WriterOutput } from './render.ts';

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Sources the run may read: the user's selection (+ the vault), or everything when nothing was selected. */
function readable(ctx: FunctionContext): Set<string> | null {
  if (!ctx.scope.sourceIds.length) return null;
  return new Set([...ctx.scope.sourceIds, ctx.rt.primaryVaultId()]);
}

function runEvent(ctx: FunctionContext, type: string, message: string, data: unknown): void {
  ctx.rt.db.run("INSERT INTO run_events(run_id, step_id, ts, level, type, message, data) VALUES (?, ?, ?, 'info', ?, ?, ?)", ctx.runId, ctx.stepId, nowIso(), type, message, JSON.stringify(data));
}

function lastRunEvent<T>(ctx: FunctionContext, type: string): T | null {
  const r = ctx.rt.db.get<{ data: string }>('SELECT data FROM run_events WHERE run_id = ? AND type = ? ORDER BY id DESC LIMIT 1', ctx.runId, type);
  return r ? parseJson<T | null>(r.data, null) : null;
}

async function pathFree(root: string, rel: string): Promise<boolean> {
  try {
    await stat(join(root, rel));
    return false;
  } catch {
    return true;
  }
}

async function freeName(root: string, folder: string, base: string, taken: Set<string>): Promise<string> {
  for (let i = 0; i < 500; i++) {
    const name = i === 0 ? base : `${base} ${i + 1}`;
    const rel = folder ? `${folder}/${name}.md` : `${name}.md`;
    if (!taken.has(rel) && (await pathFree(root, rel))) {
      taken.add(rel);
      return name;
    }
  }
  throw new AppError('INTERNAL', 'Не удалось подобрать свободное имя файла.');
}

function nextNumber(ctx: FunctionContext, prefix: string): number {
  let max = 0;
  for (const r of ctx.rt.db.all<{ fm_id: string }>('SELECT fm_id FROM documents WHERE fm_id IS NOT NULL')) {
    const m = new RegExp(`^${prefix}-(\\d+)$`, 'i').exec(r.fm_id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export interface SpecPayload {
  title: string;
  goal: string;
  writer: WriterOutput;
  requirements: Requirement[];
  tasks: SpecTask[];
  evidence: Evidence[];
  issues: ContradictionIssue[];
  resolutions: { id: string; value: string }[];
  review?: SpecData['review'];
  requirementCheck?: { findings: Finding[]; metrics: Record<string, number> };
  taskCheck?: { findings: Finding[]; metrics: Record<string, number> };
}

function specData(a: SpecPayload, runId: string, status: 'draft' | 'approved'): SpecData {
  const findings = [...arr<Finding>(a.requirementCheck?.findings), ...arr<Finding>(a.taskCheck?.findings)];
  return {
    title: a.title,
    goal: a.goal,
    writer: { title: a.writer?.title ?? a.title, summary: a.writer?.summary ?? '', sections: arr(a.writer?.sections), assumptions: arr(a.writer?.assumptions), open_questions: arr(a.writer?.open_questions), omitted_sections: arr(a.writer?.omitted_sections) },
    requirements: arr(a.requirements),
    tasks: arr(a.tasks),
    evidence: arr(a.evidence),
    issues: arr(a.issues),
    resolutions: arr<{ id: string; value: string }>(a.resolutions).map((r) => ({ issue: r.id, decision: r.value })),
    findings,
    metrics: { ...(a.requirementCheck?.metrics ?? {}), ...(a.taskCheck?.metrics ?? {}) },
    review: a.review ?? null,
    runId,
    status,
  };
}

export const SPEC_FUNCTIONS: WorkflowFunction[] = [
  {
    name: 'spec.context',
    label: 'Сбор контекста',
    description: 'Список источников и документов, выбранных для запуска, и детерминированная инвентаризация проектов.',
    async run(_args, ctx) {
      const allowed = readable(ctx);
      const rows = ctx.rt.db.all<{ id: string; name: string; kind: string; confidential: number }>('SELECT id, name, kind, confidential FROM sources ORDER BY kind DESC, name');
      const inScope = rows.filter((r) => !allowed || allowed.has(r.id));
      const sources = inScope.map((r) => ({ id: r.id, name: r.name, kind: r.kind, documents: ctx.rt.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM documents WHERE source_id = ?', r.id)!.c }));
      const selectedDocuments = ctx.scope.docIds
        .map((id) => ctx.rt.db.get<{ id: string; title: string }>('SELECT id, title FROM documents WHERE id = ?', id))
        .filter((d): d is { id: string; title: string } => !!d)
        .map((d) => ({ docId: d.id, title: d.title }));
      const inventories = [];
      for (const r of inScope.filter((x) => x.kind === 'project')) {
        try {
          inventories.push(await projectInventory(ctx.rt, r.id));
        } catch (e) {
          ctx.log(`Инвентаризация проекта «${r.name}» не выполнена: ${toAppError(e).message}`);
        }
      }
      return { sources, selectedDocuments, inventories, hasProjects: inventories.length > 0, confidential: inScope.some((r) => r.confidential) };
    },
  },
  {
    name: 'spec.ground_evidence',
    label: 'Проверка цитат',
    description: 'Программно проверяет, что цитаты свидетельств дословно есть в источниках, и что источники входят в область запуска.',
    async run(args, ctx) {
      const allowed = readable(ctx);
      const s = services(ctx.rt);
      const cache = new Map<string, { text: string; title: string } | null>();
      const load = async (type: string, ref: string): Promise<{ text: string; title: string; sourceId: string } | null> => {
        if (type === 'document') {
          const d = ctx.rt.db.get<{ id: string; source_id: string; title: string }>('SELECT id, source_id, title FROM documents WHERE id = ?', ref);
          if (!d) return null;
          if (!cache.has(ref)) cache.set(ref, { text: (await s.docs.get(d.id)).content, title: d.title });
          return { ...cache.get(ref)!, sourceId: d.source_id };
        }
        const idx = ref.indexOf(':');
        if (idx <= 0) return null;
        const sourceId = ref.slice(0, idx);
        const path = ref.slice(idx + 1);
        const f = ctx.rt.db.get<{ status: string }>('SELECT status FROM files WHERE source_id = ? AND rel_path = ?', sourceId, path);
        if (!f || f.status !== 'indexed') return null;
        if (!cache.has(ref)) cache.set(ref, { text: (await s.sources.readFile(sourceId, path)).text, title: path });
        return { ...cache.get(ref)!, sourceId };
      };
      const out: Evidence[] = [];
      for (const raw of arr<Evidence & { verification?: string }>(args.evidence)) {
        const e: Evidence & { verification?: string } = { ...raw };
        if (e.kind === 'assumption' || !e.quote || !e.source) {
          e.quote_verified = false;
          e.verification = e.kind === 'assumption' ? 'допущение' : 'нет цитаты или источника';
          if (e.kind === 'fact') e.kind = 'assumption';
          out.push(e);
          continue;
        }
        let src: Awaited<ReturnType<typeof load>> = null;
        try {
          src = await load(e.source.type, e.source.ref);
        } catch {
          src = null;
        }
        if (!src) {
          e.quote_verified = false;
          e.verification = 'источник не найден';
        } else if (allowed && !allowed.has(src.sourceId)) {
          e.quote_verified = false;
          e.verification = 'источник вне области запуска';
        } else {
          const r = verifyQuote(e.quote, src.text);
          e.quote_verified = r.found;
          e.verification = r.found ? (r.method === 'exact' ? 'цитата найдена' : `цитата найдена (совпадение ${Math.round(r.ratio * 100)}%)`) : 'цитата не найдена в источнике';
          e.source = { ...e.source, title: src.title };
        }
        out.push(e);
      }
      const facts = out.filter((e) => e.kind === 'fact');
      return { evidence: out, stats: { total: out.length, facts: facts.length, verified: facts.filter((e) => e.quote_verified).length, unverified: facts.filter((e) => !e.quote_verified).length, assumptions: out.length - facts.length } };
    },
  },
  {
    name: 'spec.validate_requirements',
    label: 'Проверка требований',
    description: 'Уникальность ID, ссылки на свидетельства, циклы, расплывчатые формулировки, критерии приёмки, дубли.',
    run(args) {
      return validateRequirements(arr(args.requirements), arr(args.evidence));
    },
  },
  {
    name: 'spec.validate_tasks',
    label: 'Проверка декомпозиции',
    description: 'Ссылки задач на требования, циклы зависимостей, покрытие требований задачами.',
    run(args) {
      return validateTasks(arr(args.tasks), arr(args.requirements));
    },
  },
  {
    name: 'spec.render',
    label: 'Сборка документа ТЗ',
    description: 'Собирает Markdown технического задания из проверенных данных и разделов автора.',
    run(args, ctx) {
      const data = specData(args as unknown as SpecPayload, ctx.runId, 'draft');
      return { markdown: renderSpec(data), metrics: data.metrics, findings: data.findings, blocking: countBlocking(data.findings) };
    },
  },
  {
    name: 'spec.save',
    label: 'Сохранение ТЗ',
    description: 'Сохраняет утверждённое ТЗ, документы требований и задачи трекера со связями в графе. Повторный запуск не создаёт дубликатов.',
    sideEffects: true,
    async run(args, ctx) {
      const a = args as unknown as SpecPayload;
      const s = services(ctx.rt);
      const vault = ctx.rt.db.get<{ root_path: string }>('SELECT root_path FROM sources WHERE id = ?', ctx.rt.primaryVaultId())!;
      const specsFolder = ctx.rt.settings.get<string>('docs.specsFolder') || 'Specs';
      const requirements = arr<Requirement>(a.requirements);
      const tasks = arr<SpecTask>(a.tasks);
      if (!requirements.length) throw new AppError('VALIDATION_FAILED', 'Нечего сохранять: нет требований.');

      // 1. Plan (stored once per run so a re-run after a crash produces the same names and numbers).
      interface Plan {
        reqMap: Record<string, string>;
        specFolder: string;
        specName: string;
        reqFolder: string;
        reqNames: Record<string, string>;
      }
      let plan = lastRunEvent<Plan>(ctx, 'spec.save.plan');
      if (!plan) {
        const taken = new Set<string>();
        let n = nextNumber(ctx, 'REQ');
        const reqMap: Record<string, string> = {};
        for (const r of requirements) reqMap[r.id] = `REQ-${String(n++).padStart(3, '0')}`;
        const base = sanitizeFileName(a.title || 'Техническое задание');
        const specName = await freeName(vault.root_path, specsFolder, base, taken);
        const reqFolder = `${specsFolder}/${specName} — требования`;
        const reqNames: Record<string, string> = {};
        for (const r of requirements) reqNames[r.id] = await freeName(vault.root_path, reqFolder, sanitizeFileName(`${reqMap[r.id]} ${shortText(r.statement, 50)}`), taken);
        plan = { reqMap, specFolder: specsFolder, specName, reqFolder, reqNames };
        runEvent(ctx, 'spec.save.plan', 'План сохранения ТЗ', plan);
      }
      const map = new Map(Object.entries(plan.reqMap));
      const reqs = renumber(requirements, map);
      const specTasks = renumber(tasks, map);
      const evidence = arr<Evidence>(a.evidence);
      const writer = renumber(a.writer, map);
      const issues = renumber(arr<ContradictionIssue>(a.issues), map);
      const specLink = `${plan.specFolder}/${plan.specName}`;
      const reqDocs = new Map(requirements.map((r) => [plan!.reqMap[r.id]!, `${plan!.reqFolder}/${plan!.reqNames[r.id]}`]));

      // 2. Tasks (idempotent: created ones are journaled per local id).
      const created = new Map<string, { id: string; key: string }>();
      for (const r of ctx.rt.db.all<{ data: string }>("SELECT data FROM run_events WHERE run_id = ? AND type = 'spec.save.task'", ctx.runId)) {
        const d = parseJson<{ local: string; id: string; key: string } | null>(r.data, null);
        if (d && ctx.rt.db.get('SELECT id FROM tasks WHERE id = ?', d.id)) created.set(d.local, { id: d.id, key: d.key });
      }
      for (const t of specTasks) {
        if (created.has(t.id)) continue;
        const view = s.tasks.create({
          title: t.title,
          description: t.description,
          goal: t.goal ?? '',
          rationale: t.rationale ?? '',
          priority: t.priority,
          status: 'backlog',
          acceptanceCriteria: t.acceptance_criteria ?? [],
          affectedModules: t.affected_modules ?? [],
          unknowns: t.unknowns ?? [],
          requirementIds: t.requirement_ids ?? [],
          origin: 'agent',
          originRunId: ctx.runId,
          actor: `workflow:${ctx.runId}`,
        });
        created.set(t.id, { id: view.id, key: view.key });
        runEvent(ctx, 'spec.save.task', `Создана задача ${view.key}`, { local: t.id, id: view.id, key: view.key });
      }
      for (const t of specTasks) {
        const me = created.get(t.id)!;
        for (const d of t.depends_on ?? []) {
          const dep = created.get(d);
          if (dep) {
            try {
              s.tasks.addDependency(me.id, dep.id, `workflow:${ctx.runId}`);
            } catch (e) {
              ctx.log(`Зависимость ${me.key} → ${dep.key} не добавлена: ${toAppError(e).message}`);
            }
          }
        }
        if (t.parent_id && created.get(t.parent_id)) s.tasks.update(me.id, { parentId: created.get(t.parent_id)!.id }, `workflow:${ctx.runId}`);
      }
      const taskKeys = new Map([...created].map(([local, v]) => [local, v.key]));

      // 3. Requirement documents.
      const evMap = new Map(evidence.map((e) => [e.id, e]));
      const reqDocIds: { id: string; docId: string; path: string }[] = [];
      for (const r of reqs) {
        const name = plan.reqNames[requirements[reqs.indexOf(r)]!.id]!;
        const rel = `${plan.reqFolder}/${name}.md`;
        let doc = ctx.rt.db.get<{ id: string }>('SELECT id FROM documents WHERE source_id = ? AND rel_path = ?', ctx.rt.primaryVaultId(), rel);
        if (!doc) {
          const tasksFor = specTasks.filter((t) => (t.requirement_ids ?? []).includes(r.id)).map((t) => ({ key: created.get(t.id)!.key, title: t.title }));
          const content = requirementDocMarkdown(r, { specTitle: specLink, reqDocs, evidence: evMap, tasks: tasksFor, runId: ctx.runId });
          const d = await s.docs.create({ title: r.id, folder: plan.reqFolder, fileName: name, content, actor: `workflow:${ctx.runId}` });
          doc = { id: d.id };
        }
        reqDocIds.push({ id: r.id, docId: doc.id, path: rel });
      }

      // 4. The specification itself (approved).
      const specRel = `${plan.specFolder}/${plan.specName}.md`;
      let specDoc = ctx.rt.db.get<{ id: string }>('SELECT id FROM documents WHERE source_id = ? AND rel_path = ?', ctx.rt.primaryVaultId(), specRel);
      if (!specDoc) {
        const data = specData({ ...a, writer, requirements: reqs, tasks: specTasks, issues, evidence }, ctx.runId, 'approved');
        let md = renderSpec(data, { requirementDocs: reqDocs, taskKeys });
        const sourceDocs = [...new Set(evidence.filter((e) => e.source?.type === 'document' && e.quote_verified && e.source.title).map((e) => e.source!.title!))];
        if (sourceDocs.length) md = md.replace(/^---\n/, `---\nderived_from: [${sourceDocs.map((t) => JSON.stringify(`[[${t}]]`)).join(', ')}]\n`);
        const d = await s.docs.create({ title: a.title, folder: plan.specFolder, fileName: plan.specName, content: md, actor: `workflow:${ctx.runId}` });
        specDoc = { id: d.id };
      }
      // 5. Tasks point at the spec and their requirement documents now that both are indexed.
      for (const v of created.values()) {
        ctx.rt.db.run('UPDATE tasks SET origin_doc_id = ? WHERE id = ?', specDoc.id, v.id);
        s.tasks.syncGraph(v.id);
      }
      ctx.rt.emit('tasks.changed', { runId: ctx.runId });
      return { specDocId: specDoc.id, specPath: specRel, requirementDocs: reqDocIds, tasks: [...created].map(([local, v]) => ({ localId: local, id: v.id, key: v.key })), idMap: plan.reqMap };
    },
  },
];
