import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, rename, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Controller } from '../src/main/controller';
import { contract } from '../src/shared/ipc-contract';
import type { Skill, Source, ScanResult } from '../src/shared/types';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup.length = 0;
});

it('resolves recorded skill source and Finder destinations without accepting renderer paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hm-locations-'));
  const sourcePath = path.join(root, 'source');
  await mkdir(sourcePath);
  await writeFile(path.join(sourcePath, 'SKILL.md'), '---\nname: example\ndescription: Example skill\n---\n# Example');
  const opened: string[] = [];
  const revealed: string[] = [];
  const controller = new Controller(path.join(root, 'library'), () => {}, {
    watch: false,
    ports: { openExternal: async (url) => void opened.push(url), showItemInFolder: (target) => void revealed.push(target) },
  });
  cleanup.push(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  await controller.initialize();
  const scan = (await controller.invoke('scan', { uri: sourcePath })) as ScanResult;
  await controller.invoke('install', { scanId: scan.id, candidateIds: [scan.candidates[0].id] });
  const skill = (await controller.snapshot()).skills[0];
  await controller.invoke('revealSkill', { skillId: skill.id });
  expect(revealed).toEqual([skill.directory]);
  await expect(controller.invoke('openSkillSource', { skillId: skill.id })).rejects.toThrow('没有可打开的网页来源');
  const source = controller.store.get<Source>('sources', skill.sourceId)!;
  controller.store.put('sources', { ...source, type: 'github', uri: 'https://github.com/acme/skills.git', commit: 'a'.repeat(40) });
  controller.store.put<Skill>('skills', { ...skill, sourcePath: 'skills/example', resolvedCommit: 'b'.repeat(40) });
  await controller.invoke('openSkillSource', { skillId: skill.id });
  expect(opened).toEqual([`https://github.com/acme/skills/tree/${'b'.repeat(40)}/skills/example`]);
  expect(contract.revealSkill.input.safeParse({ skillId: skill.id, path: '/tmp/arbitrary' }).success).toBe(false);
  await expect(controller.invoke('revealSkill', { skillId: 'missing' })).rejects.toThrow('不存在');
  const moved = path.join(root, 'moved');
  await rename(skill.directory, moved);
  await symlink(moved, skill.directory);
  await expect(controller.invoke('revealSkill', { skillId: skill.id })).rejects.toThrow('已被替换');
});
