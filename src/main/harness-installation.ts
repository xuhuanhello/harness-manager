import { randomUUID } from 'node:crypto';
import { constants, type Dirent, type Stats } from 'node:fs';
import { execFile as nodeExecFile } from 'node:child_process';
import { access, lstat, readFile, readlink, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Binding, Distribution, Harness, Target, Workspace } from '../shared/types';
import type {
  HarnessCleanupPreview,
  HarnessCleanupResult,
  HarnessInstallationResult,
  ResidualDirectory,
  ResidualDirectoryClassification,
} from '../shared/harness-installation';
import { errorMessage } from '../shared/errors';
import { isHarnessEnabled } from '../shared/harness-enabled';
import { HARNESS_DEFINITION_FIELDS } from '../shared/harness-fields';
import { errorCode, isMissingEntryError, isWithin, overlaps } from './fs-utils';
import { canonicalizePath, expandUserPath, validateWorkspaceRelativePath } from './paths';
import type { Store } from './store';
import { appError } from './messages';
import { runWindowsBatch, windowsBinaryDirectories, windowsEnv, windowsPathEntries } from './windows-cli';

const CACHE_MS = 5 * 60_000;
const CLEANUP_PREVIEW_MS = 90_000;
// The first run of a newly installed or updated large binary can spend seconds in macOS code-signature checks.
const COMMAND_TIMEOUT_MS = 5_000;
const COMMAND_MAX_BUFFER = 16 * 1024;
const MAX_CANDIDATES = 48;
const MAX_PATH_DIRECTORIES = 256;
const MAX_VERSION_ATTEMPTS = 2;
const MAX_VERSION_LENGTH = 300;
const DEFAULT_MAX_CONCURRENT = 4;
const MAX_EXTENSION_DIRECTORIES = 2_000;
const MAX_EXTENSION_MANIFEST_BYTES = 1024 * 1024;

export interface ExecuteFileOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
  shell: false;
  windowsHide: true;
  encoding: 'utf8';
}

export type ExecuteFile = (file: string, args: string[], options: ExecuteFileOptions) => Promise<{ stdout?: string; stderr?: string }>;

export interface HarnessInstallationServiceOptions {
  /** Must move the item to the OS trash; this service never recursively deletes a path. */
  trashItem?: (path: string) => Promise<void>;
  home?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execute?: ExecuteFile;
  now?: () => number;
  cacheMs?: number;
  cleanupPreviewMs?: number;
  commandTimeoutMs?: number;
  commandMaxBuffer?: number;
  maxConcurrent?: number;
}

interface InstallationStore {
  root: string;
  list<T>(collection: string): T[];
}

interface CandidateRoot {
  harnessId: string;
  path: string;
  scope: 'user' | 'workspace';
  workspaceId?: string;
  inventoryOnly?: boolean;
}

interface CacheEntry {
  key: string;
  expiresAt: number;
  result: HarnessInstallationResult;
}

interface PendingCleanup {
  harnessId: string;
  path: string;
  fingerprint: string;
  expiresAt: number;
}

interface Inspection {
  classification: ResidualDirectoryClassification;
  canTrash: boolean;
  detail: string;
  fingerprint?: string;
}

interface ExecFailure extends Error {
  code?: string | number;
  killed?: boolean;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}

function runExecFile(file: string, args: string[], options: ExecuteFileOptions): Promise<{ stdout?: string; stderr?: string }> {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(file)) return runWindowsBatch(file, args, options);
  return new Promise((resolve, reject) => {
    nodeExecFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        const failure = error as ExecFailure;
        failure.stdout = stdout;
        failure.stderr = stderr;
        reject(failure);
      } else resolve({ stdout, stderr });
    });
  });
}

function pathEntries(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()) : [];
}

function definitionKey(harness: Harness): string {
  return JSON.stringify(HARNESS_DEFINITION_FIELDS.map((field) => harness[field]));
}

