import { describe, expect, it } from 'vitest';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { services } from '../src/wiring.ts';
import { hashTree, startTestApp, waitFor } from './helpers.ts';
import { writeProject } from './fixtures/project.ts';

async function setup() {
  const t = await startTestApp();
  const sys = await t.core.systems.create({ name: 'Knowledge', storagePath: t.sysDir('main'), template: 'starter' });
  const rt = await t.core.systems.runtime(sys.systemId);
  const s = services(rt);
  await s.indexer.indexSource(rt.primaryVaultId());
  return { t, rt, s };
}

describe('projects: connect, index, rules', () => {
  it('indexes a project read-only, skips secrets/ignored files and never modifies originals', async () => {
    const { t, rt, s } = await setup();
    try {
      const proj = join(t.root, 'demo-shop');
      await writeProject(proj);
      const before = await hashTree(proj);
      const preview = await s.sources.preview(proj);
      expect(preview.git.isRepo).toBe(true);
      expect(preview.git.branch).toBe('main');
      expect(preview.git.remotes[0]!.url).not.toContain('secret');
      expect(preview.skippedByReason['secret-name']?.count).toBeGreaterThanOrEqual(2);

      const src = await s.sources.connect({ path: proj, name: 'Demo Shop', purpose: 'test' });
      await waitFor(() => s.sources.get(src.id).status === 'ready', { message: 'index ready' });
      const info = s.sources.get(src.id);
      expect(info.isGit).toBe(true);
      expect(info.writable).toBe(false);

      const files = s.sources.files(src.id, { limit: 500 }).items;
      const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
      expect(byPath['.env']?.skipReason).toBe('secret-name');
      expect(byPath['config/secrets.json']?.skipReason).toBe('secret-name');
      expect(byPath['src/leak.ts']?.skipReason).toBe('secret-content');
      expect(byPath['notes.local']?.skipReason).toBe('gitignore');
      expect(files.some((f) => f.path.startsWith('node_modules/'))).toBe(false);
      expect(files.some((f) => f.path.startsWith('build/'))).toBe(false);
      expect(byPath['src/auth.ts']?.status).toBe('indexed');

      // secret content is not searchable
      expect(s.search.search('sk-ant-api03').total).toBe(0);
      expect(s.search.search('should-never-be-indexed').total).toBe(0);

      // project files untouched
      expect(await hashTree(proj)).toEqual(before);
      await s.sources.disconnect(src.id);
      expect(await hashTree(proj)).toEqual(before);
      expect(rt.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM documents WHERE source_id = ?', src.id)!.c).toBe(0);
    } finally {
      await t.cleanup();
    }
  });

  it('builds links, backlinks, typed relations and requirement traceability', async () => {
    const { t, s } = await setup();
    try {
      const proj = join(t.root, 'demo-shop');
      await writeProject(proj);
      const src = await s.sources.connect({ path: proj, name: 'Demo Shop' });
      await waitFor(() => s.sources.get(src.id).status === 'ready');
      const auth = s.docs.list({ type: 'requirement' }).items.find((d) => d.fmId === 'REQ-001')!;
      expect(auth.title).toBe('Authorization requirements');
      const detail = await s.docs.get(auth.id);
      const backTitles = detail.backlinks.map((b) => b.title).sort();
      // README links [[REQ-001]] (resolved via frontmatter id), architecture links by title, sessions via depends_on
      expect(backTitles).toEqual(expect.arrayContaining(['Demo Shop', 'Architecture', 'Session storage']));
      expect(detail.backlinks.find((b) => b.title === 'Session storage')?.relation).toBe('depends_on');
      expect(detail.editable).toBe(false);

      const local = s.graph.local(`doc:${auth.id}`, 1);
      const relations = local.edges.map((e) => `${e.relation}:${e.origin}`);
      expect(relations).toEqual(expect.arrayContaining(['implements:extracted', 'verifies:extracted', 'depends_on:explicit', 'references:explicit']));
      expect(relations.filter((r) => r === 'implements:extracted')).toHaveLength(1);
      const project = s.graph.getNode(`project:${src.id}`);
      expect(project?.type).toBe('repository');
    } finally {
      await t.cleanup();
    }
  });
});

describe('search', () => {
  it('supports words, phrases, operators, properties and negation', async () => {
    const { t, s } = await setup();
    try {
      const proj = join(t.root, 'demo-shop');
      await writeProject(proj);
      const src = await s.sources.connect({ path: proj, name: 'Demo Shop' });
      await waitFor(() => s.sources.get(src.id).status === 'ready');
      const titles = (q: string) => s.search.search(q).hits.map((h) => h.title).sort();
      expect(titles('session')).toEqual(expect.arrayContaining(['Authorization requirements', 'Session storage']));
      expect(titles('"after 24 hours"')).toEqual(['Session storage']);
      expect(titles('session -24')).not.toContain('Session storage');
      expect(titles('tag:security')).toEqual(['Authorization requirements']);
      expect(titles('type:requirement [priority:high]')).toEqual(['Authorization requirements']);
      expect(titles('[status:draft] path:requirements')).toHaveLength(2);
      expect(titles('linksto:"Authorization requirements"')).toEqual(expect.arrayContaining(['Architecture']));
      expect(titles('file:auth')).toEqual(expect.arrayContaining(['auth', 'auth.test']));
      expect(titles('Redis OR PostgreSQL')).toContain('Architecture');
      const hit = s.search.search('Redis').hits[0]!;
      expect(hit.snippet).toContain('\u0002Redis\u0003');
      await s.docs.create({ title: 'Plan', content: '- [ ] call the supplier\n- [x] send the letter' });
      expect(titles('task-todo:call')).toEqual(['Plan']);
      expect(titles('task-done:call')).toEqual([]);
      expect(titles('task-done:letter')).toEqual(['Plan']);
    } finally {
      await t.cleanup();
    }
  });
});

describe('vault documents', () => {
  it('creates from templates, saves with conflict detection, keeps history and restores', async () => {
    const { t, rt, s } = await setup();
    try {
      const req = await s.docs.create({ title: 'Password login', templateId: 'builtin:requirement' });
      expect(req.relPath).toBe('Requirements/Password login.md');
      expect(req.fmId).toBe('REQ-001');
      const req2 = await s.docs.create({ title: 'Second', templateId: 'builtin:requirement' });
      expect(req2.fmId).toBe('REQ-002');

      const note = await s.docs.create({ title: 'Note', content: 'First version' });
      const saved = await s.docs.save(note.id, '# Note\n\nSecond version with a link to [[Password login]]', note.diskHash);
      const detail = await s.docs.get(note.id);
      expect(detail.outgoing.find((o) => o.targetRaw === 'Password login')?.resolved).toBe(true);
      // stale hash → conflict, nothing overwritten
      await expect(s.docs.save(note.id, 'conflict', note.diskHash)).rejects.toMatchObject({ code: 'WRITE_CONFLICT' });
      // external edit is detected too
      await writeFile(join(rt.paths.root, note.relPath), 'external edit');
      await expect(s.docs.save(note.id, 'mine', saved.hash)).rejects.toMatchObject({ code: 'WRITE_CONFLICT' });
      expect(await readFile(join(rt.paths.root, note.relPath), 'utf8')).toBe('external edit');

      await waitFor(async () => (await s.docs.get(note.id)).content === 'external edit');
      const versions = s.docs.versions(note.id);
      expect(versions.length).toBeGreaterThanOrEqual(1);
      const first = versions[versions.length - 1]!;
      const current = await s.docs.get(note.id);
      await s.docs.restore(note.id, first.id, current.diskHash);
      expect(await readFile(join(rt.paths.root, note.relPath), 'utf8')).toContain('First version');
    } finally {
      await t.cleanup();
    }
  });

  it('renames with a link-update plan and keeps the document id', async () => {
    const { t, rt, s } = await setup();
    try {
      const target = await s.docs.create({ title: 'Old name', folder: 'Notes' });
      const a = await s.docs.create({ title: 'A', content: 'See [[Old name]] and [[Old name#Section|alias]].' });
      const b = await s.docs.create({ title: 'B', content: 'Markdown: [link](Notes/Old%20name.md)' });
      const plan = await s.docs.planRename(target.id, 'Notes/Café menu.md');
      expect(plan.changes).toHaveLength(3);
      expect(plan.changes.map((c) => c.after).join('\n')).toContain('[[Café menu]]');
      const res = await s.docs.rename(target.id, 'Notes/Café menu.md', { updateLinks: true, planHash: plan.planHash });
      expect(res.failed).toEqual([]);
      expect(res.docId).toBe(target.id);
      const aText = await readFile(join(rt.paths.root, a.relPath), 'utf8');
      expect(aText).toContain('[[Café menu]]');
      expect(aText).toContain('[[Café menu#Section|alias]]');
      expect(await readFile(join(rt.paths.root, b.relPath), 'utf8')).toContain('(Notes/Caf%C3%A9%20menu.md)');
      const moved = await s.docs.get(target.id);
      expect(moved.relPath).toBe('Notes/Café menu.md');
      expect([...new Set(moved.backlinks.map((x) => x.title))].sort()).toEqual(['A', 'B']);
      expect(moved.backlinks).toHaveLength(3); // each link occurrence is a separate mention, like Obsidian
    } finally {
      await t.cleanup();
    }
  });

  it('detects external file changes through the watcher and moves deletions to trash', async () => {
    const { t, rt, s } = await setup();
    try {
      await writeFile(join(rt.paths.root, 'Outside.md'), '# Outside\n\ntext about hedgehogs');
      await waitFor(() => s.search.search('hedgehogs').total === 1, { message: 'watcher picked up new file' });
      await rm(join(rt.paths.root, 'Outside.md'));
      await waitFor(() => s.search.search('hedgehogs').total === 0, { message: 'watcher picked up deletion' });

      const doc = await s.docs.create({ title: 'To be deleted' });
      const res = await s.docs.delete(doc.id);
      expect(res.trashedTo).toContain('.trash');
      expect(await readFile(res.trashedTo, 'utf8')).toContain('To be deleted');
    } finally {
      await t.cleanup();
    }
  });

  it('daily notes are idempotent; unresolved links appear in the graph', async () => {
    const { t, s } = await setup();
    try {
      const d1 = await s.docs.daily(new Date(2026, 9, 12));
      const d2 = await s.docs.daily(new Date(2026, 9, 12));
      expect(d1.id).toBe(d2.id);
      expect(d1.relPath).toBe('Daily/2026-10-12.md');
      const n = await s.docs.create({ title: 'With a dangling link', content: 'Future [[Missing note]]' });
      const g = s.graph.local(`doc:${n.id}`, 1, { includeUnresolved: true });
      expect(g.nodes.some((x) => x.type === 'unresolved' && x.label === 'Missing note')).toBe(true);
      // creating the target resolves the link (forward reference)
      await s.docs.create({ title: 'Missing note' });
      const after = await s.docs.get(n.id);
      expect(after.outgoing[0]?.resolved).toBe(true);
      expect(s.graph.graph({ includeUnresolved: true }).nodes.some((x) => x.label === 'Missing note' && x.type === 'unresolved')).toBe(false);
    } finally {
      await t.cleanup();
    }
  });
});
