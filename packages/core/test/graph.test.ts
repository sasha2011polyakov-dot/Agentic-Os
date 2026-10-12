import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db/db.ts';
import { SYSTEM_MIGRATIONS } from '../src/db/system-migrations.ts';
import { GraphService, findCycles } from '../src/graph/graph.ts';
import { services } from '../src/wiring.ts';
import { integrityReport } from '../src/vault/integrity.ts';
import { startTestApp } from './helpers.ts';

function graphWith(nodes: string[], edges: [string, string, string][]) {
  const { db } = openDb(':memory:', { migrations: SYSTEM_MIGRATIONS });
  const g = new GraphService(db);
  for (const n of nodes) g.upsertNode({ id: n, type: 'note', label: n.toUpperCase() });
  for (const [a, b, rel] of edges) g.addEdge({ src: a, dst: b, relation: rel, origin: 'explicit' });
  return { g, db };
}

describe('graph algorithms', () => {
  it('finds directed cycles with Tarjan and ignores DAGs', () => {
    expect(findCycles([['a', 'b'], ['b', 'c'], ['c', 'a'], ['c', 'd']])).toEqual([['a', 'b', 'c']]);
    expect(findCycles([['a', 'b'], ['b', 'c']])).toEqual([]);
    expect(findCycles([['x', 'x']])).toEqual([['x']]);
    // long chain must not overflow the stack
    const chain: [string, string][] = Array.from({ length: 20000 }, (_, i) => [`n${i}`, `n${i + 1}`]);
    expect(findCycles(chain)).toEqual([]);
  });

  it('computes shortest paths, local neighbourhoods by depth and degree-limited views', () => {
    const { g, db } = graphWith(['a', 'b', 'c', 'd', 'e'], [
      ['a', 'b', 'references'],
      ['b', 'c', 'references'],
      ['c', 'd', 'depends_on'],
      ['a', 'e', 'references'],
    ]);
    expect(g.path('a', 'd')).toEqual(['a', 'b', 'c', 'd']);
    expect(g.path('d', 'a')).toEqual(['d', 'c', 'b', 'a']);
    expect(g.local('a', 1).nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'e']);
    expect(g.local('a', 2).nodes.map((n) => n.id).sort()).toEqual(['a', 'b', 'c', 'e']);
    const limited = g.graph({ limit: 2 });
    expect(limited.truncated).toBe(true);
    expect(limited.nodes).toHaveLength(2);
    expect(limited.total).toBe(5);
    expect(g.graph({ relations: ['depends_on'] }).edges).toHaveLength(1);
    db.close();
  });

  it('keeps AI suggestions hidden until confirmed, and remembers rejections', () => {
    const { g, db } = graphWith(['a', 'b', 'c'], []);
    g.addEdge({ src: 'a', dst: 'b', relation: 'references', origin: 'ai_suggested', confidence: 0.82, evidence: 'похожие термины' });
    const e2 = g.addEdge({ src: 'a', dst: 'c', relation: 'references', origin: 'ai_suggested', confidence: 0.4 });
    expect(g.graph().edges).toHaveLength(0);
    expect(g.graph({ includeSuggested: true }).edges).toHaveLength(2);
    const [first] = g.suggestions();
    expect(first!.confidence).toBe(0.82);
    g.reviewSuggestion(first!.id, 'confirmed');
    g.reviewSuggestion(e2, 'rejected');
    expect(g.graph().edges.map((e) => e.dst)).toEqual(['b']);
    expect(g.suggestions()).toHaveLength(0);
    expect(() => g.reviewSuggestion(e2, 'confirmed')).not.toThrow();
    db.close();
  });
});

describe('graph from documents', () => {
  it('reports cycles, broken links and missing properties in the integrity report', async () => {
    const t = await startTestApp();
    try {
      const sys = await t.core.systems.create({ name: 'G', storagePath: t.sysDir('g') });
      const rt = await t.core.systems.runtime(sys.systemId);
      const s = services(rt);
      await s.docs.create({ title: 'Задача А', content: '---\ntype: task\ndepends_on: "[[Задача Б]]"\n---\n# А' });
      await s.docs.create({ title: 'Задача Б', content: '---\ntype: task\ndepends_on: "[[Задача А]]"\n---\n# Б\nСм. [[Нет такой]]' });
      await s.docs.create({ title: 'Требование без id', content: '---\ntype: requirement\n---\n# R' });
      const report = integrityReport(rt, s.graph);
      expect(report.counts['dependency-cycle']).toBe(1);
      expect(report.counts['broken-link']).toBe(1);
      expect(report.issues.find((i) => i.kind === 'missing-property')?.message).toContain('id, status');
      expect(s.graph.integrity()).toEqual([]);
      // graph rebuild is idempotent
      const before = s.graph.stats();
      s.indexer.rebuildAllEdges();
      expect(s.graph.stats()).toEqual(before);
    } finally {
      await t.cleanup();
    }
  });
});
