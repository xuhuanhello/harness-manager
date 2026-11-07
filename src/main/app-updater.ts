import { appError } from './messages';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppRelease, AppUpdateState } from '../shared/app-update';
import { APP_RELEASES_URL } from '../shared/app-update';
import { AppError } from '../shared/errors';
import { t } from '../shared/i18n';
import {
  MAX_UPDATE_BYTES,
  compareVersions,
  parseChecksums,
  parseVersion,
  selectAsset,
  selectRelease,
  updateFeed,
  validAssetUrl,
  validReleaseUrl,
  type Release,
  type ReleaseAsset,
} from './app-update-release';

export interface UpdateFiles {
  list(directory: string): Promise<string[]>;
  mkdir(directory: string): Promise<void>;
  remove(file: string): Promise<void>;
  read(file: string): Promise<Uint8Array>;
  write(file: string, text: string): Promise<void>;
  hash(file: string): Promise<string>;
  sink(file: string): Promise<{ write(bytes: Uint8Array): Promise<void>; close(): Promise<void> }>;
}

export const updateFiles: UpdateFiles = {
  list: (directory) => readdir(directory),
  mkdir: async (directory) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  },
  remove: async (file) => {
    await rm(file, { recursive: true, force: true });
  },
  read: (file) => readFile(file),
  write: (file, text) => writeFile(file, text, { mode: 0o600 }),
  hash: async (file) => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
  },
  sink: async (file) => {
    const handle = await open(file, 'wx', 0o600);
    return {
      write: async (bytes) => {
        let offset = 0;
        while (offset < bytes.length) offset += (await handle.write(bytes, offset, bytes.length - offset)).bytesWritten;
      },
      close: () => handle.close(),
    };
  },
};

interface UpdaterOptions {
  version: string;
  platform: string;
  arch: string;
  isPackaged: boolean;
  userData: string;
  env?: NodeJS.ProcessEnv;
  fetch: typeof globalThis.fetch;
  files?: UpdateFiles;
  locationReason?: () => Promise<string | undefined>;
  install: (file: string, version: string) => Promise<void>;
  quit: () => void;
  openExternal: (url: string) => Promise<void>;
  changed?: (state: AppUpdateState) => void;
  now?: () => number;
}

export class AppUpdater {
  private state: AppUpdateState = { status: 'idle' };
  private selected?: { release: Release; info: AppRelease; asset?: ReleaseAsset };
  private downloaded?: { file: string; hash: string };
  private abort?: AbortController;
  private operation?: Promise<AppUpdateState>;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private intervalTimer?: ReturnType<typeof setInterval>;
  private closed = false;
  private files: UpdateFiles;
  private feed: ReturnType<typeof updateFeed>;
  private now: () => number;
  readonly updatesRoot: string;

  constructor(private options: UpdaterOptions) {
    this.files = options.files ?? updateFiles;
    this.feed = updateFeed(options.env?.HARNESS_UPDATE_FEED_URL);
    this.now = options.now ?? Date.now;
    this.updatesRoot = path.join(options.userData, 'updates');
  }

  getState(): AppUpdateState {
    return structuredClone(this.state);
  }

  private setState(state: AppUpdateState) {
    this.state = { lastCheckedAt: this.state.lastCheckedAt, ...state };
    if (!this.closed) this.options.changed?.(this.getState());
    return this.getState();
  }

  private failure(error: unknown, installing = false) {
    return this.setState({
      status: 'error',
      message: error instanceof AppError ? error.message : t(installing ? 'appUpdate.installFailed' : 'appUpdate.requestFailed'),
      retryable: true,
    });
  }

  async unsupportedReason(): Promise<string | undefined> {
    if (!this.options.isPackaged) return t('appUpdate.developmentMode');
    if (this.options.platform === 'win32' && (this.options.env?.PORTABLE_EXECUTABLE_FILE || this.options.env?.PORTABLE_EXECUTABLE_DIR))
      return t('appUpdate.portableMode');
    if (
      !(this.options.platform === 'darwin' && this.options.arch === 'arm64') &&
      !(this.options.platform === 'win32' && this.options.arch === 'x64')
    )
      return t('appUpdate.unsupportedPlatform');
    return this.options.platform === 'darwin' ? this.options.locationReason?.() : undefined;
  }

  private async showSelected(): Promise<AppUpdateState> {
    if (!this.selected) return this.setState({ status: 'idle' });
    const reason = (await this.unsupportedReason()) ?? (!this.selected.asset ? t('appUpdate.missingAsset') : undefined);
    return reason
      ? this.setState({ status: 'unsupported', reason, ...this.selected.info, release: this.selected.info })
      : this.setState({ status: 'available', ...this.selected.info });
  }

