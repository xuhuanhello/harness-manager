import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { HarnessInstallationService, type ExecuteFile } from '../src/main/harness-installation';
import { runWindowsBatch, windowsPathEntries } from '../src/main/windows-cli';
import { BUILTIN_HARNESSES } from '../src/shared/harness-registry';
import type { Harness } from '../src/shared/types';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hm-windows-detection-'));
  roots.push(root);
  const home = path.join(root, 'Profile with spaces');
  await mkdir(home);
  const env = {
    ...process.env,
    PATH: '',
    APPDATA: path.join(root, 'Roaming'),
    LOCALAPPDATA: path.join(root, 'Local'),
    ProgramFiles: path.join(root, 'Programs'),
  };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path' && key !== 'PATH') delete env[key as keyof typeof env];
  const store = { root: path.join(root, 'library'), list: <T>() => [] as T[] };
  return { root, home, env, store };
}
async function file(directory: string, name: string, contents = 'fixture') {
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, name);
  await writeFile(target, contents);
  return target;
}
function builtins(...ids: string[]): Harness[] {
  return BUILTIN_HARNESSES.filter((item) => ids.includes(item.id)).map((item) => ({ ...item, enabled: true }));
}
const fakeVersion: ExecuteFile = async (command) => ({ stdout: command.endsWith('powershell.exe') ? '[]' : 'fixture 1.2.3' });

it('finds official native Claude and standalone Codex locations with a minimal GUI PATH', async () => {
  const f = await fixture();
  const claude = await file(path.join(f.home, '.local', 'bin'), 'claude.exe');
  const codex = await file(path.join(f.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin'), 'codex.exe');
  const service = new HarnessInstallationService(f.store, { home: f.home, env: f.env, platform: 'win32', execute: fakeVersion });
  const results = await service.detect(builtins('claude-code', 'codex'));
  expect(results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ harnessId: 'claude-code', status: 'installed', executable: claude }),
      expect.objectContaining({ harnessId: 'codex', status: 'installed', executable: codex }),
    ]),
  );
  await rm(claude);
  const wingetClaude = await file(path.join(f.env.LOCALAPPDATA, 'Programs', 'claude'), 'claude.exe');
  expect((await service.detect(builtins('claude-code'), { refresh: true }))[0].executable).toBe(wingetClaude);
});

it('does not let missing entries in a long PATH hide native or npm installations', async () => {
  const f = await fixture();
  const lateDirectory = path.join(f.root, 'late native installation');
  const codex = await file(lateDirectory, 'codex.exe');
  const npm = path.join(f.env.APPDATA, 'npm');
  const gemini = await file(npm, 'gemini.cmd');
  const pi = await file(npm, 'pi.cmd');
  const copilot = await file(npm, 'copilot.cmd');
  const env = { ...f.env, PATH: [...Array.from({ length: 90 }, (_, i) => path.join(f.root, `missing-${i}`)), lateDirectory].join(';') };
  const execute = vi.fn<ExecuteFile>(fakeVersion);
  const service = new HarnessInstallationService(f.store, { home: f.home, env, platform: 'win32', execute });
  const results = await service.detect(builtins('codex', 'gemini-cli', 'pi', 'github-copilot-cli'));
  expect(results.map((result) => result.executable)).toEqual([codex, gemini, copilot, pi]);
  expect(results.every((result) => result.status === 'installed')).toBe(true);
  expect(execute.mock.calls.filter(([command]) => command.endsWith('powershell.exe'))).toHaveLength(1);
});

it('merges fresh registry PATH, expands variables, keeps inherited precedence, and canonicalizes the child PATH', async () => {
  const f = await fixture();
  const inherited = path.join(f.root, 'first');
  const registry = path.join(f.root, '安装位置');
  const first = await file(inherited, 'codex.exe');
  const second = await file(registry, 'codex.exe');
  const execute = vi.fn<ExecuteFile>(async (command) => ({
    stdout: command.endsWith('powershell.exe') ? JSON.stringify(['%CLI_LOCATION%', inherited.toUpperCase()]) : 'codex 1.2.3',
  }));
  const env = { ...f.env, PATH: undefined, Path: `"${inherited}"`, cli_location: registry };
  const service = new HarnessInstallationService(f.store, { home: f.home, env, platform: 'win32', execute });
  expect((await service.detect(builtins('codex')))[0].executable).toBe(first);
  const commandEnv = execute.mock.calls.find(([command]) => command === first)![2].env;
  expect(Object.keys(commandEnv).filter((key) => key.toLowerCase() === 'path')).toEqual(['PATH']);
  expect(commandEnv.PATH?.split(';')).toContain(registry);
  await rm(first);
  expect((await service.detect(builtins('codex'), { refresh: true }))[0].executable).toBe(second);
  expect(windowsPathEntries(';"%CLI_LOCATION%";;', env)).toEqual([registry]);
});

