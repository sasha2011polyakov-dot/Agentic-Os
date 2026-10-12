import { readFile } from 'node:fs/promises';
import { atomicWrite } from '../fs/safe-fs.ts';
import { AppError } from '../util/errors.ts';
import { systemPaths } from './paths.ts';

export const SYSTEM_FORMAT = 'agentic-os-system';
export const SYSTEM_FORMAT_VERSION = 1;

/** Identity passport stored in <root>/.aos/system.json — makes a system folder self-describing and portable. */
export interface SystemManifest {
  format: typeof SYSTEM_FORMAT;
  formatVersion: number;
  systemId: string;
  name: string;
  createdAt: string;
}

const SYSTEM_ID_RE = /^sys_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isValidSystemId(id: string): boolean {
  return SYSTEM_ID_RE.test(id);
}

export async function readManifest(root: string): Promise<SystemManifest> {
  let raw: string;
  try {
    raw = await readFile(systemPaths(root).manifest, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new AppError('SYSTEM_NOT_FOUND_AT_PATH', undefined, { details: { path: root } });
    throw new AppError('SYSTEM_UNAVAILABLE', undefined, { cause: e, details: { path: root } });
  }
  let data: Partial<SystemManifest>;
  try {
    data = JSON.parse(raw) as Partial<SystemManifest>;
  } catch {
    throw new AppError('SYSTEM_NOT_FOUND_AT_PATH', 'Файл system.json повреждён.', { details: { path: root } });
  }
  if (data.format !== SYSTEM_FORMAT || typeof data.systemId !== 'string' || !isValidSystemId(data.systemId)) {
    throw new AppError('SYSTEM_NOT_FOUND_AT_PATH', 'Файл system.json не является паспортом системы Agentic OS.', { details: { path: root } });
  }
  if (typeof data.formatVersion !== 'number' || data.formatVersion > SYSTEM_FORMAT_VERSION) {
    throw new AppError('ARCHIVE_INVALID', `Система создана более новой версией приложения (формат ${String(data.formatVersion)}).`, { hint: 'Обновите приложение.' });
  }
  return {
    format: SYSTEM_FORMAT,
    formatVersion: data.formatVersion,
    systemId: data.systemId,
    name: typeof data.name === 'string' ? data.name : 'Без названия',
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date(0).toISOString(),
  };
}

export async function writeManifest(root: string, manifest: SystemManifest): Promise<void> {
  await atomicWrite(systemPaths(root).manifest, JSON.stringify(manifest, null, 2) + '\n');
}
