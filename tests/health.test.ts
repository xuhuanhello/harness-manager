import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createServices } from '../src/main/services';
import { Store } from '../src/main/store';
import type { Distribution, Skill } from '../src/shared/types';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

it('re-hashes the central library unless told the stored hashes are current', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hm-health-')));
  const store = new Store(path.join(root, 'library'));
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const services = createServices(store, { home: path.join(root, 'home') });
  const source = path.join(root, 'source', 'health-tool');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: health-tool\ndescription: health test\n---\n');
  const scan = await services.library.scan({ uri: source });
  const [skillId] = (await services.library.install({ scanId: scan.id, candidateIds: [scan.candidates[0].id] })).skillIds!;
  const harness = services.harnesses.saveHarness({
    name: 'Copy target',
    userSkillsPath: path.join(root, 'target'),
    workspaceSkillsRelativePath: '',
  });
  await services.distribution.apply({ skillIds: [skillId], harnessIds: [harness.id], scope: 'user', strategy: 'copy' });
  const health = () => store.list<Distribution>('distributions')[0].health;

  await writeFile(path.join(store.get<Skill>('skills', skillId)!.directory, 'notes.txt'), 'changed centrally\n');
  await services.health.checkHealth(undefined, { rehashSkills: false });
  expect(health()).toBe('healthy');
  await services.health.checkHealth();
  expect(health()).toBe('stale');
});
