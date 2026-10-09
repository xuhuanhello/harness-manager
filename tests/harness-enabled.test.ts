import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HarnessInstallationService } from '../src/main/harness-installation';
import { createServices } from '../src/main/services';
import type { HarnessConfigService } from '../src/main/harness-config';
import { Store } from '../src/main/store';
import type { Binding, Harness, Skill } from '../src/shared/types';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hm-harness-enabled-'));
  const home = path.join(root, 'home');
  await mkdir(home, { recursive: true });
  const store = new Store(path.join(root, 'library'));
  const services = createServices(store, { home });
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { ...services, root, home };
}

function saveHarness(harnesses: HarnessConfigService, name: string, userSkillsPath: string) {
  return harnesses.saveHarness({ name, userSkillsPath, workspaceSkillsRelativePath: '' });
}

async function importSkill(f: Awaited<ReturnType<typeof fixture>>, name = 'enabled-skill'): Promise<Skill> {
  const repo = path.join(f.root, 'repo');
  const source = path.join(repo, name);
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), `---\nname: ${name}\ndescription: enabled test skill\n---\n# ${name}\n`);
  const scan = await f.library.scan({ uri: repo });
  const candidate = scan.candidates.find((item) => item.name === name)!;
  await f.library.install({ scanId: scan.id, candidateIds: [candidate.id] });
  return f.store.get<Skill>('skills', candidate.id)!;
}

it('seeds only legacy builtins enabled, upgrades old bindings conservatively, and preserves saved state', async () => {
  const f = await fixture();
  const defaults = f.store.list<Harness>('harnesses');
  for (const id of ['universal', 'claude-code', 'codex']) expect(defaults.find((item) => item.id === id)?.enabled).toBe(true);
  expect(defaults.find((item) => item.id === 'gemini-cli')?.enabled).toBe(false);
  expect(defaults.find((item) => item.id === 'codex-app')?.enabled).toBe(false);

  const custom = saveHarness(f.harnesses, 'Default custom', path.join(f.home, '.custom/skills'));
  expect(custom.enabled).toBe(true);
  f.harnesses.setHarnessEnabled({ harnessId: custom.id, enabled: false });
  createServices(f.store, { home: f.home });
  expect(f.store.get<Harness>('harnesses', custom.id)?.enabled).toBe(false);

  const legacyHome = path.join(f.root, 'legacy-home');
  const legacyStore = new Store(path.join(f.root, 'legacy-library'));
  const legacyRecord = (id: string): Harness => ({
    id,
    name: id,
    icon: '',
    userSkillsPath: `~/.${id}/skills`,
    workspaceSkillsRelativePath: `.${id}/skills`,
    origin: 'builtin',
  });
  legacyStore.put('harnesses', legacyRecord('gemini-cli'));
  legacyStore.put('harnesses', legacyRecord('opencode'));
  legacyStore.put('harnesses', legacyRecord('codex'));
  legacyStore.put('bindings', {
    id: 'old-gemini-binding',
    targetId: 'old-target',
    harnessId: 'gemini-cli',
    scope: 'user',
  } satisfies Binding);
  // Startup migrates the store before any service reads it.
  createServices(legacyStore, { home: legacyHome });
  expect(legacyStore.get<Harness>('harnesses', 'gemini-cli')?.enabled).toBe(true);
  expect(legacyStore.get<Harness>('harnesses', 'opencode')?.enabled).toBe(false);
  expect(legacyStore.get<Harness>('harnesses', 'codex')?.enabled).toBe(true);
  legacyStore.close();
});

it('blocks apply and removal through disabled or shared-disabled bindings without changing installed files', async () => {
  const f = await fixture();
  const skill = await importSkill(f);
  const sharedPath = path.join(f.home, '.shared-skills');
  const active = saveHarness(f.harnesses, 'Active reader', sharedPath);
  const second = saveHarness(f.harnesses, 'Second reader', sharedPath);
  const request = { skillIds: [skill.id], harnessIds: [active.id, second.id], scope: 'user' as const, strategy: 'symlink' as const };
  await f.distribution.apply(request);
  const entry = path.join(sharedPath, skill.name);
  const existingTarget = await realpath(entry);
  expect(f.store.list('intents')).toHaveLength(2);

  f.harnesses.setHarnessEnabled({ harnessId: second.id, enabled: false });
  expect(await realpath(entry)).toBe(existingTarget);
  expect(f.store.list('intents')).toHaveLength(2);
  await expect(f.distribution.previewApply({ ...request, harnessIds: [active.id] })).rejects.toThrow(/已禁用.*共享目录/);
  const disabledBinding = f.store.list<Binding>('bindings').find((binding) => binding.harnessId === second.id)!;
  await expect(f.distribution.remove({ bindingId: disabledBinding.id, skillIds: [skill.id] })).rejects.toThrow(/已禁用/);
  const activeBinding = f.store.list<Binding>('bindings').find((binding) => binding.harnessId === active.id)!;
  await expect(f.distribution.remove({ bindingId: activeBinding.id, skillIds: [skill.id] })).rejects.toThrow(/已禁用.*共享目录/);
  expect(await realpath(entry)).toBe(existingTarget);
  expect(f.store.list('intents')).toHaveLength(2);
});

