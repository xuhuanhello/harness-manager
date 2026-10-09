import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Controller } from '../src/main/controller';
import { Journal } from '../src/main/journal';
import { MIGRATIONS } from '../src/main/migrations';
import { Store, type StoreMigration } from '../src/main/store';
import type { Harness } from '../src/shared/types';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function root(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hm-store-migrations-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function open(directory: string): Store {
  const store = new Store(directory);
  cleanups.push(async () => store.close());
  return store;
}

const legacyHarness = (id: string, origin: Harness['origin'] = 'builtin'): Harness => ({
  id,
  name: id,
  icon: '',
  userSkillsPath: `~/.${id}/skills`,
  workspaceSkillsRelativePath: '',
  origin,
});

/** A library as the first release wrote it: user_version 0, implicit enabled flags, old phase names. */
function seedVersionZero(store: Store): void {
  store.put('harnesses', legacyHarness('codex'));
  store.put('harnesses', legacyHarness('gemini-cli'));
  store.put('harnesses', legacyHarness('opencode'));
  store.put('harnesses', legacyHarness('custom-old', 'custom'));
  store.put('harnesses', { ...legacyHarness('pi'), enabled: false });
  store.put('bindings', { id: 'binding-1', targetId: 'target-1', harnessId: 'gemini-cli', scope: 'user' });
  store.put('operations', { id: 'install-1', owner: 'library', kind: 'install', phase: 'complete', createdAt: '2026-01-01T00:00:00.000Z' });
  store.put('operations', { id: 'repair-1', owner: 'repair', phase: 'committed' });
}

describe('store migrations', () => {
  it('upgrades a version-0 library and keeps a backup of the original', async () => {
    const directory = await root();
    const store = open(directory);
    seedVersionZero(store);
    expect(store.version).toBe(0);

    const result = store.migrate(MIGRATIONS);
    expect(result).toMatchObject({ from: 0, to: 3 });
    expect(store.version).toBe(3);
    const enabled = Object.fromEntries(store.list<Harness>('harnesses').map((harness) => [harness.id, harness.enabled]));
    expect(enabled).toEqual({ codex: true, 'gemini-cli': true, opencode: false, 'custom-old': true, pi: false });
    expect(store.get<{ phase: string; updatedAt: string }>('operations', 'install-1')).toMatchObject({
      phase: 'committed',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(store.get<{ updatedAt?: string }>('operations', 'repair-1')?.updatedAt).toEqual(expect.any(String));

    expect(path.dirname(result.backupPath!)).toBe(store.root);
    const files = await readdir(store.root);
    expect(files.filter((name) => name.startsWith('manager.sqlite.bak-v0-'))).toHaveLength(1);
  });

  it('keeps the backup readable with the pre-migration data', async () => {
    const directory = await root();
    const store = open(directory);
    seedVersionZero(store);
    const { backupPath } = store.migrate(MIGRATIONS);
    const restoredRoot = await root();
    await copyFile(backupPath!, path.join(restoredRoot, 'manager.sqlite'));
    const restored = open(restoredRoot);
    expect(restored.version).toBe(0);
    expect(restored.get<Harness>('harnesses', 'opencode')?.enabled).toBeUndefined();
  });

  it('does nothing on an up-to-date store and skips the backup for an empty one', async () => {
    const store = open(await root());
    expect(store.migrate(MIGRATIONS)).toEqual({ from: 0, to: 3, backupPath: undefined });
    expect(store.migrate(MIGRATIONS)).toEqual({ from: 3, to: 3 });
    expect((await readdir(store.root)).some((name) => name.includes('.bak-'))).toBe(false);
  });

  it('stops at the last completed version and rolls back a failed migration', async () => {
    const store = open(await root());
    store.put('harnesses', legacyHarness('codex'));
    const migrations: StoreMigration[] = [
      { version: 1, description: 'ok', up: (target) => target.put('marks', { id: 'first' }) },
      {
        version: 2,
        description: 'fails halfway',
        up: (target) => {
          target.put('marks', { id: 'second' });
          throw new Error('migration failed');
        },
      },
    ];
    expect(() => store.migrate(migrations)).toThrow('migration failed');
    expect(store.version).toBe(1);
    expect(store.list<{ id: string }>('marks').map((mark) => mark.id)).toEqual(['first']);
  });

  it('migrates the library when the app starts', async () => {
    const directory = await root();
    const legacy = new Store(directory);
    seedVersionZero(legacy);
    legacy.close();
    const app = new Controller(directory, () => {}, { watch: false });
    cleanups.push(() => app.close());
    expect(app.store.version).toBe(3);
    expect(app.store.get<Harness>('harnesses', 'opencode')?.enabled).toBe(false);
    expect(app.store.get<Harness>('harnesses', 'custom-old')?.enabled).toBe(true);
  });
});

describe('journal', () => {
  it('prunes old committed and failed records but keeps blocked ones and recent history', async () => {
    const store = open(await root());
    const now = new Date('2026-09-26T00:00:00.000Z');
    const journal = new Journal(store, () => now);
    const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
    for (const [id, phase, age] of [
      ['old-committed', 'committed', 40],
      ['old-failed', 'failed', 31],
      ['old-blocked', 'blocked', 400],
      ['recent-committed', 'committed', 5],
      ['old-pending', 'staged', 90],
    ] as const) {
      store.put('operations', { id, owner: 'distribution', phase, updatedAt: daysAgo(age) });
    }
    expect(journal.prune(30)).toBe(2);
    expect(store.list<{ id: string }>('operations').map((record) => record.id)).toEqual(['old-blocked', 'old-pending', 'recent-committed']);
  });

  it('reports errors from records that did not commit', async () => {
    const store = open(await root());
    const journal = new Journal(store);
    journal.put({ id: 'a', owner: 'distribution', phase: 'blocked', error: 'needs attention' });
    journal.put({ id: 'b', owner: 'library', phase: 'committed', error: 'resolved earlier' });
    journal.put({ id: 'c', owner: 'repair', phase: 'failed' });
    expect(journal.issues()).toEqual([{ id: 'a', message: 'needs attention' }]);
    expect(journal.update('c', { error: 'retry' }).updatedAt).toEqual(expect.any(String));
  });
});
