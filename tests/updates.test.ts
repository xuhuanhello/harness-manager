import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashDirectory } from '../src/main/content';
import { createServices, type Services } from '../src/main/services';
import { Store } from '../src/main/store';
import { remoteCommit } from '../src/main/updates';
import type { Skill, Source } from '../src/shared/types';
import { crashAtJournalWrite } from './helpers/crash';

type Fixture = Services & { root: string; home: string; source: string; trashed: string[] };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function fixture(options: { trash?: boolean } = {}): Promise<Fixture> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hm-updates-')));
  const home = path.join(root, 'home');
  const source = path.join(root, 'source');
  await mkdir(home);
  await mkdir(source);
  const trashed: string[] = [];
  const store = new Store(path.join(root, 'library'));
  const trashItem =
    options.trash === false
      ? undefined
      : async (item: string) => {
          const destination = path.join(root, 'trash', `${trashed.length}-${path.basename(item)}`);
          await mkdir(path.dirname(destination), { recursive: true });
          await rename(item, destination);
          trashed.push(destination);
        };
  const services = createServices(store, { home, trashItem });
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { ...services, root, home, source, trashed };
}

async function writeSkill(directory: string, name: string, notes: string, description = `${name} skill`): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`);
  await writeFile(path.join(directory, 'notes.txt'), `${notes}\n`);
}

async function install(f: Fixture, ...names: string[]): Promise<Skill[]> {
  for (const name of names) await writeSkill(path.join(f.source, 'skills', name), name, 'v1');
  const scan = await f.library.scan({ uri: f.source });
  const result = await f.library.install({ scanId: scan.id, candidateIds: scan.candidates.map((item) => item.id) });
  return (result.skillIds ?? []).map((id) => f.store.get<Skill>('skills', id)!);
}

const notes = (skill: Skill) => readFile(path.join(skill.directory, 'notes.txt'), 'utf8');
const exists = (entry: string) =>
  lstat(entry).then(
    () => true,
    () => false,
  );

describe('UpdateService.check', () => {
  it('reports changed, missing and renamed upstream skills without touching the library', async () => {
    const f = await fixture();
    const [changed, removed, renamed, unchanged] = await install(f, 'changed-skill', 'removed-skill', 'renamed-skill', 'unchanged-skill');
    await writeSkill(path.join(f.source, 'skills', 'changed-skill'), 'changed-skill', 'v2', 'New description');
    await rm(path.join(f.source, 'skills', 'removed-skill'), { recursive: true });
    await writeSkill(path.join(f.source, 'skills', 'renamed-skill'), 'brand-new-name', 'v2');

    const check = await f.updates.check();
    expect(check.sources).toHaveLength(1);
    const [result] = check.sources;
    expect(result.error).toBeUndefined();
    expect(result.missing).toEqual([removed.id]);
    const byId = new Map(result.updates.map((item) => [item.skillId, item]));
    expect(byId.get(changed.id)).toMatchObject({ name: 'changed-skill', description: 'New description', localModified: false });
    expect(byId.get(changed.id)?.blocked).toBeUndefined();
    expect(byId.get(renamed.id)?.blocked).toContain('brand-new-name');
    expect(byId.has(unchanged.id)).toBe(false);
    expect(await notes(changed)).toBe('v1\n');
    expect(f.store.get<Skill>('skills', changed.id)?.baseHash).toBe(changed.baseHash);
  });

  it('does not report a source whose skills match their baseline', async () => {
    const f = await fixture();
    await install(f, 'steady-skill');
    const check = await f.updates.check();
    expect(check.sources).toEqual([{ sourceId: expect.any(String), updates: [], missing: [] }]);
  });

  it('reports a source that can no longer be read as an error, not as missing skills', async () => {
    const f = await fixture();
    await install(f, 'lost-skill');
    await rm(f.source, { recursive: true });
    const [result] = (await f.updates.check()).sources;
    expect(result.error).toBeTruthy();
    expect(result.missing).toEqual([]);
  });
});

describe('UpdateService.apply', () => {
  it('replaces the central copy, records the new baseline and keeps links working', async () => {
    const f = await fixture();
    const [skill] = await install(f, 'linked-skill');
    const target = path.join(f.root, 'agent-skills');
    const harness = f.harnesses.saveHarness({ name: 'Agent', userSkillsPath: target, workspaceSkillsRelativePath: '' });
    await f.distribution.apply({ skillIds: [skill.id], harnessIds: [harness.id], scope: 'user', strategy: 'symlink' });
    await writeSkill(path.join(f.source, 'skills', 'linked-skill'), 'linked-skill', 'v2', 'Updated description');

    const check = await f.updates.check();
    const result = await f.updates.apply({ checkId: check.id, skillIds: [skill.id] });
    expect(result.items).toEqual([expect.objectContaining({ id: skill.id, status: 'success' })]);
    expect(result.skillIds).toEqual([skill.id]);

    const updated = f.store.get<Skill>('skills', skill.id)!;
    const newHash = await hashDirectory(path.join(f.source, 'skills', 'linked-skill'));
    expect(updated).toMatchObject({
      baseHash: newHash,
      currentHash: newHash,
      description: 'Updated description',
      directory: skill.directory,
    });
    expect(await notes(updated)).toBe('v2\n');
    expect(await readlink(path.join(target, 'linked-skill'))).toBe(skill.directory);
    expect(await readFile(path.join(target, 'linked-skill', 'notes.txt'), 'utf8')).toBe('v2\n');
    expect(f.store.list('operations').filter((item) => (item as { owner: string }).owner === 'update')).toEqual([
      expect.objectContaining({ phase: 'committed' }),
    ]);
    expect(await exists(path.join(f.store.root, '.staging', (f.store.list('operations')[0] as { id: string }).id))).toBe(false);
    expect((await f.updates.check()).sources[0].updates).toEqual([]);
  });

  it('leaves local edits alone unless the user confirms replacing them, then moves them to the trash', async () => {
    const f = await fixture();
    const [skill] = await install(f, 'edited-skill');
    await writeFile(path.join(skill.directory, 'notes.txt'), 'my edit\n');
    await writeSkill(path.join(f.source, 'skills', 'edited-skill'), 'edited-skill', 'v2');

    const check = await f.updates.check();
    expect(check.sources[0].updates[0]).toMatchObject({ skillId: skill.id, localModified: true });
    const skipped = await f.updates.apply({ checkId: check.id, skillIds: [skill.id] });
    expect(skipped.items[0].status).toBe('skipped');
    expect(await notes(skill)).toBe('my edit\n');

    const replaced = await f.updates.apply({ checkId: check.id, skillIds: [skill.id], replaceModified: [skill.id] });
    expect(replaced.items[0].status).toBe('success');
    expect(await notes(skill)).toBe('v2\n');
    expect(f.trashed).toHaveLength(1);
    expect(path.basename(f.trashed[0])).toContain('edited-skill');
    expect(await readFile(path.join(f.trashed[0], 'notes.txt'), 'utf8')).toBe('my edit\n');
  });

  it('skips replacing local edits when nothing can move them to the trash', async () => {
    const f = await fixture({ trash: false });
    const [skill] = await install(f, 'edited-skill');
    await writeFile(path.join(skill.directory, 'notes.txt'), 'my edit\n');
    await writeSkill(path.join(f.source, 'skills', 'edited-skill'), 'edited-skill', 'v2');
    const check = await f.updates.check();
    const result = await f.updates.apply({ checkId: check.id, skillIds: [skill.id], replaceModified: [skill.id] });
    expect(result.items[0].status).toBe('skipped');
    expect(await notes(skill)).toBe('my edit\n');
  });

  it('refuses content that changed after the check, on either side', async () => {
    const f = await fixture();
    const [central, upstream] = await install(f, 'central-edit', 'upstream-edit');
    await writeSkill(path.join(f.source, 'skills', 'central-edit'), 'central-edit', 'v2');
    await writeSkill(path.join(f.source, 'skills', 'upstream-edit'), 'upstream-edit', 'v2');
    const check = await f.updates.check();
    await writeFile(path.join(central.directory, 'notes.txt'), 'edited after check\n');
    await writeSkill(path.join(f.source, 'skills', 'upstream-edit'), 'upstream-edit', 'v3');

    const result = await f.updates.apply({ checkId: check.id, skillIds: [central.id, upstream.id] });
    expect(result.items.map((item) => item.status)).toEqual(['error', 'error']);
    expect(await notes(central)).toBe('edited after check\n');
    expect(await notes(upstream)).toBe('v1\n');
    expect(f.store.get<Skill>('skills', upstream.id)?.baseHash).toBe(upstream.baseHash);
    expect(f.journal.issues()).toEqual([]);
  });

  it('rejects an unknown or superseded check', async () => {
    const f = await fixture();
    const [skill] = await install(f, 'any-skill');
    await expect(f.updates.apply({ checkId: '00000000-0000-0000-0000-000000000000', skillIds: [skill.id] })).rejects.toMatchObject({
      code: 'UPDATE_CHECK_EXPIRED',
    });
    await writeSkill(path.join(f.source, 'skills', 'any-skill'), 'any-skill', 'v2');
    const first = await f.updates.check();
    await f.updates.check();
    await expect(f.updates.apply({ checkId: first.id, skillIds: [skill.id] })).rejects.toMatchObject({ code: 'UPDATE_CHECK_EXPIRED' });
  });
});

describe('update recovery', () => {
  async function crashedUpdate(phase: string, when: 'before' | 'after' = 'after') {
    const f = await fixture();
    const [skill] = await install(f, 'crash-skill');
    await writeSkill(path.join(f.source, 'skills', 'crash-skill'), 'crash-skill', 'v2');
    const check = await f.updates.check();
    const crash = crashAtJournalWrite(f.updates, f.store, (op) => op.owner === 'update' && op.phase === phase, when);
    const result = await f.updates.apply({ checkId: check.id, skillIds: [skill.id] });
    crash.restore();
    expect(crash.crashed).toBe(true);
    expect(result.items[0].status).toBe('error');
    const restarted = createServices(f.store, { home: f.home });
    await restarted.updates.recover();
    const [operation] = f.store.list<{ id: string; owner: string; phase: string }>('operations').filter((item) => item.owner === 'update');
    return { f, skill, operation };
  }

  it.each([
    ['prepared', 'after' as const],
    ['old_moved', 'before' as const],
    ['old_moved', 'after' as const],
  ])('restores the previous content when the update stopped at %s (%s the write)', async (phase, when) => {
    const { f, skill, operation } = await crashedUpdate(phase, when);
    expect(operation.phase).toBe('failed');
    expect(await notes(skill)).toBe('v1\n');
    expect(f.store.get<Skill>('skills', skill.id)?.baseHash).toBe(skill.baseHash);
    expect(await exists(path.join(f.store.root, '.staging', operation.id))).toBe(false);
  });

  it.each([
    ['new_placed', 'before' as const],
    ['new_placed', 'after' as const],
    ['committed', 'before' as const],
  ])('finishes the update when the new content was already placed (%s, %s the write)', async (phase, when) => {
    const { f, skill, operation } = await crashedUpdate(phase, when);
    expect(operation.phase).toBe('committed');
    expect(await notes(skill)).toBe('v2\n');
    const updated = f.store.get<Skill>('skills', skill.id)!;
    expect(updated.baseHash).toBe(await hashDirectory(skill.directory));
    expect(await exists(path.join(f.store.root, '.staging', operation.id))).toBe(false);
  });

  it('removes checkouts left by an earlier run', async () => {
    const f = await fixture();
    const leftover = path.join(f.store.root, '.staging', 'update-00000000-0000-0000-0000-000000000000', '0', 'checkout');
    await mkdir(leftover, { recursive: true });
    await f.updates.recover();
    expect(await exists(path.dirname(path.dirname(leftover)))).toBe(false);
  });
});

describe('remoteCommit', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const c = 'c'.repeat(40);

  it('resolves HEAD, branches and peeled annotated tags the way fetch does', () => {
    expect(remoteCommit(`${a}\tHEAD\n`, 'HEAD')).toBe(a);
    expect(remoteCommit(`${a}\trefs/heads/feature/main\n${b}\trefs/heads/main\n`, 'main')).toBe(b);
    expect(remoteCommit(`${a}\trefs/tags/v1\n${b}\trefs/tags/v1^{}\n${c}\trefs/heads/v1\n`, 'v1')).toBe(b);
    expect(remoteCommit(`${a}\trefs/heads/main\n`, 'refs/heads/main')).toBe(a);
  });

  it('returns nothing when the ref is not listed', () => {
    expect(remoteCommit('', 'main')).toBeUndefined();
    expect(remoteCommit(`${a}\trefs/heads/other\n`, 'main')).toBeUndefined();
    expect(remoteCommit('not a commit\trefs/heads/main\n', 'main')).toBeUndefined();
  });
});

describe('source bookkeeping', () => {
  it('keeps the source record of a local source unchanged by an update', async () => {
    const f = await fixture();
    const [skill] = await install(f, 'local-skill');
    const before = f.store.get<Source>('sources', skill.sourceId);
    await writeSkill(path.join(f.source, 'skills', 'local-skill'), 'local-skill', 'v2');
    const check = await f.updates.check();
    await f.updates.apply({ checkId: check.id, skillIds: [skill.id] });
    expect(f.store.get<Source>('sources', skill.sourceId)).toEqual(before);
    expect(f.store.get<Skill>('skills', skill.id)?.resolvedCommit).toBeUndefined();
  });
});