it('keeps enabled compatible readers scanning and inheriting shared skills when universal is disabled', async () => {
  const f = await fixture();
  f.harnesses.setHarnessEnabled({ harnessId: 'universal', enabled: false });
  const sharedRoot = path.join(f.home, '.agents', 'skills');
  const skillPath = path.join(sharedRoot, 'shared-external');
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(skillPath, 'SKILL.md'), '---\nname: shared-external\ndescription: shared\n---\n');

  const external = await f.external.externalSkills();
  const canonicalSkillPath = await realpath(skillPath);
  expect(external.some((item) => item.harnessId === 'universal')).toBe(false);
  expect(external.some((item) => item.harnessId === 'codex' && item.path === canonicalSkillPath)).toBe(true);
  const visible = await f.external.visibleSkills(external);
  expect(visible.visibleExternalSkills.some((item) => item.harnessId === 'codex' && item.path === canonicalSkillPath)).toBe(true);
  expect(f.store.list('bindings').some((item: any) => item.harnessId === 'universal')).toBe(false);
});

it('blocks migration through an independent disabled reference but migrates a shared physical entry without disabled intents', async () => {
  const f = await fixture();
  const source = path.join(f.root, 'old-source');
  await mkdir(source);
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: legacy-skill\ndescription: legacy\n---\n');
  const enabledRoot = path.join(f.home, '.enabled', 'skills');
  const disabledRoot = path.join(f.home, '.disabled', 'skills');
  await mkdir(enabledRoot, { recursive: true });
  await mkdir(disabledRoot, { recursive: true });
  await symlink(source, path.join(enabledRoot, 'enabled-alias'));
  await symlink(source, path.join(disabledRoot, 'disabled-alias'));
  const enabled = saveHarness(f.harnesses, 'Enabled legacy reader', enabledRoot);
  const disabled = saveHarness(f.harnesses, 'Disabled legacy reader', disabledRoot);
  f.harnesses.setHarnessEnabled({ harnessId: disabled.id, enabled: false });
  const migration = f.migration;
  const selected = (await f.external.externalSkills()).find((item) => item.harnessId === enabled.id)!;
  await expect(migration.preview({ externalSkillId: selected.id })).rejects.toThrow(/禁用的 Harness.*独立入口/);
  expect(await readFile(path.join(source, 'SKILL.md'), 'utf8')).toContain('legacy-skill');
  expect(f.store.list('skills')).toHaveLength(0);

  f.harnesses.setHarnessEnabled({ harnessId: enabled.id, enabled: false });
  await rm(enabledRoot, { recursive: true });
  await rm(disabledRoot, { recursive: true });

  // A disabled builtin can declare the same .agents root. That rule overlap is not a second entry.
  const sharedRoot = path.join(f.home, '.agents', 'skills');
  const sharedSource = path.join(sharedRoot, 'shared-legacy');
  await mkdir(sharedSource, { recursive: true });
  await writeFile(path.join(sharedSource, 'SKILL.md'), '---\nname: shared-legacy\ndescription: legacy\n---\n');
  f.harnesses.setHarnessEnabled({ harnessId: 'universal', enabled: false });
  f.harnesses.setHarnessEnabled({ harnessId: 'codex', enabled: true });
  const canonicalSharedSource = await realpath(sharedSource);
  const codexExternal = (await f.external.externalSkills()).find(
    (item) => item.harnessId === 'codex' && item.path === canonicalSharedSource,
  )!;
  const preview = await migration.preview({ externalSkillId: codexExternal.id });
  expect(preview.references.map((reference) => reference.harnessId)).toEqual(['codex']);
  const migrated = await migration.migrate({ externalSkillId: codexExternal.id, previewId: preview.previewId });
  expect(migrated.items.every((item) => item.status === 'success')).toBe(true);
  expect(f.store.list<Binding>('bindings').map((binding) => binding.harnessId)).toEqual(['codex']);
  expect(
    f.store.list<any>('intents').every((intent) => f.store.get<Binding>('bindings', intent.bindingId)?.harnessId !== 'universal'),
  ).toBe(true);
  expect(f.store.get<Harness>('harnesses', 'universal')?.enabled).toBe(false);
});

