import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, parseBlocks, stripFrontmatter, type MdHandlers } from '../src/markdown.tsx';

const h: MdHandlers = {
  onLink: () => {},
  onTag: () => {},
  isResolved: (t) => (t === 'Exists' ? true : t === 'Missing' ? false : null),
  attachmentUrl: (t) => `/api/systems/s1/attachment?target=${encodeURIComponent(t)}`,
};

const html = (src: string) => renderToStaticMarkup(<Markdown source={src} h={h} />);

describe('markdown renderer: structure', () => {
  it('parses headings, paragraphs, fences, rules, tables and callouts', () => {
    const blocks = parseBlocks('# Heading\n\nA paragraph\nin two lines\n\n```ts\nconst x = 1;\n```\n\n---\n\n| a | b |\n|:-|-:|\n| 1 | 2 |\n\n> [!warning] Careful\n> text');
    expect(blocks.map((b) => b.t)).toEqual(['h', 'p', 'code', 'hr', 'table', 'quote']);
    expect(blocks[2]).toMatchObject({ t: 'code', lang: 'ts', text: 'const x = 1;' });
    expect(blocks[4]).toMatchObject({ t: 'table', head: ['a', 'b'], align: ['left', 'right'], rows: [['1', '2']] });
    expect(blocks[5]).toMatchObject({ t: 'quote', callout: { kind: 'warning', title: 'Careful' } });
  });

  it('keeps task items with links as one item each, with nesting', () => {
    const [list] = parseBlocks('- [x] Core: [[Graph]], search\n- [ ] Interface\n  - nested item\n- plain');
    expect(list).toMatchObject({ t: 'list', ordered: false });
    const items = (list as { items: { text: string; task: boolean | null; children: unknown[] }[] }).items;
    expect(items.map((i) => [i.text, i.task])).toEqual([
      ['Core: [[Graph]], search', true],
      ['Interface', false],
      ['plain', null],
    ]);
    expect(items[1]!.children).toHaveLength(1);
  });

  it('strips YAML frontmatter (shown as properties, not as text)', () => {
    expect(stripFrontmatter('---\ntype: plan\n---\n# T\n').body).toBe('# T\n');
    expect(html('---\nsecret: x\n---\nText')).not.toContain('secret');
  });

  it('renders ordered lists from their start number', () => {
    expect(html('3. three\n4. four')).toContain('<ol start="3">');
  });
});

describe('markdown renderer: links, tags and inline marks', () => {
  it('wikilinks: alias, heading, unresolved state', () => {
    const out = html('See [[Exists|a friendly name]], [[Exists#Section]] and [[Missing]].');
    expect(out).toContain('>a friendly name</a>');
    expect(out).toContain('Exists › Section');
    expect(out).toMatch(/class="wikilink unresolved"[^>]*>Missing</);
  });

  it('tags: #tag, Unicode and nested tags are tags, #1984 and a#b are not', () => {
    const out = html('#café and #a/b, but not #1984 and not a#b');
    expect(out).toContain('>#café</a>');
    expect(out).toContain('>#a/b</a>');
    expect(out).not.toContain('>#1984</a>');
    expect(out).not.toContain('>#b</a>');
  });

  it('bold, italic, strike, highlight, inline code; comments are hidden', () => {
    const out = html('**bold** *italic* ~~struck~~ ==highlighted== `code` %%hidden comment%%');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<em>italic</em>');
    expect(out).toContain('<del>struck</del>');
    expect(out).toContain('<mark>highlighted</mark>');
    expect(out).toContain('<code>code</code>');
    expect(out).not.toContain('hidden');
  });

  it('local images and embeds load through the attachment API', () => {
    const out = html('![[schéma.png]] ![](img/a%20b.png)');
    expect(out).toContain('src="/api/systems/s1/attachment?target=sch%C3%A9ma.png"');
    expect(out).toContain('target=img%2Fa%20b.png');
  });
});

describe('markdown renderer: untrusted content is never executed', () => {
  it('raw HTML is shown as text, not injected', () => {
    const out = html('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<img src="x"');
    expect(out).toContain('&lt;script&gt;');
  });

  it('javascript: and data: links do not become links', () => {
    const out = html('[click](javascript:alert(1)) and [data](data:text/html,x)');
    expect(out).not.toMatch(/href="javascript:/i);
    expect(out).not.toMatch(/href="data:/i);
  });

  it('external links open in a new tab without access to the app window', () => {
    const out = html('[site](https://example.org) and https://example.com/café');
    expect(out).toContain('href="https://example.org"');
    expect(out).toMatch(/target="_blank" rel="noopener noreferrer"/);
    expect(out).toContain('href="https://example.com/café"');
  });

  it('external images are not loaded (privacy, strict CSP): shown as a link instead', () => {
    const out = html('![tracker](https://tracker.example/pixel.png)');
    expect(out).not.toContain('<img');
    expect(out).toContain('href="https://tracker.example/pixel.png"');
  });
});
