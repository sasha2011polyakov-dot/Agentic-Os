import type { HttpClient } from '../net/http.ts';
import { TransportError } from '../net/http.ts';
import { AppError } from '../util/errors.ts';

export interface WebSearchResult {
  url: string;
  title: string;
  snippet: string;
  publishedAt: string | null;
  provider: string;
}

export interface WebSearchProvider {
  id: string;
  search(query: string, opts: { limit: number; signal?: AbortSignal; systemId?: string }): Promise<WebSearchResult[]>;
}

function transport(e: unknown, name: string): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof TransportError) return new AppError(e.kind === 'timeout' ? 'TIMEOUT' : 'FETCH_FAILED', `${name}: ${e.message}`);
  return new AppError('FETCH_FAILED', `${name}: ${e instanceof Error ? e.message : String(e)}`);
}

/**
 * SearXNG Search API (docs.searxng.org/dev/search_api.html): GET /search?q=…&format=json. JSON output must be
 * enabled in the instance settings (search.formats), otherwise the instance answers 403.
 */
export class SearxngProvider implements WebSearchProvider {
  id = 'searxng';
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,
  ) {}
  async search(query: string, opts: { limit: number; signal?: AbortSignal; systemId?: string }): Promise<WebSearchResult[]> {
    const url = new URL('/search', this.baseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    let res;
    try {
      res = await this.http.json<{ results?: { url: string; title?: string; content?: string; publishedDate?: string }[] }>({ url: url.toString(), purpose: 'web-research', timeoutMs: 20_000, ...(opts.signal ? { signal: opts.signal } : {}), ...(opts.systemId ? { systemId: opts.systemId } : {}) });
    } catch (e) {
      throw transport(e, 'SearXNG');
    }
    if (res.status === 403) throw new AppError('WEB_SEARCH_NOT_CONFIGURED', 'SearXNG отклонил запрос формата JSON (403).', { hint: 'Включите формат json в settings.yml инстанса (search.formats: [html, json]).' });
    if (!res.ok) throw new AppError('FETCH_FAILED', `SearXNG ответил ${res.status}.`);
    return (res.data?.results ?? []).slice(0, opts.limit).map((r) => ({ url: r.url, title: r.title ?? r.url, snippet: r.content ?? '', publishedAt: r.publishedDate ?? null, provider: 'searxng' }));
  }
}

/** Brave Search API: GET https://api.search.brave.com/res/v1/web/search, header X-Subscription-Token. */
export class BraveProvider implements WebSearchProvider {
  id = 'brave';
  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: string,
  ) {}
  async search(query: string, opts: { limit: number; signal?: AbortSignal; systemId?: string }): Promise<WebSearchResult[]> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(Math.min(opts.limit, 20)));
    let res;
    try {
      res = await this.http.json<{ web?: { results?: { url: string; title?: string; description?: string; page_age?: string; age?: string }[] } }>({
        url: url.toString(),
        headers: { 'x-subscription-token': this.apiKey, accept: 'application/json' },
        purpose: 'web-research',
        timeoutMs: 20_000,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.systemId ? { systemId: opts.systemId } : {}),
      });
    } catch (e) {
      throw transport(e, 'Brave Search');
    }
    if (res.status === 401 || res.status === 403) throw new AppError('PROVIDER_AUTH_FAILED', 'Brave Search отклонил ключ.');
    if (res.status === 429) throw new AppError('PROVIDER_RATE_LIMITED', 'Brave Search: превышен лимит запросов.');
    if (!res.ok) throw new AppError('FETCH_FAILED', `Brave Search ответил ${res.status}.`);
    return (res.data?.web?.results ?? []).slice(0, opts.limit).map((r) => ({ url: r.url, title: r.title ?? r.url, snippet: (r.description ?? '').replace(/<[^>]+>/g, ''), publishedAt: r.page_age ?? null, provider: 'brave' }));
  }
}

/**
 * GitHub REST: repository search works without a token (10 req/min); code search requires authentication
 * (docs.github.com/en/rest/search/search).
 */
