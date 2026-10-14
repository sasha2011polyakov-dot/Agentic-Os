/**
 * Themes change appearance only (30.6). Design tokens are validated value by value; CSS is rewritten by an allowlist
 * sanitizer: no external resources (url(), @import, @font-face — nothing can be loaded from disk or network), no
 * attribute selectors (CSS-based data exfiltration), no properties that hide or overlay interface elements
 * (display, visibility, position, z-index, content, transform…), no !important, and every rule is scoped to themable
 * containers. Security-critical UI (confirmations, warnings) lives outside `.aos-themable` and cannot be restyled.
 */

const TOKEN_KEY = /^--aos-(color|font|radius|space|shadow|motion|size|border)-[a-z0-9-]{1,40}$/;
const SAFE_VALUE = /^[a-zA-Z0-9#%.,()\s'"\-/]+$/;
const FORBIDDEN_VALUE = /url\s*\(|expression\s*\(|javascript:|image-set|attr\s*\(|@|\\|var\s*\(|env\s*\(|element\s*\(|-moz-binding|behavior/i;

export function validateThemeTokens(tokens: Record<string, unknown>): { errors: string[]; tokens: Record<string, string> } {
  const errors: string[] = [];
  const out: Record<string, string> = {};
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return { errors: ['tokens must be an object "name → value".'], tokens: out };
  const keys = Object.keys(tokens);
  if (keys.length > 200) errors.push('no more than 200 tokens.');
  for (const k of keys) {
    const v = String(tokens[k] ?? '');
    if (!TOKEN_KEY.test(k)) {
      errors.push(`the token "${k}" is not supported (allowed: --aos-color-*, --aos-font-*, --aos-radius-*, --aos-space-*, --aos-shadow-*, --aos-motion-*, --aos-size-*, --aos-border-*).`);
      continue;
    }
    if (v.length > 200 || !SAFE_VALUE.test(v) || FORBIDDEN_VALUE.test(v)) {
      errors.push(`token "${k}": invalid value (external resources, expressions and special characters are not allowed).`);
      continue;
    }
    out[k] = v.trim();
  }
  return { errors, tokens: out };
}

const ALLOWED_PROPS = new Set([
  'color', 'background', 'background-color', 'border', 'border-color', 'border-width', 'border-style', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'border-radius', 'outline-color', 'outline-width', 'outline-style', 'outline-offset',
  'box-shadow', 'text-shadow', 'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'line-height', 'text-decoration', 'text-decoration-color',
  'text-transform', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'gap', 'row-gap', 'column-gap', 'accent-color', 'caret-color', 'transition', 'transition-duration', 'transition-timing-function', 'transition-property', 'transition-delay',
  'animation', 'animation-name', 'animation-duration', 'animation-timing-function', 'animation-delay', 'animation-iteration-count', 'opacity', 'cursor',
  'scrollbar-color', 'scrollbar-width', 'text-underline-offset',
]);
const KEYFRAME_PROPS = new Set(['color', 'background-color', 'border-color', 'box-shadow', 'opacity', 'outline-color', 'text-shadow']);
const SELECTOR_OK = /^[a-zA-Z0-9_\-.:#\s>+~*(),]+$/;
const PSEUDO_OK = /^:(hover|focus|focus-visible|focus-within|active|disabled|checked|first-child|last-child|nth-child\(\s*[0-9n+\-\s]+\s*\)|not\([^()]*\)|:before|:after|:placeholder|:selection|:marker|:-webkit-scrollbar(-thumb|-track)?)$/;
const CURSORS = new Set(['auto', 'default', 'pointer', 'text', 'move', 'not-allowed', 'grab', 'grabbing', 'help', 'wait', 'progress', 'crosshair']);

export interface CssRemoval {
  severity: 'high' | 'medium' | 'low';
  text: string;
}

function lengthTooSmall(v: string): boolean {
  const m = /^(-?\d*\.?\d+)\s*(px|rem|em|%)?$/.exec(v.trim());
  if (!m) return false;
  const n = Number(m[1]);
  const unit = m[2] ?? 'px';
  return unit === 'px' ? n < 9 : unit === '%' ? n < 60 : n < 0.6;
}

/** Checks one declaration. Returns the reason it is removed, or null when it is safe. */
function declProblem(prop: string, value: string, inKeyframes: boolean): CssRemoval | null {
  const p = prop.toLowerCase();
  if (p.startsWith('--')) return /^--aos-[a-z0-9-]{1,60}$/.test(p) && SAFE_VALUE.test(value) && !FORBIDDEN_VALUE.test(value) ? null : { severity: 'medium', text: `the variable ${p} was rejected` };
  if (!(inKeyframes ? KEYFRAME_PROPS : ALLOWED_PROPS).has(p)) {
    const hiding = ['display', 'visibility', 'position', 'z-index', 'content', 'transform', 'clip', 'clip-path', 'mask', 'filter', 'width', 'height', 'max-width', 'max-height', 'overflow', 'pointer-events', 'inset', 'top', 'left', 'right', 'bottom'];
    return { severity: hiding.includes(p) ? 'high' : 'low', text: hiding.includes(p) ? `the property "${p}" can hide or replace interface elements: removed` : `the property "${p}" is not supported in themes: removed` };
  }
  if (/!\s*important/i.test(value)) return { severity: 'medium', text: `"!important" in ${p} is not allowed: protected interface elements always keep their look` };
  if (FORBIDDEN_VALUE.test(value) || !SAFE_VALUE.test(value)) return { severity: 'high', text: `the value of ${p} refers to external resources or contains expressions: removed` };
  if (p === 'opacity' && Number(value) < 0.6) return { severity: 'high', text: 'opacity below 0.6 can hide elements: removed' };
  if (p === 'color' && /transparent|rgba\([^)]*,\s*0?\.[0-4]\d*\s*\)|hsla\([^)]*,\s*0?\.[0-4]\d*\s*\)/i.test(value)) return { severity: 'high', text: 'a transparent text color can hide warnings: removed' };
  if (p === 'font-size' && lengthTooSmall(value)) return { severity: 'high', text: 'a font that is too small can hide text: removed' };
  if (p === 'cursor' && !CURSORS.has(value.trim())) return { severity: 'low', text: 'unsupported cursor: removed' };
  return null;
}

function scopeSelector(sel: string, themeId: string): string | null {
  const s = sel.trim();
  if (!s || !SELECTOR_OK.test(s)) return null;
  // pseudo-classes / pseudo-elements must be from the allowlist
  for (const m of s.matchAll(/::?[a-zA-Z-]+(\([^)]*\))?/g)) {
    const token = m[0].startsWith('::') ? `:${m[0].slice(1)}` : m[0];
    if (!PSEUDO_OK.test(token.startsWith('::') ? token.slice(1) : token)) return null;
  }
  if (/\b(html|body|head|script|iframe|dialog)\b/i.test(s) || /aos-(protected|secure|confirm)/i.test(s)) return null;
  return `[data-aos-theme="${themeId}"] .aos-themable ${s}`;
}

/** Splits CSS into top-level blocks, respecting nesting for @media / @keyframes. */
function blocks(css: string): { prelude: string; body: string }[] {
  const out: { prelude: string; body: string }[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    let depth = 1;
    let j = open + 1;
    for (; j < css.length && depth > 0; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
    }
    out.push({ prelude: css.slice(i, open).trim(), body: css.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}

function declarations(body: string, inKeyframes: boolean, removed: CssRemoval[]): string[] {
  const out: string[] = [];
  for (const raw of body.split(';')) {
    const idx = raw.indexOf(':');
    if (idx === -1) {
      if (raw.trim()) removed.push({ severity: 'low', text: `unrecognized declaration "${raw.trim().slice(0, 40)}": removed` });
      continue;
    }
    const prop = raw.slice(0, idx).trim();
    const value = raw.slice(idx + 1).trim();
    const problem = declProblem(prop, value, inKeyframes);
    if (problem) removed.push(problem);
    else out.push(`${prop.toLowerCase()}: ${value}`);
  }
  return out;
}

/** Returns sanitized CSS and the list of what was removed and why (shown to the user before installation). */
export function sanitizeThemeCss(input: string, themeId: string): { css: string; removed: CssRemoval[] } {
  const removed: CssRemoval[] = [];
  if (input.length > 200_000) return { css: '', removed: [{ severity: 'medium', text: 'CSS larger than 200 KB is not applied' }] };
  const css = input.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  for (const raw of blocks(css)) {
    // statements before a rule (`@import url(…);`, `@charset …;`) end with ";": they are dropped, the rule itself is kept
    const parts = raw.prelude.split(';');
    for (const st of parts.slice(0, -1).map((x) => x.trim()).filter(Boolean)) removed.push({ severity: /^@(import|namespace)/i.test(st) || /url\s*\(/i.test(st) ? 'high' : 'medium', text: `the statement "${st.slice(0, 40)}" loads resources or is not supported: removed` });
    const b = { prelude: parts[parts.length - 1]!.trim(), body: raw.body };
    if (/^@(import|font-face|namespace|charset|supports|layer|property|page|document)/i.test(b.prelude)) {
      removed.push({ severity: 'high', text: `the rule "${b.prelude.slice(0, 40)}" loads resources or is not supported: removed` });
      continue;
    }
    if (/^@keyframes\s+[a-zA-Z0-9_-]+$/i.test(b.prelude)) {
      const name = b.prelude.split(/\s+/)[1]!;
      const frames: string[] = [];
      for (const f of blocks(b.body)) {
        if (!/^((from|to|\d{1,3}%)\s*,?\s*)+$/.test(f.prelude)) continue;
        const d = declarations(f.body, true, removed);
        if (d.length) frames.push(`${f.prelude} { ${d.join('; ')} }`);
      }
      out.push(`@keyframes aos-${themeId}-${name} { ${frames.join(' ')} }`);
      continue;
    }
    if (/^@media\s/i.test(b.prelude)) {
      if (!/^@media\s+[a-z0-9\s():,.\-]+$/i.test(b.prelude) || /url|expression/i.test(b.prelude)) {
        removed.push({ severity: 'medium', text: 'invalid @media condition: removed' });
        continue;
      }
      const inner: string[] = [];
      for (const r of blocks(b.body)) {
        const sels = r.prelude.split(',').map((x) => scopeSelector(x, themeId));
        if (sels.some((x) => !x)) {
          removed.push({ severity: 'medium', text: `the selector "${r.prelude.slice(0, 40)}" is not supported: the rule was removed` });
          continue;
        }
        const d = declarations(r.body, false, removed);
        if (d.length) inner.push(`${sels.join(', ')} { ${d.join('; ')} }`);
      }
      if (inner.length) out.push(`${b.prelude} { ${inner.join(' ')} }`);
      continue;
    }
    if (b.prelude.startsWith('@')) {
      removed.push({ severity: 'medium', text: `the rule "${b.prelude.slice(0, 40)}" is not supported: removed` });
      continue;
    }
    if (b.prelude.includes('[')) {
      removed.push({ severity: 'high', text: `the attribute selector "${b.prelude.slice(0, 40)}" is not allowed (it can be used to read page data): removed` });
      continue;
    }
    const sels = b.prelude.split(',').map((x) => scopeSelector(x, themeId));
    if (sels.some((x) => !x)) {
      removed.push({ severity: 'medium', text: `the selector "${b.prelude.slice(0, 40)}" is not supported: the rule was removed` });
      continue;
    }
    const d = declarations(b.body, false, removed);
    if (d.length) out.push(`${sels.join(', ')} { ${d.join('; ')} }`);
  }
  // animation names point only to this theme's own keyframes
  const result = out.join('\n').replace(/(animation(?:-name)?:\s*)([a-zA-Z0-9_-]+)/g, (_m, p: string, n: string) => (['none', 'initial', 'inherit'].includes(n) ? `${p}${n}` : `${p}aos-${themeId}-${n}`));
  return { css: result, removed };
}

/** Tokens as a CSS block scoped to the theme (applied on the themable root). */
export function tokensCss(themeId: string, tokens: Record<string, string>): string {
  const body = Object.entries(tokens)
    .map(([k, v]) => `${k}: ${v};`)
    .join(' ');
  return `[data-aos-theme="${themeId}"] { ${body} }`;
}
