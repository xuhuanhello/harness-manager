import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ApplyRequest, HarnessInput, Skill } from '../src/shared/types';
import { createServices, type Services } from '../src/main/services';
import { canonicalizePath, validateWorkspaceRelativePath } from '../src/main/paths';
import { Store } from '../src/main/store';
import { hashDirectory } from '../src/main/content';

type Fixture = Services & { root: string; home: string; source: string; skill: Skill };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-distribution-'));
  const home = path.join(root, 'home');
  const libraryRoot = path.join(root, 'library');
  const source = path.join(libraryRoot, 'skills', 'skill-1', 'search-tool');
  await mkdir(source, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: search-tool\ndescription: search\n---\n# Search\n');
  const store = new Store(libraryRoot);
  const services = createServices(store, { home });
  const skill: Skill = {
    id: 'skill-1',
    name: 'search-tool',
    description: 'search',
    sourceId: 'source-1',
    sourcePath: 'search-tool',
    directory: source,
    baseHash: await hashDirectory(source),
    currentHash: await hashDirectory(source),
    installedAt: new Date().toISOString(),
  };
  store.put('skills', skill);
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { ...services, root, home, source, skill };
}

function customHarness(name: string, userSkillsPath: string, workspaceSkillsRelativePath = '.agent/skills'): HarnessInput {
  return {
    name,
    icon: '',
    userSkillsPath,
    workspaceSkillsRelativePath,
  };
}

