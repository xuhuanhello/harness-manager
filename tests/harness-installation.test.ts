import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HarnessInstallationService, type ExecuteFile } from '../src/main/harness-installation';
import { Store } from '../src/main/store';
import type { Harness } from '../src/shared/types';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});

async function fixture(options: { execute?: ExecuteFile; maxConcurrent?: number } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hm-installation-'));
  const home = path.join(root, 'home');
  await mkdir(home);
  const store = new Store(path.join(root, 'library'));
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const service = new HarnessInstallationService(store, { home, env: { PATH: '' }, ...options });
  return { root, home, store, service };
}

function harness(id: string, overrides: Partial<Harness> = {}): Harness {
  return {
    id,
    name: id,
    icon: 'test',
    userSkillsPath: `~/.${id}/skills`,
    workspaceSkillsRelativePath: '',
    origin: 'custom',
    kind: 'cli',
    enabled: true,
    ...overrides,
  };
}

async function executable(root: string, name = 'test-harness') {
  const file = path.join(root, name);
  await writeFile(file, '#!/bin/sh\nexit 0\n');
  await chmod(file, 0o755);
  return file;
}

it('uses direct bounded version execution and never infers installation from a configured skills directory', async () => {
  const f = await fixture();
  const binary = await executable(f.root);
  const execute = vi.fn<ExecuteFile>(async (_file, _args, _options) => ({ stdout: 'Harness 2.4.1\nmore output' }));
  const service = new HarnessInstallationService(f.store, { home: f.home, env: { PATH: '' }, execute });
  const installedHarness = harness('versioned', {
    executablePaths: [path.join(f.root, 'missing-one'), path.join(f.root, 'missing-two'), binary],
    versionArgs: ['--version'],
  });
  const installed = (await service.detect([installedHarness]))[0];
  expect(installed).toMatchObject({ status: 'installed', method: 'version-command', executable: binary, version: 'Harness 2.4.1' });
  expect(execute).toHaveBeenCalledWith(
    binary,
    ['--version'],
    expect.objectContaining({ shell: false, timeout: 5000, maxBuffer: 16 * 1024 }),
  );

  const skillRoot = path.join(f.home, '.configured-only', 'skills');
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(skillRoot, 'SKILL.md'), 'user data');
  const absent = harness('configured-only', { userSkillsPath: skillRoot, command: 'not-a-real-harness-installation-test-command' });
  const absentResult = (await service.detect([absent], { refresh: true }))[0];
  expect(absentResult.status).toBe('not-found');
  expect(absentResult.residualDirectories).toContainEqual(
    expect.objectContaining({ path: skillRoot, classification: 'contains-data', canTrash: false }),
  );
});

it('coalesces concurrent checks, limits parallel commands, and caches each selected harness independently', async () => {
  const f = await fixture();
  const binary = await executable(f.root);
  let inProgress = 0;
  let maxInProgress = 0;
  let calls = 0;
  const execute: ExecuteFile = async () => {
    calls += 1;
    inProgress += 1;
    maxInProgress = Math.max(maxInProgress, inProgress);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inProgress -= 1;
    return { stdout: '1.0' };
  };
  const service = new HarnessInstallationService(f.store, { home: f.home, env: { PATH: '' }, execute, maxConcurrent: 2 });
  const h1 = harness('cache-one', { executablePaths: [binary] });
  const h2 = harness('cache-two', { executablePaths: [binary] });
  const h3 = harness('cache-three', { executablePaths: [binary] });
  const h4 = harness('cache-four', { executablePaths: [binary] });
  const [first, duplicate] = await Promise.all([service.detect([h1]), service.detect([h1])]);
  expect(first[0].status).toBe('installed');
  expect(duplicate[0].status).toBe('installed');
  expect(calls).toBe(1);

  await service.detect([h1, h2, h3, h4]);
  expect(calls).toBe(4);
  expect(maxInProgress).toBeLessThanOrEqual(2);
  await service.detect([h1]);
  expect(calls).toBe(4);
  await service.detect([h1], { refresh: true });
  expect(calls).toBe(5);
  await service.detect([h2]);
  expect(calls).toBe(5);
});

