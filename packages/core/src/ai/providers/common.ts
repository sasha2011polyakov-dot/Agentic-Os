import { AppError } from '../../util/errors.ts';
import { TransportError, type HttpResponse } from '../../net/http.ts';
import { StructuredUnsupportedError } from '../types.ts';

/** Maps transport failures and HTTP statuses of any provider to stable app error codes. */
export function providerError(e: unknown, providerName: string): AppError {
  if (e instanceof AppError) return e;
  if (e instanceof StructuredUnsupportedError) throw e;
  if (e instanceof TransportError) {
    if (e.kind === 'timeout') return new AppError('TIMEOUT', `${providerName}: the response timed out.`);
    if (e.kind === 'aborted') return new AppError('CANCELLED');
    return new AppError('PROVIDER_UNREACHABLE', `${providerName}: cannot connect (${e.message}).`);
  }
  return new AppError('PROVIDER_ERROR', `${providerName}: ${e instanceof Error ? e.message : String(e)}`);
}

export function httpError(res: HttpResponse<unknown>, providerName: string, model?: string): AppError {
  const msg = extractMessage(res.data) ?? res.text.slice(0, 300);
  const lower = msg.toLowerCase();
  if (res.status === 401 || res.status === 403) return new AppError('PROVIDER_AUTH_FAILED', `${providerName}: access denied (${res.status}).`, { details: { message: msg } });
  if (res.status === 429) return new AppError('PROVIDER_RATE_LIMITED', `${providerName}: the request limit was exceeded.`, { details: { message: msg } });
  if (res.status === 404 || /model .*not found|no such model|unknown model|model_not_found|not_found_error/.test(lower)) {
    return new AppError('MODEL_UNAVAILABLE', `${providerName}: model ${model ? `"${model}" ` : ''}not found.`, { details: { message: msg } });
  }
  if (res.status === 413 || /context length|context window|too many tokens|maximum context|prompt is too long/.test(lower)) {
    return new AppError('CONTEXT_TOO_LARGE', undefined, { details: { message: msg } });
  }
  return new AppError('PROVIDER_ERROR', `${providerName}: error ${res.status}: ${msg}`, { details: { status: res.status } });
}

/** True when a 400 response is about the structured-output parameter (so we can retry in prompt mode). */
export function isStructuredRejection(res: HttpResponse<unknown>): boolean {
  if (res.status !== 400 && res.status !== 422) return false;
  const msg = (extractMessage(res.data) ?? res.text).toLowerCase();
  return /response_format|json_schema|output_config|output_format|structured|format/.test(msg);
}

function extractMessage(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { error?: unknown; message?: unknown };
  if (typeof d.error === 'string') return d.error;
  if (d.error && typeof d.error === 'object' && typeof (d.error as { message?: unknown }).message === 'string') return (d.error as { message: string }).message;
  if (typeof d.message === 'string') return d.message;
  return null;
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
