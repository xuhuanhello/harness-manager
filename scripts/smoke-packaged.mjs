import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, lstat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from '@playwright/test';

const defaultApp = process.platform === 'win32' ? 'release/win-unpacked/Harness Manager.exe' : 'release/mac-arm64/Harness Manager.app';
const appPath = path.resolve(process.argv[2] || defaultApp);
const executablePath = appPath.endsWith('.app') ? path.join(appPath, 'Contents/MacOS/Harness Manager') : appPath;
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'harness-packaged-smoke-')));
let application;
try {
  const source = path.join(root, 'source');
  const target = path.join(root, 'agent-skills');
  await mkdir(source);
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: packaged-smoke\ndescription: Packaged desktop smoke fixture\n---\n');
  const env = { ...process.env, HARNESS_PROFILE_ROOT: path.join(root, 'profile'), HARNESS_LIBRARY_ROOT: path.join(root, 'library') };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.HARNESS_DEV_URL;
  application = await electron.launch({ executablePath, args: [], env, timeout: 30000 });
  const page = await application.firstWindow();
  await page.waitForFunction(() => Boolean(window.harness), undefined, { timeout: 30000 });
  assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
  const result = await page.evaluate(
    async ({ source, target }) => {
      const initial = await window.harness.snapshot();
      if (initial.skills.length) throw new Error('Expected an isolated empty library');
      const scan = await window.harness.scan({ uri: source });
      await window.harness.install({ scanId: scan.id, candidateIds: [scan.candidates[0].id] });
      const harness = await window.harness.saveHarness({
        name: 'Packaged Smoke',
        userSkillsPath: target,
        workspaceSkillsRelativePath: '.smoke/skills',
      });
      const skill = (await window.harness.snapshot()).skills[0];
      const applied = await window.harness.apply({ skillIds: [skill.id], harnessIds: [harness.id], scope: 'user', strategy: 'symlink' });
      if (applied.items.some((item) => item.status === 'error')) throw new Error(JSON.stringify(applied));
      await window.harness.setHarnessEnabled({ harnessId: harness.id, enabled: false });
      const snapshot = await window.harness.snapshot();
      return {
        skillId: skill.id,
        harnessId: harness.id,
        bindingId: snapshot.bindings.find((binding) => binding.harnessId === harness.id).id,
        directory: skill.directory,
        enabled: snapshot.harnesses.find((item) => item.id === harness.id).enabled,
        intents: snapshot.intents.length,
      };
    },
    { source, target },
  );
  assert.equal(result.enabled, false);
  assert.equal(result.intents, 1);
  assert.equal(await realpath(path.join(target, 'packaged-smoke')), await realpath(result.directory));
  await page.evaluate(async ({ skillId, harnessId, bindingId }) => {
    await window.harness.setHarnessEnabled({ harnessId, enabled: true });
    await window.harness.checkHealth();
    const snapshot = await window.harness.snapshot();
    if (snapshot.distributions[0].health !== 'healthy') throw new Error('Expected a healthy managed directory link');
    const removed = await window.harness.remove({ bindingId, skillIds: [skillId] });
    if (removed.items.some((item) => item.status === 'error')) throw new Error(JSON.stringify(removed));
    if ((await window.harness.snapshot()).distributions.length) throw new Error('Expected no managed entries after removal');
  }, result);
  await assert.rejects(lstat(path.join(target, 'packaged-smoke')), { code: 'ENOENT' });
  assert.match(await readFile(path.join(result.directory, 'SKILL.md'), 'utf8'), /packaged-smoke/);
  console.log('Packaged app passed: renderer, preload IPC, SQLite, local import, directory link apply/remove, health, management toggle.');
} finally {
  await application?.close();
  await rm(root, { recursive: true, force: true });
}
