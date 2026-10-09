import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashDirectory } from '../src/main/content';
import { createServices, type Services } from '../src/main/services';
import { Store } from '../src/main/store';
import type { ApplyRequest, Binding, Distribution, Skill } from '../src/shared/types';
import { crashAtJournalWrite, crashOnCall, skipMethod } from './helpers/crash';

/**
 * Characterization tests for startup recovery. Each test lets a real operation run until a
 * simulated crash, then runs recovery in a fresh service instance as after a restart.
 */

type MigrationReference = { phase: string; path: string; stagePath: string; backupPath: string };
type Operation = {
  id: string;
  owner: string;
  kind?: string;
  phase: string;
  entryPath?: string;
  stagePath?: string;
  backupPath?: string;
  originalLink?: string;
  migration?: { references: MigrationReference[] };
};

type Fixture = Services & { root: string; home: string };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hm-recovery-')));
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

async function writeSkill(directory: string, name: string, notes = 'v1'): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: recovery test skill\n---\n# ${name}\n`);
  await writeFile(path.join(directory, 'notes.txt'), `${notes}\n`);
}

async function installCentralSkill(f: Fixture, name = 'recovery-tool'): Promise<Skill> {
  const source = path.join(f.root, 'sources', name);
  await writeSkill(source, name);
  const scan = await f.library.scan({ uri: source });
  const result = await f.library.install({ scanId: scan.id, candidateIds: [scan.candidates[0].id] });
  const skill = f.store.get<Skill>('skills', result.skillIds?.[0] ?? '');
  if (!skill) throw new Error('Test skill was not installed.');
  return skill;
}

/** Startup recovery always runs in a new service instance, as after a real restart. */
async function restartDistribution(f: Fixture): Promise<void> {
  const restarted = createServices(f.store, { home: f.home });
  await restarted.distribution.recover();
  await restarted.migrationExecutor.recover();
}

function operation(f: Fixture, id: string): Operation {
  const record = f.store.get<Operation>('operations', id);
  if (!record) throw new Error(`Operation ${id} is missing.`);
  return record;
}

function onlyOperation(f: Fixture, kind: string, phase?: string): Operation {
  const matches = f.store.list<Operation>('operations').filter((item) => item.kind === kind && (!phase || item.phase === phase));
  expect(matches).toHaveLength(1);
  return matches[0];
}

async function exists(entry: string): Promise<boolean> {
  return lstat(entry).then(
    () => true,
    () => false,
  );
}

