import { candidateGroup } from '../src/shared/candidate-groups';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copySkillDirectory, hashDirectory } from '../src/main/content';
import { LibraryService } from '../src/main/library';
import { Store } from '../src/main/store';
import type { Candidate, Group, Skill, Source } from '../src/shared/types';

const roots: string[] = [];
const stores: Store[] = [];

function thrownCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

afterEach(async () => {
  for (const store of stores.splice(0).reverse()) store.close();
  for (const root of roots.splice(0).reverse()) await rm(root, { recursive: true, force: true });
});

describe('LibraryService', () => {
  it('parses bounded YAML headers with multiline descriptions and rejects unterminated frontmatter', async () => {
    const root = await temporaryDirectory('hm-frontmatter-');
    const source = path.join(root, 'source');
    const fixtures = {
      folded: '\uFEFF---\r\nname: folded\r\ndescription: >-\r\n  Reviews local\r\n  project files.\r\n---\r\ninvalid: [markdown body',
      literal: '---\nname: literal\ndescription: |-\n  Keep this divider:\n  ---\n  and this line.\n---\n# Body\n',
      unterminated: '---\nname: unterminated\ndescription: Missing a closing delimiter\n',
    };
    for (const [name, content] of Object.entries(fixtures)) {
      await mkdir(path.join(source, name), { recursive: true });
      await writeFile(path.join(source, name, 'SKILL.md'), content);
    }
    const store = makeStore(path.join(root, 'library'));
    const service = new LibraryService(store);
    const scan = await service.scan({ uri: source });
    expect(scan.candidates.find((item) => item.name === 'folded')).toMatchObject({
      description: 'Reviews local project files.',
      issues: [],
    });
    expect(scan.candidates.find((item) => item.name === 'literal')).toMatchObject({
      description: 'Keep this divider:\n---\nand this line.',
      issues: [],
    });
    const unterminated = scan.candidates.find((item) => item.path === 'unterminated')!;
    expect(unterminated.issues.length).toBeGreaterThan(0);
    expect((await service.install({ scanId: scan.id, candidateIds: [unterminated.id] })).items[0].status).toBe('error');
    expect(store.list('skills')).toHaveLength(0);
  });

  it('validates custom install groups before writing and merges only successfully installed skills', async () => {
    const root = await temporaryDirectory('hm-custom-install-');
    const source = path.join(root, 'source');
    await mkdir(source);
    for (const name of ['first', 'second', 'failed']) await makeSkill(source, name, 'Custom grouping test');
    const store = makeStore(path.join(root, 'library'));
    const service = new LibraryService(store);
    const scan = await service.scan({ uri: source });
    const id = (name: string) => scan.candidates.find((item) => item.name === name)!.id;
    await expect(service.install({ scanId: scan.id, candidateIds: [id('first')], customGroupName: '   ' })).rejects.toThrow();
    expect(store.list('skills')).toHaveLength(0);
    await service.install({ scanId: scan.id, candidateIds: [id('first')], customGroupName: ' Business ' });
    await rm(path.join(source, 'failed'), { recursive: true });
    await expect(service.install({ scanId: scan.id, candidateIds: [id('second')], customGroupName: 'business' })).rejects.toThrow();
    expect(store.list('skills')).toHaveLength(1);
    await service.install({
      scanId: scan.id,
      candidateIds: [id('second'), id('failed')],
      customGroupName: 'Business',
      mergeExistingGroups: true,
    });
    const groups = store.list<Group>('groups');
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Business');
    expect(groups[0].skillIds.sort()).toEqual([id('first'), id('second')].sort());
  });

  it('infers directory groups and only groups selected successful installs after opt-in', async () => {
    expect(candidateGroup('skills/engineering/review')).toBe('engineering');
    expect(candidateGroup('skills/plain-skill')).toBeNull();
    expect(candidateGroup('plain-skill')).toBeNull();
    expect(candidateGroup('skills/engineering/frontend/review')).toBe('engineering / frontend');
    const root = await temporaryDirectory('hm-group-install-');
    const source = path.join(root, 'source');
    await mkdir(path.join(source, 'skills', 'engineering'), { recursive: true });
    await makeSkill(path.join(source, 'skills', 'engineering'), 'first-skill', 'First');
    await makeSkill(path.join(source, 'skills', 'engineering'), 'second-skill', 'Second');
    await makeSkill(path.join(source, 'skills', 'engineering'), 'failed-skill', 'Failed');
    const store = makeStore(path.join(root, 'library'));
    const service = new LibraryService(store);
    const scan = await service.scan({ uri: source });
    const first = scan.candidates.find((item) => item.name === 'first-skill')!;
    const second = scan.candidates.find((item) => item.name === 'second-skill')!;
    const failed = scan.candidates.find((item) => item.name === 'failed-skill')!;
    await service.install({ scanId: scan.id, candidateIds: [first.id] });
    expect(store.list('groups')).toHaveLength(0);
    const existing = service.saveGroup({ name: 'engineering', skillIds: [first.id] });
    await rm(path.join(source, 'skills', 'engineering', 'failed-skill'), { recursive: true });
    await expect(service.install({ scanId: scan.id, candidateIds: [second.id], createDetectedGroups: true })).rejects.toThrow();
    expect(store.list('skills')).toHaveLength(1);
    const result = await service.install({
      scanId: scan.id,
      candidateIds: [second.id, failed.id],
      createDetectedGroups: true,
      mergeExistingGroups: true,
    });
    expect(result.items.find((item) => item.id === failed.id)?.status).toBe('error');
    const groups = store.list<Group>('groups');
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe(existing.id);
    expect(groups[0].skillIds.sort()).toEqual([first.id, second.id].sort());
  });

  it('selectively installs a validated local candidate, preserves its executable hash, and stays idempotent', async () => {
    const root = await temporaryDirectory('hm-library-');
    const sourceRoot = path.join(root, 'source');
    const libraryRoot = path.join(root, 'library');
    await mkdir(sourceRoot);
    await makeSkill(sourceRoot, 'search-tool', 'Searches the project files.', true);
    await makeSkill(sourceRoot, 'design-tool', 'Reads design references.');
    await mkdir(path.join(sourceRoot, 'tagged-skill'));
    await writeFile(
      path.join(sourceRoot, 'tagged-skill', 'SKILL.md'),
      `---\nname: !!js/function 'function () { throw new Error("executed") }'\ndescription: unsafe tag\n---\n`,
    );
    const marker = path.join(root, 'script-ran');
    await writeFile(path.join(sourceRoot, 'search-tool', 'run.sh'), `#!/bin/sh\nprintf bad > '${marker}'\n`, { mode: 0o751 });

    const store = makeStore(libraryRoot);
    const service = new LibraryService(store);
    const scan = await service.scan({ uri: sourceRoot });
    expect(scan.source.type).toBe('local');
    expect(scan.source.ref).toBe('local');
    expect(scan.candidates.map((candidate) => candidate.name)).toEqual(['design-tool', 'search-tool', 'tagged-skill']);
    const tagged = scan.candidates.find((candidate) => candidate.path === 'tagged-skill')!;
    expect(tagged.issues.length).toBeGreaterThan(0);
    const rejectedTagged = await service.install({ scanId: scan.id, candidateIds: [tagged.id] });
    expect(rejectedTagged.items[0].status).toBe('error');
    const candidate = scan.candidates.find((entry) => entry.name === 'search-tool')!;
    expect(candidate.description).toBe('Searches the project files.');

    const installed = await service.install({ scanId: scan.id, candidateIds: [candidate.id] });
    expect(installed.items).toEqual([{ id: candidate.id, label: 'search-tool', status: 'success' }]);
    expect(installed.skillIds).toEqual([candidate.id]);
    const skills = store.list<Skill>('skills');
    expect(skills).toHaveLength(1);
    expect(skills[0].sourcePath).toBe('search-tool');
    expect(skills[0].directory).toBe(path.join(store.root, 'skills', candidate.id, 'search-tool'));
    expect(skills[0].baseHash).toBe(skills[0].currentHash);
    expect(skills[0].description).toBe('Searches the project files.');
    expect((await lstat(path.join(skills[0].directory, 'run.sh'))).mode & 0o111).toBe(0o111);
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    const repeated = await service.install({ scanId: scan.id, candidateIds: [candidate.id, candidate.id] });
    expect(repeated.items).toHaveLength(1);
    expect(repeated.items[0].status).toBe('skipped');
    expect(store.list<Skill>('skills')).toHaveLength(1);
    const rescanned = await service.scan({ uri: sourceRoot });
    expect(rescanned.candidates.find((entry) => entry.name === 'search-tool')?.id).toBe(candidate.id);
    expect(rescanned.candidates.find((entry) => entry.name === 'search-tool')?.installed).toBe(true);

    const group = service.saveGroup({ name: 'Research', skillIds: [candidate.id] });
    const joined = service.saveGroup({ groupId: group.id, skillIds: [candidate.id, candidate.id] });
    expect(joined.skillIds).toEqual([candidate.id]);
    expect(thrownCode(() => service.saveGroup({ name: 'research', skillIds: [] }))).toBe('GROUP_NAME_TAKEN');
    expect(thrownCode(() => service.saveGroup({ groupId: '../outside', skillIds: [] }))).toBe('GROUP_NOT_FOUND');
    expect(store.list<Group>('groups')).toHaveLength(1);

    service.saveSettings({ viewMode: 'group', activeTabs: { group: group.id } });
    service.saveSettings({ activeTabs: { source: 'all' } });
    expect(store.get<{ id: string; viewMode: string; activeTabs: Record<string, string> }>('settings', 'ui')).toEqual({
      id: 'ui',
      viewMode: 'group',
      activeTabs: { group: group.id, source: 'all' },
    });
  });

  it('forgets the oldest abandoned scans beyond the session limit', async () => {
    const root = await temporaryDirectory('hm-scan-sessions-');
    const source = path.join(root, 'source');
    await mkdir(source);
    await makeSkill(source, 'session-skill', 'Scanned repeatedly');
    const service = new LibraryService(makeStore(path.join(root, 'library')));
    const scans = [];
    for (let index = 0; index < 17; index += 1) scans.push(await service.scan({ uri: source }));
    const [oldest, ...recent] = scans;
    await expect(service.install({ scanId: oldest.id, candidateIds: [oldest.candidates[0].id] })).rejects.toMatchObject({
      code: 'SCAN_EXPIRED',
    });
    const latest = recent.at(-1)!;
    expect((await service.install({ scanId: latest.id, candidateIds: [latest.candidates[0].id] })).items[0].status).toBe('success');
  });

  it('commits an install whose staged copy was already renamed into the library', async () => {
    const root = await temporaryDirectory('hm-recovery-renamed-');
    const sourceRoot = path.join(root, 'source');
    await mkdir(sourceRoot);
    await makeSkill(sourceRoot, 'renamed-skill', 'A skill renamed before the crash.');
    const store = makeStore(path.join(root, 'library'));
    const service = new LibraryService(store);
    const scan = await service.scan({ uri: sourceRoot });
    const candidate = scan.candidates.find((item) => item.name === 'renamed-skill')!;
    const pending = await preparePendingInstall(store.root, scan.source, candidate, sourceRoot);
    await mkdir(path.dirname(pending.finalPath), { recursive: true });
    await rename(pending.stagePath, pending.finalPath);
    store.put('operations', { ...store.get<{ id: string; phase: string }>('operations', pending.id)!, phase: 'renamed' });

    await service.recover();
    expect(store.get<Skill>('skills', candidate.id)?.directory).toBe(pending.finalPath);
    expect(store.get<{ phase: string }>('operations', pending.id)?.phase).toBe('committed');
    expect(await hashDirectory(pending.finalPath)).toBe(pending.newHash);
    await expect(lstat(path.dirname(pending.stagePath))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a complete staged install and leaves an ambiguous external destination untouched', async () => {
    const root = await temporaryDirectory('hm-recovery-');
    const sourceRoot = path.join(root, 'source');
    const libraryRoot = path.join(root, 'library');
    await mkdir(sourceRoot);
    await makeSkill(sourceRoot, 'recover-skill', 'A skill for recovery.');
    await makeSkill(sourceRoot, 'conflict-skill', 'A skill with an external destination.');
    const store = makeStore(libraryRoot);
    const service = new LibraryService(store);
    const scan = await service.scan({ uri: sourceRoot });
    const recoverCandidate = scan.candidates.find((candidate) => candidate.name === 'recover-skill')!;
    const conflictCandidate = scan.candidates.find((candidate) => candidate.name === 'conflict-skill')!;

    const recoverOperation = await preparePendingInstall(store.root, scan.source, recoverCandidate, sourceRoot);
    await service.recover();
    expect(store.get<Skill>('skills', recoverCandidate.id)?.directory).toBe(recoverOperation.finalPath);
    expect(store.get<{ id: string; phase: string }>('operations', recoverOperation.id)?.phase).toBe('committed');
    expect(await hashDirectory(recoverOperation.finalPath)).toBe(recoverOperation.newHash);
    await expect(lstat(path.dirname(recoverOperation.stagePath))).rejects.toMatchObject({ code: 'ENOENT' });

    const conflictOperation = await preparePendingInstall(store.root, scan.source, conflictCandidate, sourceRoot);
    await mkdir(conflictOperation.finalPath, { recursive: true });
    await writeFile(path.join(conflictOperation.finalPath, 'external.txt'), 'externally created');
    await service.recover();
    expect(store.get<Skill>('skills', conflictCandidate.id)).toBeUndefined();
    expect(store.get<{ id: string; phase: string }>('operations', conflictOperation.id)?.phase).toBe('failed');
    expect(await readFile(path.join(conflictOperation.finalPath, 'external.txt'), 'utf8')).toBe('externally created');
    await service.recover();
    await expect(lstat(path.dirname(conflictOperation.stagePath))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(conflictOperation.finalPath, 'external.txt'), 'utf8')).toBe('externally created');

    await makeSkill(sourceRoot, 'redirect-skill', 'A skill with a redirected journal ancestor.');
    const redirectedScan = await service.scan({ uri: sourceRoot });
    const redirectedCandidate = redirectedScan.candidates.find((candidate) => candidate.name === 'redirect-skill')!;
    const redirectedOperation = await preparePendingInstall(store.root, redirectedScan.source, redirectedCandidate, sourceRoot);
    const operationDirectory = path.dirname(redirectedOperation.stagePath);
    const relocatedOperation = path.join(root, 'relocated-operation');
    await rm(relocatedOperation, { recursive: true, force: true });
    await rename(operationDirectory, relocatedOperation);
    await symlink(relocatedOperation, operationDirectory);
    await service.recover();
    expect(store.get<{ id: string; phase: string }>('operations', redirectedOperation.id)?.phase).toBe('failed');
    expect(await readFile(path.join(relocatedOperation, 'content', 'SKILL.md'), 'utf8')).toContain('redirect-skill');
    await expect(lstat(redirectedOperation.finalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await service.recover();
    expect(await readFile(path.join(relocatedOperation, 'content', 'SKILL.md'), 'utf8')).toContain('redirect-skill');
  });

  it('rolls back nested SQLite transactions and remains usable after a thrown callback', async () => {
    const root = await temporaryDirectory('hm-store-');
    const store = makeStore(root);
    expect(() =>
      store.transaction(() => {
        store.put('sources', { id: 'source_one', uri: 'local' });
        store.transaction(() => {
          store.put('sources', { id: 'source_two', uri: 'local' });
        });
        throw new Error('abort outer transaction');
      }),
    ).toThrow('abort outer transaction');
    expect(store.list('sources')).toEqual([]);

    store.transaction(() => {
      store.put('sources', { id: 'source_three', uri: 'local' });
      expect(() =>
        store.transaction(() => {
          store.put('sources', { id: 'source_four', uri: 'local' });
          throw new Error('abort nested transaction');
        }),
      ).toThrow('abort nested transaction');
      store.put('sources', { id: 'source_five', uri: 'local' });
    });
    expect(store.list<{ id: string }>('sources').map((source) => source.id)).toEqual(['source_five', 'source_three']);
    store.transaction(() => store.put('sources', { id: 'source_six', uri: 'local' }));
    expect(store.get('sources', 'source_six')).toEqual({ id: 'source_six', uri: 'local' });
  });
});

describe('skill content safety', () => {
  it('hashes executable bits and copies safe internal symlinks without overwriting existing entries', async () => {
    const root = await temporaryDirectory('hm-content-');
    const source = path.join(root, 'skill');
    const destination = path.join(root, 'copied');
    await mkdir(source);
    await writeFile(path.join(source, 'SKILL.md'), 'content');
    await writeFile(path.join(source, 'run.sh'), '#!/bin/sh\nexit 0\n');
    await writeFile(path.join(source, 'notes.md'), 'notes');
    await chmod(path.join(source, 'run.sh'), 0o751);
    await symlink('notes.md', path.join(source, 'notes-link.md'));
    const sourceHash = await hashDirectory(source);
    await copySkillDirectory(source, destination);
    expect(await hashDirectory(destination)).toBe(sourceHash);
    expect(await readlink(path.join(destination, 'notes-link.md'))).toBe('notes.md');
    expect((await lstat(path.join(destination, 'run.sh'))).mode & 0o111).toBe(0o111);

    await chmod(path.join(source, 'run.sh'), 0o644);
    expect(await hashDirectory(source)).not.toBe(sourceHash);

    const occupied = path.join(root, 'occupied');
    await mkdir(occupied);
    await writeFile(path.join(occupied, 'preserve.txt'), 'keep');
    await expect(copySkillDirectory(source, occupied)).rejects.toMatchObject({ code: 'CONTENT_DESTINATION_EXISTS' });
    expect(await readFile(path.join(occupied, 'preserve.txt'), 'utf8')).toBe('keep');
    await expect(copySkillDirectory(source, path.join(source, 'nested-copy'))).rejects.toMatchObject({ code: 'CONTENT_COPY_INTO_SOURCE' });
  });

  it('rejects external links and directory cycles before copying', async () => {
    const root = await temporaryDirectory('hm-links-');
    const external = path.join(root, 'outside.txt');
    const skill = path.join(root, 'skill');
    const destination = path.join(root, 'copy');
    await mkdir(skill);
    await writeFile(external, 'outside');
    await writeFile(path.join(skill, 'SKILL.md'), 'content');
    await symlink(external, path.join(skill, 'external.txt'));
    await expect(hashDirectory(skill)).rejects.toMatchObject({ code: 'CONTENT_SYMLINK_ABSOLUTE' });
    await expect(copySkillDirectory(skill, destination)).rejects.toMatchObject({ code: 'CONTENT_SYMLINK_ABSOLUTE' });
    await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });

    const cycle = path.join(root, 'cycle');
    await mkdir(cycle);
    await writeFile(path.join(cycle, 'SKILL.md'), 'content');
    await symlink('.', path.join(cycle, 'self'));
    await expect(hashDirectory(cycle)).rejects.toMatchObject({ code: 'CONTENT_SYMLINK_CYCLE' });
  });
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function makeStore(root: string): Store {
  const store = new Store(root);
  stores.push(store);
  return store;
}

async function makeSkill(sourceRoot: string, name: string, description: string, multiline = false): Promise<void> {
  const directory = path.join(sourceRoot, name);
  await mkdir(directory, { recursive: true });
  const descriptionYaml = multiline
    ? `description: >-\n  ${description}\n`
    : `description: '${description.replace(/'/g, "''")}' # YAML comments are parsed safely\n`;
  await writeFile(
    path.join(directory, 'SKILL.md'),
    `---\nname: "${name}" # inline comment\n${descriptionYaml}metadata:\n  version: 1\n---\n# ${name}\n`,
  );
  await writeFile(path.join(directory, 'README.md'), `Notes for ${name}.`);
}

async function preparePendingInstall(
  libraryRoot: string,
  source: Source,
  candidate: Candidate,
  sourceRoot: string,
): Promise<{ id: string; stagePath: string; finalPath: string; newHash: string }> {
  const id = randomUUID();
  const operationDirectory = path.join(libraryRoot, '.staging', id);
  const stagePath = path.join(operationDirectory, 'content');
  const finalPath = path.join(libraryRoot, 'skills', candidate.id, candidate.name);
  await mkdir(operationDirectory, { recursive: true });
  const sourceDirectory = path.join(sourceRoot, candidate.path);
  await copySkillDirectory(sourceDirectory, stagePath);
  const newHash = await hashDirectory(stagePath);
  const skill: Skill = {
    id: candidate.id,
    name: candidate.name,
    description: candidate.description,
    sourceId: source.id,
    sourcePath: candidate.path,
    directory: finalPath,
    baseHash: newHash,
    currentHash: newHash,
    installedAt: new Date().toISOString(),
    resolvedCommit: source.type === 'github' ? source.commit : undefined,
    upstreamSignal: source.type === 'github' ? { algo: 'git-commit', value: source.commit } : undefined,
  };
  const store = stores.at(-1)!;
  store.put('operations', {
    id,
    owner: 'library',
    kind: 'install',
    phase: 'prepared',
    createdAt: skill.installedAt,
    candidateId: candidate.id,
    stagePath,
    finalPath,
    source,
    skill,
    newHash,
  });
  return { id, stagePath, finalPath, newHash };
}
