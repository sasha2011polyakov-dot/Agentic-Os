import type { Db } from '../db/db.ts';
import type { HttpClient } from '../net/http.ts';
import { AppError } from '../util/errors.ts';
import { newId } from '../util/ids.ts';
import { parseJson } from '../util/json.ts';
import { nowIso } from '../util/time.ts';
import type { AIProvider, Locality, ModelInfo, ProviderConfig, ProviderHealth, ProviderKind } from './types.ts';
import type { SecretStore } from './secrets.ts';
import { OllamaProvider } from './providers/ollama.ts';
import { OpenAICompatibleProvider } from './providers/openai-compatible.ts';
import { AnthropicProvider } from './providers/anthropic.ts';
import { TestProvider } from './providers/test.ts';
import { isPrivateNetworkHost } from '../net/policy.ts';

interface Row {
  id: string;
  kind: ProviderKind;
  name: string;
  base_url: string;
  locality: Locality;
  enabled: number;
  secret_ref: string | null;
  options: string;
}

const toConfig = (r: Row): ProviderConfig => ({ id: r.id, kind: r.kind, name: r.name, baseUrl: r.base_url, locality: r.locality, enabled: !!r.enabled, secretRef: r.secret_ref, options: parseJson(r.options, {}) });

export interface ProviderView extends ProviderConfig {
  key: { present: boolean; masked: string | null; backend: string | null };
  isTest: boolean;
}