describe('apply recovery', () => {
  async function applySetup(f: Fixture, strategy: ApplyRequest['strategy'] = 'symlink') {
    const skill = await installCentralSkill(f);
    const target = path.join(f.root, 'agent-skills');
    const harness = f.harnesses.saveHarness({ name: 'Agent', userSkillsPath: target, workspaceSkillsRelativePath: '' });
    const request: ApplyRequest = { skillIds: [skill.id], harnessIds: [harness.id], scope: 'user', strategy };
    return { skill, request, entryPath: path.join(target, skill.name) };
  }

  it.each([
    ['before the staged phase was recorded', 'before' as const, 'planned'],
    ['after the staged phase was recorded', 'after' as const, 'staged'],
  ])('removes the staged link of a new install that crashed %s', async (_label, when, crashedPhase) => {
    const f = await fixture();
    const { request, entryPath } = await applySetup(f);
    const crash = crashAtJournalWrite(f.distribution, f.store, (op) => op.kind === 'apply' && op.phase === 'staged', when);
    const result = await f.distribution.apply(request);
    crash.restore();
    expect(crash.crashed).toBe(true);
    expect(result.items[0].status).toBe('error');
    const crashed = onlyOperation(f, 'apply');
    expect(crashed.phase).toBe(crashedPhase);
    expect(await exists(crashed.stagePath!)).toBe(true);

    await restartDistribution(f);
    expect(operation(f, crashed.id).phase).toBe('failed');
    expect(await exists(crashed.stagePath!)).toBe(false);
    expect(await exists(entryPath)).toBe(false);
    expect(f.store.list('distributions')).toHaveLength(0);
    expect(f.store.list('intents')).toHaveLength(0);
  });

  it('commits metadata for a projection placed before the crash', async () => {
    const f = await fixture();
    const { skill, request, entryPath } = await applySetup(f);
    const crash = crashAtJournalWrite(f.distribution, f.store, (op) => op.kind === 'apply' && op.phase === 'new_placed');
    await f.distribution.apply(request);
    crash.restore();
    const crashed = onlyOperation(f, 'apply', 'new_placed');
    expect(f.store.list('distributions')).toHaveLength(0);

    await restartDistribution(f);
    expect(operation(f, crashed.id).phase).toBe('committed');
    expect(await realpath(entryPath)).toBe(await realpath(skill.directory));
    expect(f.store.list('distributions')).toHaveLength(1);
    expect(f.store.list('intents')).toHaveLength(1);
  });

  it('restores the previous managed copy when the crash happened after it was moved aside', async () => {
    const f = await fixture();
    const { skill, request, entryPath } = await applySetup(f, 'copy');
    expect((await f.distribution.apply(request)).items[0].status).toBe('success');
    const previousHash = await hashDirectory(entryPath);
    await writeFile(path.join(skill.directory, 'notes.txt'), 'v2\n');
    expect((await f.distribution.previewApply(request)).items[0].status).toBe('sync');

    const crash = crashAtJournalWrite(f.distribution, f.store, (op) => op.kind === 'apply' && op.phase === 'old_moved');
    await f.distribution.apply(request);
    crash.restore();
    const crashed = onlyOperation(f, 'apply', 'old_moved');
    expect(await exists(entryPath)).toBe(false);
    expect(await exists(crashed.backupPath!)).toBe(true);

    await restartDistribution(f);
    expect(operation(f, crashed.id).phase).toBe('failed');
    expect(await hashDirectory(entryPath)).toBe(previousHash);
    expect(await exists(crashed.stagePath!)).toBe(false);
    expect(f.store.list<Distribution>('distributions')[0].lastWrittenHash).toBe(previousHash);
  });

  it('blocks and preserves everything when the moved-aside copy changed before recovery', async () => {
    const f = await fixture();
    const { skill, request, entryPath } = await applySetup(f, 'copy');
    await f.distribution.apply(request);
    await writeFile(path.join(skill.directory, 'notes.txt'), 'v2\n');
    const crash = crashAtJournalWrite(f.distribution, f.store, (op) => op.kind === 'apply' && op.phase === 'old_moved');
    await f.distribution.apply(request);
    crash.restore();
    const crashed = onlyOperation(f, 'apply', 'old_moved');
    await writeFile(path.join(crashed.backupPath!, 'notes.txt'), 'edited after the crash\n');

    await restartDistribution(f);
    expect(operation(f, crashed.id).phase).toBe('blocked');
    expect(await readFile(path.join(crashed.backupPath!, 'notes.txt'), 'utf8')).toBe('edited after the crash\n');
    expect(await exists(crashed.stagePath!)).toBe(true);
    expect(await exists(entryPath)).toBe(false);
  });
});

describe('remove recovery', () => {
  async function removeSetup(f: Fixture) {
    const skill = await installCentralSkill(f);
    const target = path.join(f.root, 'agent-skills');
    const harness = f.harnesses.saveHarness({ name: 'Agent', userSkillsPath: target, workspaceSkillsRelativePath: '' });
    await f.distribution.apply({ skillIds: [skill.id], harnessIds: [harness.id], scope: 'user', strategy: 'symlink' });
    const binding = f.store.list<Binding>('bindings').find((item) => item.harnessId === harness.id)!;
    const crash = crashAtJournalWrite(f.distribution, f.store, (op) => op.kind === 'remove' && op.phase === 'old_moved');
    await f.distribution.remove({ bindingId: binding.id, skillIds: [skill.id] });
    crash.restore();
    expect(crash.crashed).toBe(true);
    const crashed = onlyOperation(f, 'remove', 'old_moved');
    const entryPath = path.join(target, skill.name);
    expect(await exists(entryPath)).toBe(false);
    expect(await exists(crashed.backupPath!)).toBe(true);
    expect(f.store.list('intents')).toHaveLength(1);
    return { skill, target, binding, crashed, entryPath };
  }

  it('finishes a removal whose entry was already moved to the recovery location', async () => {
    const f = await fixture();
    const { crashed } = await removeSetup(f);

    await restartDistribution(f);
    expect(operation(f, crashed.id).phase).toBe('committed');
    expect(f.store.list('intents')).toHaveLength(0);
    expect(f.store.list('distributions')).toHaveLength(0);
    expect(await exists(crashed.backupPath!)).toBe(true); // Recovery copies are retained.
  });

  it('restores the entry when another binding needs the shared target', async () => {
    const f = await fixture();
    const { skill, target, binding, crashed, entryPath } = await removeSetup(f);
    const other = f.harnesses.saveHarness({ name: 'Other', userSkillsPath: target, workspaceSkillsRelativePath: '' });
    f.store.put('bindings', { id: 'binding-other', targetId: binding.targetId, harnessId: other.id, scope: 'user' });
    f.store.put('intents', { id: 'intent-other', bindingId: 'binding-other', skillId: skill.id });

    await restartDistribution(f);
    expect(operation(f, crashed.id).phase).toBe('failed');
    expect(await realpath(entryPath)).toBe(await realpath(skill.directory));
    expect(await exists(crashed.backupPath!)).toBe(false);
    expect(f.store.list('distributions')).toHaveLength(1);
  });

  it('blocks and keeps the intent when both the entry and its recovery copy are gone', async () => {
    const f = await fixture();
    const { crashed } = await removeSetup(f);
    await rm(crashed.backupPath!);

    await restartDistribution(f);
    expect(operation(f, crashed.id).phase).toBe('blocked');
    expect(f.store.list('intents')).toHaveLength(1);
  });
});