describe('DistributionService', () => {
  it('keeps user targets independent and writes the universal target only when selected', async () => {
    const f = await fixture();
    const aPath = path.join(f.home, '.a/skills');
    const bPath = path.join(f.home, '.b/skills');
    const a = f.harnesses.saveHarness(customHarness('Separate A', aPath));
    const b = f.harnesses.saveHarness(customHarness('Separate B', bPath));
    const result = await f.distribution.apply({ skillIds: [f.skill.id], harnessIds: [a.id, b.id], scope: 'user', strategy: 'symlink' });
    expect(result.items.map((item) => item.status)).toEqual(['success', 'success']);
    expect(await readFile(path.join(aPath, f.skill.name, 'SKILL.md'), 'utf8')).toContain('search-tool');
    expect(await readFile(path.join(bPath, f.skill.name, 'SKILL.md'), 'utf8')).toContain('search-tool');
    await expect(readdir(path.join(f.home, '.agents/skills'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('points out an existing install in another root that the selected Harness also reads', async () => {
    const f = await fixture();
    await f.distribution.apply({ skillIds: [f.skill.id], harnessIds: ['claude-code'], scope: 'user', strategy: 'symlink' });
    // Cursor installs into ~/.cursor/skills and also reads Claude Code's root.
    f.harnesses.setHarnessEnabled({ harnessId: 'cursor', enabled: true });
    const request: ApplyRequest = { skillIds: [f.skill.id], harnessIds: ['cursor'], scope: 'user', strategy: 'symlink' };
    const [item] = (await f.distribution.previewApply(request)).items;
    expect(item.status).toBe('new');
    expect(item.targetPath).toBe(path.join((await canonicalizePath(path.join(f.home, '.cursor/skills'))).path, f.skill.name));
    expect(item.message).toContain(path.join('.claude', 'skills', f.skill.name));

    // A Harness that does not read the shared root gets no such note.
    const isolated = f.harnesses.saveHarness(customHarness('Isolated Reader', path.join(f.home, '.isolated/skills')));
    const [plain] = (await f.distribution.previewApply({ ...request, harnessIds: [isolated.id] })).items;
    expect(plain.message).toBeUndefined();
  });

  it('reports colliding skill names and never repairs a missing central source with empty content', async () => {
    const f = await fixture();
    const target = path.join(f.root, 'target');
    const harness = f.harnesses.saveHarness(customHarness('Collision Agent', target));
    const second = { ...f.skill, id: 'skill-2', sourceId: 'source-2' };
    f.store.put('skills', second);
    const request: ApplyRequest = { skillIds: [f.skill.id, second.id], harnessIds: [harness.id], scope: 'user', strategy: 'symlink' };
    expect((await f.distribution.previewApply(request)).items.every((item) => item.status === 'conflict')).toBe(true);
    await expect(readdir(target)).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(f.source, { recursive: true });
    await expect(f.distribution.apply({ ...request, skillIds: [f.skill.id] })).rejects.toThrow();
    await expect(readdir(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('merges selected harnesses sharing a physical path and reapplying a symlink is idempotent', async () => {
    const f = await fixture();
    const target = path.join(f.root, 'shared-user-skills');
    const a = f.harnesses.saveHarness(customHarness('Agent A', target));
    const b = f.harnesses.saveHarness(customHarness('Agent B', target));
    const request: ApplyRequest = { skillIds: [f.skill.id], harnessIds: [a.id, b.id], scope: 'user', strategy: 'symlink' };

    const plan = await f.distribution.previewApply(request);
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].targetPath).toBe(path.join((await canonicalizePath(target)).path, f.skill.name));
    const first = await f.distribution.apply(request);
    expect(first.items.map((item) => item.status)).toEqual(['success']);
    expect(await readFile(path.join(target, f.skill.name, 'SKILL.md'), 'utf8')).toContain('name: search-tool');

    await rm(path.join(target, f.skill.name), { force: true });
    expect((await f.distribution.previewApply(request)).items[0].status).toBe('sync');
    expect((await f.distribution.apply(request)).items[0].status).toBe('success');

    const repeated = await f.distribution.previewApply(request);
    expect(repeated.items[0].status).toBe('existing');
    const again = await f.distribution.apply(request);
    expect(again.items[0].status).toBe('skipped');
    expect(f.store.list('distributions')).toHaveLength(1);
    expect(f.store.list('bindings')).toHaveLength(2);
    expect(f.store.list('intents')).toHaveLength(2);
  });

  it('allows editing a custom path after its last installation intent is removed', async () => {
    const f = await fixture();
    const firstPath = path.join(f.root, 'first-user-target');
    const harness = f.harnesses.saveHarness(customHarness('Editable Agent', firstPath));
    await f.distribution.apply({ skillIds: [f.skill.id], harnessIds: [harness.id], scope: 'user', strategy: 'symlink' });
    const binding = f.store.list<{ id: string; harnessId: string }>('bindings').find((item) => item.harnessId === harness.id)!;
    await f.distribution.remove({ bindingId: binding.id, skillIds: [f.skill.id] });

    const updated = f.harnesses.saveHarness({
      id: harness.id,
      name: harness.name,
      icon: harness.icon,
      userSkillsPath: path.join(f.root, 'second-user-target'),
      workspaceSkillsRelativePath: harness.workspaceSkillsRelativePath,
    });
    expect(updated.userSkillsPath).toBe(path.join(f.root, 'second-user-target'));
  });

  it('removes one shared-path intent without deleting another harness installation', async () => {
    const f = await fixture();
    const target = path.join(f.root, 'shared');
    const a = f.harnesses.saveHarness(customHarness('Agent A', target));
    const b = f.harnesses.saveHarness(customHarness('Agent B', target));
    await f.distribution.apply({ skillIds: [f.skill.id], harnessIds: [a.id, b.id], scope: 'user', strategy: 'symlink' });
    const bindings = f.store.list<{ id: string; harnessId: string }>('bindings');

    const firstRemoval = await f.distribution.remove({
      bindingId: bindings.find((item) => item.harnessId === a.id)!.id,
      skillIds: [f.skill.id],
    });
    expect(firstRemoval.items[0].status).toBe('success');
    expect(f.store.list('distributions')).toHaveLength(1);
    expect(await readFile(path.join(target, f.skill.name, 'SKILL.md'), 'utf8')).toContain('Search');

    const lastRemoval = await f.distribution.remove({
      bindingId: bindings.find((item) => item.harnessId === b.id)!.id,
      skillIds: [f.skill.id],
    });
    expect(lastRemoval.items[0].status).toBe('success');
    expect(f.store.list('distributions')).toHaveLength(0);
    await expect(readFile(path.join(target, f.skill.name, 'SKILL.md'), 'utf8')).rejects.toThrow();
  });

  it('refreshes a clean copy but protects it after external drift', async () => {
    const f = await fixture();
    const target = path.join(f.root, 'copy-target');
    const harness = f.harnesses.saveHarness(customHarness('Copy Agent', target));
    const request: ApplyRequest = { skillIds: [f.skill.id], harnessIds: [harness.id], scope: 'user', strategy: 'copy' };
    await f.distribution.apply(request);

    await writeFile(path.join(f.source, 'SKILL.md'), '---\nname: search-tool\ndescription: changed\n---\n# Updated\n');
    expect((await f.distribution.previewApply(request)).items[0].status).toBe('sync');
    const refreshed = await f.distribution.apply(request);
    expect(refreshed.items[0].status).toBe('success');
    expect(await readFile(path.join(target, f.skill.name, 'SKILL.md'), 'utf8')).toContain('description: changed');

    await writeFile(path.join(target, f.skill.name, 'SKILL.md'), 'external edit');
    await f.health.checkHealth([f.skill.id]);
    expect(f.store.list<{ health: string }>('distributions')[0].health).toBe('conflict');
    expect((await f.distribution.previewApply(request)).items[0].status).toBe('conflict');
    const blocked = await f.distribution.apply(request);
    expect(blocked.items[0].status).toBe('error');
    expect(await readFile(path.join(target, f.skill.name, 'SKILL.md'), 'utf8')).toBe('external edit');
  });

  it('allows an explicit checked strategy change from symlink to copy', async () => {
    const f = await fixture();
    const target = path.join(f.root, 'switch-target');
    const harness = f.harnesses.saveHarness(customHarness('Switch Agent', target));
    const linkRequest: ApplyRequest = { skillIds: [f.skill.id], harnessIds: [harness.id], scope: 'user', strategy: 'symlink' };
    await f.distribution.apply(linkRequest);
    const copyRequest = { ...linkRequest, strategy: 'copy' as const };
    expect((await f.distribution.previewApply(copyRequest)).items[0].status).toBe('sync');
    const result = await f.distribution.apply(copyRequest);
    expect(result.items[0].status).toBe('success');
    const entry = path.join(target, f.skill.name);
    const names = await readdir(target);
    expect(names).toContain(f.skill.name);
    expect(names.some((name) => name.startsWith('.harness-manager-stage-'))).toBe(false);
    expect(f.store.list<{ strategy: string }>('distributions')[0].strategy).toBe('copy');
    expect(await readFile(path.join(entry, 'SKILL.md'), 'utf8')).toContain('name: search-tool');
  });

  it('validates custom paths, protects workspace boundaries, and lists unowned external skills', async () => {
    const f = await fixture();
    expect(() => validateWorkspaceRelativePath('../outside')).toThrow();
    expect(() => validateWorkspaceRelativePath('/absolute/skills')).toThrow();
    expect(() => f.harnesses.saveHarness(customHarness('Bad Path', path.join(f.root, 'bad'), '../escape'))).toThrow();

    const workspace = path.join(f.root, 'workspace');
    const outside = path.join(f.root, 'outside');
    await mkdir(workspace);
    await mkdir(path.join(outside, 'skills', 'external-tool'), { recursive: true });
    await writeFile(path.join(outside, 'skills', 'external-tool', 'SKILL.md'), '---\nname: external-tool\n---\n# External skill\n');
    await symlink(outside, path.join(workspace, '.redirect'));
    const escaping = f.harnesses.saveHarness(customHarness('Escaping', path.join(f.root, 'unused-user'), '.redirect/skills'));
    const request: ApplyRequest = {
      skillIds: [f.skill.id],
      harnessIds: [escaping.id],
      scope: 'workspace',
      workspacePath: workspace,
      strategy: 'symlink',
    };
    await expect(f.distribution.previewApply(request)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });

    const safe = f.harnesses.saveHarness(customHarness('External Reader', path.join(f.root, 'unused-user'), '.external/skills'));
    const externalRoot = path.join(workspace, '.external', 'skills', 'local-tool');
    await mkdir(externalRoot, { recursive: true });
    await writeFile(path.join(externalRoot, 'SKILL.md'), '---\nname: local-tool\n---\n# Local external tool\n');
    await f.distribution.apply({ ...request, harnessIds: [safe.id] });
    const listed = await f.external.externalSkills();
    expect(listed.some((entry) => entry.name === 'local-tool' && entry.harnessId === safe.id)).toBe(true);
    expect(listed.some((entry) => entry.name === 'search-tool' && entry.harnessId === safe.id)).toBe(false);
  });

  it('recovers a completed disk projection if the process stopped before metadata commit', async () => {
    const f = await fixture();
    const configuredTarget = path.join(f.root, 'recovery-target');
    const harness = f.harnesses.saveHarness(customHarness('Recovery Agent', configuredTarget));
    const plan = await f.distribution.previewApply({
      skillIds: [f.skill.id],
      harnessIds: [harness.id],
      scope: 'user',
      strategy: 'symlink',
    });
    const entryPath = plan.items[0].targetPath;
    const targetPath = path.dirname(entryPath);
    await mkdir(targetPath, { recursive: true });
    await symlink(f.source, entryPath, 'dir');
    f.store.put('targets', { id: 'target-recovery', path: targetPath });
    const effects = {
      target: { id: 'target-recovery', path: targetPath },
      bindings: [{ id: 'binding-recovery', targetId: 'target-recovery', harnessId: harness.id, scope: 'user' }],
      skillId: f.skill.id,
    };
    const sourceHash = await hashDirectory(f.source);
    f.store.put('operations', {
      id: 'operation-recovery',
      owner: 'distribution',
      kind: 'apply',
      phase: 'new_placed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      skillId: f.skill.id,
      targetId: 'target-recovery',
      entryPath,
      sourcePath: f.source,
      strategy: 'symlink',
      newHash: sourceHash,
      stagePath: path.join(path.dirname(targetPath), '.recovery-target.harness-manager-stage-operation-recovery'),
      backupPath: path.join(path.dirname(targetPath), '.recovery-target.harness-manager-trash', 'operation-recovery', 'entry'),
      effects,
    });

    await f.distribution.recover();
    expect(f.store.list('distributions')).toHaveLength(1);
    expect(f.store.list('intents')).toHaveLength(1);
    expect(f.store.get<{ phase: string }>('operations', 'operation-recovery')?.phase).toBe('committed');
  });
});

describe('filesystem path resolution', () => {
  it('resolves a missing path beneath a symlinked directory ancestor', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harness-paths-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const physical = path.join(root, 'physical');
    const alias = path.join(root, 'alias');
    await mkdir(physical);
    await symlink(physical, alias);
    const resolved = await canonicalizePath(path.join(alias, 'new', 'skills'));
    expect(resolved.path).toBe(path.join((await canonicalizePath(physical)).path, 'new', 'skills'));
  });

  it('rejects a broken symbolic link in a configured path', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'harness-paths-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const dangling = path.join(root, 'dangling');
    await symlink(path.join(root, 'missing-target'), dangling);
    await expect(canonicalizePath(path.join(dangling, 'skills'))).rejects.toMatchObject({ code: 'PATH_RESOLVE_FAILED' });
  });

  it('refuses removal when a recorded target ancestor was replaced by a symlink', async () => {
    const f = await fixture();
    const workspace = path.join(f.root, 'workspace');
    const outside = path.join(f.root, 'outside');
    const agentDirectory = path.join(workspace, '.agent');
    await mkdir(agentDirectory, { recursive: true });
    await mkdir(path.join(outside, 'skills', f.skill.name), { recursive: true });
    await writeFile(path.join(outside, 'skills', f.skill.name, 'SKILL.md'), 'external target');
    const harness = f.harnesses.saveHarness(customHarness('Redirect Check', path.join(f.root, 'unused-user'), '.agent/skills'));
    const applied = await f.distribution.apply({
      skillIds: [f.skill.id],
      harnessIds: [harness.id],
      scope: 'workspace',
      workspacePath: workspace,
      strategy: 'symlink',
    });
    expect(applied.items[0].status).toBe('success');
    const binding = f.store.list<{ id: string }>('bindings')[0];

    await rm(agentDirectory, { recursive: true, force: true });
    await symlink(outside, agentDirectory);
    await expect(f.distribution.remove({ bindingId: binding.id, skillIds: [f.skill.id] })).rejects.toMatchObject({
      code: 'REMOVE_TARGET_REDIRECTED',
    });
    expect(await readFile(path.join(outside, 'skills', f.skill.name, 'SKILL.md'), 'utf8')).toBe('external target');
  });
});