it('matches editor extensions by exact manifest identity without executing extension code', async () => {
  const f = await fixture({
    execute: vi.fn<ExecuteFile>(async () => {
      throw new Error('must not execute');
    }),
  });
  const extensions = path.join(f.home, '.vscode', 'extensions');
  const lookalike = path.join(extensions, 'publisher.tool-1.0.0');
  const exact = path.join(extensions, 'anything-at-all');
  await mkdir(lookalike, { recursive: true });
  await mkdir(exact, { recursive: true });
  await writeFile(path.join(lookalike, 'package.json'), JSON.stringify({ publisher: 'publisher', name: 'tooling', version: '1.0.0' }));
  await writeFile(path.join(exact, 'package.json'), JSON.stringify({ publisher: 'publisher', name: 'tool', version: '2.2.0' }));
  const editor = harness('extension-tool', { extensionIds: ['publisher.tool'] } as Partial<Harness>);
  const detected = (await f.service.detect([editor]))[0];
  expect(detected).toMatchObject({ status: 'installed', method: 'editor-extension', executable: exact, version: '2.2.0' });
});

it('does not infer absence from an app bundle path on a platform that cannot inspect bundles', async () => {
  const f = await fixture();
  const appOnly = harness('desktop-only', { appPaths: ['/Applications/Example.app'] });
  const service = new HarnessInstallationService(f.store, { home: f.home, env: { PATH: '' }, platform: 'linux' });
  const result = (await service.detect([appOnly]))[0];
  expect(result.status).toBe('unknown');
  expect(result.residualDirectories.every((directory) => !directory.canTrash)).toBe(true);
});

it('requires fresh not-found status and an unchanged safe directory before moving it to Trash', async () => {
  const trashed: string[] = [];
  const f = await fixture();
  const service = new HarnessInstallationService(f.store, {
    home: f.home,
    env: { PATH: '' },
    trashItem: async (directory) => {
      trashed.push(directory);
    },
  });
  const root = path.join(f.home, '.cleanup-target', 'skills');
  await mkdir(root, { recursive: true });
  const target = harness('cleanup-target', { userSkillsPath: root, command: 'not-a-real-cleanup-target-command' });
  f.store.put('harnesses', target);

  const preview = await service.previewCleanup({ harnessId: target.id, path: root });
  expect(preview).toMatchObject({ canTrash: true, classification: 'empty' });
  expect(preview.token).toBeTruthy();
  await writeFile(path.join(root, 'new-user-file.txt'), 'preserve');
  await expect(service.cleanup({ token: preview.token! })).rejects.toThrow(/变化/);
  expect(trashed).toEqual([]);

  await rm(root, { recursive: true });
  await mkdir(root, { recursive: true });
  const secondPreview = await service.previewCleanup({ harnessId: target.id, path: root });
  expect(secondPreview.canTrash).toBe(true);
  await service.cleanup({ token: secondPreview.token! });
  expect(trashed).toEqual([root]);
  await expect(service.cleanup({ token: secondPreview.token! })).rejects.toThrow(/失效/);
});

