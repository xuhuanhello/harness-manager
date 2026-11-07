import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import packageJson from '../../package.json' with { type: 'json' };

for (const locale of ['zh-CN', 'en'] as const) {
  // Playwright requires a destructured fixtures argument for test metadata.
  // biome-ignore lint/correctness/noEmptyPattern: This Electron test uses only testInfo.
  test(`app update: local feed, release dialog and persisted settings (${locale})`, async ({}, testInfo) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'hm-app-update-'));
    const asset = Buffer.from('small deterministic update attachment');
    const version = '99.0.0-beta.1';
    const names = [`harness-manager-${version}-mac-arm64.zip`, `harness-manager-${version}-win-x64-setup.exe`];
    let address = '';
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url!);
      expect(req.headers['user-agent']).toBe(`Harness-Manager/${packageJson.version}`);
      if (req.url === '/') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify([
            {
              tag_name: `v${version}`,
              draft: false,
              prerelease: true,
              html_url: `https://github.com/xuhuanhello/harness-manager/releases/tag/v${version}`,
              published_at: '2026-10-01T12:00:00Z',
              body: 'Fixture release notes\n<script>window.injected = true</script>',
              assets: [...names, 'SHA256SUMS.txt'].map((name) => ({
                name,
                size: name.endsWith('.txt') ? 256 : asset.length,
                browser_download_url: `${address}${name}`,
              })),
            },
          ]),
        );
      } else if (req.url === '/SHA256SUMS.txt') {
        res.end(names.map((name) => `${createHash('sha256').update(asset).digest('hex')}  ${name}`).join('\n'));
      } else if (names.some((name) => req.url === `/${name}`)) {
        res.setHeader('content-length', asset.length);
        res.end(asset);
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = server.address();
    if (!endpoint || typeof endpoint === 'string') throw new Error('No test server');
    address = `http://127.0.0.1:${endpoint.port}/`;
    const env: Record<string, string> = Object.fromEntries(
      Object.entries(process.env).filter(
        (pair): pair is [string, string] => typeof pair[1] === 'string' && !['ELECTRON_RUN_AS_NODE', 'HARNESS_DEV_URL'].includes(pair[0]),
      ),
    );
    Object.assign(env, {
      HARNESS_PROFILE_ROOT: path.join(root, 'profile'),
      HARNESS_LIBRARY_ROOT: path.join(root, 'library'),
      HARNESS_SYSTEM_LOCALE: locale,
      HARNESS_UPDATE_FEED_URL: address,
    });
    let app: ElectronApplication | undefined;
    const labels =
      locale === 'en'
        ? {
            settings: 'Settings',
            check: 'Check for app updates',
            version: `New version: v${version}`,
            auto: 'Automatically check for updates',
            later: 'Later',
            download: 'Download update',
            reason: 'This is a development build.',
          }
        : {
            settings: '设置',
            check: '检查应用更新',
            version: `有新版本 v${version}`,
            auto: '自动检查更新',
            later: '稍后',
            download: '下载更新',
            reason: '当前为开发模式',
          };
    try {
      app = await electron.launch({ args: ['.'], env });
      let page = await app.firstWindow();
      await page.locator('.sidebar').getByRole('button', { name: labels.settings, exact: true }).click();
      await page.getByRole('button', { name: labels.check, exact: true }).click();
      const footer = page.locator('.sidebar-footer');
      await expect(footer.getByRole('button', { name: labels.version, exact: true })).toBeVisible();
      await footer.getByRole('button').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText(`v${packageJson.version} → v${version}`);
      await expect(dialog).toContainText('Fixture release notes');
      await expect(dialog).toContainText('<script>window.injected = true</script>');
      await expect(dialog).toContainText(labels.reason);
      await expect(dialog.getByRole('button', { name: labels.download, exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as { injected?: boolean }).injected)).toBeUndefined();
      if (locale === 'en') {
        const text = await dialog.innerText();
        expect(text).not.toMatch(/[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u);
      }
      await page.screenshot({ path: testInfo.outputPath(`app-update-${locale}.png`), animations: 'disabled' });
      await dialog.getByRole('button', { name: labels.later, exact: true }).click();
      await page.getByRole('switch', { name: labels.auto, exact: true }).uncheck();
      await expect.poll(() => page.evaluate(async () => (await window.harness.snapshot()).settings.appUpdates?.autoCheck)).toBe(false);
      await app.close();
      app = await electron.launch({ args: ['.'], env });
      page = await app.firstWindow();
      await page.locator('.sidebar').getByRole('button', { name: labels.settings, exact: true }).click();
      await expect(page.getByRole('switch', { name: labels.auto, exact: true })).not.toBeChecked();
      await page.getByRole('switch', { name: labels.auto, exact: true }).check();
      await expect.poll(() => page.evaluate(async () => (await window.harness.snapshot()).settings.appUpdates?.autoCheck)).toBe(true);
      expect(requests).toEqual(['/']); // Development mode never downloads an installer.
      const status = await page.evaluate(() => window.harness.checkAppUpdate());
      expect(status.status).toBe('unsupported');
    } finally {
      await app?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
}
