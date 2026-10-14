import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, parseBlocks, stripFrontmatter, type MdHandlers } from '../src/markdown.tsx';

const h: MdHandlers = {
  onLink: () => {},
  onTag: () => {},
  isResolved: (t) => (t === 'Есть' ? true : t === 'Нет' ? false : null),
  attachmentUrl: (t) => `/api/systems/s1/attachment?target=${encodeURIComponent(t)}`,
};

const html = (src: string) => renderToStaticMarkup(<Markdown source={src} h={h} />);

describe('markdown renderer: structure', () => {
  it('parses headings, paragraphs, fences, rules, tables and callouts', () => {
    const blocks = parseBlocks('# Заголовок\n\nАбзац\nв две строки\n\n```ts\nconst x = 1;\n```\n\n---\n\n| a | b |\n|:-|-:|\n| 1 | 2 |\n\n> [!warning] Осторожно\n> текст');
    expect(blocks.map((b) => b.t)).toEqual(['h', 'p', 'code', 'hr', 'table', 'quote']);
    expect(blocks[2]).toMatchObject({ t: 'code', lang: 'ts', text: 'const x = 1;' });
    expect(blocks[4]).toMatchObject({ t: 'table', head: ['a', 'b'], align: ['left', 'right'], rows: [['1', '2']] });
    expect(blocks[5]).toMatchObject({ t: 'quote', callout: { kind: 'warning', title: 'Осторожно' } });
  });

  it('keeps task items with links as one item each, with nesting', () => {
    const [list] = parseBlocks('- [x] Ядро: [[Граф]], поиск\n- [ ] Интерфейс\n  - вложенный пункт\n- обычный');
    expect(list).toMatchObject({ t: 'list', ordered: false });
    const items = (list as { items: { text: string; task: boolean | null; children: unknown[] }[] }).items;
    expect(items.map((i) => [i.text, i.task])).toEqual([
      ['Ядро: [[Граф]], поиск', true],
      ['Интерфейс', false],
      ['обычный', null],
    ]);
    expect(items[1]!.children).toHaveLength(1);
  });

  it('strips YAML frontmatter (shown as properties, not as text)', () => {
    expect(stripFrontmatter('---\ntype: plan\n---\n# Т\n').body).toBe('# Т\n');
    expect(html('---\nsecret: x\n---\nТекст')).not.toContain('secret');
  });

  it('renders ordered lists from their start number', () => {
    expect(html('3. три\n4. четыре')).toContain('<ol start="3">');
  });
});

describe('markdown renderer: links, tags and inline marks', () => {
  it('wikilinks: alias, heading, unresolved state', () => {
    const out = html('См. [[Есть|понятное имя]], [[Есть#Раздел]] и [[Нет]].');
    expect(out).toContain('>понятное имя</a>');
    expect(out).toContain('Есть › Раздел');
    expect(out).toMatch(/class="wikilink unresolved"[^>]*>Нет</);
  });

  it('tags: #тег and nested tags are tags, #1984 and a#b are not', () => {
    const out = html('#проект и #a/b, но не #1984 и не a#b');
    expect(out).toContain('>#проект</a>');
    expect(out).toContain('>#a/b</a>');
    expect(out).not.toContain('>#1984</a>');
    expect(out).not.toContain('>#b</a>');
  });

  it('bold, italic, strike, highlight, inline code; comments are hidden', () => {
    const out = html('**жирный** *курсив* ~~зачёркнуто~~ ==выделено== `код` %%скрытый комментарий%%');
    expect(out).toContain('<strong>жирный</strong>');
    expect(out).toContain('<em>курсив</em>');
    expect(out).toContain('<del>зачёркнуто</del>');
    expect(out).toContain('<mark>выделено</mark>');
    expect(out).toContain('<code>код</code>');
    expect(out).not.toContain('скрытый');
  });

  it('local images and embeds load through the attachment API', () => {
    const out = html('![[схема.png]] ![](img/a%20b.png)');
    expect(out).toContain('src="/api/systems/s1/attachment?target=%D1%81%D1%85%D0%B5%D0%BC%D0%B0.png"');
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
    const out = html('[нажми](javascript:alert(1)) и [данные](data:text/html,x)');
    expect(out).not.toMatch(/href="javascript:/i);
    expect(out).not.toMatch(/href="data:/i);
  });

  it('external links open in a new tab without access to the app window', () => {
    const out = html('[сайт](https://example.org) и https://example.com/путь');
    expect(out).toContain('href="https://example.org"');
    expect(out).toMatch(/target="_blank" rel="noopener noreferrer"/);
    expect(out).toContain('href="https://example.com/путь"');
  });

  it('external images are not loaded (privacy, strict CSP): shown as a link instead', () => {
    const out = html('![трекер](https://tracker.example/pixel.png)');
    expect(out).not.toContain('<img');
    expect(out).toContain('href="https://tracker.example/pixel.png"');
  });
});