describe('migration recovery', () => {
  async function migrationSetup(f: Fixture) {
    const target = path.join(f.root, 'user-skills');
    const source = path.join(target, 'local-tool');
    await writeSkill(source, 'local-tool');
    f.harnesses.saveHarness({ name: 'Local harness', userSkillsPath: target, workspaceSkillsRelativePath: '' });
    const migration = f.migration;
    const external = (await f.external.externalSkills()).find((item) => item.name === 'local-tool')!;
    const preview = await migration.preview({ externalSkillId: external.id });
    return { source, migration, external, preview, originalHash: await hashDirectory(source) };
  }

  it.each([
    ['staged', (op: Operation) => op.migration?.references[0]?.phase === 'staged'],
    ['old_moved', (op: Operation) => op.migration?.references[0]?.phase === 'old_moved'],
    ['new_placed', (op: Operation) => op.migration?.references[0]?.phase === 'new_placed'],
    ['cleanup', (op: Operation) => op.phase === 'cleanup'],
  ])('rolls a migration interrupted at %s forward to the central link', async (_phase, matches) => {
    const f = await fixture();
    const m = await migrationSetup(f);
    const crash = crashAtJournalWrite(f.migrationExecutor, f.store, (op) => op.kind === 'migration' && matches(op as Operation));
    await m.migration.migrate({ externalSkillId: m.external.id, previewId: m.preview.previewId });
    crash.restore();
    expect(crash.crashed).toBe(true);
    const crashed = onlyOperation(f, 'migration');
    expect(crashed.phase).not.toBe('committed');
    const [reference] = crashed.migration!.references;

    await restartDistribution(f);
    expect(operation(f, crashed.id).phase).toBe('committed');
    expect((await lstat(m.source)).isSymbolicLink()).toBe(true);
    expect(await realpath(m.source)).toBe(m.preview.centralPath);
    expect(await hashDirectory(m.preview.centralPath)).toBe(m.originalHash);
    expect(await exists(reference.stagePath)).toBe(false);
    expect(await exists(reference.backupPath)).toBe(false);
    expect(f.store.list('distributions')).toHaveLength(1);
  });

  it('stops without deleting anything when the retained original changed before recovery', async () => {
    const f = await fixture();
    const m = await migrationSetup(f);
    const crash = crashAtJournalWrite(
      f.migrationExecutor,
      f.store,
      (op) => op.kind === 'migration' && (op as Operation).migration?.references[0]?.phase === 'old_moved',
    );
    await m.migration.migrate({ externalSkillId: m.external.id, previewId: m.preview.previewId });
    crash.restore();
    const crashed = onlyOperation(f, 'migration');
    const [reference] = crashed.migration!.references;
    await writeFile(path.join(reference.backupPath, 'notes.txt'), 'edited after the crash\n');

    await restartDistribution(f);
    expect(operation(f, crashed.id).phase).toBe('blocked');
    expect(await readFile(path.join(reference.backupPath, 'notes.txt'), 'utf8')).toBe('edited after the crash\n');
    expect(await exists(reference.stagePath)).toBe(true);
    expect(await exists(m.source)).toBe(false);
  });
});