function outputVersion(value: string | Buffer | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = String(value)
    .replace(/\u001b\[[0-9;]*m/g, '')
    .trim();
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim();
  return firstLine ? firstLine.slice(0, MAX_VERSION_LENGTH) : undefined;
}

function commonBinaryDirectories(home: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') return windowsBinaryDirectories(home, env);
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.local', 'share', 'pnpm'),
    path.join(home, '.opencode', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ];
}

function parseExecutableName(plist: string): string | undefined {
  const value = plist.match(/<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/i)?.[1]?.trim();
  if (!value || value.includes('/') || value.includes('\\') || value.includes('\0')) return undefined;
  return value;
}

function parseBundleIdentifier(plist: string): string | undefined {
  return plist.match(/<key>\s*CFBundleIdentifier\s*<\/key>\s*<string>([^<]+)<\/string>/i)?.[1]?.trim() || undefined;
}

function isUniversalSkillsRoot(base: string, target: string): boolean {
  return path.resolve(target) === path.resolve(base, '.agents', 'skills');
}

function primaryWorkspaceRoot(harness: Harness): string | undefined {
  try {
    return validateWorkspaceRelativePath(harness.workspaceSkillsRelativePath ?? '') || undefined;
  } catch {
    return undefined;
  }
}

function nodeKegRank(name: string): number {
  return name === 'node' ? Number.MAX_SAFE_INTEGER : Number(name.slice('node@'.length));
}

export class HarnessInstallationService {
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly execute: ExecuteFile;
  private readonly now: () => number;
  private readonly cacheMs: number;
  private readonly cleanupPreviewMs: number;
  private readonly commandTimeoutMs: number;
  private readonly commandMaxBuffer: number;
  private readonly maxConcurrent: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<HarnessInstallationResult>>();
  private readonly cleanups = new Map<string, PendingCleanup>();
  private readonly knownHarnesses = new Map<string, Harness>();
  private readonly latestStatus = new Map<string, HarnessInstallationResult['status']>();
  private readonly latestStatusCheckedAt = new Map<string, number>();
  private registryPaths?: Promise<string[]>;
  private activeDetections = 0;
  private readonly detectionWaiters: Array<() => void> = [];

  constructor(
    private readonly store: InstallationStore | Store,
    options: HarnessInstallationServiceOptions = {},
  ) {
    this.home = path.resolve(options.home ?? os.homedir());
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.execute = options.execute ?? runExecFile;
    this.now = options.now ?? Date.now;
    this.cacheMs = Math.max(0, options.cacheMs ?? CACHE_MS);
    this.cleanupPreviewMs = Math.max(1, options.cleanupPreviewMs ?? CLEANUP_PREVIEW_MS);
    this.commandTimeoutMs = Math.max(100, options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS);
    this.commandMaxBuffer = Math.max(1024, options.commandMaxBuffer ?? COMMAND_MAX_BUFFER);
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT));
    this.trashItem = options.trashItem;
  }

  private readonly trashItem?: (path: string) => Promise<void>;

  /** Detects only executable/app evidence. Configured skill directories never imply installation. */
  async detect(harnesses: readonly Harness[], options: { refresh?: boolean } = {}): Promise<HarnessInstallationResult[]> {
    const selected = harnesses.filter((harness) => harness && typeof harness.id === 'string' && !!harness.id && isHarnessEnabled(harness));
    if (options.refresh) this.registryPaths = undefined;
    for (const harness of selected) this.knownHarnesses.set(harness.id, harness);
    this.pruneExpired();
    const detected = await Promise.all(selected.map((harness) => this.detectOne(harness, !!options.refresh)));
    for (const result of detected) {
      this.latestStatus.set(result.harnessId, result.status);
      this.latestStatusCheckedAt.set(result.harnessId, Date.parse(result.checkedAt));
    }
    const everyHarness = this.allStoredHarnesses(selected);
    const results = await Promise.all(
      detected.map(async (result) => ({
        ...result,
        residualDirectories: await Promise.all(
          result.residualDirectories.map(async (directory) => {
            if (directory.classification === 'missing') return directory;
            const candidate: CandidateRoot = {
              harnessId: directory.harnessId,
              path: directory.path,
              scope: directory.scope,
              ...(directory.workspaceId ? { workspaceId: directory.workspaceId } : {}),
            };
            const activeReason = await this.sharedReaderReason(candidate, everyHarness);
            return activeReason ? { ...directory, classification: 'active' as const, canTrash: false, detail: activeReason } : directory;
          }),
        ),
      })),
    );
    for (const result of results) {
      const harness = everyHarness.find((item) => item.id === result.harnessId);
      if (harness) this.cache.set(harness.id, { key: definitionKey(harness), expiresAt: this.now() + this.cacheMs, result });
    }
    return results.map((result) => structuredClone(result));
  }

  /** Returns a path only if detection currently lists it as one of this Harness's skill directories. */
  async resolveRevealPath(request: { harnessId: string; path: string }): Promise<string> {
    const harness = this.store.list<Harness>('harnesses').find((item) => item.id === request.harnessId);
    if (!harness) throw appError('INSTALLATION_HARNESS_NOT_FOUND');
    if (!isHarnessEnabled(harness)) throw appError('INSTALLATION_REVEAL_DISABLED');
    const [result] = await this.detect([harness]);
    if (!result?.residualDirectories.some((item) => item.path === request.path)) throw appError('INSTALLATION_REVEAL_UNKNOWN_PATH');
    return request.path;
  }

  /** Returns a one-shot token only for an empty or inactive symlink-only skill root. */
  async previewCleanup(request: { harnessId: string; path: string }): Promise<HarnessCleanupPreview> {
    this.pruneExpired();
    const requestedPath = path.resolve(request.path);
    const harness = this.getKnownHarness(request.harnessId);
    if (!harness || !path.isAbsolute(request.path) || request.path.includes('\0')) {
      return {
        harnessId: request.harnessId,
        path: request.path,
        classification: 'unknown',
        canTrash: false,
        reason: '无法确认该目录属于当前 Harness 的技能根目录。',
      };
    }
    if (!isHarnessEnabled(harness)) {
      return {
        harnessId: request.harnessId,
        path: requestedPath,
        classification: 'active',
        canTrash: false,
        reason: '此 Harness 已禁用；禁用状态不会授权清理其目录。',
      };
    }
    const allHarnesses = this.allStoredHarnesses([harness]);
    await this.detect(allHarnesses, { refresh: true });
    const status = this.latestStatus.get(harness.id) ?? 'unknown';
    if (status !== 'not-found') {
      return {
        harnessId: harness.id,
        path: requestedPath,
        classification: status === 'installed' ? 'active' : 'unknown',
        canTrash: false,
        reason: status === 'installed' ? '应用已检测为已安装；不会清理其技能目录。' : '应用安装状态无法确认；为保护数据，不允许清理。',
      };
    }
    const candidate = (await this.candidateRoots([harness], status)).find((item) => path.resolve(item.path) === requestedPath);
    if (!candidate) {
      return {
        harnessId: request.harnessId,
        path: requestedPath,
        classification: 'protected',
        canTrash: false,
        reason: '只能清理当前 Harness 注册的技能根目录。',
      };
    }
    const sharedReader = await this.sharedReaderReason(candidate, allHarnesses);
    if (sharedReader)
      return { harnessId: harness.id, path: candidate.path, classification: 'active', canTrash: false, reason: sharedReader };
    const inspection = await this.inspectRoot(candidate);
    if (!inspection.canTrash || !inspection.fingerprint) {
      return {
        harnessId: request.harnessId,
        path: candidate.path,
        classification: inspection.classification,
        canTrash: false,
        reason: inspection.detail,
      };
    }
    const token = randomUUID();
    const expiresAt = this.now() + this.cleanupPreviewMs;
    this.cleanups.set(token, { harnessId: request.harnessId, path: candidate.path, fingerprint: inspection.fingerprint, expiresAt });
    return {
      token,
      harnessId: request.harnessId,
      path: candidate.path,
      classification: inspection.classification,
      canTrash: true,
      reason: inspection.detail,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /** Consumes its preview token, checks the directory again, then asks Electron to move it to Trash. */
  async cleanup(request: { token: string }): Promise<HarnessCleanupResult> {
    const pending = this.cleanups.get(request.token);
    this.cleanups.delete(request.token);
    if (!pending || pending.expiresAt < this.now()) throw appError('CLEANUP_PREVIEW_EXPIRED');
    if (!this.trashItem) throw appError('CLEANUP_TRASH_UNAVAILABLE');
    const harness = this.getKnownHarness(pending.harnessId);
    if (!harness) throw appError('CLEANUP_HARNESS_CHANGED');
    if (!isHarnessEnabled(harness)) throw appError('CLEANUP_HARNESS_DISABLED');
    const allHarnesses = this.allStoredHarnesses([harness]);
    await this.detect(allHarnesses, { refresh: true });
    const status = this.latestStatus.get(harness.id) ?? 'unknown';
    if (status !== 'not-found') throw appError('CLEANUP_STATUS_CHANGED');
    const candidate = (await this.candidateRoots([harness], status)).find((item) => path.resolve(item.path) === path.resolve(pending.path));
    if (!candidate) throw appError('CLEANUP_ROOT_CHANGED');
    const sharedReader = await this.sharedReaderReason(candidate, allHarnesses);
    if (sharedReader) throw appError('CLEANUP_SHARED_READER', { reason: sharedReader });
    const inspection = await this.inspectRoot(candidate);
    if (!inspection.canTrash || inspection.fingerprint !== pending.fingerprint) {
      throw appError('CLEANUP_CONTENT_CHANGED');
    }
    await this.trashItem(candidate.path);
    this.cache.delete(harness.id);
    return { harnessId: harness.id, path: candidate.path, status: 'trashed' };
  }

  private async detectOne(harness: Harness, refresh: boolean): Promise<HarnessInstallationResult> {
    const key = definitionKey(harness);
    const cached = this.cache.get(harness.id);
    if (!refresh && cached && cached.key === key && cached.expiresAt > this.now()) return structuredClone(cached.result);
    const inFlightKey = `${harness.id}\0${key}`;
    const pending = this.inFlight.get(inFlightKey);
    if (pending) return structuredClone(await pending);
    const task = this.withDetectionSlot(async () => this.detectFresh(harness));
    this.inFlight.set(inFlightKey, task);
    try {
      const result = await task;
      this.cache.set(harness.id, { key, expiresAt: this.now() + this.cacheMs, result });
      return structuredClone(result);
    } finally {
      if (this.inFlight.get(inFlightKey) === task) this.inFlight.delete(inFlightKey);
    }
  }

  private async detectFresh(harness: Harness): Promise<HarnessInstallationResult> {
    const checkedAt = new Date(this.now()).toISOString();
    const detection = await this.findInstallation(harness);
    const roots = await this.candidateRoots([harness], detection.status);
    const residualDirectories = await Promise.all(
      roots.map(async (root): Promise<ResidualDirectory> => {
        if (detection.status !== 'not-found') {
          return {
            ...root,
            classification: detection.status === 'installed' ? 'active' : 'unknown',
            canTrash: false,
            detail:
              detection.status === 'installed'
                ? 'Harness 已检测为已安装；不会清理此技能目录。'
                : 'Harness 安装状态无法确认；为保护数据，不允许清理。',
          };
        }
        const inspection = await this.inspectRoot(root);
        return { ...root, classification: inspection.classification, canTrash: inspection.canTrash, detail: inspection.detail };
      }),
    );
    return {
      harnessId: harness.id,
      status: detection.status,
      checkedAt,
      ...(detection.method ? { method: detection.method } : {}),
      ...(detection.executable ? { executable: detection.executable } : {}),
      ...(detection.version ? { version: detection.version } : {}),
      ...(detection.reason ? { reason: detection.reason } : {}),
      residualDirectories,
    };
  }

  private async findInstallation(
    harness: Harness,
  ): Promise<Pick<HarnessInstallationResult, 'status' | 'method' | 'executable' | 'version' | 'reason'>> {
    if (harness.kind === 'universal') return { status: 'unknown', reason: '通用技能目标没有独立的应用程序可供检测。' };
    const extensionIds = pathEntries(harness.extensionIds).map((id) => id.toLocaleLowerCase('en-US'));
    if (extensionIds.length) return this.findEditorExtension(harness, extensionIds);
    const command = typeof harness.command === 'string' ? harness.command.trim() : '';
    const executablePaths = pathEntries(harness.executablePaths);
    const appPaths = pathEntries(harness.appPaths);
    const hasDetectionDefinition = !!command || executablePaths.length > 0 || appPaths.length > 0;
    if (!hasDetectionDefinition) return { status: 'unknown', reason: '此 Harness 尚未配置可检测的命令或应用程序路径。' };

    let uncertain = false;
    const candidates = await this.resolveExecutableCandidates(command, executablePaths);
    const args = Array.isArray(harness.versionArgs)
      ? harness.versionArgs.filter((arg): arg is string => typeof arg === 'string' && !arg.includes('\0')).slice(0, 12)
      : ['--version'];
    const runtimeDirectories = candidates.length ? await this.runtimeDirectories() : [];
    const deadline = Date.now() + this.commandTimeoutMs;
    let attempts = 0;
    for (const candidate of candidates) {
      // Store aliases may open a desktop app/protocol handler instead of a CLI. Never launch them in a passive probe.
      if (this.platform === 'win32' && /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(candidate)) {
        uncertain = true;
        continue;
      }
      if (attempts >= MAX_VERSION_ATTEMPTS) break;
      attempts += 1;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        uncertain = true;
        break;
      }
      try {
        const result = await this.execute(candidate, args, {
          cwd: this.home,
          env: this.commandEnvironment(candidate, runtimeDirectories),
          timeout: remaining,
          maxBuffer: this.commandMaxBuffer,
          shell: false,
          windowsHide: true,
          encoding: 'utf8',
        });
        return {
          status: 'installed',
          method: 'version-command',
          executable: candidate,
          ...(outputVersion(result.stdout) || outputVersion(result.stderr)
            ? { version: outputVersion(result.stdout) || outputVersion(result.stderr) }
            : {}),
        };
      } catch (cause) {
        if (errorCode(cause) === 'ENOENT') continue;
        uncertain = true;
      }
    }

    if (appPaths.length && this.platform !== 'darwin' && !candidates.length) {
      return { status: 'unknown', reason: '此应用只配置了 macOS 应用包路径；当前系统无法据此判断是否已安装。' };
    }

    if (this.platform === 'darwin' && appPaths.length) {
      const bundleIds = pathEntries(harness.appBundleIds);
      for (const appPathValue of appPaths) {
        const appPath = this.expandPath(appPathValue);
        if (!appPath) {
          uncertain = true;
          continue;
        }
        const result = await this.inspectAppBundle(appPath, bundleIds);
        if (result === 'installed') return { status: 'installed', method: 'app-bundle', executable: appPath };
        if (result === 'unknown') uncertain = true;
      }
    }

    if (uncertain) return { status: 'unknown', reason: '找到了候选程序，但无法在安全的时间或输出限制内验证版本。' };
    return { status: 'not-found', reason: '未在 PATH、常见程序目录或已保存的可执行路径中找到可验证的应用。' };
  }

  private async findEditorExtension(
    harness: Harness,
    extensionIds: string[],
  ): Promise<Pick<HarnessInstallationResult, 'status' | 'method' | 'executable' | 'version' | 'reason'>> {
    const explicitRoots = pathEntries(harness.extensionRoots);
    const roots = [
      ...new Set([
        ...explicitRoots.map((value) => this.expandPath(value)).filter((value): value is string => !!value),
        path.join(this.home, '.vscode', 'extensions'),
        path.join(this.home, '.vscode-insiders', 'extensions'),
      ]),
    ];
    let couldNotRead = false;
    const wanted = new Set(extensionIds);
    for (const root of roots) {
      let entries: Dirent[];
      try {
        const rootInfo = await lstat(root);
        if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
          couldNotRead = true;
          continue;
        }
        entries = await readdir(root, { withFileTypes: true });
      } catch (cause) {
        if (!isMissingEntryError(cause)) couldNotRead = true;
        continue;
      }
      let checked = 0;
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        checked += 1;
        if (checked > MAX_EXTENSION_DIRECTORIES) {
          couldNotRead = true;
          break;
        }
        const extensionPath = path.join(root, entry.name);
        const manifestPath = path.join(extensionPath, 'package.json');
        try {
          const manifestInfo = await lstat(manifestPath);
          if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > MAX_EXTENSION_MANIFEST_BYTES) continue;
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { publisher?: unknown; name?: unknown; version?: unknown };
          if (typeof manifest.publisher !== 'string' || typeof manifest.name !== 'string') continue;
          const id = `${manifest.publisher}.${manifest.name}`.toLocaleLowerCase('en-US');
          if (!wanted.has(id)) continue;
          return {
            status: 'installed',
            method: 'editor-extension',
            executable: extensionPath,
            ...(typeof manifest.version === 'string' ? { version: manifest.version.slice(0, MAX_VERSION_LENGTH) } : {}),
          };
        } catch (cause) {
          if (!isMissingEntryError(cause) && !(cause instanceof SyntaxError)) couldNotRead = true;
        }
      }
    }
    return couldNotRead
      ? { status: 'unknown', method: 'editor-extension', reason: '无法完整读取编辑器扩展清单；未确认插件是否安装。' }
      : { status: 'not-found', method: 'editor-extension', reason: '在已知扩展清单目录中没有找到匹配的插件 ID。' };
  }

  private async resolveExecutableCandidates(command: string, configuredPaths: string[]): Promise<string[]> {
    const candidates: string[] = [];
    const seen = new Set<string>();
    const add = (value: string) => {
      const resolved = path.resolve(value);
      const key = this.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(resolved);
      }
    };
    for (const configured of configuredPaths) {
      const expanded = this.expandPath(configured);
      if (expanded) add(expanded);
    }
    if (command && !command.includes('\0')) {
      if (path.isAbsolute(command)) add(command);
      else if (!command.includes('/') && !command.includes('\\')) {
        const pathValue = this.platform === 'win32' ? windowsEnv(this.env, 'PATH') || '' : this.env.PATH || '';
        const inherited =
          this.platform === 'win32' ? windowsPathEntries(pathValue, this.env) : pathValue.split(path.delimiter).filter(Boolean);
        const directories = [
          ...inherited.slice(0, MAX_PATH_DIRECTORIES),
          ...(await this.windowsRegistryPaths()),
          ...commonBinaryDirectories(this.home, this.platform, this.env),
          ...(await this.nvmBinaryDirectories()),
        ];
        const extensions =
          this.platform === 'win32'
            ? path.extname(command)
              ? ['']
              : [
                  ...new Set([
                    ...(windowsEnv(this.env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').map((ext) => ext.toLowerCase()),
                    '.exe',
                    '.cmd',
                    '.bat',
                  ]),
                ].filter((ext) => ['.exe', '.com', '.cmd', '.bat'].includes(ext))
            : [''];
        const visitedDirectories = new Set<string>();
        for (const directory of directories) {
          if (!path.isAbsolute(directory)) continue;
          const key = this.platform === 'win32' ? path.resolve(directory).toLowerCase() : path.resolve(directory);
          if (visitedDirectories.has(key)) continue;
          visitedDirectories.add(key);
          for (const extension of extensions) add(path.join(directory, `${command}${extension}`));
        }
      }
    }
    const existing: string[] = [];
    for (const candidate of candidates) {
      try {
        const info = await stat(candidate);
        if (!info.isFile()) continue;
        if (this.platform !== 'win32') await access(candidate, constants.X_OK);
        existing.push(candidate);
      } catch (cause) {
        if (errorCode(cause) !== 'ENOENT' && errorCode(cause) !== 'ENOTDIR') existing.push(candidate);
      }
      // Missing entries in a long Windows PATH must not consume the budget for real installations.
      if (existing.length >= MAX_CANDIDATES) break;
    }
    return existing;
  }

  private windowsRegistryPaths(): Promise<string[]> {
    if (this.platform !== 'win32') return Promise.resolve([]);
    this.registryPaths ??= (async () => {
      const system = windowsEnv(this.env, 'SystemRoot') || 'C:\\Windows';
      // A fixed .NET query avoids reg.exe's locale-dependent encoding corrupting non-ASCII installation paths.
      const script =
        "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); ConvertTo-Json -Compress -InputObject @([Environment]::GetEnvironmentVariable('Path','User'), [Environment]::GetEnvironmentVariable('Path','Machine'))";
      try {
        const result = await this.execute(
          path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
          {
            cwd: this.home,
            env: this.env,
            timeout: Math.min(2000, this.commandTimeoutMs),
            maxBuffer: 128 * 1024,
            shell: false,
            windowsHide: true,
            encoding: 'utf8',
          },
        );
        const values: unknown = JSON.parse(result.stdout?.trim().replace(/^\uFEFF/, '') || '[]');
        if (Array.isArray(values))
          return values
            .filter((value): value is string => typeof value === 'string')
            .flatMap((value) => windowsPathEntries(value, this.env).slice(0, MAX_PATH_DIRECTORIES));
      } catch {
        // Registry access is optional: keep inherited PATH and verified known installation directories.
      }
      return [];
    })();
    return this.registryPaths;
  }

  private async nvmBinaryDirectories(): Promise<string[]> {
    if (this.platform === 'win32') {
      const root =
        windowsEnv(this.env, 'NVM_HOME') || path.join(windowsEnv(this.env, 'APPDATA') || path.join(this.home, 'AppData', 'Roaming'), 'nvm');
      try {
        return (await readdir(root, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && /^v\d+\.\d+\.\d+$/.test(entry.name))
          .sort((a, b) => b.name.localeCompare(a.name, 'en-US', { numeric: true }))
          .slice(0, 8)
          .map((entry) => path.join(root, entry.name));
      } catch {
        return [];
      }
    }
    const versionsRoot = path.join(this.home, '.nvm', 'versions', 'node');
    try {
      const versions = (await readdir(versionsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort((a, b) => b.localeCompare(a, 'en-US', { numeric: true }))
        .slice(0, 8);
      return versions.map((version) => path.join(versionsRoot, version, 'bin'));
    } catch {
      return [];
    }
  }

  /** Finder-launched apps inherit a minimal PATH, so `#!/usr/bin/env node` launchers need the usual runtime locations. */
  private async runtimeDirectories(): Promise<string[]> {
    if (this.platform === 'win32')
      return [
        ...(await this.windowsRegistryPaths()),
        ...windowsBinaryDirectories(this.home, this.env),
        ...(await this.nvmBinaryDirectories()),
      ];
    const homebrewNode: string[] = [];
    for (const optRoot of ['/opt/homebrew/opt', '/usr/local/opt']) {
      try {
        const kegs = (await readdir(optRoot)).filter((name) => /^node(@\d+)?$/.test(name));
        kegs.sort((a, b) => nodeKegRank(b) - nodeKegRank(a));
        homebrewNode.push(...kegs.map((name) => path.join(optRoot, name, 'bin')));
      } catch {
        /* No Homebrew installation at this prefix. */
      }
    }
    return [
      ...commonBinaryDirectories(this.home, this.platform, this.env),
      ...(await this.nvmBinaryDirectories()),
      ...homebrewNode,
      path.join(this.home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
      path.join(this.home, 'Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin'),
      path.join(this.home, '.fnm', 'aliases', 'default', 'bin'),
      path.join(this.home, '.local', 'share', 'mise', 'shims'),
      path.join(this.home, '.asdf', 'shims'),
    ];
  }

  private commandEnvironment(candidate: string, runtimeDirectories: string[]): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.env, HOME: this.home, USERPROFILE: this.home };
    if (this.platform === 'win32') {
      for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
      const inherited = windowsPathEntries(windowsEnv(this.env, 'PATH') || '', this.env);
      const directories = [...inherited, path.dirname(candidate), ...runtimeDirectories];
      const seen = new Set<string>();
      env.PATH = directories
        .filter((directory) => {
          const key = directory.toLowerCase();
          if (!directory || seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .join(';');
      return env;
    }
    const inherited = (this.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    env.PATH = [...new Set([...inherited, path.dirname(candidate), ...runtimeDirectories])].join(path.delimiter);
    return env;
  }

  private async binaryBundleIdentifier(infoPath: string): Promise<string | undefined> {
    try {
      const result = await this.execute('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPath], {
        cwd: this.home,
        env: this.env,
        timeout: this.commandTimeoutMs,
        maxBuffer: this.commandMaxBuffer,
        shell: false,
        windowsHide: true,
        encoding: 'utf8',
      });
      return String(result.stdout ?? '').trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private expandPath(value: string): string | undefined {
    try {
      const trimmed = value.trim();
      if (trimmed.startsWith('~')) return expandUserPath(trimmed, this.home);
      if (!path.isAbsolute(trimmed) || trimmed.includes('\0')) return undefined;
      return path.resolve(trimmed);
    } catch {
      return undefined;
    }
  }

  private async inspectAppBundle(appPath: string, bundleIds: string[]): Promise<'installed' | 'not-found' | 'unknown'> {
    if (!appPath.toLocaleLowerCase('en-US').endsWith('.app')) return 'not-found';
    try {
      const bundle = await lstat(appPath);
      if (bundle.isSymbolicLink() || !bundle.isDirectory()) return 'unknown';
      const infoPath = path.join(appPath, 'Contents', 'Info.plist');
      const macosPath = path.join(appPath, 'Contents', 'MacOS');
      const [info, infoContents] = await Promise.all([lstat(infoPath), readFile(infoPath, 'utf8')]);
      const macos = await lstat(macosPath);
      if (!info.isFile() || macos.isSymbolicLink() || !macos.isDirectory()) return 'unknown';
      if (bundleIds.length) {
        const identifier = infoContents.startsWith('bplist')
          ? await this.binaryBundleIdentifier(infoPath)
          : (parseBundleIdentifier(infoContents) ?? '');
        if (identifier === undefined) return 'unknown';
        // A bundle with the same file name can belong to a different product.
        if (!bundleIds.includes(identifier)) return 'not-found';
      }
      const namedExecutable = parseExecutableName(infoContents);
      const entries = namedExecutable ? [namedExecutable] : await readdir(macosPath);
      for (const entry of entries) {
        if (entry.includes('/') || entry.includes('\\') || entry.includes('\0')) continue;
        const executablePath = path.join(macosPath, entry);
        try {
          const executableInfo = await stat(executablePath);
          if (!executableInfo.isFile()) continue;
          await access(executablePath, constants.X_OK);
          return 'installed';
        } catch (cause) {
          if (!isMissingEntryError(cause)) return 'unknown';
        }
      }
      return 'unknown';
    } catch (cause) {
      return isMissingEntryError(cause) ? 'not-found' : 'unknown';
    }
  }

  private async candidateRoots(
    harnesses: readonly Harness[],
    installationStatus?: HarnessInstallationResult['status'],
  ): Promise<CandidateRoot[]> {
    const roots: CandidateRoot[] = [];
    const seen = new Set<string>();
    const add = (harnessId: string, rootPath: string, scope: CandidateRoot['scope'], workspaceId?: string) => {
      const key = `${harnessId}\0${scope}\0${workspaceId ?? ''}\0${path.resolve(rootPath)}`;
      if (!seen.has(key)) {
        seen.add(key);
        roots.push({ harnessId, path: path.resolve(rootPath), scope, ...(workspaceId ? { workspaceId } : {}) });
      }
    };
    const workspaces = this.safeList<Workspace>('workspaces');
    const primaries = this.allStoredHarnesses(harnesses).map((item) => ({
      id: item.id,
      user: this.primaryUserRoot(item),
      workspace: primaryWorkspaceRoot(item),
    }));
    for (const harness of harnesses) {
      // The shared Agent Skills roots belong to the universal record, and another product's primary root is only
      // a compatibility read root here; neither is this product's leftover.
      const ownsUniversalRoots = harness.kind === 'universal';
      const ownUserPrimary = this.primaryUserRoot(harness);
      const ownWorkspacePrimary = primaryWorkspaceRoot(harness);
      const isForeignUserRoot = (target: string) =>
        target !== ownUserPrimary && primaries.some((item) => item.id !== harness.id && item.user === target);
      const isForeignWorkspaceRoot = (relative: string) =>
        relative !== ownWorkspacePrimary && primaries.some((item) => item.id !== harness.id && item.workspace === relative);
      for (const userRoot of [harness.userSkillsPath, ...pathEntries(harness.extraUserSkillsPaths)]) {
        const expanded = typeof userRoot === 'string' ? this.expandPath(userRoot) : undefined;
        if (expanded) {
          if (!ownsUniversalRoots && isUniversalSkillsRoot(this.home, expanded)) continue;
          if (isForeignUserRoot(expanded)) continue;
          add(harness.id, expanded, 'user');
          if (installationStatus === 'not-found' && this.isKnownToolConfigRoot(expanded)) {
            try {
              await lstat(expanded);
            } catch (cause) {
              if (isMissingEntryError(cause)) {
                const toolRoot = this.toolConfigParent(expanded);
                if (toolRoot) {
                  try {
                    const info = await lstat(toolRoot);
                    if (!info.isSymbolicLink() && info.isDirectory()) {
                      const key = `${harness.id}\0user\0\0${path.resolve(toolRoot)}\0inventory`;
                      if (!seen.has(key)) {
                        seen.add(key);
                        roots.push({ harnessId: harness.id, path: path.resolve(toolRoot), scope: 'user', inventoryOnly: true });
                      }
                    }
                  } catch {
                    /* A missing or unreadable config root is not a cleanup candidate. */
                  }
                }
              }
            }
          }
        }
      }
      const relativeValues = [harness.workspaceSkillsRelativePath, ...pathEntries(harness.extraWorkspaceSkillsRelativePaths)];
      for (const relativeValue of relativeValues) {
        if (typeof relativeValue !== 'string' || !relativeValue.trim()) continue;
        let relative: string;
        try {
          relative = validateWorkspaceRelativePath(relativeValue);
        } catch {
          continue;
        }
        if (isForeignWorkspaceRoot(relative)) continue;
        for (const workspace of workspaces) {
          if (!workspace.path || !path.isAbsolute(workspace.path)) continue;
          const workspaceRoot = path.resolve(workspace.path);
          const target = path.resolve(workspaceRoot, relative);
          if (!isWithin(workspaceRoot, target)) continue;
          if (!ownsUniversalRoots && isUniversalSkillsRoot(workspaceRoot, target)) continue;
          add(harness.id, target, 'workspace', workspace.id);
        }
      }
    }
    return roots;
  }

  private primaryUserRoot(harness: Harness): string | undefined {
    return typeof harness.userSkillsPath === 'string' && harness.userSkillsPath.trim()
      ? this.expandPath(harness.userSkillsPath)
      : undefined;
  }

  private toolConfigParent(skillPath: string): string | undefined {
    const pairs: Array<[string, string]> = [
      [path.join(this.home, '.claude', 'skills'), path.join(this.home, '.claude')],
      [path.join(this.home, '.codex', 'skills'), path.join(this.home, '.codex')],
      [path.join(this.home, '.pi', 'agent', 'skills'), path.join(this.home, '.pi', 'agent')],
      [path.join(this.home, '.cursor', 'skills'), path.join(this.home, '.cursor')],
      [path.join(this.home, '.continue', 'skills'), path.join(this.home, '.continue')],
    ];
    const resolved = path.resolve(skillPath);
    return pairs.find(([knownSkillsPath]) => path.resolve(knownSkillsPath) === resolved)?.[1];
  }

  private isKnownToolConfigRoot(skillPath: string): boolean {
    return !!this.toolConfigParent(skillPath);
  }

  private async inspectInventoryOnlyRoot(rootPath: string): Promise<Inspection> {
    if (overlaps(rootPath, this.store.root))
      return { classification: 'central-library', canTrash: false, detail: '工具配置目录与中央技能库重叠；不会清理。' };
    let info: Stats;
    try {
      info = await lstat(rootPath);
    } catch (cause) {
      return isMissingEntryError(cause)
        ? { classification: 'missing', canTrash: false, detail: '工具配置目录已不存在。' }
        : { classification: 'unknown', canTrash: false, detail: `无法检查工具配置目录：${errorMessage(cause)}` };
    }
    if (info.isSymbolicLink() || !info.isDirectory())
      return { classification: 'protected', canTrash: false, detail: '工具配置根目录不是普通目录；不会清理。' };
    try {
      const entries = await readdir(rootPath, { withFileTypes: true });
      return entries.length
        ? {
            classification: 'contains-data',
            canTrash: false,
            detail: '技能目录不存在，但此工具的专属配置或缓存目录仍有内容。可在访达中查看；不会自动清理。',
          }
        : { classification: 'protected', canTrash: false, detail: '技能目录和配置内容均为空；工具配置根目录仍受保护，不会清理。' };
    } catch (cause) {
      return { classification: 'unknown', canTrash: false, detail: `无法读取工具配置目录：${errorMessage(cause)}` };
    }
  }

  private async inspectRoot(candidate: CandidateRoot): Promise<Inspection> {
    if (candidate.inventoryOnly) return this.inspectInventoryOnlyRoot(candidate.path);
    const deniedByPath = await this.protectedPathReason(candidate.path);
    if (deniedByPath) return { classification: deniedByPath.classification, canTrash: false, detail: deniedByPath.detail };
    const activeReason = await this.activeReferenceReason(candidate.path);
    if (activeReason) return { classification: 'active', canTrash: false, detail: activeReason };
    let rootInfo: Stats;
    try {
      rootInfo = await lstat(candidate.path);
    } catch (cause) {
      if (isMissingEntryError(cause)) return { classification: 'missing', canTrash: false, detail: '此技能根目录已不存在。' };
      return { classification: 'unknown', canTrash: false, detail: `无法检查目录：${errorMessage(cause)}` };
    }
    if (rootInfo.isSymbolicLink())
      return { classification: 'protected', canTrash: false, detail: '技能根目录本身是符号链接；为避免触及真实数据，不会清理。' };
    if (!rootInfo.isDirectory()) return { classification: 'protected', canTrash: false, detail: '目标不是普通目录；不会清理。' };
    let entries: Dirent[];
    try {
      entries = await readdir(candidate.path, { withFileTypes: true });
    } catch (cause) {
      return { classification: 'unknown', canTrash: false, detail: `无法读取目录内容：${errorMessage(cause)}` };
    }
    const baseFingerprint = [rootInfo.dev, rootInfo.ino, rootInfo.mode, rootInfo.mtimeMs, rootInfo.ctimeMs].join(':');
    if (!entries.length) {
      const fingerprint = `${path.resolve(candidate.path)}\0${baseFingerprint}\0empty`;
      return { classification: 'empty', canTrash: true, detail: '目录为空；确认后只会将这个技能根目录移入系统废纸篓。', fingerprint };
    }
    if (!entries.every((entry) => entry.isSymbolicLink())) {
      return {
        classification: 'contains-data',
        canTrash: false,
        detail: '目录中包含实体文件或子目录。请在访达中查看；此工具不会自动清理实体技能。',
      };
    }
    const signatures: string[] = [];
    for (const entry of entries) {
      const entryPath = path.join(candidate.path, entry.name);
      let info: Stats;
      try {
        info = await lstat(entryPath);
      } catch (cause) {
        return { classification: 'unknown', canTrash: false, detail: `无法再次验证链接 ${entry.name}：${errorMessage(cause)}` };
      }
      if (!info.isSymbolicLink())
        return { classification: 'contains-data', canTrash: false, detail: '目录内容在检查时发生变化，请重新检查。' };
      const linkText = await readlink(entryPath)
        .catch((cause) => {
          throw appError('RESIDUAL_LINK_UNREADABLE', { name: entry.name, reason: errorMessage(cause) });
        })
        .catch((cause) => cause as Error);
      if (linkText instanceof Error) return { classification: 'unknown', canTrash: false, detail: linkText.message };
      signatures.push(`${entry.name}:${info.dev}:${info.ino}:${info.mode}:${info.mtimeMs}:${linkText}`);
      const linkPath = path.resolve(candidate.path, linkText);
      if (await this.pointsIntoLibrary(linkPath))
        return { classification: 'central-library', canTrash: false, detail: '目录中的链接指向中央技能库；不会触及中央库或其入口。' };
      if (await this.isLiveSkillLink(linkPath))
        return { classification: 'active', canTrash: false, detail: '目录中的链接仍指向可用技能；为保留 Harness 当前入口，不会清理。' };
    }
    const signature = signatures.sort().join('\0');
    const fingerprint = `${path.resolve(candidate.path)}\0${baseFingerprint}\0${signature}`;
    return {
      classification: 'symlink-only',
      canTrash: true,
      detail: '目录只包含符号链接；确认后只会将该根目录及其链接入口移入系统废纸篓，不会跟随或删除链接目标。',
      fingerprint,
    };
  }

  private async protectedPathReason(
    targetPath: string,
  ): Promise<{ classification: ResidualDirectoryClassification; detail: string } | undefined> {
    const resolved = path.resolve(targetPath);
    if (resolved === path.parse(resolved).root || resolved === this.home)
      return { classification: 'protected', detail: '不会清理文件系统根目录或用户主目录。' };
    const protectedAgentRoots = ['.codex', '.claude', '.agents'].map((name) => path.resolve(this.home, name));
    const safeSkillRoots = new Set(protectedAgentRoots.map((root) => path.resolve(root, 'skills')));
    for (const protectedRoot of protectedAgentRoots) {
      if (isWithin(resolved, protectedRoot) && !safeSkillRoots.has(resolved)) {
        return { classification: 'protected', detail: `不会清理 ${path.basename(protectedRoot)} 配置根目录或认证数据。` };
      }
    }
    try {
      const [candidateReal, libraryReal] = await Promise.all([realpath(resolved), realpath(this.store.root)]);
      const canonicalHome = await realpath(this.home).catch(() => this.home);
      const expectedReal = isWithin(this.home, resolved) ? path.resolve(canonicalHome, path.relative(this.home, resolved)) : resolved;
      if (path.resolve(candidateReal) !== path.resolve(expectedReal)) {
        return { classification: 'protected', detail: '目录路径经过符号链接重定向；为避免影响其它真实目录，不会清理。' };
      }
      if (overlaps(candidateReal, libraryReal) || overlaps(resolved, this.store.root)) {
        return { classification: 'central-library', detail: '目标与中央技能库重叠；不会清理。' };
      }
    } catch (cause) {
      if (!isMissingEntryError(cause)) return { classification: 'unknown', detail: `无法确认目录是否与中央库重叠：${errorMessage(cause)}` };
      if (overlaps(resolved, this.store.root)) return { classification: 'central-library', detail: '目标与中央技能库重叠；不会清理。' };
    }
    return undefined;
  }

  private async activeReferenceReason(targetPath: string): Promise<string | undefined> {
    const targets = this.safeList<Target>('targets');
    const bindings = this.safeList<Binding>('bindings');
    const distributions = this.safeList<Distribution>('distributions');
    if (distributions.some((item) => item.entryPath && isWithin(targetPath, item.entryPath))) {
      return '目录中存在中央库登记的受管分发；请先从对应 Harness 移除或迁移。';
    }
    const activeTargetIds = new Set(bindings.map((item) => item.targetId));
    if (targets.some((target) => activeTargetIds.has(target.id) && target.path && overlaps(targetPath, target.path))) {
      return '该目录仍被 Harness 安装绑定引用；请先从对应 Harness 移除或迁移。';
    }
    return undefined;
  }

  private async sharedReaderReason(candidate: CandidateRoot, harnesses: readonly Harness[]): Promise<string | undefined> {
    const workspaces = this.safeList<Workspace>('workspaces');
    const candidateCanonical = await canonicalizePath(candidate.path).catch(() => undefined);
    // Any registered reader blocks cleanup; the message names the most relevant one, not whichever record sorts first.
    let best: { rank: number; reason: string } | undefined;
    for (const peer of harnesses) {
      if (peer.id === candidate.harnessId) continue;
      const peerEnabled = isHarnessEnabled(peer);
      const checkedAt = this.latestStatusCheckedAt.get(peer.id) ?? 0;
      const status = peerEnabled && this.now() - checkedAt <= this.cacheMs ? (this.latestStatus.get(peer.id) ?? 'unknown') : 'unknown';
      if (peerEnabled && status === 'not-found') continue;
      const rank = peerEnabled && status === 'installed' ? 0 : peer.kind === 'universal' ? 1 : peerEnabled ? 2 : 3;
      if (best && best.rank <= rank) continue;
      const paths: string[] = [];
      if (candidate.scope === 'user') {
        for (const value of [peer.userSkillsPath, ...pathEntries(peer.extraUserSkillsPaths)]) {
          const expanded = typeof value === 'string' ? this.expandPath(value) : undefined;
          if (expanded) paths.push(expanded);
        }
        if (peer.readsUserAgents) paths.push(path.join(this.home, '.agents', 'skills'));
      } else {
        const workspace = workspaces.find((item) => item.id === candidate.workspaceId);
        if (!workspace?.path) continue;
        const relativePaths = [peer.workspaceSkillsRelativePath, ...pathEntries(peer.extraWorkspaceSkillsRelativePaths)];
        if (peer.readsWorkspaceAgents) relativePaths.push(path.join('.agents', 'skills'));
        for (const value of relativePaths) {
          if (!value) continue;
          try {
            const relative = validateWorkspaceRelativePath(value);
            paths.push(path.resolve(workspace.path, relative));
          } catch {
            /* Invalid saved relative paths never become deletion permissions. */
          }
        }
      }
      let canReadCandidate = false;
      for (const readPath of paths) {
        if (overlaps(candidate.path, readPath)) {
          canReadCandidate = true;
          break;
        }
        if (!candidateCanonical) continue;
        const peerCanonical = await canonicalizePath(readPath).catch(() => undefined);
        if (peerCanonical && overlaps(candidateCanonical.path, peerCanonical.path)) {
          canReadCandidate = true;
          break;
        }
      }
      if (!canReadCandidate) continue;
      const reason =
        rank === 0
          ? `${peer.name} 已安装并读取此共享技能目录；不会清理。`
          : rank === 1
            ? '该目录属于多个工具共享的通用 Agents 技能目录；不会清理。'
            : rank === 2
              ? `${peer.name} 的安装状态未确认，但它可能读取此共享目录；为保护数据，不允许清理。`
              : `${peer.name} 已禁用，但仍登记为此共享技能目录的读取方；不会清理或修改该目录。`;
      best = { rank, reason };
      if (rank === 0) break;
    }
    return best?.reason;
  }

  private async pointsIntoLibrary(targetPath: string): Promise<boolean> {
    try {
      const real = await realpath(targetPath);
      const library = await realpath(this.store.root);
      return isWithin(library, real);
    } catch {
      return false;
    }
  }

  private async isLiveSkillLink(targetPath: string): Promise<boolean> {
    try {
      const info = await stat(targetPath);
      return info.isDirectory() && (await stat(path.join(targetPath, 'SKILL.md'))).isFile();
    } catch {
      return false;
    }
  }

  private allStoredHarnesses(fallback: readonly Harness[]): Harness[] {
    const stored = this.safeList<Harness>('harnesses');
    const combined = new Map<string, Harness>();
    for (const harness of [...stored, ...fallback]) if (harness?.id) combined.set(harness.id, harness);
    return [...combined.values()];
  }

  private getKnownHarness(id: string): Harness | undefined {
    const stored = this.safeList<Harness>('harnesses').find((item) => item.id === id);
    return stored ?? this.knownHarnesses.get(id);
  }

  private safeList<T>(collection: string): T[] {
    try {
      return this.store.list<T>(collection);
    } catch {
      throw appError('INSTALLATION_STORE_UNREADABLE');
    }
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [harnessId, cached] of this.cache) if (cached.expiresAt <= now) this.cache.delete(harnessId);
    for (const [token, cleanup] of this.cleanups) if (cleanup.expiresAt <= now) this.cleanups.delete(token);
  }

  private async withDetectionSlot<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeDetections >= this.maxConcurrent) await new Promise<void>((resolve) => this.detectionWaiters.push(resolve));
    else this.activeDetections += 1;
    try {
      return await operation();
    } finally {
      const next = this.detectionWaiters.shift();
      if (next) next();
      else this.activeDetections -= 1;
    }
  }
}

export default HarnessInstallationService;
