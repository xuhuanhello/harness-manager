import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Controller } from '../src/main/controller';
import { contract } from '../src/shared/ipc-contract';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup.length = 0;
});

describe('persistent marketplace sources', () => {
  it('seeds default markets, persists custom sources, and resolves browser opens by stored ID', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hm-marketplaces-'));
    const opened: string[] = [];
    const ports = { openExternal: async (url: string) => void opened.push(url) };
    let app: Controller | undefined = new Controller(root, () => {}, { watch: false, ports });
    cleanup.push(async () => {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    });
    await app.initialize();

    const defaults = (await app.snapshot()).marketplaces;
    expect(defaults.map((item) => [item.id, item.url, item.origin])).toEqual([
      ['skills-sh', 'https://skills.sh/', 'builtin'],
      ['skillsmp', 'https://skillsmp.com/', 'builtin'],
    ]);
    await app.invoke('openMarketplace', undefined);
    await app.invoke('openMarketplace', { marketplaceId: 'skillsmp' });
    expect(opened.splice(0)).toEqual(['https://skills.sh/', 'https://skillsmp.com/']);

    const saved = (await app.invoke('saveMarketplace', { name: '  Team Catalog  ', url: 'https://catalog.example/tools/' })) as {
      id: string;
      name: string;
      url: string;
      origin: string;
    };
    expect(saved).toMatchObject({ name: 'Team Catalog', url: 'https://catalog.example/tools/', origin: 'custom' });
    expect(saved.id).not.toBe('skills-sh');
    await app.invoke('openMarketplace', { marketplaceId: saved.id });
    expect(opened.splice(0)).toEqual([saved.url]);
    await expect(app.invoke('saveMarketplace', { name: 'Different name', url: 'https://catalog.example/tools' })).rejects.toThrow(
      '已使用这个市场地址',
    );
    await expect(app.invoke('saveMarketplace', { name: ' team   catalog ', url: 'https://another.example/' })).rejects.toThrow('市场名称');
    await expect(app.invoke('openMarketplace', { marketplaceId: 'arbitrary' })).rejects.toThrow('不存在');
    await expect(app.invoke('deleteMarketplace', 'skills-sh')).rejects.toThrow('内置市场不能删除');
    await expect(app.invoke('saveMarketplace', { id: 'skills-sh', name: 'Edited', url: 'https://example.net/' })).rejects.toThrow(
      '内置市场不能编辑',
    );

    const edited = (await app.invoke('saveMarketplace', {
      id: saved.id,
      name: 'Team Catalog v2',
      url: 'http://catalog.example/new',
    })) as typeof saved;
    expect(edited.id).toBe(saved.id);
    expect(edited.url).toBe('http://catalog.example/new');

    await app.close();
    app = undefined;
    app = new Controller(root, () => {}, { watch: false, ports });
    await app.initialize();
    expect((await app.snapshot()).marketplaces).toContainEqual(edited);
    await app.invoke('deleteMarketplace', saved.id);
    expect((await app.snapshot()).marketplaces.some((item) => item.id === saved.id)).toBe(false);
    expect((await app.snapshot()).marketplaces.filter((item) => item.origin === 'builtin')).toHaveLength(2);
  });

  it('rejects unsafe or invalid website URLs and arbitrary open addresses', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hm-marketplace-validation-'));
    const opened: string[] = [];
    const app = new Controller(root, () => {}, { watch: false, ports: { openExternal: async (url) => void opened.push(url) } });
    cleanup.push(async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    });
    await app.initialize();

    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'ftp://catalog.example/',
      'https://user:secret@catalog.example/',
      'https://',
      '',
    ]) {
      await expect(app.invoke('saveMarketplace', { name: 'Unsafe', url })).rejects.toThrow();
    }
    expect(contract.openMarketplace.input.safeParse({ url: 'https://attacker.example/' }).success).toBe(false);
    await expect(app.invoke('openMarketplace', { url: 'https://attacker.example/' })).rejects.toThrow();
    expect(opened).toEqual([]);
  });
});