export const PROVIDER_PRESETS: { kind: ProviderKind; name: string; baseUrl: string; locality: Locality; needsKey: boolean; options?: Record<string, unknown>; description: string }[] = [
  { kind: 'ollama', name: 'Ollama (локально)', baseUrl: 'http://127.0.0.1:11434', locality: 'local', needsKey: false, description: 'Локальные модели через Ollama. API-ключ не нужен.' },
  { kind: 'openai-compatible', name: 'LM Studio (локально)', baseUrl: 'http://127.0.0.1:1234/v1', locality: 'local', needsKey: false, options: { flavor: 'lmstudio' }, description: 'Локальный сервер LM Studio (вкладка Developer → Start server).' },
  { kind: 'openai-compatible', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', locality: 'cloud', needsKey: true, options: { flavor: 'openai' }, description: 'Облачные модели OpenAI по API-ключу.' },
  { kind: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com', locality: 'cloud', needsKey: true, description: 'Облачные модели Claude по API-ключу.' },
  { kind: 'openai-compatible', name: 'Другой OpenAI-совместимый', baseUrl: 'http://127.0.0.1:8000/v1', locality: 'local', needsKey: false, options: { flavor: 'generic' }, description: 'llama.cpp server, vLLM, LocalAI и другие совместимые серверы.' },
];

/** Shared (application-level) AI providers. Keys live in the SecretStore; the database keeps only references. */
export class ProviderRegistry {
  private readonly instances = new Map<string, AIProvider>();

  constructor(
    private readonly db: Db,
    private readonly http: HttpClient,
    private readonly secrets: SecretStore,
    private readonly testEnabled: boolean,
  ) {}

  ensureDefaults(): void {
    const count = this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM ai_providers WHERE kind <> 'test'")!.c;
    if (count === 0) {
      const now = nowIso();
      for (const p of PROVIDER_PRESETS.slice(0, 2)) {
        this.db.run('INSERT INTO ai_providers(id, kind, name, base_url, locality, enabled, secret_ref, options, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)', p.kind === 'ollama' ? 'ollama' : 'lmstudio', p.kind, p.name, p.baseUrl, p.locality, JSON.stringify(p.options ?? {}), now, now);
      }
    }
    const test = this.db.get<{ id: string }>("SELECT id FROM ai_providers WHERE id = 'test'");
    if (this.testEnabled && !test) {
      const now = nowIso();
      this.db.run("INSERT INTO ai_providers(id, kind, name, base_url, locality, enabled, secret_ref, options, created_at, updated_at) VALUES ('test', 'test', 'Тестовый провайдер (для автоматических тестов)', 'http://127.0.0.1:0', 'local', 1, NULL, '{}', ?, ?)", now, now);
    }
    if (!this.testEnabled && test) this.db.run("UPDATE ai_providers SET enabled = 0 WHERE id = 'test'");
  }

  configs(): ProviderConfig[] {
    return this.db.all<Row>('SELECT * FROM ai_providers ORDER BY locality, name').map(toConfig).filter((c) => c.kind !== 'test' || this.testEnabled);
  }

  config(id: string): ProviderConfig {
    const r = this.db.get<Row>('SELECT * FROM ai_providers WHERE id = ?', id);
    if (!r || (r.kind === 'test' && !this.testEnabled)) throw new AppError('NOT_FOUND', 'Провайдер не найден.');
    return toConfig(r);
  }

  async views(): Promise<ProviderView[]> {
    const out: ProviderView[] = [];
    for (const c of this.configs()) out.push({ ...c, key: await this.secrets.masked(c.secretRef), isTest: c.kind === 'test' });
    return out;
  }

  private validate(kind: ProviderKind, baseUrl: string, locality: Locality): void {
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new AppError('VALIDATION_FAILED', 'Некорректный адрес провайдера.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AppError('VALIDATION_FAILED', 'Адрес должен начинаться с http:// или https://.');
    if (locality === 'local' && !isPrivateNetworkHost(url.hostname)) {
      throw new AppError('VALIDATION_FAILED', 'Локальный провайдер должен указывать на этот компьютер или локальную сеть.', { hint: 'Для удалённого сервера выберите тип «облачный» — тогда к нему применяются политики облака.' });
    }
    if (locality === 'cloud' && url.protocol === 'http:' && !isPrivateNetworkHost(url.hostname)) {
      throw new AppError('VALIDATION_FAILED', 'Облачный провайдер должен использовать HTTPS.');
    }
    if (kind === 'test') throw new AppError('VALIDATION_FAILED', 'Тестовый провайдер нельзя создать вручную.');
  }

  async create(input: { kind: ProviderKind; name: string; baseUrl: string; locality: Locality; options?: Record<string, unknown>; apiKey?: string; secretBackend?: string; envKey?: string }): Promise<ProviderConfig> {
    this.validate(input.kind, input.baseUrl, input.locality);
    const id = newId('prov');
    let ref: string | null = null;
    if (input.apiKey) ref = await this.secrets.put(`provider_${id}`, input.apiKey, input.secretBackend);
    else if (input.envKey) ref = this.secrets.envRef(input.envKey);
    const now = nowIso();
    this.db.run(
      'INSERT INTO ai_providers(id, kind, name, base_url, locality, enabled, secret_ref, options, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)',
      id,
      input.kind,
      input.name.trim().slice(0, 100) || input.kind,
      input.baseUrl.trim(),
      input.locality,
      ref,
      JSON.stringify(input.options ?? {}),
      now,
      now,
    );
    return this.config(id);
  }

  async update(id: string, patch: { name?: string; baseUrl?: string; enabled?: boolean; options?: Record<string, unknown>; locality?: Locality }): Promise<ProviderConfig> {
    const c = this.config(id);
    if (c.kind === 'test') throw new AppError('VALIDATION_FAILED', 'Тестовый провайдер не редактируется.');
    const baseUrl = patch.baseUrl ?? c.baseUrl;
    const locality = patch.locality ?? c.locality;
    this.validate(c.kind, baseUrl, locality);
    this.db.run(
      'UPDATE ai_providers SET name = ?, base_url = ?, enabled = ?, options = ?, locality = ?, updated_at = ? WHERE id = ?',
      patch.name?.trim().slice(0, 100) || c.name,
      baseUrl,
      patch.enabled === undefined ? (c.enabled ? 1 : 0) : patch.enabled ? 1 : 0,
      JSON.stringify(patch.options ?? c.options),
      locality,
      nowIso(),
      id,
    );
    this.instances.delete(id);
    return this.config(id);
  }

  async setApiKey(id: string, value: string, backend?: string): Promise<void> {
    const c = this.config(id);
    if (c.secretRef) await this.secrets.remove(c.secretRef).catch(() => undefined);
    const ref = await this.secrets.put(`provider_${id}`, value, backend);
    this.db.run('UPDATE ai_providers SET secret_ref = ?, updated_at = ? WHERE id = ?', ref, nowIso(), id);
    this.instances.delete(id);
  }

  async setEnvKey(id: string, envKey: string): Promise<void> {
    this.config(id);
    this.db.run('UPDATE ai_providers SET secret_ref = ?, updated_at = ? WHERE id = ?', this.secrets.envRef(envKey), nowIso(), id);
    this.instances.delete(id);
  }

  async clearApiKey(id: string): Promise<void> {
    const c = this.config(id);
    await this.secrets.remove(c.secretRef).catch(() => undefined);
    this.db.run('UPDATE ai_providers SET secret_ref = NULL, updated_at = ? WHERE id = ?', nowIso(), id);
    this.instances.delete(id);
  }

  async remove(id: string): Promise<void> {
    const c = this.config(id);
    if (c.kind === 'test') throw new AppError('VALIDATION_FAILED', 'Тестовый провайдер не удаляется.');
    await this.secrets.remove(c.secretRef).catch(() => undefined);
    this.db.run('DELETE FROM ai_providers WHERE id = ?', id);
    this.instances.delete(id);
  }

  async instance(id: string): Promise<AIProvider> {
    const cached = this.instances.get(id);
    if (cached) return cached;
    const c = this.config(id);
    if (!c.enabled) throw new AppError('MODEL_UNAVAILABLE', `Провайдер «${c.name}» отключён.`);
    const apiKey = await this.secrets.resolve(c.secretRef);
    let p: AIProvider;
    switch (c.kind) {
      case 'ollama':
        p = new OllamaProvider(c, { http: this.http, apiKey });
        break;
      case 'openai-compatible':
        p = new OpenAICompatibleProvider(c, { http: this.http, apiKey });
        break;
      case 'anthropic':
        p = new AnthropicProvider(c, { http: this.http, apiKey });
        break;
      case 'test':
        p = new TestProvider(c);
        break;
    }
    this.instances.set(id, p);
    return p;
  }

  async health(id: string, signal?: AbortSignal): Promise<ProviderHealth> {
    const p = await this.instance(id);
    return p.health(signal);
  }

  /** Lists models (live) and refreshes the cache used by the router; falls back to the cache when offline. */
  async models(id: string, opts: { refresh?: boolean } = {}): Promise<{ models: ModelInfo[]; cached: boolean; error?: { code: string; message: string; hint?: string } }> {
    const cachedRows = this.db.all<{ info: string }>('SELECT info FROM ai_models_cache WHERE provider_id = ? ORDER BY model', id).map((r) => parseJson<ModelInfo>(r.info, null as unknown as ModelInfo));
    if (!opts.refresh && cachedRows.length) return { models: cachedRows, cached: true };
    try {
      const p = await this.instance(id);
      const models = await p.listModels();
      const now = nowIso();
      this.db.transaction(() => {
        this.db.run('DELETE FROM ai_models_cache WHERE provider_id = ?', id);
        for (const m of models) this.db.run('INSERT INTO ai_models_cache(provider_id, model, info, fetched_at) VALUES (?, ?, ?, ?)', id, m.id, JSON.stringify(m), now);
      });
      return { models, cached: false };
    } catch (e) {
      const err = e instanceof AppError ? e : new AppError('PROVIDER_ERROR', String(e));
      return { models: cachedRows, cached: true, error: { code: err.code, message: err.message, hint: err.hint } };
    }
  }

  cachedModel(providerId: string, model: string): ModelInfo | null {
    const r = this.db.get<{ info: string }>('SELECT info FROM ai_models_cache WHERE provider_id = ? AND model = ?', providerId, model);
    return r ? parseJson<ModelInfo>(r.info, null as unknown as ModelInfo) : null;
  }

  firstCachedModel(providerId: string, want: 'chat' | 'embeddings'): ModelInfo | null {
    const rows = this.db.all<{ info: string }>('SELECT info FROM ai_models_cache WHERE provider_id = ? ORDER BY model', providerId).map((r) => parseJson<ModelInfo>(r.info, null as unknown as ModelInfo));
    return rows.find((m) => (want === 'chat' ? m.capabilities.chat : m.capabilities.embeddings)) ?? null;
  }

  setPrice(providerId: string, model: string, inputPerMTok: number | null, outputPerMTok: number | null): void {
    this.db.run(
      'INSERT INTO ai_model_prices(provider_id, model, input_per_mtok, output_per_mtok) VALUES (?, ?, ?, ?) ON CONFLICT(provider_id, model) DO UPDATE SET input_per_mtok = excluded.input_per_mtok, output_per_mtok = excluded.output_per_mtok',
      providerId,
      model,
      inputPerMTok,
      outputPerMTok,
    );
  }

  price(providerId: string, model: string): { input: number | null; output: number | null } | null {
    const r = this.db.get<{ input_per_mtok: number | null; output_per_mtok: number | null }>('SELECT input_per_mtok, output_per_mtok FROM ai_model_prices WHERE provider_id = ? AND model = ?', providerId, model);
    return r ? { input: r.input_per_mtok, output: r.output_per_mtok } : null;
  }

  prices(): { providerId: string; model: string; input: number | null; output: number | null }[] {
    return this.db.all<{ provider_id: string; model: string; input_per_mtok: number | null; output_per_mtok: number | null }>('SELECT * FROM ai_model_prices').map((r) => ({ providerId: r.provider_id, model: r.model, input: r.input_per_mtok, output: r.output_per_mtok }));
  }
}
