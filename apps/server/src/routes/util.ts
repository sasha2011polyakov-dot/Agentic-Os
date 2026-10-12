import { AppError, type SystemRuntime } from '@aos/core';
import type { RouteContext } from '../http/router.ts';

/** Resolves the runtime of the system addressed in the URL. Every system route goes through this. */
export async function sys(ctx: RouteContext): Promise<SystemRuntime> {
  const id = ctx.params.systemId;
  if (!id) throw new AppError('VALIDATION_FAILED', 'Не указана система.');
  return ctx.core.systems.runtime(id);
}

export function body<T extends Record<string, unknown>>(ctx: RouteContext): T {
  const b = ctx.body;
  if (b === undefined || b === null) return {} as T;
  if (typeof b !== 'object' || Array.isArray(b)) throw new AppError('VALIDATION_FAILED', 'Ожидается JSON-объект.');
  return b as T;
}

export function str(v: unknown, name: string, opts: { optional?: boolean; max?: number } = {}): string {
  if (v === undefined || v === null || v === '') {
    if (opts.optional) return '';
    throw new AppError('VALIDATION_FAILED', `Поле «${name}» обязательно.`, { details: { field: name } });
  }
  if (typeof v !== 'string') throw new AppError('VALIDATION_FAILED', `Поле «${name}» должно быть строкой.`, { details: { field: name } });
  if (opts.max && v.length > opts.max) throw new AppError('VALIDATION_FAILED', `Поле «${name}» длиннее ${opts.max} символов.`, { details: { field: name } });
  return v;
}

export function optStr(v: unknown, name: string, max?: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  return str(v, name, max ? { max } : {});
}

export function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export function int(v: string | null | undefined, fallback: number, max = 10_000): number {
  const n = v === null || v === undefined ? NaN : Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, max);
}
