import { describe, expect, it } from 'vitest';
import { parseMarkdown, maskNonContent } from '../src/markdown/parse.ts';
import { splitFrontmatter, updateFrontmatter } from '../src/markdown/frontmatter.ts';
import { flattenProperties, inferType } from '../src/markdown/properties.ts';

const DOC = `---
id: req-auth-001
title: User authorization
type: requirement
status: draft
tags:
  - backend
  - security
aliases: [Login]
depends_on: "[[Session store]]"
created: 2026-10-12
---

# Heading H1

Links: [[Note A]], [[Folder/Note B|alias]], [[Note C#Section]], [[Note D#^blk-1]], ![[image.png]].
Markdown: [text](Other%20Note.md) and [site](https://example.com) and [section](#local).
Tags: #projekt/größe, #1984 is not a tag, #y1984 is a tag, email@test#nottag.

\`\`\`js
const x = "[[Not a link]] #nottag";
\`\`\`

Inline \`[[also not]]\` and %%[[hidden]] #hidden%% and <!-- [[html comment]] -->.

- [ ] open task
- [x] closed task ^task-1

## Second section ##
`;

describe('markdown parser', () => {
  const p = parseMarkdown(DOC, 'req.md');

  it('parses frontmatter, title and aliases', () => {
    expect(p.frontmatterError).toBeNull();
    expect(p.frontmatter.id).toBe('req-auth-001');
    expect(p.frontmatter.created).toBe('2026-10-12');
    expect(p.title).toBe('User authorization');
    expect(p.aliases).toEqual(['Login']);
  });

  it('extracts wikilinks, embeds and markdown links with headings and blocks', () => {
    const body = p.links.filter((l) => l.kind !== 'frontmatter');
    expect(body.map((l) => [l.kind, l.target, l.heading, l.blockId, l.alias])).toEqual([
      ['wikilink', 'Note A', null, null, null],
      ['wikilink', 'Folder/Note B', null, null, 'alias'],
      ['wikilink', 'Note C', 'Section', null, null],
      ['wikilink', 'Note D', null, 'blk-1', null],
      ['embed', 'image.png', null, null, null],
      ['markdown', 'Other Note.md', null, null, 'text'],
      ['markdown', 'https://example.com', null, null, 'site'],
      ['markdown', '', 'local', null, 'section'],
    ]);
    expect(body.find((l) => l.target === 'https://example.com')?.external).toBe(true);
  });

  it('ignores links and tags inside code and comments', () => {
    const targets = p.links.map((l) => l.target);
    for (const hidden of ['Not a link', 'also not', 'hidden', 'html comment']) expect(targets).not.toContain(hidden);
    expect(p.tags.map((t) => t.tag)).not.toContain('nottag');
    expect(p.tags.map((t) => t.tag)).not.toContain('hidden');
  });

  it('applies Obsidian tag rules', () => {
    const tags = p.tags.map((t) => t.tag);
    expect(tags).toContain('projekt/größe');
    expect(tags).toContain('y1984');
    expect(tags).not.toContain('1984');
    expect(tags).toContain('backend');
    expect(tags).toContain('security');
  });

  it('turns typed frontmatter keys into relation links', () => {
    const fmLinks = p.links.filter((l) => l.kind === 'frontmatter');
    expect(fmLinks).toEqual([expect.objectContaining({ relation: 'depends_on', target: 'Session store' })]);
  });

  it('reports exact positions so links can be rewritten', () => {
    const b = p.links.find((l) => l.target === 'Folder/Note B')!;
    expect(DOC.slice(b.targetStart, b.targetEnd)).toBe('Folder/Note B');
    expect(DOC.split('\n')[b.line]).toContain('[[Folder/Note B|alias]]');
    const md = p.links.find((l) => l.target === 'Other Note.md')!;
    expect(DOC.slice(md.targetStart, md.targetEnd)).toBe('Other%20Note.md');
  });

  it('extracts headings, tasks and block ids', () => {
    expect(p.headings.map((h) => [h.level, h.text])).toEqual([
      [1, 'Heading H1'],
      [2, 'Second section'],
    ]);
    expect(p.tasks.map((t) => [t.text.replace(/ \^task-1$/, ''), t.done])).toEqual([
      ['open task', false],
      ['closed task', true],
    ]);
    expect(p.blockIds).toEqual(['task-1']);
  });

  it('keeps offsets when masking', () => {
    const t = 'a `b` c\n```\nx\n```\nd';
    expect(maskNonContent(t).length).toBe(t.length);
    expect(maskNonContent(t).split('\n').length).toBe(t.split('\n').length);
  });

  it('falls back to H1 then file name for the title', () => {
    expect(parseMarkdown('# Hello\ntext', 'x.md').title).toBe('Hello');
    expect(parseMarkdown('text only', 'My file.md').title).toBe('My file');
  });

  it('reports invalid YAML without crashing', () => {
    const bad = parseMarkdown('---\nkey: [unclosed\n---\nbody', 'x.md');
    expect(bad.frontmatterError).not.toBeNull();
    expect(bad.frontmatter).toEqual({});
  });
});

describe('frontmatter editing', () => {
  it('updates keys preserving order and comments', () => {
    const src = '---\n# comment\ntitle: A\nstatus: draft\n---\nBody\n';
    const out = updateFrontmatter(src, { status: 'approved', owner: 'me' });
    expect(out).toContain('# comment');
    expect(out.indexOf('title: A')).toBeLessThan(out.indexOf('status: approved'));
    expect(out).toContain('owner: me');
    expect(out.endsWith('Body\n')).toBe(true);
  });

  it('creates and removes the block', () => {
    const created = updateFrontmatter('Body', { tags: ['a'] });
    expect(splitFrontmatter(created).raw).toContain('tags:');
    expect(updateFrontmatter(created, { tags: undefined })).toBe('Body');
  });
});

describe('properties', () => {
  it('infers Obsidian property types', () => {
    expect(inferType('tags', ['a'])).toBe('tags');
    expect(inferType('due', '2026-10-12')).toBe('date');
    expect(inferType('at', '2026-10-12T10:30:00')).toBe('datetime');
    expect(inferType('n', 3)).toBe('number');
    expect(inferType('ok', true)).toBe('checkbox');
    expect(inferType('cast', ['a', 'b'])).toBe('list');
    const rows = flattenProperties({ cast: ['x', 'y'], n: 2, link: '[[Doc]]' });
    expect(rows).toEqual([
      { key: 'cast', ord: 0, type: 'list', text: 'x', num: null },
      { key: 'cast', ord: 1, type: 'list', text: 'y', num: null },
      { key: 'n', ord: 0, type: 'number', text: '2', num: 2 },
      { key: 'link', ord: 0, type: 'text', text: 'Doc', num: null },
    ]);
  });
});
