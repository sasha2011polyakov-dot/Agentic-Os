import { Fragment, type ReactNode } from 'react';

/**
 * Markdown → React elements (CommonMark/GFM subset + Obsidian-style wikilinks, tags, ==highlights==, %%comments%%).
 * Content is untrusted (notes, connected repositories): nothing is ever injected as HTML, raw HTML is shown as text,
 * and only http(s)/mailto links leave the app.
 */

export interface MdHandlers {
  /** Internal link: wikilink target or a relative Markdown link. */
  onLink(target: string): void;
  onTag(tag: string): void;
  /** Whether a wikilink target resolves (unresolved links are styled differently). */
  isResolved(target: string): boolean | null;
  /** URL of a local attachment (image) for an embed or a relative image path. */
  attachmentUrl(target: string): string;
}

type Block =
  | { t: 'h'; level: number; text: string; line: number }
  | { t: 'p'; text: string }
  | { t: 'code'; lang: string; text: string }
  | { t: 'hr' }
  | { t: 'quote'; callout: { kind: string; title: string } | null; children: Block[] }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'table'; head: string[]; align: ('left' | 'center' | 'right' | null)[]; rows: string[][] };

interface ListItem {
  text: string;
  task: boolean | null;
  children: Block[];
}

const FENCE = /^\s{0,3}(```+|~~~+)\s*([^`\s]*)?.*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

export function stripFrontmatter(src: string): { body: string; offset: number } {
  const m = /^---\r?\n[\s\S]*?\r?\n---\s*(\r?\n|$)/.exec(src);
  if (!m) return { body: src, offset: 0 };
  return { body: src.slice(m[0].length), offset: m[0].split('\n').length - 1 };
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function startsBlock(line: string, next: string | undefined): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST_ITEM.test(line) || (line.includes('|') && next !== undefined && TABLE_SEP.test(next));
}

export function parseBlocks(src: string, lineOffset = 0): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) body.push(lines[i++]!);
      i++;
      out.push({ t: 'code', lang: fence[2] ?? '', text: body.join('\n') });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      out.push({ t: 'h', level: h[1]!.length, text: h[2]!, line: i + lineOffset });
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(QUOTE.exec(lines[i++]!)![1]!);
      const callout = /^\[!(\w+)\][+-]?\s*(.*)$/.exec(body[0] ?? '');
      out.push({ t: 'quote', callout: callout ? { kind: callout[1]!.toLowerCase(), title: callout[2] || callout[1]! } : null, children: parseBlocks((callout ? body.slice(1) : body).join('\n')) });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]!).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim()) rows.push(splitRow(lines[i++]!));
      out.push({ t: 'table', head, align, rows });
      continue;
    }
    const li = LIST_ITEM.exec(line);
    if (li) {
      const block: string[] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        if (!l.trim()) {
          // a blank line ends the list unless the list continues after it
          const nxt = lines[i + 1];
          if (nxt !== undefined && (LIST_ITEM.test(nxt) || /^\s{2,}\S/.test(nxt))) {
            block.push('');
            i++;
            continue;
          }
          break;
        }
        if (!LIST_ITEM.test(l) && !/^\s+\S/.test(l) && block.length && startsBlock(l, lines[i + 1])) break;
        block.push(l);
        i++;
      }
      out.push(parseList(block));
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !(para.length && startsBlock(lines[i]!, lines[i + 1]))) para.push(lines[i++]!.trim());
    out.push({ t: 'p', text: para.join('\n') });
  }
  return out;
}

function parseList(lines: string[]): Block {
  const first = LIST_ITEM.exec(lines[0]!)!;
  const baseIndent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const items: ListItem[] = [];
  let cur: { text: string[]; sub: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const text = cur.text.join(' ');
    const task = /^\[([ xX])\]\s+/.exec(text);
    items.push({ text: task ? text.slice(task[0].length) : text, task: task ? task[1] !== ' ' : null, children: cur.sub.length ? parseBlocks(cur.sub.join('\n')) : [] });
  };
  for (const l of lines) {
    const m = LIST_ITEM.exec(l);
    if (m && m[1]!.length <= baseIndent + 1) {
      flush();
      cur = { text: [m[3]!], sub: [] };
    } else if (cur) {
      if (!cur.sub.length && !m && l.trim() && !/^\s{2,}/.test(l)) cur.text.push(l.trim());
      else cur.sub.push(l.replace(new RegExp(`^\\s{0,${baseIndent + 4}}`), ''));
    }
  }
  flush();
  return { t: 'list', ordered, start: ordered ? Number.parseInt(first[2]!, 10) || 1 : 1, items };
}

