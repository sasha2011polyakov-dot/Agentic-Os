import { describe, expect, it } from 'vitest';
import { cp, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readManifest } from '../src/systems/manifest.ts';
import { fileExists, hashTree, startTestApp, userTree } from './helpers.ts';

describe('system lifecycle', () => {
  it('creates independent systems with permanent ids', async () => {
    const t = await startTestApp();
    try {
      const a = await t.core.systems.create({ name: 'A', storagePath: t.sysDir('a'), template: 'starter' });
      expect(a.systemId).toMatch(/^sys_/);
      expect(a.status).toBe('connected');
      expect(await fileExists(join(t.sysDir('a'), '.aos', 'system.db'))).toBe(true);
      expect(await fileExists(join(t.sysDir('a'), 'Welcome.md'))).toBe(true);
      const aTree = await hashTree(t.sysDir('a'), { skip: (r) => r.startsWith('.aos/') });

      const b = await t.core.systems.create({ name: 'B', storagePath: t.sysDir('b') });
      expect(b.systemId).not.toBe(a.systemId);
      expect(await hashTree(t.sysDir('a'), { skip: (r) => r.startsWith('.aos/') })).toEqual(aTree);
      expect(t.core.systems.list().map((s) => s.name)).toEqual(['A', 'B']);
      // the first created system becomes active; creating B does not steal focus
      expect(t.core.systems.activeSystemId()).toBe(a.systemId);

      const renamed = await t.core.systems.update(a.systemId, { name: 'A renamed' });
      expect(renamed.systemId).toBe(a.systemId);
      expect((await readManifest(t.sysDir('a'))).name).toBe('A renamed');
    } finally {
      await t.cleanup();
    }
  });

  it('refuses nested or non-empty folders unless adopting explicitly', async () => {
    const t = await startTestApp();
    try {
      await t.core.systems.create({ name: 'A', storagePath: t.sysDir('a') });
      await expect(t.core.systems.create({ name: 'Nested', storagePath: join(t.sysDir('a'), 'inner') })).rejects.toMatchObject({ code: 'SYSTEM_PATH_CONFLICT' });
      const existing = t.sysDir('obsidian-vault');
      await mkdir(existing, { recursive: true });
      await writeFile(join(existing, 'note.md'), '# hello');
      await expect(t.core.systems.create({ name: 'V', storagePath: existing })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      const v = await t.core.systems.create({ name: 'V', storagePath: existing, adoptExistingFolder: true });
      expect(v.status).toBe('connected');
      expect(await hashTree(existing, { skip: (r) => r.startsWith('.aos/') })).toEqual(await hashTree(existing, { skip: (r) => r.startsWith('.aos/') }));
    } finally {
      await t.cleanup();
    }
  });

  it('disconnect keeps files; reconnect restores; unavailable folders are never removed', async () => {
    const t = await startTestApp();
    try {
      const a = await t.core.systems.create({ name: 'A', storagePath: t.sysDir('a'), template: 'starter' });
      const before = await userTree(t.sysDir('a'));
      await t.core.systems.disconnect(a.systemId);
      expect(t.core.systems.get(a.systemId).status).toBe('disconnected');
      expect(await userTree(t.sysDir('a'))).toEqual(before);
      await expect(t.core.systems.runtime(a.systemId)).rejects.toMatchObject({ code: 'SYSTEM_DISCONNECTED' });
      await t.core.systems.reconnect(a.systemId);
      expect(t.core.systems.get(a.systemId).status).toBe('connected');

      // simulate the folder being moved away
      await t.core.systems.closeRuntime(a.systemId);
      await rename(t.sysDir('a'), t.sysDir('a-moved'));
      expect(await t.core.systems.checkAvailability(a.systemId)).toBe('unavailable');
      expect(t.core.systems.registry.get(a.systemId)).not.toBeNull();
      await t.core.systems.relocate(a.systemId, t.sysDir('a-moved'));
      expect(t.core.systems.get(a.systemId).status).toBe('connected');
    } finally {
      await t.cleanup();
    }
  });

  it('attaching a copy with a conflicting id requires an explicit choice', async () => {
    const t = await startTestApp();
    try {
      const a = await t.core.systems.create({ name: 'A', storagePath: t.sysDir('a'), template: 'starter' });
      await t.core.systems.closeRuntime(a.systemId);
      await cp(t.sysDir('a'), t.sysDir('a-copy'), { recursive: true });
      await t.core.systems.runtime(a.systemId);
      await expect(t.core.systems.attach(t.sysDir('a-copy'))).rejects.toMatchObject({ code: 'SYSTEM_ID_CONFLICT' });
      const copy = await t.core.systems.attach(t.sysDir('a-copy'), { asCopy: true });
      expect(copy.systemId).not.toBe(a.systemId);
      expect((await readManifest(t.sysDir('a-copy'))).systemId).toBe(copy.systemId);
      expect((await readManifest(t.sysDir('a'))).systemId).toBe(a.systemId);
      // attaching the same folder again is idempotent
      const again = await t.core.systems.attach(t.sysDir('a'));
      expect(again.systemId).toBe(a.systemId);
      expect(t.core.systems.list()).toHaveLength(2);
    } finally {
      await t.cleanup();
    }
  });

  it('forget keeps files; deleteData requires the exact name and spares other systems', async () => {
    const t = await startTestApp();
    try {
      const a = await t.core.systems.create({ name: 'A', storagePath: t.sysDir('a'), template: 'starter' });
      const b = await t.core.systems.create({ name: 'B', storagePath: t.sysDir('b'), template: 'starter' });
      const bBefore = await userTree(t.sysDir('b'));
      await expect(t.core.systems.deleteData(a.systemId, { mode: 'everything', confirmName: 'wrong' })).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
      const plan = await t.core.systems.deletionPlan(a.systemId);
      expect(plan.documentFiles).toBe(2);
      const res = await t.core.systems.deleteData(a.systemId, { mode: 'everything', confirmName: 'A' });
      expect(res.status).toBe('completed');
      expect(await fileExists(t.sysDir('a'))).toBe(false);
      expect(t.core.systems.registry.get(a.systemId)).toBeNull();
      expect(await userTree(t.sysDir('b'))).toEqual(bBefore);

      await t.core.systems.forget(b.systemId);
      expect(t.core.systems.list()).toHaveLength(0);
      expect(await userTree(t.sysDir('b'))).toEqual(bBefore);
      const reattached = await t.core.systems.attach(t.sysDir('b'));
      expect(reattached.systemId).toBe(b.systemId);
    } finally {
      await t.cleanup();
    }
  });
});
