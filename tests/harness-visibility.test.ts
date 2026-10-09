import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServices } from '../src/main/services';
import { Store } from '../src/main/store';
import { harnessReadPaths } from '../src/shared/harness-paths';
import { BUILTIN_HARNESSES } from '../src/shared/harness-registry';
import type { Harness, Skill } from '../src/shared/types';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hm-visibility-'));
  const home = path.join(root, 'home');
  await mkdir(home);
  const store = new Store(path.join(root, 'library'));
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  return { ...createServices(store, { home }), root, home };
}
it('shows inherited managed and external skills in both scopes without creating extra install intents', async () => {
  const f = await fixture();
  const source = path.join(f.root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: common\ndescription: Common tool\n---\n');
  const scan = await f.library.scan({ uri: source });
  await f.library.install({ scanId: scan.id, candidateIds: [scan.candidates[0].id] });
  const skill = f.store.list<Skill>('skills')[0];
  const inherited = f.harnesses.saveHarness({
    name: 'Compatible Test',
    userSkillsPath: '~/.test/skills',
    workspaceSkillsRelativePath: '.test/skills',
    readsUserAgents: true,
    readsWorkspaceAgents: true,
  });
  const isolated = f.harnesses.saveHarness({
    name: 'Isolated Test',
    userSkillsPath: '~/.isolated/skills',
    workspaceSkillsRelativePath: '.isolated/skills',
  });
  await f.distribution.apply({ skillIds: [skill.id], harnessIds: ['universal'], scope: 'user', strategy: 'symlink' });
  const workspace = path.join(f.root, 'workspace');
  await mkdir(workspace);
  await f.distribution.apply({
    skillIds: [skill.id],
    harnessIds: ['universal'],
    scope: 'workspace',
    workspacePath: workspace,
    strategy: 'symlink',
  });
  for (const dir of [path.join(f.home, '.agents/skills/external'), path.join(workspace, '.agents/skills/external')]) {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), '---\nname: external\ndescription: External\n---\n');
  }
  const raw = await f.external.externalSkills();
  const visible = await f.external.visibleSkills(raw);
  expect(visible.visibleManagedSkills.filter((item) => item.harnessId === inherited.id)).toHaveLength(2);
  expect(visible.visibleExternalSkills.filter((item) => item.harnessId === inherited.id)).toHaveLength(2);
  expect(visible.visibleManagedSkills.filter((item) => item.harnessId === isolated.id)).toHaveLength(0);
  expect(
    visible.visibleExternalSkills
      .filter((item) => item.harnessId === inherited.id)
      .map((item) => item.inheritedFrom)
      .sort(),
  ).toEqual(['.agents/skills', '~/.agents/skills']);
  expect(f.store.list('intents')).toHaveLength(2);
  expect(f.store.list('distributions')).toHaveLength(2);
});
it('installs Codex into the documented shared roots and still reads its legacy and project .codex roots', () => {
  for (const id of ['codex', 'codex-app']) {
    const codex = BUILTIN_HARNESSES.find((harness) => harness.id === id)!;
    expect(codex).toMatchObject({ userSkillsPath: '~/.agents/skills', workspaceSkillsRelativePath: '.agents/skills' });
    expect(harnessReadPaths(codex, 'user').map((item) => item.path)).toEqual(['~/.agents/skills', '~/.codex/skills']);
    expect(harnessReadPaths(codex, 'workspace').map((item) => item.path)).toEqual(['.agents/skills', '.codex/skills']);
  }
});

it('locks builtin discovery rules but preserves executable overrides across registry reseeding', async () => {
  const f = await fixture();
  const builtin = f.store.get<Harness>('harnesses', 'codex')!;
  const { origin, ...input } = builtin;
  expect(() => f.harnesses.saveHarness({ ...input, readsUserAgents: !builtin.readsUserAgents })).toThrow('不可修改');
  f.harnesses.saveHarness({ ...input, executablePaths: ['~/bin/codex'] });
  createServices(f.store, { home: f.home });
  expect(f.store.get<Harness>('harnesses', 'codex')?.executablePaths).toEqual(['~/bin/codex']);
  expect(f.store.list('harnesses').length).toBeGreaterThanOrEqual(15);
});
it('adds newer built-in app candidates to an existing saved record without dropping local additions', async () => {
  const f = await fixture();
  const current = f.store.get<Harness>('harnesses', 'codex-app')!;
  const { appBundleIds: _bundleIds, ...olderRecord } = current;
  f.store.put('harnesses', {
    ...olderRecord,
    enabled: true,
    appPaths: ['/Applications/Codex.app', '~/Applications/Codex.app', '~/Tools/Codex Dev.app'],
  });
  createServices(f.store, { home: f.home });
  const upgraded = f.store.get<Harness>('harnesses', 'codex-app')!;
  expect(upgraded.enabled).toBe(true);
  expect(upgraded.appPaths).toEqual([
    '/Applications/Codex.app',
    '~/Applications/Codex.app',
    '~/Tools/Codex Dev.app',
    '/Applications/ChatGPT.app',
    '~/Applications/ChatGPT.app',
  ]);
  expect(upgraded.appBundleIds).toEqual(['com.openai.codex']);
  const { origin, ...input } = upgraded;
  expect(() => f.harnesses.saveHarness({ ...input, appBundleIds: ['com.openai.chat'] })).toThrow('不可修改');
  expect(f.harnesses.saveHarness(input).appBundleIds).toEqual(['com.openai.codex']);
});