describe('managed link repair recovery', () => {
  async function repairSetup(f: Fixture) {
    const skill = await installCentralSkill(f, 'skill-tool');
    const managedTarget = path.join(f.root, 'managed');
    const managed = f.harnesses.saveHarness({ name: 'Managed', userSkillsPath: managedTarget, workspaceSkillsRelativePath: '' });
    await f.distribution.apply({ skillIds: [skill.id], harnessIds: [managed.id], scope: 'user', strategy: 'symlink' });
    const oldSource = path.join(f.root, 'external-source', 'skill-tool');
    await writeSkill(oldSource, 'skill-tool', 'old');
    const externalTarget = path.join(f.root, 'external');
    await mkdir(externalTarget);
    await symlink(oldSource, path.join(externalTarget, 'skill-tool'));
    f.harnesses.saveHarness({ name: 'External', userSkillsPath: externalTarget, workspaceSkillsRelativePath: '' });
    const entryPath = f.store.list<Distribution>('distributions')[0].entryPath;
    await rm(entryPath);
    await symlink(oldSource, entryPath);
    const repair = f.repair;
    const external = (await f.external.externalSkills()).find((item) => item.harnessId !== managed.id)!;
    const [preview] = await repair.preview({ externalSkillId: external.id });
    return { entryPath, oldSource, repair, preview, centralPath: await realpath(skill.directory) };
  }

  async function restartRepair(f: Fixture): Promise<void> {
    await createServices(f.store, { home: f.home }).repair.recover();
  }

  it.each([
    ['after staging the central link', 'validatePaths', 2],
    ['after moving the original link aside', 'validatePaths', 3],
  ])('restores the original link when the repair crashed %s', async (_label, method, callNumber) => {
    const f = await fixture();
    const r = await repairSetup(f);
    const crash = crashOnCall(r.repair, method, callNumber);
    const skip = skipMethod(r.repair, 'recoverRecord');
    await r.repair.repair({ repairId: r.preview.repairId });
    crash.restore();
    skip.restore();
    expect(crash.crashed).toBe(true);
    const crashed = operation(f, r.preview.repairId);
    expect(crashed.phase).toBe('planned');

    await restartRepair(f);
    expect(operation(f, crashed.id).phase).toBe('failed');
    expect(await readlink(r.entryPath)).toBe(r.oldSource);
    expect(await exists(crashed.stagePath!)).toBe(false);
    expect(await exists(crashed.backupPath!)).toBe(false);
  });

  it('completes a repair whose central link was already in place', async () => {
    const f = await fixture();
    const r = await repairSetup(f);
    const crash = crashOnCall(r.repair, 'finish', 1);
    const skip = skipMethod(r.repair, 'recoverRecord');
    await r.repair.repair({ repairId: r.preview.repairId });
    crash.restore();
    skip.restore();
    const crashed = operation(f, r.preview.repairId);
    expect(await readlink(r.entryPath)).toBe(r.centralPath);
    expect(await exists(crashed.backupPath!)).toBe(true);

    await restartRepair(f);
    expect(operation(f, crashed.id).phase).toBe('committed');
    expect(await readlink(r.entryPath)).toBe(r.centralPath);
    expect(await exists(crashed.backupPath!)).toBe(false);
  });

  it('retries a blocked repair on the next startup', async () => {
    const f = await fixture();
    const r = await repairSetup(f);
    const crash = crashOnCall(r.repair, 'finish', 1);
    const skip = skipMethod(r.repair, 'recoverRecord');
    await r.repair.repair({ repairId: r.preview.repairId });
    crash.restore();
    skip.restore();
    const crashed = operation(f, r.preview.repairId);
    await rm(crashed.backupPath!);
    await symlink(path.join(f.root, 'somewhere-else'), crashed.backupPath!);

    await restartRepair(f);
    expect(operation(f, crashed.id).phase).toBe('blocked');
    expect(await readlink(crashed.backupPath!)).toBe(path.join(f.root, 'somewhere-else'));

    await rm(crashed.backupPath!);
    await symlink(crashed.originalLink!, crashed.backupPath!);
    await restartRepair(f);
    expect(operation(f, crashed.id).phase).toBe('committed');
    expect(await exists(crashed.backupPath!)).toBe(false);
  });
});
