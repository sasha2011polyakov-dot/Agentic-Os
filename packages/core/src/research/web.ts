import type { AppServices } from '../systems/context.ts';
import type { SystemRuntime } from '../systems/runtime.ts';
import type { SecretStore } from '../ai/secrets.ts';
import { AppError } from '../util/errors.ts';
import { secretKindsIn } from '../security/egress.ts';
import { sha256 } from '../util/hash.ts';
import { newId } from '../util/ids.ts';
import { nowIso } from '../util/time.ts';
import { extractPage } from './extract.ts';
import { SafeFetcher } from './safe-fetch.ts';
import { BraveProvider, GithubClient, SearxngProvider, type WebSearchProvider, type WebSearchResult } from './search-providers.ts';

export interface WebSearchSettings {
  provider: 'none' | 'searxng' | 'brave';
  searxngUrl: string;
  braveSecretRef: string | null;
  githubSecretRef: string | null;
  allowHttp: boolean;
}

export interface StoredPage {
  sourceId: string;
  url: string;
  finalUrl: string;
  title: string | null;
  publishedAt: string | null;
  retrievedAt: string;
  contentHash: string;
  text: string;
  markdown: string;
  truncated: boolean;
  links: { href: string; text: string }[];
}

/**
 * Web research services. Fetching uses SafeFetcher (SSRF-safe); results are stored in the requesting system's
 * own database (web_sources + content blob) so citations can be re-verified later and travel with the system.
 */
export class WebResearch {
  readonly fetcher: SafeFetcher;

  constructor(
    private readonly app: AppServices,
    private readonly secrets: SecretStore,
    fetcher?: SafeFetcher,
  ) {
    this.fetcher = fetcher ?? new SafeFetcher(app.policy);
  }

  settings(): WebSearchSettings {
    return this.app.appSettings.get<WebSearchSettings>('web.search');
  }

  async provider(): Promise<WebSearchProvider> {
    const s = this.settings();
    if (s.provider === 'searxng') {
      if (!s.searxngUrl) throw new AppError('WEB_SEARCH_NOT_CONFIGURED');
      return new SearxngProvider(this.app.http, s.searxngUrl);
    }
    if (s.provider === 'brave') {
      const key = await this.secrets.resolve(s.braveSecretRef);
      if (!key) throw new AppError('WEB_SEARCH_NOT_CONFIGURED', 'Не задан ключ Brave Search.');
      return new BraveProvider(this.app.http, key);
    }
    throw new AppError('WEB_SEARCH_NOT_CONFIGURED');
  }

  async github(): Promise<GithubClient> {
    const token = await this.secrets.resolve(this.settings().githubSecretRef);
    return new GithubClient(this.app.http, token);
  }

  async search(query: string, limit: number, signal?: AbortSignal, systemId?: string): Promise<WebSearchResult[]> {
    if (!query.trim()) throw new AppError('VALIDATION_FAILED', 'Пустой поисковый запрос.');
    const kinds = secretKindsIn(query);
    if (kinds.length) throw new AppError('SECRET_EGRESS_BLOCKED', `Поисковый запрос не отправлен: в нём найдено ${kinds.join(', ')}.`);
    const p = await this.provider();
    return p.search(query.slice(0, 400), { limit: Math.min(limit, 20), ...(signal ? { signal } : {}), ...(systemId ? { systemId } : {}) });
  }

