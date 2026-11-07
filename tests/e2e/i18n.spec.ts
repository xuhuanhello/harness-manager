import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('switches language immediately, keeps English after restart, and returns to system language', async () => {
  const testInfo = test.info();
  const root = await mkdtemp(path.join(os.tmpdir(), 'hm-i18n-e2e-'));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => value !== undefined && !['ELECTRON_RUN_AS_NODE', 'HARNESS_DEV_URL'].includes(key)),
  ) as Record<string, string>;
  Object.assign(env, {
    HARNESS_LIBRARY_ROOT: path.join(root, 'library'),
    HARNESS_PROFILE_ROOT: path.join(root, 'profile'),
    HARNESS_SYSTEM_LOCALE: 'zh-CN',
  });
  let app: ElectronApplication | undefined;
  try {
    const source = path.join(root, 'source');
    for (const name of ['alpha-helper', 'beta-helper']) {
      await mkdir(path.join(source, name), { recursive: true });
      await writeFile(
        path.join(source, name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: External description stays unchanged\n---\n# ${name}\n`,
      );
    }
    app = await electron.launch({ args: ['.'], env });
    let page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '中央技能库', exact: true })).toBeVisible();
    await page.evaluate(
      async ({ source, userPath }) => {
        const scan = await window.harness.scan({ uri: source });
        await window.harness.install({ scanId: scan.id, candidateIds: scan.candidates.map((candidate) => candidate.id) });
        const harness = await window.harness.saveHarness({
          name: 'Localization Agent',
          userSkillsPath: userPath,
          workspaceSkillsRelativePath: '',
          kind: 'cli',
          icon: 'L',
          readsUserAgents: false,
          readsWorkspaceAgents: false,
          extraUserSkillsPaths: [],
          extraWorkspaceSkillsRelativePaths: [],
          command: '',
          versionArgs: [],
          executablePaths: [],
          appPaths: [],
        });
        const snapshot = await window.harness.snapshot();
        for (const item of snapshot.harnesses)
          if (item.id !== harness.id && item.enabled) await window.harness.setHarnessEnabled({ harnessId: item.id, enabled: false });
        await window.harness.apply({
          skillIds: snapshot.skills.map((skill) => skill.id),
          harnessIds: [harness.id],
          scope: 'user',
          strategy: 'symlink',
        });
        await window.harness.saveSettings({ viewMode: 'harness', activeTabs: { harness: harness.id } });
        await window.harness.saveMarketplace({ name: 'Example Market', url: 'https://example.com/skills' });
      },
      { source, userPath: path.join(root, 'agent-skills') },
    );
    await page.locator('.sidebar').getByRole('button', { name: '设置', exact: true }).click();
    const language = page.getByTestId('language-select');
    await expect(language).toHaveValue('system');
    await language.selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    expect(await page.evaluate(() => window.harness.deleteMarketplace('skills-sh').catch((error: Error) => error.message))).toBe(
      'Built-in marketplaces cannot be deleted.',
    );
    await expect(page.locator('.sidebar').getByRole('button', { name: /^Skill Library/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('english-settings.png'), fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: 'Delete Example Market', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Delete marketplace source');
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('english-confirmation.png'), fullPage: true, animations: 'disabled' });
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await page
      .locator('.sidebar')
      .getByRole('button', { name: /^Skill Library/ })
      .click();
    await expect(page.getByRole('button', { name: 'Add source', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check updates', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Skill Library/ })).toBeVisible();
    await expect(page.getByText('External description stays unchanged').first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('english-library-harness.png'), fullPage: true, animations: 'disabled' });
    await page.locator('.sidebar').getByRole('button', { name: 'Agent Harness', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Agent Harness', exact: true })).toBeVisible();
    await expect(page.getByText('Library managed', { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('english-agent-harness.png'), fullPage: true, animations: 'disabled' });
    await app.close();
    app = await electron.launch({ args: ['.'], env });
    page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: /^Skill Library/ })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.locator('.sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByTestId('language-select')).toHaveValue('en');
    await page.getByTestId('language-select').selectOption('system');
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect.poll(() => page.evaluate(async () => (await window.harness.snapshot()).settings.locale)).toBe('system');
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

// Exercise actual navigation and collect both visible and accessibility copy.
test('English screens contain no CJK copy or punctuation across every library view and management page', async () => {
  const testInfo = test.info();
  const root = await mkdtemp(path.join(os.tmpdir(), 'hm-english-scan-'));
  const source = path.join(root, 'source');
  const target = path.join(root, 'agent-skills');
  const extraTarget = path.join(root, 'extra-skills');
  const workspace = path.join(root, 'project');
  const fixtureDescription = '用户填写的技能描述';
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => value !== undefined && !['ELECTRON_RUN_AS_NODE', 'HARNESS_DEV_URL'].includes(key)),
  ) as Record<string, string>;
  Object.assign(env, {
    HARNESS_LIBRARY_ROOT: path.join(root, 'library'),
    HARNESS_PROFILE_ROOT: path.join(root, 'profile'),
    HARNESS_SYSTEM_LOCALE: 'zh-CN',
  });
  let app: ElectronApplication | undefined;
  const scans: { stage: string; body: string; attributes: string[] }[] = [];
  try {
    for (const name of ['alpha-helper', 'beta-helper']) {
      await mkdir(path.join(source, name), { recursive: true });
      await writeFile(path.join(source, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${fixtureDescription}\n---\n# ${name}\n`);
    }
    await mkdir(path.join(target, 'external-helper'), { recursive: true });
    await mkdir(extraTarget);
    await mkdir(workspace);
    await writeFile(path.join(target, 'external-helper', 'SKILL.md'), '---\nname: external-helper\ndescription: External fixture\n---\n');
    app = await electron.launch({ args: ['.'], env });
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: '中央技能库', exact: true })).toBeVisible();
    await page.evaluate(
      async ({ source, target, extraTarget, workspace }) => {
        const scan = await window.harness.scan({ uri: source });
        await window.harness.install({ scanId: scan.id, candidateIds: scan.candidates.map((candidate) => candidate.id) });
        const harness = await window.harness.saveHarness({
          name: 'Review Agent',
          userSkillsPath: target,
          extraUserSkillsPaths: [extraTarget],
          workspaceSkillsRelativePath: '.review/skills',
        });
        const snapshot = await window.harness.snapshot();
        for (const item of snapshot.harnesses)
          if (item.id !== harness.id && item.enabled) await window.harness.setHarnessEnabled({ harnessId: item.id, enabled: false });
        const skillIds = snapshot.skills.map((skill) => skill.id);
        await window.harness.saveGroup({ name: 'Review group', skillIds });
        await window.harness.apply({ skillIds, harnessIds: [harness.id], scope: 'user', strategy: 'symlink' });
        await window.harness.apply({
          skillIds,
          harnessIds: [harness.id],
          scope: 'workspace',
          workspacePath: workspace,
          strategy: 'symlink',
        });
      },
      { source, target, extraTarget, workspace },
    );

    const sidebar = page.locator('.sidebar');
    await sidebar.getByRole('button', { name: '设置', exact: true }).click();
    const fontSizes = () =>
      page
        .locator('.harness-setting-row, [data-testid="harness-setting-row"]')
        .first()
        .evaluate((row) => {
          const size = (selector: string) => getComputedStyle(row.querySelector(selector)!).fontSize;
          return {
            rules: size('.harness-read-rules'),
            paths: size('.harness-paths span'),
            toggle: size('.harness-enable-switch'),
            edit: size('.button.compact'),
          };
        });
    const chineseSizes = await fontSizes();
    await page.getByTestId('language-select').selectOption('en');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    const englishSizes = await fontSizes();
    expect(englishSizes).toEqual(chineseSizes);
    expect(englishSizes.rules).toBe(englishSizes.paths);
    expect(englishSizes.toggle).toBe(englishSizes.edit);
    await expect(page.locator('.harness-read-rules').first()).toContainText('Shared .agents/skills — user:');

    const scanCopy = async (stage: string) => {
      const copy = await page.evaluate(() => ({
        body: document.body.innerText,
        attributes: Array.from(document.querySelectorAll('[aria-label], [title], [placeholder]')).flatMap((element) =>
          ['aria-label', 'title', 'placeholder']
            .map((attribute) => element.getAttribute(attribute))
            .filter((value): value is string => value !== null),
        ),
      }));
      scans.push({ stage, ...copy });
      const allowed = ['简体中文', fixtureDescription];
      const normalized = [copy.body, ...copy.attributes].map((value) => allowed.reduce((text, item) => text.replaceAll(item, ''), value));
      for (const value of normalized) {
        expect(value, `${stage}: unexpected CJK text or punctuation`).not.toMatch(
          /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef\u201c\u201d]/u,
        );
        expect(value, `${stage}: singular count uses a plural noun`).not.toMatch(
          /\b1 (?:items|skills|destinations|sources|groups|installations|repositories|updates|copies|references)\b/,
        );
      }
    };
    await scanCopy('settings');
    await page
      .getByRole('heading', { name: 'Harness management', exact: true })
      .evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: testInfo.outputPath('english-harness-settings-fixed.png'), animations: 'disabled' });

    await sidebar.getByRole('button', { name: /^Skill Library/ }).click();
    for (const label of ['By source', 'By Harness', 'By group', 'All skills']) {
      await page.getByTestId('view-mode-select').click();
      await page.getByRole('menuitemradio', { name: label, exact: true }).click();
      await expect(page.getByTestId('view-mode-select')).toContainText(label);
      if (label === 'By Harness') await page.getByRole('tab', { name: /Review Agent/ }).click();
      await expect(page.getByText('alpha-helper', { exact: true }).first()).toBeVisible();
      await scanCopy(`library: ${label}`);
    }
    await page.getByTestId('view-mode-select').click();
    await page.getByRole('menuitemradio', { name: 'By Harness', exact: true }).click();
    await page.getByRole('tab', { name: /Review Agent/ }).click();
    await page.getByTestId('start-selection').click();
    await page.getByRole('checkbox', { name: 'Select alpha-helper', exact: true }).check();
    await expect(page.locator('.selection-hint')).toContainText('Selected 1 item. Select a section');
    await scanCopy('single selection');
    await page.getByRole('checkbox', { name: 'Select beta-helper', exact: true }).check();
    await expect(page.locator('.selection-hint')).toContainText('Selected 2 items. Select a section');
    await scanCopy('multiple selection');
    await page.screenshot({ path: testInfo.outputPath('english-selection-fixed.png'), animations: 'disabled' });
    await page.getByTestId('unapply-selection').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Unapply 2 skills from Review Agent', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Unapply 2 skills', exact: true })).toBeVisible();
    await scanCopy('unapply confirmation');
    await page.screenshot({ path: testInfo.outputPath('english-unapply-fixed.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: 'Back', exact: true }).click();

    await sidebar.getByRole('button', { name: 'Agent Harness', exact: true }).click();
    await expect(page.getByText('external-helper', { exact: true })).toBeVisible();
    const external = page
      .locator('.effective-section')
      .filter({ has: page.locator('.section-heading > strong', { hasText: /^External skills$/ }) });
    await expect(external.locator('.section-count')).toHaveText('1 item');
    await scanCopy('Agent Harness');

    await sidebar.getByRole('button', { name: /^Workspaces/ }).click();
    await scanCopy('workspace list');
    await page.locator('.workspace-card').filter({ hasText: 'project' }).click();
    await expect(page.getByText('alpha-helper', { exact: true }).first()).toBeVisible();
    await scanCopy('workspace detail');

    // Local deterministic catalog data also exercises repository and installation counts.
    await app.evaluate(() => {
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            skills: [{ source: 'fixture/repository', skillId: 'fixture-skill', name: 'fixture-skill', installs: 1 }],
            page: 0,
            total: 1,
            hasMore: false,
          }),
          { headers: { 'content-type': 'application/json' } },
        );
    });
    await sidebar.getByRole('button', { name: 'skills.sh', exact: true }).click();
    await expect(page.getByTestId('marketplace-counts')).toContainText('1 repository');
    await scanCopy('marketplace');
    await writeFile(testInfo.outputPath('english-copy-scan.json'), JSON.stringify(scans, null, 2));
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
