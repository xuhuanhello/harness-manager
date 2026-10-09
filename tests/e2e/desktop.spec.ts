import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, lstat, symlink, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

async function stubMarketLeaderboard(app: ElectronApplication) {
  await app.evaluate(() => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          skills: [{ source: 'catalog/demo', skillId: 'alpha-helper', name: 'alpha-helper', installs: 123 }],
          page: 0,
          total: 1,
          hasMore: false,
        }),
        { headers: { 'content-type': 'application/json' } },
      );
  });
}

test('desktop bridge, persistence and workspace configuration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hm-desktop-'));
  let app: ElectronApplication | undefined;
  const fixture = path.join(root, 'source', 'search-tool');
  const workspace = path.join(root, 'workspace');
  await mkdir(fixture, { recursive: true });
  await mkdir(workspace);
  await writeFile(
    path.join(fixture, 'SKILL.md'),
    '---\nname: search-tool\ndescription: A local search skill for desktop acceptance\n---\n# Search\n',
  );
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (pair): pair is [string, string] => typeof pair[1] === 'string' && !['ELECTRON_RUN_AS_NODE', 'HARNESS_DEV_URL'].includes(pair[0]),
    ),
  );
  env.HARNESS_LIBRARY_ROOT = path.join(root, 'library');
  env.HARNESS_PROFILE_ROOT = path.join(root, 'profile');
  try {
    app = await electron.launch({ args: ['.'], env });
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.harness));
    const sandbox = await page.evaluate(() => ({
      require: typeof (window as unknown as { require?: unknown }).require,
      bridge: typeof window.harness.scan,
    }));
    expect(sandbox).toEqual({ require: 'undefined', bridge: 'function' });
    // Rejections reach the renderer as the plain user-facing message, without Electron's IPC wrapper text.
    const rejection = await page.evaluate(() =>
      window.harness.deleteMarketplace('skills-sh').then(
        () => 'resolved',
        (error: Error) => error.message,
      ),
    );
    expect(rejection).toBe('内置市场不能删除。');
    const result = await page.evaluate(
      async ({ uri, workspacePath, userPath }) => {
        const scan = await window.harness.scan({ uri });
        const install = await window.harness.install({ scanId: scan.id, candidateIds: scan.candidates.map((x) => x.id) });
        const snapshot = await window.harness.snapshot();
        const skillIds = snapshot.skills.map((x) => x.id);
        await window.harness.saveGroup({ name: 'Desktop acceptance', skillIds });
        const harness = await window.harness.saveHarness({
          name: 'Acceptance Agent',
          userSkillsPath: userPath,
          workspaceSkillsRelativePath: '.acceptance/skills',
        });
        const request = { skillIds, harnessIds: [harness.id], scope: 'workspace' as const, workspacePath, strategy: 'symlink' as const };
        const plan = await window.harness.previewApply(request);
        const applied = await window.harness.apply(request);
        await window.harness.saveSettings({ viewMode: 'flat' });
        return { install, plan, applied };
      },
      { uri: path.join(root, 'source'), workspacePath: workspace, userPath: path.join(root, 'user-skills') },
    );
    expect(result.install.items.every((x) => x.status !== 'error')).toBe(true);
    expect(result.plan.items).toHaveLength(1);
    expect(result.applied.items.every((x) => x.status !== 'error')).toBe(true);
    await expect(page.getByText('search-tool', { exact: true }).first()).toBeVisible();
    expect(await readFile(path.join(workspace, '.acceptance/skills/search-tool/SKILL.md'), 'utf8')).toContain('local search skill');
    await page.screenshot({ path: test.info().outputPath('desktop-acceptance.png'), fullPage: true });
    await app.close();
    app = await electron.launch({ args: ['.'], env });
    const reopened = await app.firstWindow();
    await reopened.waitForFunction(() => Boolean(window.harness));
    const persisted = await reopened.evaluate(() => window.harness.snapshot());
    expect(persisted.skills).toHaveLength(1);
    expect(persisted.groups[0].name).toBe('Desktop acceptance');
    expect(persisted.settings.viewMode).toBe('flat');
    expect(persisted.distributions[0].health).toBe('healthy');
    const custom = persisted.harnesses.find((x) => x.name === 'Acceptance Agent')!;
    await reopened.evaluate(
      async ({ skillId, harnessId }) => {
        await window.harness.apply({ skillIds: [skillId], harnessIds: [harnessId], scope: 'user', strategy: 'symlink' });
      },
      { skillId: persisted.skills[0].id, harnessId: custom.id },
    );
    await reopened.getByTestId('view-mode-select').click();
    await reopened.getByRole('menuitemradio', { name: '按 Harness', exact: true }).click();
    await reopened.getByRole('tab', { name: /Acceptance Agent/ }).click();
    await reopened.getByTestId('start-selection').click();
    await reopened.getByRole('checkbox').first().check();
    await reopened.getByRole('button', { name: /从 Acceptance Agent 移除所选/ }).click();
    await reopened.getByRole('button', { name: '确认移除', exact: true }).click();
    await expect(reopened.getByText('操作已完成', { exact: true })).toBeVisible();
    const afterRemoval = await reopened.evaluate(() => window.harness.snapshot());
    expect(afterRemoval.skills).toHaveLength(1);
    expect(afterRemoval.distributions).toHaveLength(1);
    expect(await readFile(path.join(workspace, '.acceptance/skills/search-tool/SKILL.md'), 'utf8')).toContain('local search skill');
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('first-use UI selects one candidate and applies a source group to a workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hm-ui-'));
  let app: ElectronApplication | undefined;
  const source = path.join(root, 'product-skills');
  const workspace = path.join(root, 'project');
  await mkdir(workspace);
  for (const name of ['research-helper', 'unused-helper']) {
    await mkdir(path.join(source, name), { recursive: true });
    await writeFile(
      path.join(source, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: A useful product workflow skill\n---\n# Instructions\n`,
    );
  }
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (pair): pair is [string, string] => typeof pair[1] === 'string' && !['ELECTRON_RUN_AS_NODE', 'HARNESS_DEV_URL'].includes(pair[0]),
    ),
  );
  env.HARNESS_LIBRARY_ROOT = path.join(root, 'library');
  env.HARNESS_PROFILE_ROOT = path.join(root, 'profile');
  try {
    app = await electron.launch({ args: ['.'], env });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '添加来源', exact: true }).first().click();
    await page.getByRole('tab', { name: '本地目录', exact: true }).click();
    await page.getByLabel('本地技能目录', { exact: true }).fill(source);
    await page.getByRole('button', { name: '扫描技能', exact: true }).click();
    await expect(page.getByText('发现 2 个技能')).toBeVisible();
    const candidate = page.locator('.candidate-row').filter({ hasText: 'research-helper' });
    await candidate.getByRole('checkbox').check();
    await page.getByRole('button', { name: '安装所选技能 (1)', exact: true }).click();
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await page.getByRole('button', { name: '跳过', exact: true }).click();
    expect((await page.evaluate(() => window.harness.snapshot())).skills.map((x) => x.name)).toEqual(['research-helper']);
    await page.getByRole('button', { name: '更多操作' }).click();
    await page.getByRole('menuitem', { name: '选择多个技能' }).click();
    await page.getByRole('checkbox', { name: /选择product-skills中的/ }).check();
    await page.getByRole('button', { name: /^应用/ }).last().click();
    await page.getByRole('radio', { name: /工作区级/ }).click();
    await page.getByLabel('工作目录', { exact: true }).fill(workspace);
    await page.locator('.harness-choice').filter({ hasText: 'Claude Code' }).click();
    await page.getByRole('button', { name: '预览安装目标', exact: true }).click();
    await expect(page.getByText(path.join(await realpath(workspace), '.claude/skills/research-helper'), { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /确认应用|应用到目标|执行应用/ }).click();
    await expect
      .poll(async () => readFile(path.join(workspace, '.claude/skills/research-helper/SKILL.md'), 'utf8').catch(() => ''))
      .toContain('research-helper');
    await page.screenshot({ path: test.info().outputPath('workspace-apply-acceptance.png'), fullPage: true });
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const groupMode of ['detected', 'custom', 'custom-merge', 'custom-rename'] as const) {
  test(`directory groups are collapsed, selectable, searchable and created via ${groupMode}`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hm-groups-ui-'));
    let app: ElectronApplication | undefined;
    const source = path.join(root, 'source');
    for (const [category, name] of [
      ['engineering', 'review-code'],
      ['engineering', 'design-code'],
      ['productivity', 'handoff'],
    ]) {
      const directory = path.join(source, 'skills', category, name);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Grouped skill example\n---\n# Instructions\n`);
    }
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && !['ELECTRON_RUN_AS_NODE', 'HARNESS_DEV_URL'].includes(entry[0]),
      ),
    );
    try {
      app = await electron.launch({
        args: ['.'],
        env: { ...env, HARNESS_LIBRARY_ROOT: path.join(root, 'library'), HARNESS_PROFILE_ROOT: path.join(root, 'profile') },
      });
      const page = await app.firstWindow();
      await page.getByTestId('view-mode-select').click();
      await expect(page.getByRole('menu', { name: '分类方式', exact: true })).toBeVisible();
      await page.getByRole('menuitemradio', { name: '平铺', exact: true }).click();
      await page.getByRole('button', { name: '添加来源', exact: true }).first().click();
      await page.getByRole('tab', { name: '本地目录', exact: true }).click();
      await page.getByLabel('本地技能目录', { exact: true }).fill(source);
      await page.getByRole('button', { name: '扫描技能', exact: true }).click();
      await expect(page.getByText('发现 3 个技能')).toBeVisible();
      await expect(page.locator('.candidate-row')).toHaveCount(0);
      await page.getByRole('button', { name: '全部展开', exact: true }).click();
      await expect(page.locator('.candidate-row')).toHaveCount(3);
      await page.getByRole('button', { name: '全部折叠', exact: true }).click();
      await expect(page.locator('.candidate-row')).toHaveCount(0);
      await page.getByRole('button', { name: '全选 3 项', exact: true }).click();
      await page.getByRole('button', { name: '取消全选', exact: true }).click();
      await expect(page.getByText('已选择 0 项', { exact: true })).toBeVisible();
      await page.getByLabel('搜索扫描结果').fill('review');
      await expect(page.locator('.candidate-row')).toHaveCount(1);
      await page.getByLabel('搜索扫描结果').fill('');
      await page.getByRole('checkbox', { name: '选择分组 engineering', exact: true }).check();
      await page.screenshot({ path: test.info().outputPath('grouped-scan-acceptance.png'), fullPage: true });
      await page.getByRole('button', { name: '安装所选技能 (2)', exact: true }).click();
      await expect(page.getByRole('region', { name: '创建识别分组' })).toBeVisible();
      if (groupMode === 'custom-merge' || groupMode === 'custom-rename') {
        await page.evaluate(async (uri) => {
          const scan = await window.harness.scan({ uri });
          const result = await window.harness.install({
            scanId: scan.id,
            candidateIds: [scan.candidates.find((item) => item.name === 'handoff')!.id],
          });
          await window.harness.saveGroup({ name: '产品交付', skillIds: result.skillIds! });
        }, source);
      }
      if (groupMode.startsWith('custom')) {
        await page.getByRole('button', { name: '自定义分组', exact: true }).click();
        await expect(page.getByRole('button', { name: '安装并加入自定义分组', exact: true })).toBeDisabled();
        await page.getByLabel('自定义分组名称', { exact: true }).fill('   ');
        await expect(page.getByRole('button', { name: '安装并加入自定义分组', exact: true })).toBeDisabled();
        await page.getByLabel('自定义分组名称', { exact: true }).fill('产品交付');
        await page.screenshot({ path: test.info().outputPath('custom-group-acceptance.png'), fullPage: true });
        await page.getByRole('button', { name: '安装并加入自定义分组', exact: true }).click();
        if (groupMode === 'custom-merge') {
          expect((await page.evaluate(() => window.harness.snapshot())).skills).toHaveLength(1);
          await page.getByRole('button', { name: '合并到已有分组', exact: true }).click();
        } else if (groupMode === 'custom-rename') {
          expect((await page.evaluate(() => window.harness.snapshot())).skills).toHaveLength(1);
          await page.getByRole('button', { name: '换个名称创建新分组', exact: true }).click();
          await page.getByLabel('自定义分组名称', { exact: true }).fill('新交付分组');
          await page.getByRole('button', { name: '安装并加入自定义分组', exact: true }).click();
        }
      } else {
        await page.getByRole('button', { name: '安装并创建分组', exact: true }).click();
      }
      await page.getByRole('button', { name: '继续', exact: true }).click();
      const snapshot = await page.evaluate(() => window.harness.snapshot());
      const collision = groupMode === 'custom-merge' || groupMode === 'custom-rename';
      expect(snapshot.skills).toHaveLength(collision ? 3 : 2);
      expect(snapshot.groups).toHaveLength(groupMode === 'custom-rename' ? 2 : 1);
      const expectedName = groupMode === 'custom-rename' ? '新交付分组' : groupMode.startsWith('custom') ? '产品交付' : 'engineering';
      expect(snapshot.groups.find((group) => group.name === expectedName)?.skillIds).toHaveLength(groupMode === 'custom-merge' ? 3 : 2);
      if (groupMode === 'custom-rename') expect(snapshot.groups.find((group) => group.name === '产品交付')?.skillIds).toHaveLength(1);
      expect(snapshot.settings.viewMode).toBe('flat');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } finally {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const sourceKind of ['directory', 'linked-source'] as const) {
  test(`Harness navigation migrates ${sourceKind} and removes old source contents`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hm-harness-view-'));
    let app: ElectronApplication | undefined;
    const target = path.join(root, 'agent-skills');
    const externalPath = path.join(target, sourceKind === 'linked-source' ? 'legacy-search' : 'external-search');
    const sourcePath = sourceKind === 'directory' ? externalPath : path.join(root, 'old-source', 'external-search');
    const secondTarget = path.join(root, 'other-agent-skills');
    await mkdir(sourcePath, { recursive: true });
    await writeFile(
      path.join(sourcePath, 'SKILL.md'),
      '---\nname: external-search\ndescription: External search workflow\n---\n# Search\n',
    );
    await mkdir(path.join(sourcePath, 'assets'));
    await writeFile(path.join(sourcePath, 'assets', 'sample.txt'), 'Full original source contents');
    if (sourceKind === 'linked-source') {
      await mkdir(target);
      await mkdir(secondTarget);
      const intermediary = path.join(root, 'source-alias');
      await symlink(sourcePath, intermediary, 'dir');
      await symlink(intermediary, externalPath, 'dir');
      await symlink(sourcePath, path.join(secondTarget, 'external-search'), 'dir');
    }
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && !['ELECTRON_RUN_AS_NODE', 'HARNESS_DEV_URL'].includes(entry[0]),
      ),
    );
    try {
      app = await electron.launch({
        args: ['.'],
        env: { ...env, HARNESS_LIBRARY_ROOT: path.join(root, 'library'), HARNESS_PROFILE_ROOT: path.join(root, 'profile') },
      });
      const page = await app.firstWindow();
      await page.waitForFunction(() => Boolean(window.harness));
      await page.evaluate(
        async ({ target, secondTarget, linked }) => {
          await window.harness.saveHarness({
            name: 'Migration Agent',
            userSkillsPath: target,
            workspaceSkillsRelativePath: '.migration/skills',
          });
          if (linked)
            await window.harness.saveHarness({
              name: 'Other Migration Agent',
              userSkillsPath: secondTarget,
              workspaceSkillsRelativePath: '.other/skills',
            });
        },
        { target, secondTarget, linked: sourceKind === 'linked-source' },
      );
      await page.getByRole('button', { name: /^Agent Harness/ }).click();
      await page
        .getByRole('tab')
        .filter({ has: page.getByText('Migration Agent', { exact: true }) })
        .click();
      await expect(page.getByText(path.basename(externalPath), { exact: true }).first()).toBeVisible();
      await page.getByRole('button', { name: '迁移到中央仓库管理', exact: true }).click();
      await expect(page.getByRole('dialog')).toContainText(await realpath(sourcePath));
      if (sourceKind === 'linked-source') await expect(page.getByRole('dialog')).toContainText('Other Migration Agent');
      await page.getByRole('button', { name: '确认迁移并移除旧源', exact: true }).click();
      await expect(page.getByRole('button', { name: '返回 Harness', exact: true })).toBeVisible();
      const migrated = await page.evaluate(() => window.harness.snapshot());
      expect(migrated.distributions.length, await page.getByRole('dialog').innerText()).toBe(sourceKind === 'directory' ? 1 : 2);
      await page.getByRole('button', { name: '返回 Harness', exact: true }).click();
      await expect(page.getByText('中央仓库托管', { exact: true }).first()).toBeVisible();
      expect(migrated.skills).toHaveLength(1);
      expect(
        migrated.externalSkills.filter(
          (item) => item.harnessId === migrated.harnesses.find((harness) => harness.name === 'Migration Agent')!.id,
        ),
      ).toHaveLength(0);
      expect(await realpath(externalPath)).toBe(await realpath(migrated.skills[0].directory));
      expect((await lstat(migrated.skills[0].directory)).isSymbolicLink()).toBe(false);
      expect((await lstat(externalPath)).isSymbolicLink()).toBe(true);
      expect(await readFile(path.join(externalPath, 'assets/sample.txt'), 'utf8')).toBe('Full original source contents');
      if (sourceKind === 'linked-source') {
        await expect(lstat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await realpath(path.join(secondTarget, 'external-search'))).toBe(await realpath(migrated.skills[0].directory));
      }
      await page.screenshot({ path: test.info().outputPath('harness-view-acceptance.png'), fullPage: true });
    } finally {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('skills.sh marketplace opens the official URL without redundant manual import', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hm-market-ui-'));
  let app: ElectronApplication | undefined;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && !['ELECTRON_RUN_AS_NODE', 'HARNESS_DEV_URL'].includes(entry[0]),
    ),
  );
  try {
    app = await electron.launch({
      args: ['.'],
      env: { ...env, HARNESS_LIBRARY_ROOT: path.join(root, 'library'), HARNESS_PROFILE_ROOT: path.join(root, 'profile') },
    });
    await stubMarketLeaderboard(app);
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'skills.sh', exact: true }).click();
    await expect(page.getByText('skills.sh', { exact: true }).first()).toBeVisible();
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url) => {
        (globalThis as typeof globalThis & { marketplaceOpened?: string }).marketplaceOpened = url;
      };
    });
    await page.getByRole('button', { name: '打开网站', exact: true }).click();
    await expect
      .poll(() => app!.evaluate(() => (globalThis as typeof globalThis & { marketplaceOpened?: string }).marketplaceOpened))
      .toBe('https://skills.sh/');
    await expect(page.getByRole('button', { name: '打开网站', exact: true })).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath('marketplace-acceptance.png'), fullPage: true });
    await expect(page.getByText('手动扫描 GitHub 仓库或 skills.sh 技能链接', { exact: true })).toHaveCount(0);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('market sources can be added, reopened, edited and removed from settings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hm-market-sources-'));
  let app: ElectronApplication | undefined;
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && !['ELECTRON_RUN_AS_NODE', 'HARNESS_DEV_URL'].includes(entry[0]),
      ),
    ),
    HARNESS_LIBRARY_ROOT: path.join(root, 'library'),
    HARNESS_PROFILE_ROOT: path.join(root, 'profile'),
  };
  try {
    app = await electron.launch({ args: ['.'], env });
    await stubMarketLeaderboard(app);
    let page = await app.firstWindow();
    await page.getByRole('button', { name: 'SkillsMP', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'SkillsMP', exact: true })).toBeVisible();
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url) => {
        (globalThis as typeof globalThis & { marketplaceOpened?: string }).marketplaceOpened = url;
      };
    });
    await page.getByRole('button', { name: '打开网站', exact: true }).click();
    await expect
      .poll(() => app!.evaluate(() => (globalThis as typeof globalThis & { marketplaceOpened?: string }).marketplaceOpened))
      .toBe('https://skillsmp.com/');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '添加市场', exact: true }).click();
    await page.getByLabel('市场名称', { exact: true }).fill('团队技能市场');
    await page.getByLabel('网站地址', { exact: true }).fill('https://example.com/skills');
    await page.getByRole('button', { name: '保存市场', exact: true }).click();
    await page.getByRole('button', { name: '团队技能市场', exact: true }).click();
    await expect(page.getByRole('button', { name: '打开网站', exact: true })).toBeVisible();
    const selectedId = await page.evaluate(
      async () => (await window.harness.snapshot()).marketplaces.find((market) => market.name === '团队技能市场')!.id,
    );
    await expect.poll(() => page.evaluate(async () => (await window.harness.snapshot()).settings.activeTabs.marketplace)).toBe(selectedId);
    await app.close();
    app = await electron.launch({ args: ['.'], env });
    await stubMarketLeaderboard(app);
    page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.harness));
    expect(await page.evaluate(async () => (await window.harness.snapshot()).settings.activeTabs.marketplace)).toBe(selectedId);
    await page.getByRole('button', { name: '团队技能市场', exact: true }).click();
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url) => {
        (globalThis as typeof globalThis & { marketplaceOpened?: string }).marketplaceOpened = url;
      };
    });
    await page.getByRole('button', { name: '打开网站', exact: true }).click();
    await expect
      .poll(() => app!.evaluate(() => (globalThis as typeof globalThis & { marketplaceOpened?: string }).marketplaceOpened))
      .toBe('https://example.com/skills');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const marketRow = page.getByTestId('marketplace-source-row').filter({ hasText: '团队技能市场' });
    await marketRow.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('marketplace-settings-acceptance.png'), fullPage: true });
    await marketRow.getByRole('button', { name: /^编辑 / }).click();
    await page.getByLabel('市场名称', { exact: true }).fill('团队市场新版');
    await page.getByLabel('网站地址', { exact: true }).fill('https://example.com/new-skills');
    await page.getByRole('button', { name: '保存市场', exact: true }).click();
    await expect(page.getByRole('button', { name: '团队市场新版', exact: true })).toBeVisible();
    await page
      .getByTestId('marketplace-source-row')
      .filter({ hasText: '团队市场新版' })
      .getByRole('button', { name: /^删除 / })
      .click();
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(page.getByRole('button', { name: '团队市场新版', exact: true })).toHaveCount(0);
    const snapshot = await page.evaluate(() => window.harness.snapshot());
    expect(snapshot.marketplaces.map((market) => market.name)).toEqual(['skills.sh', 'SkillsMP']);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('migration issues offer an explicit managed-link repair before retrying migration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hm-repair-ui-'));
  let app: ElectronApplication | undefined;
  const source = path.join(root, 'old-source', 'repair-tool');
  const originalCentralSource = path.join(root, 'central-source', 'repair-tool');
  const externalTarget = path.join(root, 'external');
  const managedTarget = path.join(root, 'managed');
  for (const directory of [source, originalCentralSource]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'SKILL.md'), '---\nname: repair-tool\ndescription: Repair acceptance\n---\n');
  }
  await mkdir(externalTarget);
  await symlink(source, path.join(externalTarget, 'repair-tool'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && !['ELECTRON_RUN_AS_NODE', 'HARNESS_DEV_URL'].includes(entry[0]),
    ),
  );
  try {
    app = await electron.launch({
      args: ['.'],
      env: { ...env, HARNESS_LIBRARY_ROOT: path.join(root, 'library'), HARNESS_PROFILE_ROOT: path.join(root, 'profile') },
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.harness));
    const registered = await page.evaluate(
      async ({ originalCentralSource, externalTarget, managedTarget }) => {
        const scan = await window.harness.scan({ uri: originalCentralSource });
        const install = await window.harness.install({ scanId: scan.id, candidateIds: [scan.candidates[0].id] });
        const managed = await window.harness.saveHarness({
          name: 'Repair Managed',
          userSkillsPath: managedTarget,
          workspaceSkillsRelativePath: '',
        });
        await window.harness.saveHarness({ name: 'Repair External', userSkillsPath: externalTarget, workspaceSkillsRelativePath: '' });
        await window.harness.apply({ skillIds: install.skillIds!, harnessIds: [managed.id], scope: 'user', strategy: 'symlink' });
        return (await window.harness.snapshot()).skills[0].directory;
      },
      { originalCentralSource, externalTarget, managedTarget },
    );
    const managedEntry = path.join(managedTarget, 'repair-tool');
    await rm(managedEntry);
    await symlink(source, managedEntry);
    await page.getByRole('button', { name: /^Agent Harness/ }).click();
    await page.getByRole('tab', { name: /Repair External/ }).click();
    await page.getByRole('button', { name: '迁移到中央仓库管理', exact: true }).click();
    await page.getByRole('button', { name: '预览修复', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText(registered);
    expect(await realpath(managedEntry)).toBe(await realpath(source));
    await page.getByRole('button', { name: '确认修复', exact: true }).click();
    await page.evaluate(() => window.harness.snapshot());
    expect(await realpath(managedEntry), await page.getByRole('dialog').innerText()).toBe(await realpath(registered));
    await expect(page.getByRole('button', { name: '确认迁移并移除旧源', exact: true })).toBeVisible();
    expect(await realpath(managedEntry)).toBe(await realpath(registered));
    expect((await lstat(source)).isDirectory()).toBe(true);
    await page.screenshot({ path: test.info().outputPath('migration-repair-acceptance.png'), fullPage: true });
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('in-app catalogs group by repository and scan a source for confirmed batch installation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hm-catalog-ui-'));
  let app: ElectronApplication | undefined;
  const source = path.join(root, 'repository');
  const git = promisify(execFile);
  for (const name of ['alpha-helper', 'beta-helper']) {
    await mkdir(path.join(source, name), { recursive: true });
    await writeFile(
      path.join(source, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Catalog acceptance skill\n---\n# Instructions\n`,
    );
  }
  await git('git', ['init', '-b', 'main', source]);
  await git('git', ['-C', source, 'add', '.']);
  await git('git', [
    '-C',
    source,
    '-c',
    'user.name=Harness Test',
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'Fixture',
  ]);
  const gitConfig = path.join(root, 'gitconfig');
  await writeFile(gitConfig, '');
  await git('git', ['config', '--file', gitConfig, `url.file://${source}.insteadOf`, 'https://github.com/catalog/demo.git']);
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && !['ELECTRON_RUN_AS_NODE', 'HARNESS_DEV_URL'].includes(entry[0]),
      ),
    ),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    HARNESS_LIBRARY_ROOT: path.join(root, 'library'),
    HARNESS_PROFILE_ROOT: path.join(root, 'profile'),
  };
  try {
    app = await electron.launch({ args: ['.'], env });
    await app.evaluate(() => {
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        if (url.hostname === 'skillsmp.com')
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                skills: [
                  {
                    id: 'mp-alpha',
                    name: 'alpha-helper',
                    description: 'A searchable skill',
                    githubUrl: 'https://github.com/catalog/demo/tree/main/alpha-helper',
                    stars: 42,
                  },
                ],
                pagination: { hasNext: false },
              },
            }),
            { headers: { 'content-type': 'application/json' } },
          );
        if (url.searchParams.get('q') === 'failure') return new Response('Unavailable', { status: 503 });
        const skills = [
          { source: 'catalog/demo', skillId: 'alpha-helper', name: 'alpha-helper', installs: 123 },
          { source: 'catalog/demo', skillId: 'beta-helper', name: 'beta-helper', installs: 52 },
        ];
        if (url.pathname === '/api/search')
          return new Response(JSON.stringify({ skills: url.searchParams.get('q') === 'empty' ? [] : skills }), {
            headers: { 'content-type': 'application/json' },
          });
        return new Response(JSON.stringify({ skills, total: skills.length, page: 0, hasMore: false }), {
          headers: { 'content-type': 'application/json' },
        });
      };
    });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'skills.sh', exact: true }).click();
    await expect(page.getByText('catalog/demo', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: '全部展开', exact: true }).click();
    await page.getByRole('button', { name: '全部折叠', exact: true }).click();
    await page.getByRole('button', { name: '全部展开', exact: true }).click();
    await page.screenshot({ path: test.info().outputPath('marketplace-catalog-acceptance.png'), fullPage: true });
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url) => {
        (globalThis as typeof globalThis & { catalogSkillOpened?: string }).catalogSkillOpened = url;
      };
    });
    await page.getByRole('button', { name: '在网页中打开 alpha-helper', exact: true }).click();
    await expect
      .poll(() => app!.evaluate(() => (globalThis as typeof globalThis & { catalogSkillOpened?: string }).catalogSkillOpened))
      .toBe('https://skills.sh/catalog/demo/alpha-helper');
    await page.getByRole('button', { name: '扫描仓库并选择安装 catalog/demo', exact: true }).click();
    await expect(page.getByText('发现 2 个技能', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '全选 2 项', exact: true }).click();
    await page.getByRole('button', { name: '安装所选技能 (2)', exact: true }).click();
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await page.getByRole('button', { name: '跳过', exact: true }).click();
    expect((await page.evaluate(() => window.harness.snapshot())).skills.map((skill) => skill.name).sort()).toEqual([
      'alpha-helper',
      'beta-helper',
    ]);
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url) => {
        (globalThis as typeof globalThis & { skillOpened?: string }).skillOpened = url;
      };
      shell.showItemInFolder = (filename) => {
        (globalThis as typeof globalThis & { skillRevealed?: string }).skillRevealed = filename;
      };
    });
    await page.getByRole('button', { name: /^中央技能库/ }).click();
    await page.getByRole('button', { name: '全部折叠', exact: true }).click();
    await expect(page.locator('.skill-row')).toHaveCount(0);
    await page.getByRole('button', { name: '全部展开', exact: true }).click();
    await expect(page.locator('.skill-row')).toHaveCount(2);
    await page.getByRole('button', { name: '选择多个', exact: true }).click();
    await page.getByRole('button', { name: '全选 2 项', exact: true }).click();
    await expect(page.locator('.skill-row input[type="checkbox"]:checked')).toHaveCount(2);
    await page.getByRole('button', { name: '取消全选', exact: true }).click();
    await page.getByRole('button', { name: '在网页中打开 alpha-helper', exact: true }).click();
    const installed = (await page.evaluate(() => window.harness.snapshot())).skills.find((skill) => skill.name === 'alpha-helper')!;
    expect(await app.evaluate(() => (globalThis as typeof globalThis & { skillOpened?: string }).skillOpened)).toBe(
      `https://github.com/catalog/demo/tree/${installed.resolvedCommit}/alpha-helper`,
    );
    await page.getByRole('button', { name: '在访达中显示 alpha-helper', exact: true }).click();
    expect(await app.evaluate(() => (globalThis as typeof globalThis & { skillRevealed?: string }).skillRevealed)).toBe(
      installed.directory,
    );
    await expect(page.locator('.skill-row input[type="checkbox"]:checked')).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('library-actions-acceptance.png'), fullPage: true });
    await page.getByRole('button', { name: 'SkillsMP', exact: true }).click();
    await page.getByLabel('搜索市场技能', { exact: true }).fill('alpha');
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await expect(page.getByText('catalog/demo', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'skills.sh', exact: true }).click();
    await page.getByLabel('搜索市场技能', { exact: true }).fill('failure');
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
    await page.getByLabel('搜索市场技能', { exact: true }).fill('empty');
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await expect(page.getByText(/没有找到匹配/)).toBeVisible();
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Harness inheritance, builtin rule locking and executable discovery are visible in settings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hm-harness-capabilities-'));
  let app: ElectronApplication | undefined;
  const source = path.join(root, 'source');
  const workspace = path.join(root, 'workspace');
  await mkdir(source);
  await mkdir(workspace);
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: inherited-helper\ndescription: An inherited common skill\n---\n');
  const executable = path.join(root, 'sample-agent');
  await writeFile(executable, '#!/bin/sh\nprintf "sample-agent 1.2.3\\n"\n');
  await chmod(executable, 0o755);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && !['ELECTRON_RUN_AS_NODE', 'HARNESS_DEV_URL'].includes(entry[0]),
    ),
  );
  try {
    app = await electron.launch({
      args: ['.'],
      env: { ...env, HARNESS_LIBRARY_ROOT: path.join(root, 'library'), HARNESS_PROFILE_ROOT: path.join(root, 'profile') },
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.harness));
    await page.evaluate(
      async ({ source, workspace, executable }) => {
        const scan = await window.harness.scan({ uri: source });
        await window.harness.install({ scanId: scan.id, candidateIds: [scan.candidates[0].id] });
        await window.harness.apply({
          skillIds: [scan.candidates[0].id],
          harnessIds: ['universal'],
          scope: 'workspace',
          workspacePath: workspace,
          strategy: 'symlink',
        });
        await window.harness.saveHarness({
          name: 'Compatible Sample',
          kind: 'cli',
          userSkillsPath: '',
          workspaceSkillsRelativePath: '.sample/skills',
          readsUserAgents: true,
          readsWorkspaceAgents: true,
          command: 'harness-test-nonexistent',
          executablePaths: [executable],
          versionArgs: ['--version'],
        });
      },
      { source, workspace, executable },
    );
    await page.getByRole('button', { name: 'Agent Harness', exact: true }).click();
    await page
      .getByRole('tab')
      .filter({ has: page.getByText('Compatible Sample', { exact: true }) })
      .click();
    await page.getByRole('tab', { name: '工作区级', exact: true }).click();
    await expect(page.getByText('继承自 .agents/skills', { exact: true })).toBeVisible();
    await expect(page.getByText('inherited-helper', { exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('harness-inheritance-acceptance.png'), fullPage: true });
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const sampleRow = page.getByTestId('harness-setting-row').filter({ hasText: 'Compatible Sample' });
    await expect(sampleRow.getByText('已安装', { exact: true })).toBeVisible({ timeout: 30000 });
    await expect(sampleRow).toContainText('sample-agent 1.2.3');
    await page.getByRole('button', { name: '编辑 Codex CLI', exact: true }).click();
    await expect(page.getByLabel('识别用户级 ~/.agents/skills', { exact: true })).toBeDisabled();
    await expect(page.getByLabel('用户级技能目录', { exact: true })).toBeDisabled();
    await expect(page.getByLabel('可执行文件路径', { exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await sampleRow.getByRole('button', { name: '编辑 Compatible Sample', exact: true }).click();
    await expect(page.getByLabel('识别工作区 .agents/skills', { exact: true })).toBeEnabled();
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('market catalog loads further remote pages on scroll and updates unique repository and skill counts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hm-market-pages-'));
  let app: ElectronApplication | undefined;
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && !['ELECTRON_RUN_AS_NODE', 'HARNESS_DEV_URL'].includes(entry[0]),
    ),
  );
  try {
    app = await electron.launch({
      args: ['.'],
      env: { ...env, HARNESS_LIBRARY_ROOT: path.join(root, 'library'), HARNESS_PROFILE_ROOT: path.join(root, 'profile') },
    });
    await app.evaluate(() => {
      (globalThis as typeof globalThis & { marketPages?: number[] }).marketPages = [];
      globalThis.fetch = async (input) => {
        const url = new URL(String(input));
        const page = Number(url.pathname.split('/').at(-1));
        (globalThis as typeof globalThis & { marketPages: number[] }).marketPages.push(page);
        const skill = (index: number) => ({
          source: `owner/repo-${index}`,
          skillId: `skill-${index}`,
          name: `skill-${index}`,
          installs: 100 - index,
        });
        const skills = page === 0 ? Array.from({ length: 18 }, (_, index) => skill(index)) : [skill(0), skill(18), skill(19)];
        return new Response(JSON.stringify({ skills, page, total: 20, hasMore: page === 0 }), {
          headers: { 'content-type': 'application/json' },
        });
      };
    });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: 'skills.sh', exact: true }).click();
    const counts = page.getByTestId('marketplace-counts');
    await expect(counts).toHaveAttribute('data-loaded-skills', '18');
    await expect(counts).toHaveAttribute('data-loaded-repositories', '18');
    await page.getByTestId('marketplace-scroll-sentinel').scrollIntoViewIfNeeded();
    await expect(counts).toHaveAttribute('data-loaded-skills', '20');
    await expect(counts).toHaveAttribute('data-loaded-repositories', '20');
    await expect(page.getByTestId('marketplace-source-group')).toHaveCount(20);
    await expect(page.getByText('已到当前榜单末尾', { exact: true })).toBeAttached();
    expect(await app.evaluate(() => (globalThis as typeof globalThis & { marketPages: number[] }).marketPages)).toEqual([0, 1]);
    await counts.scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('marketplace-pagination-acceptance.png'), fullPage: true });
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('residual cleanup presents the exact plan and invokes Trash only after explicit confirmation', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hm-cleanup-ui-')));
  let app: ElectronApplication | undefined;
  const residual = path.join(root, 'unused-agent', 'skills');
  await mkdir(residual, { recursive: true });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && !['ELECTRON_RUN_AS_NODE', 'HARNESS_DEV_URL'].includes(entry[0]),
    ),
  );
  try {
    app = await electron.launch({
      args: ['.'],
      env: { ...env, HARNESS_LIBRARY_ROOT: path.join(root, 'library'), HARNESS_PROFILE_ROOT: path.join(root, 'profile') },
    });
    await app.evaluate(({ shell }) => {
      shell.trashItem = async (value) => {
        (globalThis as typeof globalThis & { testTrashed?: string }).testTrashed = value;
      };
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.harness));
    await page.evaluate(async (residual) => {
      await window.harness.saveHarness({
        name: 'Missing Cleanup Agent',
        kind: 'cli',
        command: 'missing-harness-cleanup-test',
        versionArgs: ['--version'],
        userSkillsPath: residual,
        workspaceSkillsRelativePath: '',
      });
    }, residual);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const row = page.getByTestId('harness-setting-row').filter({ hasText: 'Missing Cleanup Agent' });
    await expect(row.getByText('未检测到安装', { exact: true })).toBeVisible({ timeout: 30000 });
    await row.scrollIntoViewIfNeeded();
    const settingsHeading = page.getByRole('heading', { name: 'Harness 管理', exact: true });
    await expect(settingsHeading).not.toBeInViewport();
    await row.getByRole('button', { name: '预览清理', exact: true }).click();
    const preview = page.getByRole('dialog', { name: '清理残留预览' });
    await expect(preview).toContainText(residual);
    await expect(preview.getByRole('button', { name: '确认移入废纸篓', exact: true })).toBeInViewport();
    await expect(settingsHeading).not.toBeInViewport();
    expect(await app.evaluate(() => (globalThis as typeof globalThis & { testTrashed?: string }).testTrashed)).toBeUndefined();
    await preview.getByRole('button', { name: '取消', exact: true }).click();
    await expect(row.getByRole('button', { name: '预览清理', exact: true })).toBeFocused();
    await row.getByRole('button', { name: '预览清理', exact: true }).click();
    await preview.getByRole('button', { name: '确认移入废纸篓', exact: true }).click();
    await expect(preview).toHaveCount(0);
    expect(await app.evaluate(() => (globalThis as typeof globalThis & { testTrashed?: string }).testTrashed)).toBe(residual);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Harness management switches persist and hide disabled tools without uninstalling skills', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hm-enabled-ui-')));
  let app: ElectronApplication | undefined;
  const source = path.join(root, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: toggle-skill\ndescription: Toggle management\n---\n');
  const target = path.join(root, 'agent-skills');
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && !['ELECTRON_RUN_AS_NODE', 'HARNESS_DEV_URL'].includes(entry[0]),
      ),
    ),
    HARNESS_LIBRARY_ROOT: path.join(root, 'library'),
    HARNESS_PROFILE_ROOT: path.join(root, 'profile'),
  };
  try {
    app = await electron.launch({ args: ['.'], env });
    let page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.harness));
    const harnessId = await page.evaluate(
      async ({ source, target }) => {
        const harness = await window.harness.saveHarness({
          name: 'Toggle Agent',
          userSkillsPath: target,
          workspaceSkillsRelativePath: '.toggle/skills',
          command: 'missing-toggle-agent',
        });
        const scan = await window.harness.scan({ uri: source });
        await window.harness.install({ scanId: scan.id, candidateIds: [scan.candidates[0].id] });
        const skill = (await window.harness.snapshot()).skills[0];
        await window.harness.apply({ skillIds: [skill.id], harnessIds: [harness.id], scope: 'user', strategy: 'symlink' });
        return harness.id;
      },
      { source, target },
    );
    await page.getByRole('button', { name: 'Agent Harness', exact: true }).click();
    await expect(page.getByRole('tab', { name: /Toggle Agent/ })).toBeVisible();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const toggle = page.getByRole('switch', { name: '启用管理 Toggle Agent', exact: true });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect(page.getByTestId('harness-setting-row').filter({ hasText: 'Toggle Agent' }).getByText('未启用管理')).toBeVisible();
    await page.getByRole('button', { name: 'Agent Harness', exact: true }).click();
    await expect(page.getByRole('tab', { name: /Toggle Agent/ })).toHaveCount(0);
    expect((await lstat(path.join(target, 'toggle-skill'))).isSymbolicLink()).toBe(true);
    const disabled = await page.evaluate(async (harnessId) => {
      const snapshot = await window.harness.snapshot();
      return {
        enabled: snapshot.harnesses.find((item) => item.id === harnessId)!.enabled,
        intents: snapshot.intents.length,
        detected: (await window.harness.detectHarnessInstallations()).some((item) => item.harnessId === harnessId),
      };
    }, harnessId);
    expect(disabled).toEqual({ enabled: false, intents: 1, detected: false });
    await app.close();
    app = await electron.launch({ args: ['.'], env });
    page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.harness));
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const restoredToggle = page.getByRole('switch', { name: '启用管理 Toggle Agent', exact: true });
    await expect(restoredToggle).not.toBeChecked();
    await restoredToggle.click();
    await expect(restoredToggle).toBeChecked();
    await page.getByRole('button', { name: 'Agent Harness', exact: true }).click();
    await page.getByRole('tab', { name: /Toggle Agent/ }).click();
    await expect(page.getByText('toggle-skill', { exact: true })).toBeVisible();
    expect((await lstat(path.join(target, 'toggle-skill'))).isSymbolicLink()).toBe(true);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('library checks sources for updates, badges the view menu and applies the selected updates', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hm-updates-ui-')));
  let app: ElectronApplication | undefined;
  const source = path.join(root, 'source');
  const target = path.join(root, 'agent-skills');
  const skill = async (directory: string, name: string, notes: string) => {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} for update acceptance\n---\n`);
    await writeFile(path.join(directory, 'notes.txt'), notes);
  };
  await skill(path.join(source, 'skills/engineering/review'), 'review', 'v1');
  await skill(path.join(source, 'skills/engineering/tests'), 'tests', 'v1');
  await skill(path.join(source, 'skills/design/handoff'), 'handoff', 'v1');
  await skill(path.join(target, 'unmanaged-helper'), 'unmanaged-helper', 'external');
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && !['ELECTRON_RUN_AS_NODE', 'HARNESS_DEV_URL'].includes(entry[0]),
      ),
    ),
    HARNESS_LIBRARY_ROOT: path.join(root, 'library'),
    HARNESS_PROFILE_ROOT: path.join(root, 'profile'),
  };
  try {
    app = await electron.launch({ args: ['.'], env });
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.harness));
    await page.evaluate(
      async ({ source, target }) => {
        const scan = await window.harness.scan({ uri: source });
        await window.harness.install({ scanId: scan.id, candidateIds: scan.candidates.map((item) => item.id) });
        await window.harness.saveHarness({ name: 'Update Agent', userSkillsPath: target, workspaceSkillsRelativePath: '.update/skills' });
      },
      { source, target },
    );

    // External skills belong to the Agent Harness page, not to the central library.
    await page.getByTestId('view-mode-select').click();
    await page.getByRole('menuitemradio', { name: '按 Harness', exact: true }).click();
    await page.getByRole('tab', { name: /Update Agent/ }).click();
    await expect(page.getByText('unmanaged-helper', { exact: true })).toHaveCount(0);
    await expect(page.getByText('外部管理', { exact: true })).toHaveCount(0);

    await skill(path.join(source, 'skills/engineering/review'), 'review', 'v2');
    await skill(path.join(source, 'skills/design/handoff'), 'handoff', 'v2');
    await page.getByTestId('check-updates').click();
    await expect(page.getByText('发现 2 个技能可更新。', { exact: true })).toBeVisible();
    await expect(page.locator('.update-badge')).toHaveText('2');
    await page.getByTestId('view-mode-select').click();
    await page.getByRole('menuitemradio', { name: /可更新/ }).click();
    await expect(page.locator('.update-row')).toHaveCount(2);
    await expect(page.getByRole('checkbox', { name: '选择更新 review', exact: true })).toBeChecked();
    await page.getByRole('checkbox', { name: '选择分组 design', exact: true }).uncheck();
    await expect(page.getByRole('checkbox', { name: '选择更新 handoff', exact: true })).not.toBeChecked();
    await page.screenshot({ path: test.info().outputPath('library-updates-acceptance.png'), fullPage: true, animations: 'disabled' });
    await page.getByTestId('apply-updates').click();
    await page.getByRole('button', { name: '确认更新 1 项', exact: true }).click();
    await expect(page.getByText('更新已完成', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /完成/ }).click();
    await expect(page.locator('.update-row')).toHaveCount(1);
    await expect(page.locator('.update-badge')).toHaveCount(0);

    const snapshot = await page.evaluate(() => window.harness.snapshot());
    const byName = (name: string) => snapshot.skills.find((item) => item.name === name)!;
    expect(await readFile(path.join(byName('review').directory, 'notes.txt'), 'utf8')).toBe('v2');
    expect(await readFile(path.join(byName('handoff').directory, 'notes.txt'), 'utf8')).toBe('v1');
    expect(snapshot.issues).toEqual([]);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
