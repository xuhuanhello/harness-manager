import { createHash } from 'node:crypto';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppUpdater, type UpdateFiles } from '../src/main/app-updater';
import {
  compareVersions,
  DOWNLOAD_PREFIX,
  parseChecksums,
  parseVersion,
  selectAsset,
  selectRelease,
  updateFeed,
  validReleaseUrl,
  type Release,
} from '../src/main/app-update-release';
import type { AppUpdateState } from '../src/shared/app-update';
import { APP_RELEASES_URL } from '../src/shared/app-update';

const bytes = new TextEncoder().encode('verified update fixture');
const hash = createHash('sha256').update(bytes).digest('hex');
const assetName = 'harness-manager-0.2.0-win-x64-setup.exe';
function release(version = '0.2.0', extra: Partial<Release> = {}): Release {
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: true,
    body: 'Release notes',
    published_at: '2026-01-01T00:00:00Z',
    html_url: `${APP_RELEASES_URL}/tag/v${version}`,
    assets: [
      { name: assetName, size: bytes.length, browser_download_url: `${DOWNLOAD_PREFIX}v0.2.0/${assetName}` },
      { name: 'SHA256SUMS.txt', size: 100, browser_download_url: `${DOWNLOAD_PREFIX}v0.2.0/SHA256SUMS.txt` },
    ],
    ...extra,
  };
}
function memoryFiles() {
  const data = new Map<string, Uint8Array>();
  const removed: string[] = [];
  const files: UpdateFiles = {
    list: async (directory) => [
      ...new Set(
        [...data.keys()].filter((name) => name.startsWith(`${directory}/`)).map((name) => name.slice(directory.length + 1).split('/')[0]),
      ),
    ],
    mkdir: async () => {},
    read: async (name) => {
      const value = data.get(name);
      if (!value) throw new Error('ENOENT');
      return value;
    },
    write: async (name, text) => {
      data.set(name, new TextEncoder().encode(text));
    },
    hash: async (name) =>
      createHash('sha256')
        .update(await files.read(name))
        .digest('hex'),
    remove: async (name) => {
      removed.push(name);
      for (const key of data.keys()) if (key === name || key.startsWith(`${name}${path.sep}`)) data.delete(key);
    },
    sink: async (name) => {
      const chunks: Uint8Array[] = [];
      return {
        write: async (chunk) => {
          chunks.push(chunk);
        },
        close: async () => {
          data.set(name, Buffer.concat(chunks));
        },
      };
    },
  };
  return { files, data, removed };
}
function setup(overrides: Partial<ConstructorParameters<typeof AppUpdater>[0]> = {}, checksum = hash) {
  const disk = memoryFiles();
  const states: AppUpdateState[] = [];
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).includes('api.github.com')) return Response.json([release()]);
    if (String(url).endsWith('SHA256SUMS.txt')) return new Response(`${checksum}  ${assetName}\n`);
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  };
  const install = vi.fn(async () => {});
  const quit = vi.fn();
  const openExternal = vi.fn(async () => {});
  const app = new AppUpdater({
    version: '0.1.3',
    platform: 'win32',
    arch: 'x64',
    isPackaged: true,
    userData: '/profile',
    files: disk.files,
    fetch: fetcher,
    install,
    quit,
    openExternal,
    changed: (state) => states.push(state),
    ...overrides,
  });
  return { app, ...disk, states, requests, install, quit, openExternal };
}
afterEach(() => vi.useRealTimers());

