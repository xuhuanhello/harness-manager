import { afterEach, it, expect } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServices } from '../src/main/services';
import { Store } from '../src/main/store';
import type { Distribution } from '../src/shared/types';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup.length = 0;
});
it('previews and explicitly restores a redirected managed link without removing either source', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hm-repair-')));
  const store = new Store(path.join(root, 'library'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  cleanup.push(async () => store.close());
  const { library, distribution, harnesses, external: scanner, health, repair } = createServices(store, { home: path.join(root, 'home') });
  const source = path.join(root, 'source', 'skill-tool');
  const oldSource = path.join(root, 'external-source', 'skill-tool');
  for (const entry of [source, oldSource]) {
    await mkdir(entry, { recursive: true });
    await writeFile(path.join(entry, 'SKILL.md'), '---\nname: skill-tool\ndescription: test\n---\n');
  }
  await writeFile(path.join(oldSource, 'custom.txt'), 'preserve');
  const managed = harnesses.saveHarness({
    name: 'Managed',
    userSkillsPath: path.join(root, 'managed'),
    workspaceSkillsRelativePath: '',
  });
  const externalTarget = path.join(root, 'external');
  await mkdir(externalTarget);
  await symlink(oldSource, path.join(externalTarget, 'skill-tool'));
  harnesses.saveHarness({ name: 'External', userSkillsPath: externalTarget, workspaceSkillsRelativePath: '' });
  const scan = await library.scan({ uri: source });
  const installed = await library.install({ scanId: scan.id, candidateIds: [scan.candidates[0].id] });
  await distribution.apply({ skillIds: installed.skillIds!, harnessIds: [managed.id], scope: 'user', strategy: 'symlink' });
  const entry = store.list<Distribution>('distributions')[0];
  const centralPath = await realpath(entry.entryPath);
  await rm(entry.entryPath);
  await symlink(oldSource, entry.entryPath);
  const external = (await scanner.externalSkills()).find((item) => item.harnessId !== managed.id)!;
  const [preview] = await repair.preview({ externalSkillId: external.id });
  expect(preview.currentTarget).toBe(oldSource);
  expect(preview.centralPath).toBe(centralPath);
  expect(await realpath(entry.entryPath)).toBe(oldSource); // Preview performs no mutation.
  await health.checkHealth(); // Health observations do not change link ownership or consent.
  const result = await repair.repair({ repairId: preview.repairId });
  expect(result.items[0].status).toBe('success');
  expect(await realpath(entry.entryPath)).toBe(centralPath);
  expect(await readFile(path.join(oldSource, 'custom.txt'), 'utf8')).toBe('preserve');
  expect(await realpath(path.join(externalTarget, 'skill-tool'))).toBe(oldSource);
  await expect(repair.repair({ repairId: preview.repairId })).rejects.toThrow(/过期/);
});