export class GithubClient {
  constructor(
    private readonly http: HttpClient,
    private readonly token: string | null,
  ) {}

  private headers(): Record<string, string> {
    return { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'AgenticOS', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) };
  }

  private async get<T>(path: string, signal?: AbortSignal, systemId?: string, accept?: string): Promise<{ status: number; data: T; text: string }> {
    try {
      const res = await this.http.json<T>({ url: `https://api.github.com${path}`, headers: { ...this.headers(), ...(accept ? { accept } : {}) }, purpose: 'web-research', timeoutMs: 20_000, ...(signal ? { signal } : {}), ...(systemId ? { systemId } : {}) });
      if (res.status === 403 || res.status === 429) throw new AppError('PROVIDER_RATE_LIMITED', 'GitHub API: превышен лимит запросов (без токена — 10 поисковых запросов в минуту).');
      if (res.status === 401) throw new AppError('PROVIDER_AUTH_FAILED', 'GitHub отклонил токен.');
      return { status: res.status, data: res.data, text: res.text };
    } catch (e) {
      throw transport(e, 'GitHub');
    }
  }

  async search(query: string, type: 'repositories' | 'code', limit: number, signal?: AbortSignal, systemId?: string): Promise<WebSearchResult[]> {
    if (type === 'code' && !this.token) throw new AppError('WEB_SEARCH_NOT_CONFIGURED', 'Поиск по коду GitHub требует токена.', { hint: 'Добавьте токен GitHub в настройках веб-исследований или ищите репозитории.' });
    const res = await this.get<{ items?: { html_url: string; full_name?: string; name?: string; description?: string; path?: string; repository?: { full_name: string }; updated_at?: string }[] }>(
      `/search/${type}?q=${encodeURIComponent(query)}&per_page=${Math.min(limit, 30)}`,
      signal,
      systemId,
    );
    if (res.status !== 200) throw new AppError('FETCH_FAILED', `GitHub ответил ${res.status}.`);
    return (res.data.items ?? []).map((i) => ({
      url: i.html_url,
      title: type === 'repositories' ? (i.full_name ?? i.name ?? i.html_url) : `${i.repository?.full_name ?? ''}/${i.path ?? ''}`,
      snippet: i.description ?? '',
      publishedAt: i.updated_at ?? null,
      provider: 'github',
    }));
  }

  async inspect(owner: string, repo: string, signal?: AbortSignal, systemId?: string): Promise<{ fullName: string; description: string | null; stars: number; language: string | null; topics: string[]; license: string | null; pushedAt: string | null; readme: string | null; topLevel: { name: string; type: string }[]; url: string }> {
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new AppError('VALIDATION_FAILED', 'Некорректное имя репозитория.');
    const meta = await this.get<{ full_name: string; description: string | null; stargazers_count: number; language: string | null; topics?: string[]; license?: { spdx_id?: string } | null; pushed_at: string | null; html_url: string }>(`/repos/${owner}/${repo}`, signal, systemId);
    if (meta.status === 404) throw new AppError('NOT_FOUND', 'Репозиторий не найден или приватный.');
    const readme = await this.get<string>(`/repos/${owner}/${repo}/readme`, signal, systemId, 'application/vnd.github.raw').catch(() => null);
    const contents = await this.get<{ name: string; type: string }[]>(`/repos/${owner}/${repo}/contents/`, signal, systemId).catch(() => null);
    return {
      fullName: meta.data.full_name,
      description: meta.data.description,
      stars: meta.data.stargazers_count,
      language: meta.data.language,
      topics: meta.data.topics ?? [],
      license: meta.data.license?.spdx_id ?? null,
      pushedAt: meta.data.pushed_at,
      readme: readme && readme.status === 200 ? readme.text.slice(0, 20_000) : null,
      topLevel: contents && Array.isArray(contents.data) ? contents.data.map((c) => ({ name: c.name, type: c.type })) : [],
      url: meta.data.html_url,
    };
  }
}