it('never cleans installed, unknown, linked, or entity-containing roots and protects symlink targets', async () => {
  const f = await fixture();
  const binary = await executable(f.root, 'installed');
  const service = new HarnessInstallationService(f.store, {
    home: f.home,
    env: { PATH: '' },
    execute: async () => ({ stdout: 'installed' }),
    trashItem: async () => {
      throw new Error('unexpected trash');
    },
  });
  const installedRoot = path.join(f.home, '.installed', 'skills');
  await mkdir(installedRoot, { recursive: true });
  const installed = harness('installed', { executablePaths: [binary], userSkillsPath: installedRoot });
  f.store.put('harnesses', installed);
  const installedPreview = await service.previewCleanup({ harnessId: installed.id, path: installedRoot });
  expect(installedPreview.canTrash).toBe(false);
  expect(installedPreview.classification).toBe('active');

  const entityRoot = path.join(f.home, '.entity', 'skills');
  await mkdir(entityRoot, { recursive: true });
  await writeFile(path.join(entityRoot, 'SKILL.md'), 'preserve');
  const missing = harness('entity', { userSkillsPath: entityRoot, command: 'missing-entity-harness' });
  f.store.put('harnesses', missing);
  const entityPreview = await service.previewCleanup({ harnessId: missing.id, path: entityRoot });
  expect(entityPreview).toMatchObject({ canTrash: false, classification: 'contains-data' });

  const actualTarget = path.join(f.root, 'outside-target');
  await mkdir(actualTarget);
  await writeFile(path.join(actualTarget, 'keep.txt'), 'preserve');
  const linkRoot = path.join(f.home, '.link-only', 'skills');
  await mkdir(linkRoot, { recursive: true });
  await symlink(actualTarget, path.join(linkRoot, 'outside'));
  const linkHarness = harness('link-only', { userSkillsPath: linkRoot, command: 'missing-link-harness' });
  f.store.put('harnesses', linkHarness);
  const linkPreview = await service.previewCleanup({ harnessId: linkHarness.id, path: linkRoot });
  expect(linkPreview).toMatchObject({ canTrash: true, classification: 'symlink-only' });
  // Preview is read-only; the symbolic link target remains intact.
  expect(await readFile(path.join(actualTarget, 'keep.txt'), 'utf8')).toBe('preserve');

  const missingRoot = path.join(f.home, '.unknown', 'skills');
  const unknown = harness('unknown', { userSkillsPath: missingRoot });
  f.store.put('harnesses', unknown);
  const unknownPreview = await service.previewCleanup({ harnessId: unknown.id, path: missingRoot });
  expect(unknownPreview.canTrash).toBe(false);
});

it('protects shared readers, redirected parents, and tool config that remains without a skills directory', async () => {
  const f = await fixture({ execute: async () => ({ stdout: '1.0' }) });
  const service = f.service;
  const sharedRoot = path.join(f.home, '.shared-agent', 'skills');
  await mkdir(sharedRoot, { recursive: true });
  const orphan = harness('orphan-agent', { userSkillsPath: sharedRoot, command: 'missing-orphan-agent' });
  const readerBinary = await executable(f.root, 'reader');
  const reader = harness('installed-reader', {
    executablePaths: [readerBinary],
    extraUserSkillsPaths: [sharedRoot],
    userSkillsPath: path.join(f.home, '.reader', 'skills'),
  });
  f.store.put('harnesses', orphan);
  f.store.put('harnesses', reader);
  const [orphanResult] = await service.detect([orphan, reader], { refresh: true });
  expect(orphanResult.residualDirectories).toContainEqual(
    expect.objectContaining({ path: sharedRoot, classification: 'active', canTrash: false }),
  );

  const symlinkTarget = path.join(f.home, '.symlink-target', 'skills');
  await mkdir(symlinkTarget, { recursive: true });
  const peerAlias = path.join(f.home, '.peer-alias', 'skills');
  await mkdir(path.dirname(peerAlias), { recursive: true });
  await symlink(symlinkTarget, peerAlias);
  const symlinkCandidate = harness('symlink-candidate', { userSkillsPath: symlinkTarget, command: 'missing-symlink-candidate' });
  const symlinkPeer = harness('symlink-peer', { userSkillsPath: peerAlias, executablePaths: [readerBinary] });
  f.store.put('harnesses', symlinkCandidate);
  f.store.put('harnesses', symlinkPeer);
  const [symlinkCandidateResult] = await f.service.detect([symlinkCandidate, symlinkPeer], { refresh: true });
  expect(symlinkCandidateResult.residualDirectories).toContainEqual(
    expect.objectContaining({ path: symlinkTarget, classification: 'active', canTrash: false }),
  );

  const redirected = path.join(f.home, '.redirected');
  const outside = path.join(f.root, 'redirected-outside');
  await mkdir(outside, { recursive: true });
  await symlink(outside, redirected);
  const redirectedSkills = path.join(redirected, 'skills');
  await mkdir(redirectedSkills);
  const redirectHarness = harness('redirected', { userSkillsPath: redirectedSkills, command: 'missing-redirected-harness' });
  f.store.put('harnesses', redirectHarness);
  const preview = await service.previewCleanup({ harnessId: redirectHarness.id, path: redirectedSkills });
  expect(preview).toMatchObject({ canTrash: false, classification: 'protected' });

  const claudeRoot = path.join(f.home, '.claude');
  await mkdir(claudeRoot);
  await writeFile(path.join(claudeRoot, 'settings.json'), '{}');
  const claude = harness('claude-tool', { userSkillsPath: path.join(claudeRoot, 'skills'), command: 'missing-claude-tool' });
  const claudeResult = (await service.detect([claude], { refresh: true }))[0];
  expect(claudeResult.residualDirectories).toContainEqual(
    expect.objectContaining({ path: claudeRoot, classification: 'contains-data', canTrash: false }),
  );
  expect(claudeResult.residualDirectories.some((item) => item.path === path.join(f.home, '.agents'))).toBe(false);
});

