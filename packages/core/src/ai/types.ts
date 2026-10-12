import type { HttpClient } from '../net/http.ts';

export type ProviderKind = 'ollama' | 'openai-compatible' | 'anthropic' | 'test';
export type Locality = 'local' | 'cloud';
export type TaskType = 'classification' | 'extraction' | 'generation' | 'review' | 'planning' | 'research' | 'embedding' | 'chat';

export const TASK_TYPES: { id: TaskType; label: string }[] = [
  { id: 'planning', label: 'Планирование (координатор)' },
  { id: 'extraction', label: 'Извлечение фактов и требований' },
  { id: 'classification', label: 'Классификация' },
  { id: 'generation', label: 'Генерация документов' },
  { id: 'review', label: 'Независимое ревью' },
  { id: 'research', label: 'Веб-исследования' },
  { id: 'chat', label: 'Свободные запросы' },
  { id: 'embedding', label: 'Эмбеддинги (семантический поиск)' },
];

export interface ModelCapabilities {
  chat: boolean;
  structuredOutput: boolean | 'unknown';
  tools: boolean | 'unknown';
  embeddings: boolean;
  vision: boolean;
}

export interface ModelInfo {
  id: string;
  providerId: string;
  displayName: string;
  locality: Locality;
  contextLength: number | null;
  sizeBytes: number | null;
  parameterSize: string | null;
  quantization: string | null;
  loaded: boolean | null;
  capabilities: ModelCapabilities;
}

export interface ProviderHealth {
  ok: boolean;
  version?: string | null;
  latencyMs: number;
  error?: { code: string; message: string; hint?: string };
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  /** Ask the provider for schema-constrained JSON. Callers always validate locally as well. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  signal?: AbortSignal;
  /** e.g. "agent:requirements-analyst" — used by audit, usage and the test provider. */
  purpose: string;
  systemId?: string;
}

export type FinishReason = 'stop' | 'length' | 'refusal' | 'error' | 'other';

export interface ChatResponse {
  text: string;
  finishReason: FinishReason;
  usage: { inputTokens: number | null; outputTokens: number | null };
  model: string;
  providerId: string;
  latencyMs: number;
  /** True when the provider enforced the JSON schema natively. */
  structured: boolean;
}

export interface EmbedRequest {
  model: string;
  input: string[];
  signal?: AbortSignal;
  systemId?: string;
}

export interface EmbedResponse {
  vectors: number[][];
  model: string;
  usage: { inputTokens: number | null };
}

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
}

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  locality: Locality;
  enabled: boolean;
  secretRef: string | null;
  options: Record<string, unknown>;
}

export interface ProviderDeps {
  http: HttpClient;
  apiKey: string | null;
}

/** Unified provider contract used by AI Core. Agents never see providers directly. */
export interface AIProvider {
  readonly config: ProviderConfig;
  health(signal?: AbortSignal): Promise<ProviderHealth>;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  chat(req: ChatRequest): Promise<ChatResponse>;
  embed?(req: EmbedRequest): Promise<EmbedResponse>;
}

/** Local engines may additionally manage models. */
export interface LocalModelProvider extends AIProvider {
  pullModel?(name: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void>;
  deleteModel?(name: string): Promise<void>;
  modelDetails?(name: string, signal?: AbortSignal): Promise<ModelInfo | null>;
}

/** Internal signal that the provider rejected the structured-output parameter (caller retries in prompt mode). */
export class StructuredUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructuredUnsupportedError';
  }
}