// ------------------------------------------------------------------------------------------------ inline

const INLINE: { re: RegExp; kind: string }[] = [
  { re: /`([^`]+)`/, kind: 'code' },
  { re: /%%[\s\S]*?%%/, kind: 'comment' },
  { re: /!\[\[([^\]\n]+)\]\]/, kind: 'embed' },
  { re: /\[\[([^\]\n]+)\]\]/, kind: 'wikilink' },
  { re: /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/, kind: 'image' },
  { re: /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/, kind: 'link' },
  { re: /\*\*([^*\n][\s\S]*?)\*\*|__([^_\n][\s\S]*?)__/, kind: 'strong' },
  { re: /~~([^~\n][\s\S]*?)~~/, kind: 'del' },
  { re: /==([^=\n][\s\S]*?)==/, kind: 'mark' },
  { re: /(?<![\p{L}\p{N}*])\*(?!\s)([^*\n]+?)\*(?![\p{L}\p{N}])|(?<![\p{L}\p{N}_])_(?!\s)([^_\n]+?)_(?![\p{L}\p{N}])/u, kind: 'em' },
  { re: /(?<![\p{L}\p{N}_/#&])#((?=[\p{L}\p{N}_/-]*[\p{L}_])[\p{L}\p{N}_/-]+)/u, kind: 'tag' },
  { re: /\bhttps?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/, kind: 'url' },
];

function safeHref(url: string): string | null {
  return /^(https?:|mailto:)/i.test(url) ? url : null;
}

function isExternal(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url);
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

export function Inline({ text, h }: { text: string; h: MdHandlers }): ReactNode {
  const nodes: ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest) {
    let best: { m: RegExpExecArray; kind: string } | null = null;
    for (const { re, kind } of INLINE) {
      const m = re.exec(rest);
      if (m && (!best || m.index < best.m.index)) best = { m, kind };
    }
    if (!best) {
      nodes.push(rest);
      break;
    }
    const { m, kind } = best;
    if (m.index > 0) nodes.push(rest.slice(0, m.index));
    rest = rest.slice(m.index + m[0].length);
    const k = key++;
    switch (kind) {
      case 'code':
        nodes.push(<code key={k}>{m[1]}</code>);
        break;
      case 'comment':
        break;
      case 'embed': {
        const target = m[1]!.split('|')[0]!.trim();
        if (IMAGE_EXT.test(target)) nodes.push(<img key={k} className="md-img" src={h.attachmentUrl(target)} alt={target} loading="lazy" />);
        else nodes.push(<WikiLink key={k} raw={m[1]!} h={h} embed />);
        break;
      }
      case 'wikilink':
        nodes.push(<WikiLink key={k} raw={m[1]!} h={h} />);
        break;
      case 'image': {
        const src = m[2]!;
        if (isExternal(src)) nodes.push(<a key={k} className="link" href={safeHref(src) ?? undefined} target="_blank" rel="noopener noreferrer">🖼 {m[1] || src}</a>);
        else nodes.push(<img key={k} className="md-img" src={h.attachmentUrl(decodeURI(src))} alt={m[1]} loading="lazy" />);
        break;
      }
      case 'link': {
        const href = m[2]!;
        if (isExternal(href)) {
          const safe = safeHref(href);
          nodes.push(safe ? <a key={k} className="link external" href={safe} target="_blank" rel="noopener noreferrer"><Inline text={m[1]!} h={h} /></a> : <span key={k}>{m[0]}</span>);
        } else {
          const target = decodeURI(href).replace(/#.*$/, '');
          nodes.push(
            <a key={k} className="link internal" href="#" onClick={(e) => { e.preventDefault(); if (target) h.onLink(target); }}>
              <Inline text={m[1]!} h={h} />
            </a>,
          );
        }
        break;
      }
      case 'strong':
        nodes.push(<strong key={k}><Inline text={m[1] ?? m[2]!} h={h} /></strong>);
        break;
      case 'del':
        nodes.push(<del key={k}><Inline text={m[1]!} h={h} /></del>);
        break;
      case 'mark':
        nodes.push(<mark key={k}><Inline text={m[1]!} h={h} /></mark>);
        break;
      case 'em':
        nodes.push(<em key={k}><Inline text={m[1] ?? m[2]!} h={h} /></em>);
        break;
      case 'tag':
        nodes.push(<a key={k} className="tag" href="#" onClick={(e) => { e.preventDefault(); h.onTag(m[1]!); }}>#{m[1]}</a>);
        break;
      case 'url':
        nodes.push(<a key={k} className="link external" href={m[0]} target="_blank" rel="noopener noreferrer">{m[0]}</a>);
        break;
    }
  }
  return <>{nodes.map((n, i) => (typeof n === 'string' ? <Fragment key={`t${i}`}>{withBreaks(n)}</Fragment> : n))}</>;
}

function withBreaks(s: string): ReactNode {
  const parts = s.split('\n');
  return parts.map((p, i) => (i ? [<br key={i} />, p] : p));
}

function WikiLink({ raw, h, embed }: { raw: string; h: MdHandlers; embed?: boolean }) {
  const [target, alias] = raw.split('|') as [string, string | undefined];
  const page = target.split(/[#^]/)[0]!.trim();
  const sub = target.includes('#') ? target.slice(target.indexOf('#') + 1) : '';
  const label = alias?.trim() || (page ? page + (sub ? ` › ${sub.replace(/^\^/, '')}` : '') : sub);
  const resolved = page ? h.isResolved(page) : true;
  return (
    <a
      className={`wikilink${resolved === false ? ' unresolved' : ''}${embed ? ' embed' : ''}`}
      href="#"
      title={resolved === false ? `«${page}» ещё не создан — нажмите, чтобы создать` : page}
      onClick={(e) => {
        e.preventDefault();
        if (page) h.onLink(page);
      }}
    >
      {embed ? '↳ ' : ''}
      {label}
    </a>
  );
}

const CALLOUT_ICON: Record<string, string> = { note: 'ℹ️', info: 'ℹ️', tip: '💡', warning: '⚠️', danger: '⛔', important: '❗', question: '❓', example: '📎', quote: '❝', todo: '☑️' };

export function slug(text: string): string {
  return 'h-' + text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
}

export function Blocks({ blocks, h }: { blocks: Block[]; h: MdHandlers }): ReactNode {
  return blocks.map((b, i) => {
    switch (b.t) {
      case 'h': {
        const Tag = `h${b.level}` as 'h1';
        return <Tag key={i} id={slug(b.text)}><Inline text={b.text} h={h} /></Tag>;
      }
      case 'p':
        return <p key={i}><Inline text={b.text} h={h} /></p>;
      case 'code':
        return (
          <pre key={i} className="code" data-lang={b.lang || undefined}>
            <code>{b.text}</code>
          </pre>
        );
      case 'hr':
        return <hr key={i} />;
      case 'quote':
        return b.callout ? (
          <div key={i} className={`callout callout-${b.callout.kind}`}>
            <div className="callout-title">{CALLOUT_ICON[b.callout.kind] ?? 'ℹ️'} <Inline text={b.callout.title} h={h} /></div>
            <Blocks blocks={b.children} h={h} />
          </div>
        ) : (
          <blockquote key={i}><Blocks blocks={b.children} h={h} /></blockquote>
        );
      case 'list': {
        const items = b.items.map((it, j) => (
          <li key={j} className={it.task !== null ? 'task' : undefined}>
            {it.task !== null && <input type="checkbox" checked={it.task} readOnly tabIndex={-1} aria-label={it.task ? 'выполнено' : 'не выполнено'} />}
            {it.task !== null ? (
              <span className="task-text">
                <Inline text={it.text} h={h} />
              </span>
            ) : (
              <Inline text={it.text} h={h} />
            )}
            {it.children.length > 0 && <Blocks blocks={it.children} h={h} />}
          </li>
        ));
        return b.ordered ? <ol key={i} start={b.start}>{items}</ol> : <ul key={i}>{items}</ul>;
      }
      case 'table':
        return (
          <div key={i} className="table-wrap">
            <table>
              <thead>
                <tr>{b.head.map((c, j) => <th key={j} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}><Inline text={c} h={h} /></th>)}</tr>
              </thead>
              <tbody>
                {b.rows.map((r, j) => (
                  <tr key={j}>{b.head.map((_, c) => <td key={c} style={b.align[c] ? { textAlign: b.align[c]! } : undefined}><Inline text={r[c] ?? ''} h={h} /></td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

export function Markdown({ source, h }: { source: string; h: MdHandlers }) {
  const { body, offset } = stripFrontmatter(source);
  return (
    <div className="md">
      <Blocks blocks={parseBlocks(body, offset)} h={h} />
    </div>
  );
}
