import { Parser } from 'htmlparser2';

export interface ExtractedPage {
  title: string | null;
  text: string;
  markdown: string;
  publishedAt: string | null;
  canonicalUrl: string | null;
  description: string | null;
  links: { href: string; text: string }[];
}

const DROP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'embed', 'canvas', 'form', 'button', 'select', 'input', 'textarea']);
const CHROME = new Set(['nav', 'footer', 'header', 'aside']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'main', 'li', 'tr', 'br', 'hr', 'table', 'ul', 'ol', 'dl', 'dt', 'dd', 'blockquote', 'figure', 'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre']);

interface Collected {
  main: string[];
  article: string[];
  body: string[];
}

/**
 * Streaming HTML → text/markdown extraction (no DOM, no script execution). Prefers <main>/<article>,
 * drops navigation chrome. Limitation: pages rendered only by JavaScript yield little or no text.
 */
export function extractPage(html: string, baseUrl?: string): ExtractedPage {
  let title: string | null = null;
  let ogTitle: string | null = null;
  let publishedAt: string | null = null;
  let canonical: string | null = null;
  let description: string | null = null;
  const links: { href: string; text: string }[] = [];
  const out: Collected = { main: [], article: [], body: [] };
  const stack: string[] = [];
  let dropDepth = 0;
  let chromeDepth = 0;
  let inTitle = false;
  let inPre = 0;
  let mainDepth = 0;
  let articleDepth = 0;
  let currentLink: { href: string; text: string } | null = null;
  let timeDatetime: string | null = null;

  const emit = (s: string) => {
    if (dropDepth > 0 || chromeDepth > 0) return;
    out.body.push(s);
    if (mainDepth > 0) out.main.push(s);
    if (articleDepth > 0) out.article.push(s);
  };

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        stack.push(name);
        if (DROP.has(name)) dropDepth++;
        if (CHROME.has(name)) chromeDepth++;
        if (name === 'main' || attrs.role === 'main') mainDepth++;
        if (name === 'article') articleDepth++;
        if (name === 'title') inTitle = true;
        if (name === 'pre') {
          inPre++;
          emit('\n```\n');
        }
        if (name === 'meta') {
          const prop = (attrs.property ?? attrs.name ?? '').toLowerCase();
          const content = attrs.content ?? '';
          if (prop === 'og:title' && content) ogTitle = content;
          if (['article:published_time', 'datepublished', 'date', 'dc.date', 'dcterms.created', 'pubdate'].includes(prop) && content && !publishedAt) publishedAt = content;
          if ((prop === 'description' || prop === 'og:description') && content && !description) description = content;
        }
        if (name === 'link' && (attrs.rel ?? '').toLowerCase() === 'canonical' && attrs.href) canonical = resolveUrl(attrs.href, baseUrl);
        if (name === 'time' && attrs.datetime && !timeDatetime) timeDatetime = attrs.datetime;
        if (/^h[1-6]$/.test(name)) emit(`\n\n${'#'.repeat(Number(name[1]))} `);
        else if (name === 'li') emit('\n- ');
        else if (BLOCK.has(name)) emit('\n\n');
        if (name === 'a' && attrs.href && dropDepth === 0) currentLink = { href: resolveUrl(attrs.href, baseUrl), text: '' };
        if (name === 'code' && inPre === 0) emit('`');
      },
      ontext(text) {
        if (inTitle) {
          title = (title ?? '') + text;
          return;
        }
        const t = inPre > 0 ? text : text.replace(/\s+/g, ' ');
        if (currentLink) currentLink.text += t;
        emit(t);
      },
      onclosetag(name) {
        stack.pop();
        if (name === 'title') inTitle = false;
        if (name === 'code' && inPre === 0) emit('`');
        if (name === 'pre') {
          inPre = Math.max(0, inPre - 1);
          emit('\n```\n');
        }
        if (name === 'a' && currentLink) {
          if (currentLink.text.trim() && /^https?:/.test(currentLink.href)) links.push({ href: currentLink.href, text: currentLink.text.trim() });
          currentLink = null;
        }
        if (BLOCK.has(name)) emit('\n');
        if (DROP.has(name)) dropDepth = Math.max(0, dropDepth - 1);
        if (CHROME.has(name)) chromeDepth = Math.max(0, chromeDepth - 1);
        if (name === 'main') mainDepth = Math.max(0, mainDepth - 1);
        if (name === 'article') articleDepth = Math.max(0, articleDepth - 1);
      },
    },
    { decodeEntities: true, lowerCaseTags: true },
  );
  parser.write(html);
  parser.end();

  const pick = out.main.join('').trim().length > 200 ? out.main : out.article.join('').trim().length > 200 ? out.article : out.body;
  const markdown = tidy(pick.join(''));
  const text = markdown.replace(/^#+\s*/gm, '').replace(/```\n?/g, '');
  return {
    title: ((ogTitle as string | null) ?? (title as string | null))?.trim() || null,
    text,
    markdown,
    publishedAt: normalizeDate((publishedAt as string | null) ?? (timeDatetime as string | null)),
    canonicalUrl: canonical as string | null,
    description: description as string | null,
    links: links.slice(0, 300),
  };
}

export function htmlToText(html: string): { text: string; title: string | null } {
  const p = extractPage(html);
  return { text: p.text, title: p.title };
}

function tidy(s: string): string {
  return s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^- \s*$/gm, '')
    .trim();
}

function resolveUrl(href: string, base?: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function normalizeDate(v: string | null): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
