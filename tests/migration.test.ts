import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BatchResult, HarnessInput, ItemResult, Skill } from '../src/shared/types';
import { createServices, type Services } from '../src/main/services';
import { Store } from '../src/main/store';
import { hashDirectory } from '../src/main/content';

type Fixture = Services & { root: string; home: string };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-migration-'));
  const home = path.join(root, 'home');
  await mkdir(home);
  const store = new Store(path.join(root, 'library'));
  const services = createServices(store, { home });
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { ...services, root, home };
}

function customHarness(name: string, userSkillsPath: string, workspaceSkillsRelativePath = ''): HarnessInput {
  return { name, userSkillsPath, workspaceSkillsRelativePath };
}

async function makeSkill(directory: string, name = 'local-tool'): Promise<void> {
  await mkdir(path.join(directory, 'assets'), { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: local tool\n---\n# Local tool\n`);
  await writeFile(path.join(directory, 'assets', 'data.txt'), 'asset content\n');
}

describe('MigrationService', () => {
  it('moves a direct user skill into the central library, removes the old copy, and registers every shared Harness intent', async () => {
    const f = await fixture();
    const target = path.join(f.root, 'user-skills');
    const source = path.join(target, 'local-tool');
    await makeSkill(source);
    const first = f.harnesses.saveHarness(customHarness('First harness', target));
    const second = f.harnesses.saveHarness(customHarness('Shared harness', target));
    const originalHash = await hashDirectory(source);
    const external = (await f.external.externalSkills()).find((item) => item.harnessId === first.id)!;

    const preview = await f.migration.preview({ externalSkillId: external.id });
    expect(preview.sourcePath).toBe(await realpath(source));
    expect(preview.references.map((reference) => reference.harnessName).sort()).toEqual(['First harness', 'Shared harness']);
    const result = await f.migration.migrate({ externalSkillId: external.id, previewId: preview.previewId });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].status).toBe('success');

    const skill = f.store.get<Skill>('skills', result.skillIds![0])!;
    expect(await hashDirectory(skill.directory)).toBe(originalHash);
    expect(await readFile(path.join(skill.directory, 'assets', 'data.txt'), 'utf8')).toBe('asset content\n');
    const centralStat = await lstat(skill.directory);
    expect(centralStat.isDirectory()).toBe(true);
    expect(centralStat.isSymbolicLink()).toBe(false);
    const entryStat = await lstat(source);
    expect(entryStat.isSymbolicLink()).toBe(true);
    expect(await realpath(source)).toBe(await realpath(skill.directory));
    expect(await readFile(path.join(source, 'assets', 'data.txt'), 'utf8')).toBe('asset content\n');
    const operation = f.store
      .list<{ kind: string; phase: string; migration?: { sourceBackupPath: string } }>('operations')
      .find((item) => item.kind === 'migration')!;
    expect(operation.phase).toBe('committed');
    expect(await lstat(operation.migration!.sourceBackupPath).catch(() => undefined)).toBeUndefined();

    const intents = f.store.list<{ bindingId: string; skillId: string }>('intents').filter((item) => item.skillId === skill.id);
    const bindings = f.store
      .list<{ id: string; harnessId: string }>('bindings')
      .filter((item) => intents.some((intent) => intent.bindingId === item.id));
    expect(new Set(bindings.map((item) => item.harnessId))).toEqual(new Set([first.id, second.id]));
    expect(await f.external.externalSkills()).toEqual([]);
  });

  it('repoints every user and workspace link in a nested symlink chain to a real central copy before deleting the true source', async () => {
    const f = await fixture();
    const realSource = path.join(f.root, 'old-source', 'local-tool');
    const chain = path.join(f.root, 'links');
    const userTarget = path.join(f.root, 'a-user-skills');
    const workspace = path.join(f.root, 'workspace');
    const workspaceTarget = path.join(workspace, '.agents', 'skills');
    await makeSkill(realSource);
    await mkdir(chain, { recursive: true });
    await mkdir(userTarget, { recursive: true });
    await mkdir(workspaceTarget, { recursive: true });
    await symlink(path.relative(chain, realSource), path.join(chain, 'first'), 'dir');
    await symlink('first', path.join(chain, 'second'), 'dir');
    const chainedEntry = path.join(userTarget, 'local-tool');
    const directEntry = path.join(workspaceTarget, 'local-tool');
    await symlink(path.relative(userTarget, path.join(chain, 'second')), chainedEntry, 'dir');
    await symlink(path.relative(workspaceTarget, realSource), directEntry, 'dir');
    f.store.put('workspaces', { id: 'workspace-test', path: await realpath(workspace), name: 'Workspace' });
    const userHarness = f.harnesses.saveHarness(customHarness('User Harness', userTarget));
    const workspaceHarness = f.harnesses.saveHarness(customHarness('Workspace Harness', path.join(f.home, '.unused'), '.agents/skills'));
    const originalHash = await hashDirectory(realSource);
    const external = (await f.external.externalSkills()).find((item) => item.harnessId === userHarness.id)!;
    const preview = await f.migration.preview({ externalSkillId: external.id });

    expect(preview.references.map((reference) => reference.harnessName)).toEqual(
      expect.arrayContaining(['Codex CLI', 'User Harness', 'Workspace Harness']),
    );
    expect(new Set(preview.references.map((reference) => reference.path)).size).toBe(2);
    expect(preview.references.filter((reference) => reference.scope === 'user')).toHaveLength(1);
    expect(preview.references.filter((reference) => reference.scope === 'workspace').length).toBeGreaterThanOrEqual(2);
    const result = await f.migration.migrate({ externalSkillId: external.id, previewId: preview.previewId });
    expect(result.items).toHaveLength(2);
    expect(result.items.every((item) => item.status === 'success')).toBe(true);
    await expect(f.migration.migrate({ externalSkillId: external.id, previewId: preview.previewId })).rejects.toThrow('迁移预览已失效');
    const skill = f.store.get<Skill>('skills', result.skillIds![0])!;
    const centralStat = await lstat(skill.directory);
    expect(centralStat.isDirectory()).toBe(true);
    expect(centralStat.isSymbolicLink()).toBe(false);
    expect(await hashDirectory(skill.directory)).toBe(originalHash);
    expect(await readFile(path.join(skill.directory, 'assets', 'data.txt'), 'utf8')).toBe('asset content\n');
    expect(await lstat(realSource).catch(() => undefined)).toBeUndefined();

    for (const entry of [chainedEntry, directEntry]) {
      expect((await lstat(entry)).isSymbolicLink()).toBe(true);
      expect(await realpath(entry)).toBe(await realpath(skill.directory));
      expect(await readFile(path.join(entry, 'assets', 'data.txt'), 'utf8')).toBe('asset content\n');
    }
    expect(f.store.list('distributions')).toHaveLength(2);
    expect(
      f.store
        .list<{ harnessId: string; scope: string }>('bindings')
        .filter((binding) => [userHarness.id, workspaceHarness.id, 'codex'].includes(binding.harnessId)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ harnessId: userHarness.id, scope: 'user' }),
        expect.objectContaining({ harnessId: workspaceHarness.id, scope: 'workspace' }),
        expect.objectContaining({ harnessId: 'codex', scope: 'workspace' }),
      ]),
    );
  });

  it('keeps the true source and reports a partial result when a configured reference cannot be moved', async () => {
    const f = await fixture();
    const source = path.join(f.root, 'external-source', 'local-tool');
    const firstTarget = path.join(f.root, 'a-target');
    const secondTarget = path.join(f.root, 'b-target');
    await makeSkill(source);
    await mkdir(firstTarget);
    await mkdir(secondTarget);
    const firstEntry = path.join(firstTarget, 'local-tool');
    const secondEntry = path.join(secondTarget, 'local-tool');
    await symlink(source, firstEntry, 'dir');
    await symlink(source, secondEntry, 'dir');
    const firstHarness = f.harnesses.saveHarness(customHarness('First', firstTarget));
    f.harnesses.saveHarness(customHarness('Second', secondTarget));
    const external = (await f.external.externalSkills()).find((item) => item.harnessId === firstHarness.id)!;
    const preview = await f.migration.preview({ externalSkillId: external.id });

    const distributionInternals = f.migrationExecutor as unknown as {
      migrateReferenceEntry(operation: unknown, entry: { path: string }): Promise<void>;
    };
    const originalMigrateReferenceEntry = distributionInternals.migrateReferenceEntry.bind(f.migrationExecutor);
    const attemptedEntries: string[] = [];
    distributionInternals.migrateReferenceEntry = async (operation, entry) => {
      attemptedEntries.push(entry.path);
      if (path.basename(path.dirname(entry.path)) === 'b-target') throw new Error('Injected move failure for test.');
      await originalMigrateReferenceEntry(operation, entry);
    };
    let result: BatchResult;
    try {
      result = await f.migration.migrate({ externalSkillId: external.id, previewId: preview.previewId });
    } finally {
      distributionInternals.migrateReferenceEntry = originalMigrateReferenceEntry;
    }

    expect(attemptedEntries.some((entry) => path.basename(path.dirname(entry)) === 'b-target')).toBe(true);
    expect(result.items.map((item) => item.status)).toEqual(['success', 'error']);
    expect(result.skillIds).toEqual([]);
    expect(await lstat(source)).toMatchObject({ isDirectory: expect.any(Function) });
    const skill = f.store.list<Skill>('skills')[0]!;
    expect(await realpath(firstEntry)).toBe(await realpath(skill.directory));
    expect(await realpath(secondEntry)).toBe(await realpath(source));
    expect(await readFile(path.join(source, 'assets', 'data.txt'), 'utf8')).toBe('asset content\n');
    expect(f.store.list<{ kind: string; phase: string }>('operations').find((item) => item.kind === 'migration')?.phase).toBe('blocked');
  });

  it('retains the old source if the central copy changes before cleanup, and blocks recovery on the hash mismatch', async () => {
    const f = await fixture();
    const source = path.join(f.root, 'external-source', 'local-tool');
    const target = path.join(f.root, 'configured-target');
    await makeSkill(source);
    await mkdir(target, { recursive: true });
    const entry = path.join(target, 'local-tool');
    await symlink(source, entry, 'dir');
    const harness = f.harnesses.saveHarness(customHarness('Cleanup harness', target));
    const external = (await f.external.externalSkills()).find((item) => item.harnessId === harness.id)!;
    const preview = await f.migration.preview({ externalSkillId: external.id });

    const distributionInternals = f.migrationExecutor as unknown as {
      finishMigrationCleanup(operationId: string): Promise<void>;
    };
    const originalFinish = distributionInternals.finishMigrationCleanup.bind(f.migrationExecutor);
    distributionInternals.finishMigrationCleanup = async (operationId) => {
      const operation = f.store.list<{ kind: string; skillId: string }>('operations').find((item) => item.kind === 'migration')!;
      const centralSkill = f.store.get<Skill>('skills', operation.skillId)!;
      await writeFile(path.join(centralSkill.directory, 'assets', 'data.txt'), 'changed during cleanup\n');
      await originalFinish(operationId);
    };
    let result: BatchResult;
    try {
      result = await f.migration.migrate({ externalSkillId: external.id, previewId: preview.previewId });
    } finally {
      distributionInternals.finishMigrationCleanup = originalFinish;
    }

    expect(result.items.at(-1)?.status).toBe('error');
    expect((await lstat(source)).isDirectory()).toBe(true);
    expect(await readFile(path.join(source, 'assets', 'data.txt'), 'utf8')).toBe('asset content\n');
    await f.migrationExecutor.recover();
    expect(f.store.list<{ kind: string; phase: string }>('operations').find((item) => item.kind === 'migration')?.phase).toBe('blocked');
    expect((await lstat(source)).isDirectory()).toBe(true);
  });

  it('recovers a cleanup journal after the verified old source was removed but before the operation was committed', async () => {
    const f = await fixture();
    const source = path.join(f.root, 'external-source', 'local-tool');
    const target = path.join(f.root, 'configured-target');
    await makeSkill(source);
    await mkdir(target, { recursive: true });
    const entry = path.join(target, 'local-tool');
    await symlink(source, entry, 'dir');
    const harness = f.harnesses.saveHarness(customHarness('Recovery harness', target));
    const external = (await f.external.externalSkills()).find((item) => item.harnessId === harness.id)!;
    const preview = await f.migration.preview({ externalSkillId: external.id });
    const result = await f.migration.migrate({ externalSkillId: external.id, previewId: preview.previewId });
    expect(result.items[0].status).toBe('success');
    expect(await lstat(source).catch(() => undefined)).toBeUndefined();

    const operation = f.store.list<{ id: string; kind: string; phase: string }>('operations').find((item) => item.kind === 'migration')!;
    f.store.put('operations', { ...operation, phase: 'cleanup', updatedAt: new Date().toISOString() });
    await f.migrationExecutor.recover();
    expect(f.store.get<{ phase: string }>('operations', operation.id)?.phase).toBe('committed');
    expect(await readFile(path.join(entry, 'assets', 'data.txt'), 'utf8')).toBe('asset content\n');
  });

  it('preserves multiple external aliases through migration, health checks, apply, remove, and remove recovery', async () => {
    const f = await fixture();
    const source = path.join(f.root, 'unity-mcp-skill');
    const target = path.join(f.root, 'unity-target');
    await makeSkill(source, 'unity-mcp-orchestrator');
    await mkdir(target, { recursive: true });
    const aliases = [path.join(target, 'unity-mcp-skill'), path.join(target, 'unity-helper')];
    await symlink(source, aliases[0], 'dir');
    await symlink(source, aliases[1], 'dir');
    const harness = f.harnesses.saveHarness(customHarness('Unity Harness', target));
    const canonicalTarget = await realpath(target);
    const canonicalAliases = aliases.map((alias) => path.join(canonicalTarget, path.basename(alias)));
    const external = (await f.external.externalSkills()).find(
      (item) => item.harnessId === harness.id && item.path === canonicalAliases[0],
    )!;
    const preview = await f.migration.preview({ externalSkillId: external.id });

    expect(preview.skillName).toBe('unity-mcp-orchestrator');
    expect(preview.sourcePath).toBe(await realpath(source));
    expect(preview.centralPath).toBe(
      path.join(f.store.root, 'skills', preview.centralPath.split(path.sep).at(-2)!, 'unity-mcp-orchestrator'),
    );
    expect(preview.references.map((reference) => reference.path).sort()).toEqual([...canonicalAliases].sort());
    const result = await f.migration.migrate({ externalSkillId: external.id, previewId: preview.previewId });
    expect(result.items).toHaveLength(2);
    expect(result.items.every((item) => item.status === 'success')).toBe(true);

    const skill = f.store.get<Skill>('skills', result.skillIds![0])!;
    expect(skill.name).toBe('unity-mcp-orchestrator');
    expect(skill.directory).toBe(preview.centralPath);
    expect((await lstat(skill.directory)).isDirectory()).toBe(true);
    expect((await lstat(skill.directory)).isSymbolicLink()).toBe(false);
    expect(await lstat(source).catch(() => undefined)).toBeUndefined();
    for (const alias of aliases) {
      expect(path.basename(alias)).not.toBe(skill.name);
      expect((await lstat(alias)).isSymbolicLink()).toBe(true);
      expect(await realpath(alias)).toBe(await realpath(skill.directory));
      expect(await readFile(path.join(alias, 'assets', 'data.txt'), 'utf8')).toBe('asset content\n');
    }
    expect(await lstat(path.join(target, skill.name)).catch(() => undefined)).toBeUndefined();

    await f.health.checkHealth([skill.id]);
    expect(
      f.store
        .list<{ entryPath: string; health: string }>('distributions')
        .map((item) => ({ entryPath: item.entryPath, health: item.health })),
    ).toEqual(expect.arrayContaining(canonicalAliases.map((entryPath) => expect.objectContaining({ entryPath, health: 'healthy' }))));

    const applyRequest = { skillIds: [skill.id], harnessIds: [harness.id], scope: 'user' as const, strategy: 'symlink' as const };
    const applyPlan = await f.distribution.previewApply(applyRequest);
    expect(applyPlan.items.map((item) => item.targetPath).sort()).toEqual([...canonicalAliases].sort());
    expect(applyPlan.items.every((item) => item.status === 'existing')).toBe(true);
    const applyResult = await f.distribution.apply(applyRequest);
    expect(applyResult.items.map((item) => item.status)).toEqual(['skipped', 'skipped']);
    expect(f.store.list('distributions')).toHaveLength(2);

    const binding = f.store
      .list<{ id: string; harnessId: string; targetId: string }>('bindings')
      .find((item) => item.harnessId === harness.id)!;
    const intent = f.store
      .list<{ id: string; bindingId: string; skillId: string }>('intents')
      .find((item) => item.bindingId === binding.id && item.skillId === skill.id)!;
    const distributions = f.store.list<{
      id: string;
      skillId: string;
      targetId: string;
      entryPath: string;
      strategy: 'symlink';
      lastWrittenHash: string;
      health: 'healthy';
      verification: 'untested';
    }>('distributions');
    const firstDistribution = distributions.find((item) => item.entryPath === canonicalAliases[0])!;
    const operationId = '21111111-1111-4111-8111-111111111111';
    const backupPath = path.join(
      path.dirname(canonicalTarget),
      `.${path.basename(canonicalTarget)}.harness-manager-trash`,
      operationId,
      'entry',
    );
    await mkdir(path.dirname(backupPath), { recursive: true });
    await rename(aliases[0], backupPath);
    f.store.put('operations', {
      id: operationId,
      owner: 'distribution',
      kind: 'remove',
      phase: 'old_moved',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      skillId: skill.id,
      targetId: binding.targetId,
      entryPath: canonicalAliases[0],
      backupPath,
      previousDistribution: firstDistribution,
      bindingId: binding.id,
      removedIntentId: intent.id,
      removeIntentOnCommit: false,
    });
    await f.distribution.recover();
    expect(f.store.get<{ phase: string }>('operations', operationId)?.phase).toBe('committed');
    expect(f.store.list<{ id: string }>('intents').some((item) => item.id === intent.id)).toBe(true);
    expect(f.store.list<{ entryPath: string }>('distributions').some((item) => item.entryPath === canonicalAliases[0])).toBe(false);
    expect(await lstat(aliases[0]).catch(() => undefined)).toBeUndefined();
    expect(await realpath(aliases[1])).toBe(await realpath(skill.directory));

    const distributionInternals = f.distribution as unknown as {
      prepareBackupPath(targetPath: string, operation: unknown): Promise<string>;
    };
    const originalPrepareBackupPath = distributionInternals.prepareBackupPath.bind(f.distribution);
    distributionInternals.prepareBackupPath = async () => {
      throw new Error('Injected removal failure for test.');
    };
    let partialRemoval: { items: ItemResult[] };
    try {
      partialRemoval = await f.distribution.remove({ bindingId: binding.id, skillIds: [skill.id] });
    } finally {
      distributionInternals.prepareBackupPath = originalPrepareBackupPath;
    }
    expect(partialRemoval.items[0].status).toBe('error');
    expect(partialRemoval.items[0].message).toContain('已保留安装意图');
    expect(f.store.list<{ id: string }>('intents').some((item) => item.id === intent.id)).toBe(true);
    expect(f.store.list('distributions')).toHaveLength(1);
    expect(await realpath(aliases[1])).toBe(await realpath(skill.directory));

    const removal = await f.distribution.remove({ bindingId: binding.id, skillIds: [skill.id] });
    expect(removal.items[0].status).toBe('success');
    expect(await lstat(aliases[1]).catch(() => undefined)).toBeUndefined();
    expect(f.store.list('distributions')).toHaveLength(0);
    expect(f.store.list<{ id: string }>('intents').some((item) => item.id === intent.id)).toBe(false);
  });
});