it('refuses cleanup when management records cannot be read', async () => {
  const f = await fixture();
  const brokenStore = {
    root: f.store.root,
    list<T>(_collection: string): T[] {
      throw new Error('database unavailable');
    },
  };
  const service = new HarnessInstallationService(brokenStore, {
    home: f.home,
    env: { PATH: '' },
    trashItem: async () => {
      throw new Error('unexpected trash');
    },
  });
  await expect(service.previewCleanup({ harnessId: 'missing', path: path.join(f.home, '.missing/skills') })).rejects.toThrow(
    '无法读取本地管理记录',
  );
});

it('accepts a renamed desktop bundle only when its bundle identifier matches', async () => {
  const f = await fixture();
  const applications = path.join(f.root, 'Applications');
  const writeBundle = async (relativePath: string, plist: string | Buffer) => {
    const app = path.join(applications, relativePath);
    await mkdir(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    await writeFile(path.join(app, 'Contents', 'Info.plist'), plist);
    await executable(path.join(app, 'Contents', 'MacOS'), 'ChatGPT');
    return app;
  };
  const xmlPlist = (identifier: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>ChatGPT</string><key>CFBundleIdentifier</key><string>${identifier}</string></dict></plist>`;
  const desktop = (appPaths: string[]) => harness('codex-desktop', { kind: 'desktop', appPaths, appBundleIds: ['com.openai.codex'] });
  const service = new HarnessInstallationService(f.store, { home: f.home, env: { PATH: '' }, platform: 'darwin' });
  const codex = await writeBundle('ChatGPT.app', xmlPlist('com.openai.codex'));
  const classic = await writeBundle('Classic/ChatGPT.app', xmlPlist('com.openai.chat'));

  expect((await service.detect([desktop([codex])], { refresh: true }))[0]).toMatchObject({
    status: 'installed',
    method: 'app-bundle',
    executable: codex,
  });
  expect((await service.detect([desktop([classic])], { refresh: true }))[0].status).toBe('not-found');
  expect((await service.detect([desktop([classic, codex])], { refresh: true }))[0]).toMatchObject({
    status: 'installed',
    executable: codex,
  });
  expect((await service.detect([harness('plain-desktop', { kind: 'desktop', appPaths: [classic] })], { refresh: true }))[0].status).toBe(
    'installed',
  );

  const binary = await writeBundle('Binary/ChatGPT.app', Buffer.from('bplist00 binary plist fixture'));
  const plutil = vi.fn<ExecuteFile>(async () => ({ stdout: 'com.openai.codex\n' }));
  const binaryService = new HarnessInstallationService(f.store, { home: f.home, env: { PATH: '' }, platform: 'darwin', execute: plutil });
  expect((await binaryService.detect([desktop([binary])], { refresh: true }))[0].status).toBe('installed');
  expect(plutil).toHaveBeenCalledWith(
    '/usr/bin/plutil',
    ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(binary, 'Contents', 'Info.plist')],
    expect.objectContaining({ shell: false }),
  );
  const unreadable = new HarnessInstallationService(f.store, {
    home: f.home,
    env: { PATH: '' },
    platform: 'darwin',
    execute: async () => {
      throw new Error('plutil failed');
    },
  });
  expect((await unreadable.detect([desktop([binary])], { refresh: true }))[0].status).toBe('unknown');
});

it('lets script launchers find their interpreter when the app inherited a minimal PATH', async () => {
  const f = await fixture();
  const runtimeBin = path.join(f.home, '.nvm', 'versions', 'node', 'v24.0.0', 'bin');
  await mkdir(runtimeBin, { recursive: true });
  const interpreter = path.join(runtimeBin, 'hm-test-runtime');
  await writeFile(interpreter, '#!/bin/sh\necho "launcher 3.1.4"\n');
  await chmod(interpreter, 0o755);
  const launcherDirectory = path.join(f.home, '.npm-global', 'bin');
  await mkdir(launcherDirectory, { recursive: true });
  const launcher = path.join(launcherDirectory, 'hm-test-launcher');
  await writeFile(launcher, '#!/usr/bin/env hm-test-runtime\n');
  await chmod(launcher, 0o755);
  const service = new HarnessInstallationService(f.store, { home: f.home, env: { PATH: '/usr/bin:/bin' } });
  const result = (await service.detect([harness('script-launcher', { command: 'hm-test-launcher' })], { refresh: true }))[0];
  expect(result).toMatchObject({ status: 'installed', method: 'version-command', executable: launcher, version: 'launcher 3.1.4' });
});

it('never reports the shared .agents/skills roots as one product\u2019s residue', async () => {
  const f = await fixture({ execute: async () => ({ stdout: '1.0' }) });
  const workspace = path.join(f.root, 'workspace');
  const workspaceUniversal = path.join(workspace, '.agents', 'skills');
  await mkdir(workspaceUniversal, { recursive: true });
  f.store.put('workspaces', { id: 'workspace-a', path: workspace, name: 'workspace' });
  const universalRoot = path.join(f.home, '.agents', 'skills');
  const legacyRoot = path.join(f.home, '.codex-like', 'skills');
  await mkdir(universalRoot, { recursive: true });
  await mkdir(legacyRoot, { recursive: true });
  const universal = harness('universal', {
    name: '通用 Agents 技能',
    kind: 'universal',
    origin: 'builtin',
    userSkillsPath: '~/.agents/skills',
    workspaceSkillsRelativePath: '.agents/skills',
    readsUserAgents: true,
    readsWorkspaceAgents: true,
  });
  const disabledReader = harness('amp', { name: 'Amp', enabled: false, readsUserAgents: true, readsWorkspaceAgents: true });
  const missing = harness('codex-like', {
    kind: 'desktop',
    userSkillsPath: '~/.agents/skills',
    workspaceSkillsRelativePath: '.agents/skills',
    extraUserSkillsPaths: [legacyRoot],
    command: 'missing-codex-like-app',
  });
  for (const item of [universal, disabledReader, missing]) f.store.put('harnesses', item);

  const [result] = await f.service.detect([missing], { refresh: true });
  expect(result.status).toBe('not-found');
  const listed = result.residualDirectories.map((item) => item.path);
  expect(listed).not.toContain(universalRoot);
  expect(listed).not.toContain(workspaceUniversal);
  expect(listed).toContain(legacyRoot);
  const preview = await f.service.previewCleanup({ harnessId: missing.id, path: universalRoot });
  expect(preview.canTrash).toBe(false);

  // A root nested inside the shared directory is explained by the universal record, not a disabled peer.
  const nested = path.join(universalRoot, 'nested-root');
  await mkdir(nested);
  const nestedHarness = harness('nested-missing', { userSkillsPath: nested, command: 'missing-nested-harness' });
  f.store.put('harnesses', nestedHarness);
  const [nestedResult] = await f.service.detect([nestedHarness], { refresh: true });
  expect(nestedResult.residualDirectories).toContainEqual(
    expect.objectContaining({
      path: nested,
      classification: 'active',
      canTrash: false,
      detail: expect.stringContaining('通用 Agents 技能目录'),
    }),
  );
  expect(nestedResult.residualDirectories.some((item) => item.detail.includes('Amp'))).toBe(false);

  const readerBinary = await executable(f.root, 'agents-reader');
  f.store.put('harnesses', harness('agents-reader', { name: 'Agents Reader', executablePaths: [readerBinary], readsUserAgents: true }));
  const withReader = await f.service.detect(f.store.list<Harness>('harnesses'), { refresh: true });
  expect(withReader.find((item) => item.harnessId === nestedHarness.id)?.residualDirectories).toContainEqual(
    expect.objectContaining({ path: nested, canTrash: false, detail: expect.stringContaining('Agents Reader 已安装') }),
  );
});

it('does not present another product\u2019s own directory as a compatibility reader\u2019s leftover', async () => {
  const f = await fixture();
  const claudeRoot = path.join(f.home, '.claude');
  await mkdir(claudeRoot);
  await writeFile(path.join(claudeRoot, 'settings.json'), '{}');
  const workspace = path.join(f.root, 'workspace');
  await mkdir(path.join(workspace, '.claude', 'skills'), { recursive: true });
  await mkdir(path.join(workspace, '.goose-like', 'skills'), { recursive: true });
  f.store.put('workspaces', { id: 'workspace-b', path: workspace, name: 'workspace' });
  const owner = harness('claude-like', {
    userSkillsPath: '~/.claude/skills',
    workspaceSkillsRelativePath: '.claude/skills',
    command: 'missing-claude-like',
  });
  const reader = harness('goose-like', {
    userSkillsPath: '~/.goose-like/skills',
    workspaceSkillsRelativePath: '.goose-like/skills',
    extraUserSkillsPaths: ['~/.claude/skills'],
    extraWorkspaceSkillsRelativePaths: ['.claude/skills'],
    command: 'missing-goose-like',
  });
  for (const item of [owner, reader]) f.store.put('harnesses', item);

  const results = await f.service.detect([owner, reader], { refresh: true });
  const readerPaths = results.find((item) => item.harnessId === reader.id)!.residualDirectories.map((item) => item.path);
  expect(readerPaths).not.toContain(claudeRoot);
  expect(readerPaths).not.toContain(path.join(claudeRoot, 'skills'));
  expect(readerPaths).not.toContain(path.join(workspace, '.claude', 'skills'));
  expect(readerPaths).toContain(path.join(workspace, '.goose-like', 'skills'));
  const ownerPaths = results.find((item) => item.harnessId === owner.id)!.residualDirectories.map((item) => item.path);
  expect(ownerPaths).toContain(claudeRoot);
  expect(ownerPaths).toContain(path.join(workspace, '.claude', 'skills'));
});

it('names the most relevant shared reader while any registered reader still blocks cleanup', async () => {
  const f = await fixture({ execute: async () => ({ stdout: '1.0' }) });
  const sharedRoot = path.join(f.home, '.shared-legacy', 'skills');
  await mkdir(sharedRoot, { recursive: true });
  const readerBinary = await executable(f.root, 'installed-peer');
  const candidate = harness('zz-missing', { userSkillsPath: sharedRoot, command: 'missing-zz-harness' });
  const disabledPeer = harness('aa-disabled', { name: 'Disabled Peer', enabled: false, extraUserSkillsPaths: [sharedRoot] });
  const installedPeer = harness('mm-installed', {
    name: 'Installed Peer',
    executablePaths: [readerBinary],
    extraUserSkillsPaths: [sharedRoot],
  });
  for (const item of [candidate, disabledPeer, installedPeer]) f.store.put('harnesses', item);

  const first = await f.service.detect(f.store.list<Harness>('harnesses'), { refresh: true });
  expect(first.find((item) => item.harnessId === candidate.id)?.residualDirectories).toContainEqual(
    expect.objectContaining({
      path: sharedRoot,
      classification: 'active',
      canTrash: false,
      detail: expect.stringContaining('Installed Peer 已安装'),
    }),
  );

  f.store.put('harnesses', { ...installedPeer, enabled: false });
  const second = await f.service.detect(f.store.list<Harness>('harnesses'), { refresh: true });
  expect(second.find((item) => item.harnessId === candidate.id)?.residualDirectories).toContainEqual(
    expect.objectContaining({
      path: sharedRoot,
      classification: 'active',
      canTrash: false,
      detail: expect.stringContaining('Disabled Peer 已禁用'),
    }),
  );
  const preview = await f.service.previewCleanup({ harnessId: candidate.id, path: sharedRoot });
  expect(preview).toMatchObject({ canTrash: false, classification: 'active' });
});