it('omits disabled installations from detection and refuses cleanup after disabling or for a disabled peer', async () => {
  const f = await fixture();
  const target = saveHarness(f.harnesses, 'Cleanup candidate', path.join(f.home, '.cleanup-candidate', 'skills'));
  const sharedDisabled = f.harnesses.saveHarness({
    name: 'Disabled shared reader',
    userSkillsPath: target.userSkillsPath,
    workspaceSkillsRelativePath: '',
  });
  f.harnesses.setHarnessEnabled({ harnessId: sharedDisabled.id, enabled: false });
  const isolated = saveHarness(f.harnesses, 'Isolated cleanup candidate', path.join(f.home, '.isolated-cleanup', 'skills'));
  const service = new HarnessInstallationService(f.store, {
    home: f.home,
    env: { PATH: '' },
    trashItem: async () => {
      throw new Error('must not trash');
    },
  });
  const targetPath = path.join(f.home, '.cleanup-candidate', 'skills');
  await mkdir(targetPath, { recursive: true });
  const isolatedPath = path.join(f.home, '.isolated-cleanup', 'skills');
  await mkdir(isolatedPath, { recursive: true });
  for (const item of [target, sharedDisabled, isolated]) {
    const saved = f.store.get<Harness>('harnesses', item.id)!;
    f.store.put('harnesses', { ...saved, command: `hm-uninstalled-${item.id}` });
  }
  const detected = await service.detect(f.store.list<Harness>('harnesses'), { refresh: true });
  expect(detected.map((item) => item.harnessId)).not.toContain(sharedDisabled.id);
  expect(
    detected.find((item) => item.harnessId === target.id)?.residualDirectories.some((item) => item.path === targetPath && !item.canTrash),
  ).toBe(true);

  const isolatedResult = await service.detect([f.store.get<Harness>('harnesses', isolated.id)!], { refresh: true });
  const preview = await service.previewCleanup({ harnessId: isolated.id, path: isolatedPath });
  expect(isolatedResult[0].status).toBe('not-found');
  expect(preview.canTrash).toBe(true);
  f.harnesses.setHarnessEnabled({ harnessId: isolated.id, enabled: false });
  await expect(service.cleanup({ token: preview.token! })).rejects.toThrow(/已禁用/);
});

it('revalidates repair ownership when its bound Harness is disabled after preview', async () => {
  const f = await fixture();
  const skill = await importSkill(f, 'repairable-skill');
  const managedRoot = path.join(f.home, '.managed', 'skills');
  const managed = saveHarness(f.harnesses, 'Managed repair owner', managedRoot);
  const externalRoot = path.join(f.home, '.external', 'skills');
  saveHarness(f.harnesses, 'External repair source', externalRoot);
  await mkdir(externalRoot, { recursive: true });
  const originalSource = path.join(f.root, 'legacy-repair-source');
  await mkdir(originalSource);
  await writeFile(path.join(originalSource, 'SKILL.md'), '---\nname: old\ndescription: old\n---\n');
  await f.distribution.apply({ skillIds: [skill.id], harnessIds: [managed.id], scope: 'user', strategy: 'symlink' });
  const managedEntry = path.join(managedRoot, skill.name);
  await rm(managedEntry);
  await symlink(originalSource, managedEntry);
  await symlink(originalSource, path.join(externalRoot, 'legacy-entry'));
  const externalEntry = path.join(await realpath(externalRoot), 'legacy-entry');
  const external = (await f.external.externalSkills()).find((item) => item.path === externalEntry)!;
  const repair = f.repair;
  const [preview] = await repair.preview({ externalSkillId: external.id });
  expect(preview).toBeTruthy();
  f.harnesses.setHarnessEnabled({ harnessId: managed.id, enabled: false });
  await expect(repair.repair({ repairId: preview.repairId })).rejects.toThrow(/已禁用/);
  expect(await realpath(managedEntry)).toBe(await realpath(originalSource));
});