  /** Fetches, extracts and stores a page in the system's web_sources (content kept for later grounding). */
  async fetchAndStore(rt: SystemRuntime, url: string, opts: { signal?: AbortSignal; maxChars?: number; provider?: string } = {}): Promise<StoredPage> {
    const kinds = secretKindsIn(url);
    if (kinds.length) {
      rt.security.record({ actor: 'web', action: 'secret.blocked', outcome: 'denied', resources: [new URL(url).hostname], message: `Загрузка адреса заблокирована: в URL найдено ${kinds.join(', ')}. Данные не отправлены.` });
      throw new AppError('SECRET_EGRESS_BLOCKED', `Адрес не загружен: в URL найдено ${kinds.join(', ')}.`);
    }
    const page = await this.fetcher.fetch(url, { systemId: rt.systemId, allowHttp: this.settings().allowHttp, ...(opts.signal ? { signal: opts.signal } : {}) });
    const raw = page.body.toString('utf8');
    const extracted = page.contentType.includes('html') ? extractPage(raw, page.finalUrl) : { title: null, text: raw, markdown: raw, publishedAt: null, canonicalUrl: null, description: null, links: [] };
    if (!extracted.text.trim()) throw new AppError('EXTRACTION_EMPTY', undefined, { details: { url: page.finalUrl } });
    const retrievedAt = nowIso();
    const contentHash = sha256(extracted.markdown);
    const blob = rt.history.putBlob(extracted.markdown);
    const existing = rt.db.get<{ id: string }>('SELECT id FROM web_sources WHERE url = ?', page.finalUrl);
    const id = existing?.id ?? newId('web');
    rt.db.run(
      `INSERT INTO web_sources(id, url, canonical_url, title, published_at, retrieved_at, verified_at, status_code, content_hash, content_blob, provider, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(url) DO UPDATE SET canonical_url = excluded.canonical_url, title = excluded.title, published_at = COALESCE(excluded.published_at, web_sources.published_at),
         retrieved_at = excluded.retrieved_at, verified_at = excluded.verified_at, status_code = excluded.status_code, content_hash = excluded.content_hash,
         content_blob = excluded.content_blob, error = NULL`,
      id,
      page.finalUrl,
      extracted.canonicalUrl,
      extracted.title,
      extracted.publishedAt,
      retrievedAt,
      retrievedAt,
      page.status,
      contentHash,
      blob,
      opts.provider ?? null,
    );
    if (page.finalUrl !== url) {
      // remember the requested URL too, so citations using it resolve to the same content
      rt.db.run('INSERT OR IGNORE INTO web_sources(id, url, canonical_url, title, published_at, retrieved_at, verified_at, status_code, content_hash, content_blob, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', newId('web'), url, page.finalUrl, extracted.title, extracted.publishedAt, retrievedAt, retrievedAt, page.status, contentHash, blob, opts.provider ?? null);
    }
    const max = opts.maxChars ?? 20_000;
    return {
      sourceId: existing?.id ?? id,
      url,
      finalUrl: page.finalUrl,
      title: extracted.title,
      publishedAt: extracted.publishedAt,
      retrievedAt,
      contentHash,
      text: extracted.text.slice(0, max),
      markdown: extracted.markdown.slice(0, max),
      truncated: page.truncated || extracted.markdown.length > max,
      links: extracted.links.slice(0, 50),
    };
  }

  /** Full stored text of previously fetched sources (for compare_sources / grounding). */
  storedTexts(rt: SystemRuntime, urls: string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const u of new Set(urls)) {
      const row = rt.db.get<{ content_blob: string | null; url: string; canonical_url: string | null }>('SELECT content_blob, url, canonical_url FROM web_sources WHERE url = ? OR canonical_url = ? LIMIT 1', u, u);
      if (row?.content_blob) {
        const text = rt.history.getBlob(row.content_blob);
        if (text !== null) out.set(u, text);
      }
    }
    return out;
  }

  /** Re-fetches a stored source and reports whether its content changed since the last retrieval. */
  async verifyFreshness(rt: SystemRuntime, url: string, signal?: AbortSignal): Promise<{ url: string; status: 'unchanged' | 'changed' | 'unavailable' | 'new'; previousRetrievedAt: string | null; retrievedAt: string | null; error?: string }> {
    const prev = rt.db.get<{ content_hash: string | null; retrieved_at: string }>('SELECT content_hash, retrieved_at FROM web_sources WHERE url = ?', url);
    try {
      const page = await this.fetchAndStore(rt, url, signal ? { signal } : {});
      if (!prev) return { url, status: 'new', previousRetrievedAt: null, retrievedAt: page.retrievedAt };
      return { url, status: prev.content_hash === page.contentHash ? 'unchanged' : 'changed', previousRetrievedAt: prev.retrieved_at, retrievedAt: page.retrievedAt };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      rt.db.run('UPDATE web_sources SET error = ? WHERE url = ?', msg, url);
      return { url, status: 'unavailable', previousRetrievedAt: prev?.retrieved_at ?? null, retrievedAt: null, error: msg };
    }
  }

  sources(rt: SystemRuntime, limit = 200): { id: string; url: string; title: string | null; publishedAt: string | null; retrievedAt: string; verifiedAt: string | null; error: string | null }[] {
    return rt.db
      .all<{ id: string; url: string; title: string | null; published_at: string | null; retrieved_at: string; verified_at: string | null; error: string | null }>('SELECT id, url, title, published_at, retrieved_at, verified_at, error FROM web_sources ORDER BY retrieved_at DESC LIMIT ?', limit)
      .map((r) => ({ id: r.id, url: r.url, title: r.title, publishedAt: r.published_at, retrievedAt: r.retrieved_at, verifiedAt: r.verified_at, error: r.error }));
  }
}