describe('release and version selection', () => {
  it('implements semver including numeric prereleases, metadata and invalid inputs', () => {
    const versions = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.1.0',
      '2.0.0',
    ];
    for (let i = 1; i < versions.length; i++) {
      expect(compareVersions(versions[i - 1], versions[i])).toBeLessThan(0);
      expect(compareVersions(versions[i], versions[i - 1])).toBeGreaterThan(0);
    }
    expect(compareVersions('v1.0.0+foo', '1.0.0+bar')).toBe(0);
    for (const version of ['1.0', '01.0.0', '1.0.0-01', '../2.0.0', '1.0.0-', '1.0.0\n']) expect(parseVersion(version)).toBeNull();
    expect(() => compareVersions('invalid', '1.0.0')).toThrow();
  });
  it('ignores drafts and includes previews only for 0.x or preview clients', () => {
    const releases = [
      release('1.1.0', { prerelease: false }),
      release('2.0.0-beta.1'),
      release('3.0.0', { draft: true }),
      release('not-semver'),
    ];
    expect(selectRelease(releases, '0.1.0')?.tag_name).toBe('v2.0.0-beta.1');
    expect(selectRelease(releases, '1.0.0')?.tag_name).toBe('v1.1.0');
    expect(selectRelease(releases, '1.0.0-rc.1')?.tag_name).toBe('v2.0.0-beta.1');
    expect(selectRelease(releases, '4.0.0')).toBeUndefined();
  });
  it('selects supported assets and refuses invalid sizes, ambiguous names and untrusted URLs', () => {
    expect(selectAsset(release(), 'win32', 'x64')?.name).toBe(assetName);
    const mac = 'harness-manager-0.2.0-mac-arm64.zip';
    expect(
      selectAsset(
        release('0.2.0', { assets: [{ name: mac, size: 10, browser_download_url: `${DOWNLOAD_PREFIX}v0.2.0/${mac}` }] }),
        'darwin',
        'arm64',
      )?.name,
    ).toBe(mac);
    for (const [platform, arch] of [
      ['linux', 'x64'],
      ['darwin', 'x64'],
      ['win32', 'arm64'],
    ])
      expect(selectAsset(release(), platform, arch)).toBeUndefined();
    for (const url of [
      'https://evil.example/file',
      `${DOWNLOAD_PREFIX}../../evil`,
      'http://github.com/xuhuanhello/harness-manager/releases/download/v2/a',
    ])
      expect(
        selectAsset(release('0.2.0', { assets: [{ name: assetName, size: 10, browser_download_url: url }] }), 'win32', 'x64'),
      ).toBeUndefined();
    expect(selectAsset(release('0.2.0', { assets: [release().assets[0], release().assets[0]] }), 'win32', 'x64')).toBeUndefined();
    expect(selectAsset(release('0.2.0', { assets: [{ ...release().assets[0], size: 1024 ** 3 + 1 }] }), 'win32', 'x64')).toBeUndefined();
  });
  it('accepts only loopback overrides and specified repository release pages', () => {
    expect(updateFeed('http://127.0.0.1:4321/').prefix).toBe('http://127.0.0.1:4321/');
    expect(updateFeed('http://127.0.0.1:80/').prefix).toBe('http://127.0.0.1/');
    for (const url of [
      'http://localhost:1234/',
      'https://127.0.0.1:1234/',
      'http://127.0.0.1:0/',
      'http://127.0.0.1:99999/',
      'http://127.0.0.1:1234/path',
      'http://127.0.0.1:1234/?x=1',
    ])
      expect(() => updateFeed(url)).toThrow();
    expect(validReleaseUrl(APP_RELEASES_URL)).toBe(true);
    expect(validReleaseUrl(`${APP_RELEASES_URL}/tag/v0.2.0`)).toBe(true);
    for (const url of [
      `${APP_RELEASES_URL}.evil/`,
      `${APP_RELEASES_URL}/../issues`,
      `${APP_RELEASES_URL}/tag/v1?x=1`,
      'https://github.com/other/repo/releases',
    ])
      expect(validReleaseUrl(url)).toBe(false);
  });
  it('parses GNU checksum formats and rejects malformed or duplicate entries', () => {
    expect(parseChecksums(`${hash}  one.zip\r\n${hash.toUpperCase()} *two.exe\n`).get('two.exe')).toBe(hash);
    for (const value of ['', `${hash}  ../one.zip`, `${hash}  one.zip\n${hash}  one.zip`, 'wrong  one.zip'])
      expect(() => parseChecksums(value)).toThrow();
  });
});