  check(): Promise<AppUpdateState> {
    if (this.operation) return this.operation;
    if (this.state.status === 'downloaded' || this.state.status === 'installing') return Promise.resolve(this.getState());
    this.operation = this.performCheck().finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }

  private async performCheck() {
    this.setState({ status: 'checking' });
    this.abort = new AbortController();
    try {
      const response = await this.request(this.feed.url, AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]));
      const body = await this.readLimited(response, 2 * 1024 * 1024);
      const release = selectRelease(JSON.parse(new TextDecoder().decode(body)), this.options.version);
      this.state.lastCheckedAt = new Date(this.now()).toISOString();
      if (!release) {
        this.selected = undefined;
        return this.setState({ status: 'upToDate' });
      }
      const asset = selectAsset(release, this.options.platform, this.options.arch, this.feed.prefix);
      const version = release.tag_name.replace(/^v/, '');
      this.selected = {
        release,
        asset,
        info: {
          version,
          notes: (release.body ?? '').slice(0, 64 * 1024),
          publishedAt: release.published_at && Number.isFinite(Date.parse(release.published_at)) ? release.published_at : '',
          size: asset?.size ?? 0,
          releaseUrl: validReleaseUrl(release.html_url)
            ? release.html_url
            : `${APP_RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}`,
        },
      };
      return await this.showSelected();
    } catch (error) {
      this.state.lastCheckedAt = new Date(this.now()).toISOString();
      return this.failure(error);
    } finally {
      this.abort = undefined;
    }
  }

  download(): Promise<AppUpdateState> {
    if (this.operation) return this.operation;
    if (this.state.status === 'downloaded' || this.state.status === 'installing') return Promise.resolve(this.getState());
    this.operation = this.performDownload().finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }

  private async performDownload(): Promise<AppUpdateState> {
    if (!this.selected) return this.getState();
    if ((await this.unsupportedReason()) || !this.selected.asset) return this.showSelected();
    const { release, asset, info } = this.selected;
    const controller = new AbortController();
    this.abort = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60_000)]);
    const directory = path.join(this.updatesRoot, info.version);
    const file = path.join(directory, asset.name);
    this.setState({ status: 'downloading', version: info.version, received: 0, total: asset.size });
    try {
      const checksums = release.assets.filter((entry) => entry.name === 'SHA256SUMS.txt');
      if (checksums.length !== 1 || !validAssetUrl(checksums[0].browser_download_url, this.feed.prefix))
        throw appError('APP_UPDATE_INVALID_CHECKSUMS');
      const checksumResponse = await this.request(checksums[0].browser_download_url, signal);
      const expected = parseChecksums(new TextDecoder().decode(await this.readLimited(checksumResponse, 128 * 1024))).get(asset.name);
      if (!expected) throw appError('APP_UPDATE_INVALID_CHECKSUMS');
      await this.files.remove(directory);
      await this.files.mkdir(directory);
      const response = await this.request(asset.browser_download_url, signal);
      const declaredSize = Number(response.headers.get('content-length'));
      if (declaredSize > MAX_UPDATE_BYTES || (declaredSize && declaredSize !== asset.size)) throw appError('APP_UPDATE_INVALID_SIZE');
      if (!response.body) throw appError('APP_UPDATE_REQUEST_FAILED');
      const sink = await this.files.sink(file);
      const reader = response.body.getReader();
      const digest = createHash('sha256');
      let received = 0;
      let lastProgress = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          if (received > MAX_UPDATE_BYTES || received > asset.size) throw appError('APP_UPDATE_INVALID_SIZE');
          digest.update(value);
          await sink.write(value);
          if (this.now() - lastProgress >= 100) {
            this.setState({ status: 'downloading', version: info.version, received, total: asset.size });
            lastProgress = this.now();
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        await sink.close();
      }
      signal.throwIfAborted();
      if (received !== asset.size) throw appError('APP_UPDATE_INVALID_SIZE');
      if (digest.digest('hex') !== expected) throw appError('APP_UPDATE_CHECKSUM_MISMATCH');
      this.downloaded = { file, hash: expected };
      return this.setState({ status: 'downloaded', version: info.version });
    } catch (error) {
      const cancelled = controller.signal.aborted;
      controller.abort();
      await this.files.remove(directory).catch(() => {});
      this.downloaded = undefined;
      return cancelled ? this.showSelected() : this.failure(error);
    } finally {
      this.abort = undefined;
    }
  }

  async cancel(): Promise<AppUpdateState> {
    if (this.state.status === 'downloading') this.abort?.abort();
    return this.operation ?? this.getState();
  }

  async install(): Promise<AppUpdateState> {
    if (this.state.status !== 'downloaded' || !this.downloaded || !this.selected) return this.getState();
    const { file, hash } = this.downloaded;
    this.setState({ status: 'installing' });
    try {
      const reason = await this.unsupportedReason();
      if (reason) return this.setState({ status: 'unsupported', reason, ...this.selected.info, release: this.selected.info });
      if ((await this.files.hash(file)) !== hash) {
        await this.files.remove(file);
        throw appError('APP_UPDATE_CHECKSUM_MISMATCH');
      }
      await this.options.install(file, this.selected.info.version);
      this.options.quit();
      return this.getState();
    } catch (error) {
      return this.failure(error, true);
    }
  }

  async openPage(url = APP_RELEASES_URL): Promise<void> {
    if (!validReleaseUrl(url)) throw appError('APP_UPDATE_INVALID_RELEASE_URL');
    await this.options.openExternal(url);
  }

  async openManagement(): Promise<void> {
    if (this.options.platform !== 'darwin' || this.state.status !== 'error' || !this.state.permissionRequired) return;
    await this.options.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles');
  }

  async initialize() {
    const resultPath = path.join(this.updatesRoot, 'last-result.json');
    try {
      const raw = await this.files.read(resultPath);
      if (raw.byteLength > 32 * 1024) return;
      const result = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
      if (result.success === true && result.version === this.options.version && parseVersion(this.options.version))
        await this.cleanInstalledDownloads();
      else if (result.success === false)
        this.setState({
          status: 'error',
          retryable: true,
          permissionRequired: result.permissionRequired === true,
          message: result.permissionRequired === true ? t('appUpdate.appManagementRequired') : t('appUpdate.installFailed'),
        });
      await this.files.remove(resultPath);
    } catch {
      /* No completed helper result on ordinary startup. */
    }
    // Windows' installer cannot write our helper result; clean only older, valid version directories.
    // A marker written just before launching the installer is consumed by the new version.
    try {
      const marker = new TextDecoder().decode(await this.files.read(path.join(this.updatesRoot, 'pending-version')));
      if (marker === this.options.version && parseVersion(marker)) {
        await this.cleanInstalledDownloads();
        await this.files.remove(path.join(this.updatesRoot, 'pending-version'));
      }
    } catch {
      /* No pending install. */
    }
  }

  private async cleanInstalledDownloads() {
    for (const name of await this.files.list(this.updatesRoot)) {
      if (parseVersion(name) && compareVersions(name, this.options.version) <= 0)
        await this.files.remove(path.join(this.updatesRoot, name));
    }
  }

  setAutoCheck(enabled: boolean) {
    clearTimeout(this.startupTimer);
    clearInterval(this.intervalTimer);
    if (!enabled || this.closed) return;
    const check = () => {
      if (this.state.status !== 'error' || !this.state.permissionRequired) void this.check();
    };
    this.startupTimer = setTimeout(check, 15_000);
    this.intervalTimer = setInterval(check, 6 * 60 * 60_000);
    this.startupTimer.unref?.();
    this.intervalTimer.unref?.();
  }

  close() {
    this.closed = true;
    this.abort?.abort();
    clearTimeout(this.startupTimer);
    clearInterval(this.intervalTimer);
  }

  private async request(url: string, signal: AbortSignal): Promise<Response> {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await this.options.fetch(url, {
        signal,
        redirect: 'manual',
        credentials: 'omit',
        headers: { 'User-Agent': `Harness-Manager/${this.options.version}`, Accept: 'application/vnd.github+json' },
      });
      if (response.status === 403 || response.status === 429) {
        await response.body?.cancel();
        throw appError('APP_UPDATE_RATE_LIMITED');
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw appError('APP_UPDATE_REQUEST_FAILED');
        const next = new URL(location, url);
        const allowed = this.feed.local
          ? validAssetUrl(next.href, this.feed.prefix)
          : validAssetUrl(next.href, this.feed.prefix) ||
            (next.protocol === 'https:' &&
              ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname) &&
              !next.username &&
              !next.password &&
              !next.port);
        if (!allowed) throw appError('APP_UPDATE_INVALID_DOWNLOAD_URL');
        url = next.href;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw appError('APP_UPDATE_HTTP', { status: response.status });
      }
      return response;
    }
    throw appError('APP_UPDATE_INVALID_DOWNLOAD_URL');
  }

  private async readLimited(response: Response, limit: number): Promise<Uint8Array> {
    if (!response.body) throw appError('APP_UPDATE_REQUEST_FAILED');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > limit) throw appError('APP_UPDATE_INVALID_SIZE');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return Buffer.concat(chunks);
  }
}
