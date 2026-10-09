import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Controller } from '../src/main/controller';
import { contract } from '../src/shared/ipc-contract';
import type { BatchResult, Group, Harness, ScanResult, ApplyPlan } from '../src/shared/types';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup.length = 0;
});
describe('M1 integrated workflow', () => {
  it('selectively imports, groups, previews and applies to shared workspace without implicit uninstall', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hm-integration-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const repo = path.join(root, 'source');
    const workspace = path.join(root, 'project');
    await mkdir(workspace);
    for (const name of ['search-tool', 'design-tool']) {
      await mkdir(path.join(repo, name), { recursive: true });
      await writeFile(path.join(repo, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Useful ${name}\n---\n# ${name}\n`);
    }
    const app = new Controller(path.join(root, 'library'), () => {}, { watch: false });
    cleanup.push(() => app.close());
    await app.initialize();
    const scan = (await app.invoke('scan', { uri: repo })) as ScanResult;
    expect(scan.candidates).toHaveLength(2);
    const candidate = scan.candidates.find((x) => x.name === 'search-tool')!;
    const install = (await app.invoke('install', { scanId: scan.id, candidateIds: [candidate.id] })) as BatchResult;
    expect(install.items.some((x) => x.status === 'error')).toBe(false);
    const snapshot = await app.snapshot();
    expect(snapshot.skills.map((x) => x.name)).toEqual(['search-tool']);
    const skillId = snapshot.skills[0].id;
    const group = (await app.invoke('saveGroup', { name: 'Research', skillIds: [skillId] })) as Group;
    expect(group.skillIds).toEqual([skillId]);
    const a = (await app.invoke('saveHarness', {
      name: 'Test A',
      userSkillsPath: path.join(root, 'user-a'),
      workspaceSkillsRelativePath: '.shared/skills',
    })) as Harness;
    const b = (await app.invoke('saveHarness', {
      name: 'Test B',
      userSkillsPath: path.join(root, 'user-b'),
      workspaceSkillsRelativePath: '.shared/skills',
    })) as Harness;
    const request = { skillIds: [skillId], harnessIds: [a.id, b.id], scope: 'workspace', workspacePath: workspace, strategy: 'symlink' };
    const plan = (await app.invoke('previewApply', request)) as ApplyPlan;
    expect(plan.items).toHaveLength(1);
    const result = (await app.invoke('apply', request)) as BatchResult;
    expect(result.items.some((x) => x.status === 'error')).toBe(false);
    expect(await readFile(path.join(workspace, '.shared/skills/search-tool/SKILL.md'), 'utf8')).toContain('Useful search-tool');
    await app.invoke('deleteGroup', group.id);
    const after = await app.snapshot();
    expect(after.groups).toHaveLength(0);
    expect(after.distributions).toHaveLength(1);
    expect(after.intents).toHaveLength(2);
    const binding = after.bindings.find((x) => x.harnessId === a.id)!;
    await app.invoke('remove', { bindingId: binding.id, skillIds: [skillId] });
    expect((await app.snapshot()).distributions).toHaveLength(1);
    expect(await readFile(path.join(workspace, '.shared/skills/search-tool/SKILL.md'), 'utf8')).toContain('search-tool');
  });
  it('rejects unknown IPC fields and empty selections before file operations', () => {
    expect(() => contract.migrateExternal.input.parse({ externalSkillId: 'external-test', path: '/arbitrary' })).toThrow();
    expect(() => contract.openMarketplace.input.parse({ url: 'https://example.com' })).toThrow();
    expect(() => contract.apply.input.parse({ skillIds: [], harnessIds: ['x'], scope: 'user', strategy: 'symlink' })).toThrow();
    expect(() =>
      contract.saveHarness.input.parse({
        name: 'x',
        userSkillsPath: '/tmp/x',
        workspaceSkillsRelativePath: '.x/skills',
        command: 'rm -rf',
      }),
    ).toThrow();
  });
  it('saves every built-in record exactly as the edit form sends it back', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hm-builtin-edit-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const app = new Controller(path.join(root, 'library'), () => {}, { watch: false });
    cleanup.push(() => app.close());
    const builtins = app.store.list<Harness>('harnesses').filter((item) => item.origin === 'builtin');
    expect(builtins.some((item) => item.appBundleIds?.length)).toBe(true);
    for (const harness of builtins) {
      const { origin: _origin, ...editable } = harness;
      await expect(app.invoke('saveHarness', editable)).resolves.toMatchObject({ id: harness.id });
    }
  });
});