describe('updater state machine with fake network and filesystem', () => {
  it('checks, streams, verifies and installs only once', async () => {
    const { app, states, data, requests, install, quit } = setup();
    expect((await app.check()).status).toBe('available');
    const lastCheckedAt = app.getState().lastCheckedAt;
    expect((await app.download()).status).toBe('downloaded');
    expect([...data.values()][0]).toEqual(Buffer.from(bytes));
    expect(requests[0].init?.headers).toEqual({ 'User-Agent': 'Harness-Manager/0.1.3', Accept: 'application/vnd.github+json' });
    await Promise.all([app.install(), app.install()]);
    expect(install).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(states.map((state) => state.status)).toEqual([
      'checking',
      'available',
      'downloading',
      'downloading',
      'downloaded',
      'installing',
    ]);
    expect(app.getState().lastCheckedAt).toBe(lastCheckedAt);
  });
  it.each([
    { isPackaged: false },
    { env: { PORTABLE_EXECUTABLE_FILE: 'portable.exe' } },
    { env: { PORTABLE_EXECUTABLE_DIR: '/portable' } },
    { platform: 'linux' },
    { arch: 'arm64' },
    { platform: 'darwin', arch: 'arm64', locationReason: async () => 'Read-only location' },
  ])('shows release details but cannot download on unsupported installations: %j', async (options) => {
    const { app, requests, install } = setup(options);
    expect(await app.check()).toMatchObject({ status: 'unsupported', version: '0.2.0', release: { notes: 'Release notes' } });
    await app.download();
    await app.install();
    expect(requests).toHaveLength(1);
    expect(install).not.toHaveBeenCalled();
  });
  it('deletes corrupt downloads and rejects a verified file changed before install', async () => {
    const { app, data } = setup({}, '0'.repeat(64));
    await app.check();
    expect(await app.download()).toMatchObject({ status: 'error', retryable: true });
    expect(data.size).toBe(0);
    const good = setup();
    await good.app.check();
    await good.app.download();
    good.data.set([...good.data.keys()][0], new Uint8Array([0]));
    expect((await good.app.install()).status).toBe('error');
    expect(good.install).not.toHaveBeenCalled();
    expect(good.data.size).toBe(0);
  });
  it('throttles streamed byte progress and rejects oversized or truncated bodies', async () => {
    for (const length of [bytes.length, bytes.length + 1, bytes.length - 1]) {
      let now = 1000;
      let offset = 0;
      const times: number[] = [];
      const fetcher: typeof fetch = async (url) => {
        if (String(url).includes('api.github.com')) return Response.json([release()]);
        if (String(url).endsWith('.txt')) return new Response(`${hash}  ${assetName}\n`);
        return new Response(
          new ReadableStream({
            pull(controller) {
              now += 10;
              if (offset < length) controller.enqueue(new Uint8Array([bytes[offset++] ?? 0]));
              else controller.close();
            },
          }),
        );
      };
      const { app, data } = setup({
        fetch: fetcher,
        now: () => now,
        changed: (state) => {
          if (state.status === 'downloading' && state.received > 0) times.push(now);
        },
      });
      await app.check();
      expect((await app.download()).status).toBe(length === bytes.length ? 'downloaded' : 'error');
      for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(100);
      if (length !== bytes.length) expect(data.size).toBe(0);
    }
  });

  it('cancels an in-flight download, deletes partial data and returns to available', async () => {
    const disk = memoryFiles();
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).includes('api.github.com')) return Response.json([release()]);
      if (String(url).endsWith('.txt')) return new Response(`${hash}  ${assetName}\n`);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(bytes.slice(0, 4));
            init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
          },
        }),
      );
    };
    const { app, states } = setup({ fetch: fetcher, files: disk.files });
    await app.check();
    const download = app.download();
    await vi.waitFor(() => expect(states.some((state) => state.status === 'downloading' && state.received > 0)).toBe(true));
    await app.cancel();
    await download;
    expect(app.getState().status).toBe('available');
    expect(disk.data.size).toBe(0);
  });
  it.each([403, 429, 500])('reports HTTP %i as a retryable failure', async (status) => {
    const { app } = setup({ fetch: async () => new Response('', { status }) });
    expect(await app.check()).toMatchObject({ status: 'error', retryable: true, lastCheckedAt: expect.any(String) });
  });
  it('handles no updates, filesystem failures, redirects and local prefix mismatches', async () => {
    const none = setup({ fetch: async () => Response.json([]) });
    expect((await none.app.check()).status).toBe('upToDate');
    const disk = memoryFiles();
    disk.files.sink = async () => {
      throw new Error('disk full');
    };
    const full = setup({ files: disk.files });
    await full.app.check();
    expect((await full.app.download()).status).toBe('error');
    const redirect = setup({ fetch: async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/file' } }) });
    expect((await redirect.app.check()).status).toBe('error');
    const local = setup({ env: { HARNESS_UPDATE_FEED_URL: 'http://127.0.0.1:3210/' }, fetch: async () => Response.json([release()]) });
    expect((await local.app.check()).status).toBe('unsupported');
  });
  it('restores permission errors, restricts links and cleans matching installed versions', async () => {
    const test = setup({ platform: 'darwin' });
    await test.files.write(
      '/profile/updates/last-result.json',
      JSON.stringify({ success: false, permissionRequired: true, version: '0.2.0' }),
    );
    await test.app.initialize();
    expect(test.app.getState()).toMatchObject({ status: 'error', permissionRequired: true });
    await test.app.openManagement();
    expect(test.openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles');
    await expect(test.app.openPage('https://evil.example')).rejects.toThrow();
    await test.app.openPage();
    expect(test.openExternal).toHaveBeenCalledWith(APP_RELEASES_URL);
    const good = setup();
    await good.files.write('/profile/updates/last-result.json', JSON.stringify({ success: true, version: '0.1.3' }));
    await good.files.write('/profile/updates/0.1.3/old.zip', 'old');
    await good.app.initialize();
    expect(good.data.size).toBe(0);
  });
  it('checks after 15 seconds and every six hours and disables scheduled checks', async () => {
    vi.useFakeTimers();
    const { app, requests } = setup();
    app.setAutoCheck(true);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(requests).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000 - 15_000);
    expect(requests).toHaveLength(2);
    app.setAutoCheck(false);
    await vi.advanceTimersByTimeAsync(12 * 60 * 60_000);
    expect(requests).toHaveLength(2);
    app.close();
  });
});