it('does not execute Windows Store aliases or report their presence as absence', async () => {
  const f = await fixture();
  const directory = path.join(f.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps');
  const alias = await file(directory, 'codex.exe');
  const execute = vi.fn<ExecuteFile>(fakeVersion);
  const service = new HarnessInstallationService(f.store, { home: f.home, env: { ...f.env, PATH: directory }, platform: 'win32', execute });
  const [result] = await service.detect(builtins('codex'));
  expect(result.status).toBe('unknown');
  expect(execute.mock.calls.some(([command]) => command === alias)).toBe(false);
  expect(result.residualDirectories.every((directory) => !directory.canTrash)).toBe(true);
});

it.runIf(process.platform === 'win32')('executes native EXEs from official directories on real Windows', async () => {
  const f = await fixture();
  const claude = await file(path.join(f.home, '.local', 'bin'), 'claude.exe');
  const codex = await file(path.join(f.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin'), 'codex.exe');
  await copyFile(process.execPath, claude);
  await copyFile(process.execPath, codex);
  const execute: ExecuteFile = async (command, args, options) =>
    command.endsWith('powershell.exe') ? { stdout: '[]' } : exec(command, args, options);
  const service = new HarnessInstallationService(f.store, { home: f.home, env: f.env, execute });
  const results = await service.detect(builtins('claude-code', 'codex'));
  expect(results.map((result) => result.executable)).toEqual([claude, codex]);
  expect(results.every((result) => result.status === 'installed' && result.version === process.version)).toBe(true);
});

it.runIf(process.platform === 'win32')('runs an npm-style launcher with literal arguments and a recovered Node PATH', async () => {
  const f = await fixture();
  const npm = path.join(f.env.APPDATA, 'npm with spaces & 工具');
  const launcher = await file(npm, 'codex.cmd', '@echo off\r\nnode "%~dp0version.cjs" %*\r\n');
  const literal = '--version & echo injected';
  const output = path.join(f.root, 'arguments.json');
  await file(
    npm,
    'version.cjs',
    "require('node:fs').writeFileSync(process.env.HM_TEST_OUTPUT, JSON.stringify(process.argv.slice(2))); console.log('codex-cli fixture');",
  );
  const execute: ExecuteFile = async (command, args, options) =>
    command.endsWith('powershell.exe')
      ? { stdout: JSON.stringify([`${npm};${path.dirname(process.execPath)}`, null]) }
      : runWindowsBatch(command, args, options);
  const env = { ...f.env, HM_TEST_OUTPUT: output };
  const service = new HarnessInstallationService(f.store, { home: f.home, env, execute });
  const codex = { ...builtins('codex')[0], versionArgs: [literal] };
  const [result] = await service.detect([codex]);
  expect(result).toMatchObject({ status: 'installed', executable: launcher, version: 'codex-cli fixture' });
  expect(JSON.parse(await readFile(output, 'utf8'))).toEqual([literal]);
  const canonical = path.toNamespacedPath(launcher);
  await runWindowsBatch(canonical, [literal], {
    cwd: f.home,
    env: { ...env, PATH: path.dirname(process.execPath) },
    timeout: 5000,
    maxBuffer: 16 * 1024,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
  });
  expect(JSON.parse(await readFile(output, 'utf8'))).toEqual([literal]);
});

it.runIf(process.platform === 'win32')('bounds batch launcher output and terminates a hanging launcher', async () => {
  const f = await fixture();
  const directory = path.join(f.root, 'scripts');
  const noisy = await file(directory, 'noisy.cmd', '@echo off\r\nnode -e "process.stdout.write(\'x\'.repeat(20000))"\r\n');
  const hanging = await file(directory, 'hanging.cmd', '@echo off\r\nnode "%~dp0hang.cjs"\r\n');
  const pidPath = path.join(f.root, 'child-pid');
  await file(
    directory,
    'hang.cjs',
    "require('node:fs').writeFileSync(process.env.HM_TEST_PID, String(process.pid)); setInterval(()=>{},1000);",
  );
  const options = {
    cwd: f.home,
    env: { ...process.env, HM_TEST_PID: pidPath },
    timeout: 2000,
    maxBuffer: 1024,
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
  } as const;
  await expect(runWindowsBatch(noisy, [], options)).rejects.toMatchObject({ code: 'INSTALLATION_COMMAND_OUTPUT_LIMIT' });
  await expect(runWindowsBatch(hanging, [], options)).rejects.toMatchObject({ code: 'INSTALLATION_COMMAND_TIMEOUT', killed: true });
  const pid = Number(await readFile(pidPath, 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
});

it.runIf(process.platform === 'win32')('uses the real Windows registry reader and default native executor', async () => {
  const f = await fixture();
  const binary = await file(path.join(f.home, '.local', 'bin'), 'hm-native-detection-fixture.exe');
  await copyFile(process.execPath, binary);
  const target = { ...builtins('codex')[0], id: 'native-fixture', command: 'hm-native-detection-fixture' };
  const service = new HarnessInstallationService(f.store, { home: f.home, env: f.env });
  expect((await service.detect([target]))[0]).toMatchObject({ status: 'installed', executable: binary, version: process.version });
  await rm(binary);
  const launcher = await file(path.join(f.env.APPDATA, 'npm'), `${target.command}.cmd`, '@echo off\r\necho native-fixture 1.2.3\r\n');
  expect((await service.detect([target], { refresh: true }))[0]).toMatchObject({
    status: 'installed',
    executable: launcher,
    version: 'native-fixture 1.2.3',
  });
});
