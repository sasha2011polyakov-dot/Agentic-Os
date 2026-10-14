import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
import { zipSync } from 'fflate';
import { services } from '../src/wiring.ts';
import { appExtensions } from '../src/extensions/service.ts';
import { validateExtension } from '../src/extensions/manifest.ts';
import { APP_VERSION } from '../src/version.ts';
import { builtinAgentsDir } from '../src/agents/catalog.ts';
import { startTestApp } from './helpers.ts';

/** Every package in examples/extensions is validated with the code the app uses at install time (contributor CI). */
const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples', 'extensions');
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function packageFiles(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.set(relative(dir, p).split(sep).join('/'), await readFile(p));
    }
  };
  await walk(dir);
  return out;
}

const zip = (files: Map<string, Buffer>) => zipSync(Object.fromEntries([...files].map(([k, v]) => [k, new Uint8Array(v)])));
const packages = readdirSync(EXAMPLES, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const builtin = new Set(readdirSync(builtinAgentsDir()));

describe('examples/extensions', () => {
  it('contains example packages', () => {
    expect(packages.length).toBeGreaterThanOrEqual(3);
  });

  for (const name of packages) {
    it(`${name}: passes the same validation as an install`, async () => {
      const { report } = validateExtension(await packageFiles(join(EXAMPLES, name)), { appVersion: APP_VERSION, knownAgents: builtin });
      expect(report.errors, report.errors.join('\n')).toEqual([]);
      expect(report.ok).toBe(true);
      expect(report.findings.filter((f) => f.severity === 'high')).toEqual([]);
    });
  }

  it('the examples install and work end to end', async () => {
    const t = await startTestApp({ env: { AOS_ENABLE_TEST_PROVIDER: '1' } });
    cleanups.push(() => t.cleanup());
    const sys = await t.core.systems.create({ name: 'Examples', storagePath: t.sysDir('ex'), template: 'empty' });
    const rt = await t.core.systems.runtime(sys.systemId);
    const s = services(rt);
    const ext = appExtensions(rt.app);
    // tool plugin: reads a document only through the API, with the granted permission
    await ext.install(zip(await packageFiles(join(EXAMPLES, 'word-count-tool'))), { grants: [{ permission: 'documents.read' }], enable: true });
    const doc = await s.docs.create({ title: 'Note', content: '# Note\n\nOne two three.\n\n## Section\n\nfour\n' });
    const res = await ext.runTool('examples.word-count', 'count_words', { docId: doc.id }, { rt, scope: null, actor: 'user' });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect(res.output).toMatchObject({ title: 'Note', words: 6, headings: 2 });
    // theme: tokens and sanitized CSS
    await ext.install(zip(await packageFiles(join(EXAMPLES, 'ocean-theme'))), { enable: true });
    const css = await ext.themeCss('examples.ocean-theme:ocean');
    expect(css).toContain('--aos-color-accent: #22d3ee');
    expect(css).toContain('.aos-themable .button:hover');
    // content kit: the role becomes available in the catalog, the template is imported on request
    await ext.install(zip(await packageFiles(join(EXAMPLES, 'meeting-notes-kit'))), { enable: true });
    expect((await s.agents.catalog()).some((c) => c.id === 'meeting-summarizer')).toBe(true);
    const tpl = await ext.importTemplate(rt, 'examples.meeting-notes-kit', 'meeting');
    expect(tpl.path).toBe('Meetings/Meeting.md');
  });
});
