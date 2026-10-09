import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Controller, type PlatformPorts } from '../src/main/controller';
import { routes } from '../src/main/routes';
import { AppError } from '../src/shared/errors';
import { ACTIONS } from '../src/shared/ipc-actions';
import { contract } from '../src/shared/ipc-contract';
import type { Harness } from '../src/shared/types';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function controller(ports: Partial<PlatformPorts> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hm-contract-'));
  let changes = 0;
  const app = new Controller(
    path.join(root, 'library'),
    () => {
      changes += 1;
    },
    { watch: false, ports },
  );
  cleanups.push(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  await app.initialize();
  return { app, root, changes: () => changes };
}

describe('IPC contract', () => {
  it('declares a schema and a route for exactly the listed actions', () => {
    expect(Object.keys(contract).sort()).toEqual([...ACTIONS].sort());
    expect(Object.keys(routes).sort()).toEqual([...ACTIONS].sort());
  });

  it('keeps the queueing and refresh behavior of each action', () => {
    const unqueued = ACTIONS.filter((action) => routes[action].queue === 'none');
    expect(unqueued.sort()).toEqual(['checkUpdates', 'chooseDirectory', 'detectHarnessInstallations', 'marketplaceCatalog']);
    const readOnly = ACTIONS.filter((action) => routes[action].queue === 'state' && !routes[action].mutates);
    expect(readOnly.sort()).toEqual(
      [
        'migrationRepairs',
        'openMarketplace',
        'openMarketplaceSkill',
        'openSkillSource',
        'previewApply',
        'previewHarnessCleanup',
        'previewMigrateExternal',
        'revealHarnessDirectory',
        'revealSkill',
        'scan',
        'snapshot',
      ].sort(),
    );
  });

  it('rejects malformed requests at the boundary with a readable Chinese message', async () => {
    const { app } = await controller();
    const skillId = `skill_${'a'.repeat(64)}`;
    const scanId = '00000000-0000-0000-0000-000000000000';
    const install = contract.install.input;
    expect(install.safeParse({ scanId, candidateIds: [skillId], customGroupName: '   ' }).success).toBe(false);
    const both = install.safeParse({ scanId, candidateIds: [skillId], customGroupName: 'Business', createDetectedGroups: true });
    expect(both.success ? '' : both.error.issues[0].message).toBe('识别分组与自定义分组不能同时指定。');
    expect(contract.saveGroup.input.safeParse({ groupId: '../outside', skillIds: [skillId] }).success).toBe(false);
    expect(contract.saveSettings.input.safeParse({ viewMode: 'unknown' }).success).toBe(false);

    const rejected = app.invoke('apply', { skillIds: [], harnessIds: ['codex'], scope: 'user', strategy: 'symlink' });
    await expect(rejected).rejects.toBeInstanceOf(AppError);
    await expect(rejected).rejects.toMatchObject({ code: 'INVALID_REQUEST', message: expect.stringMatching(/^skillIds：.*[一-鿿]/) });
  });

  it('saves every field of a custom Harness and rejects the universal kind', async () => {
    const { app, root } = await controller();
    const input = {
      name: 'Editor Agent',
      userSkillsPath: path.join(root, 'editor-agent'),
      workspaceSkillsRelativePath: '.editor/skills',
      kind: 'desktop' as const,
      appPaths: ['/Applications/Editor Agent.app'],
      appBundleIds: ['com.example.editor-agent'],
      extensionIds: ['example.editor-agent'],
      extensionRoots: ['~/.vscode/extensions'],
      documentationUrl: 'https://example.com/docs/skills',
    };
    const saved = (await app.invoke('saveHarness', input)) as Harness;
    const stored = app.store.get<Harness>('harnesses', saved.id)!;
    for (const record of [saved, stored]) {
      expect(record).toMatchObject({
        appBundleIds: input.appBundleIds,
        extensionIds: input.extensionIds,
        extensionRoots: input.extensionRoots,
        documentationUrl: input.documentationUrl,
      });
    }
    await expect(app.invoke('saveHarness', { ...input, name: 'Universal Agent', kind: 'universal' })).rejects.toThrow('命令行或桌面应用');
  });

  it('routes operating-system effects through the injected ports', async () => {
    const opened: string[] = [];
    const { app } = await controller({ chooseDirectory: async () => '/chosen', openExternal: async (url) => void opened.push(url) });
    expect(await app.invoke('chooseDirectory', undefined)).toBe('/chosen');
    await app.invoke('openMarketplace', { marketplaceId: 'skillsmp' });
    await app.invoke('openMarketplaceSkill', { marketplaceId: 'skills-sh', url: 'https://skills.sh/owner/repo/skill' });
    await expect(app.invoke('openMarketplaceSkill', { marketplaceId: 'skills-sh', url: 'https://attacker.example/' })).rejects.toThrow();
    expect(opened).toEqual(['https://skillsmp.com/', 'https://skills.sh/owner/repo/skill']);
  });

  it('asks the renderer to refresh after mutations, including failed ones, but not after reads', async () => {
    const { app, changes } = await controller();
    await app.invoke('snapshot', undefined);
    expect(changes()).toBe(0);
    await app.invoke('saveSettings', { viewMode: 'flat' });
    expect(changes()).toBe(1);
    await expect(app.invoke('deleteMarketplace', 'skills-sh')).rejects.toThrow();
    expect(changes()).toBe(2);
  });
});
