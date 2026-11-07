import { spawn, execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { currentMacApp, macInstallScript, macLocationReason, shellQuote, stageMacUpdate } from '../src/main/app-update-install';

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hm-update-'quoted-"));
  roots.push(root);
  return root;
}
async function app(directory: string, version: string, identifier = 'io.github.xuhuanhello.harness-manager') {
  await mkdir(path.join(directory, 'Contents'), { recursive: true });
  await writeFile(
    path.join(directory, 'Contents', 'Info.plist'),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
  );
  await writeFile(path.join(directory, 'version'), version);
}

it('quotes shell arguments literally and locates the enclosing app', async () => {
  expect(currentMacApp('/Applications/Harness Manager.app/Contents/MacOS/Harness Manager')).toBe('/Applications/Harness Manager.app');
  const value = "spaces 'quotes' $(echo BAD) `echo BAD`; new\nline";
  expect((await exec('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`])).stdout).toBe(value);
  expect(await macLocationReason('/Volumes/DMG/Harness Manager.app/Contents/MacOS/Harness Manager')).toBeTruthy();
  expect(await macLocationReason('/private/var/AppTranslocation/id/Harness Manager.app/Contents/MacOS/Harness Manager')).toBeTruthy();
});

describe.skipIf(process.platform !== 'darwin')('macOS updater helper integration', () => {
  it.each([false, true])('waits for the old PID, then replaces or rolls back the app (move fails: %s)', async (failMove) => {
    const root = await fixture();
    const current = path.join(root, 'Applications', 'Harness Manager.app');
    const staged = path.join(root, 'staging', 'Harness Manager.app');
    await app(current, '0.1.3');
    await app(staged, '0.2.0');
    const resultPath = path.join(root, 'last-result.json');
    const logPath = path.join(root, 'install.log');
    const old = spawn('/bin/sleep', ['0.5']);
    const exited = new Promise<void>((resolve) => old.once('exit', () => resolve()));
    const pid = old.pid!;
    let script = macInstallScript({
      pid,
      currentApp: current,
      stagedApp: failMove ? path.join(root, 'missing.app') : staged,
      resultPath,
      logPath,
      version: '0.2.0',
    });
    // Only launching is stubbed: file moves, rollback, PID wait and result/log writes run unchanged.
    script = script.replace('/usr/bin/open "$current"', '/usr/bin/true "$current"');
    const scriptFile = path.join(root, 'helper.sh');
    await writeFile(scriptFile, script);
    const start = Date.now();
    const run = exec('/bin/sh', [scriptFile]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readFile(path.join(current, 'version'), 'utf8')).toBe('0.1.3');
    await exited;
    const result = await run.catch((error: { code: number }) => ({ code: error.code }));
    expect(Date.now() - start).toBeGreaterThanOrEqual(400);
    const record = JSON.parse(await readFile(resultPath, 'utf8'));
    expect(record.success).toBe(!failMove);
    expect(record.version).toBe('0.2.0');
    expect(await readFile(path.join(current, 'version'), 'utf8')).toBe(failMove ? '0.1.3' : '0.2.0');
    await expect(access(`${current}.update-backup-${pid}`)).rejects.toThrow();
    if (failMove) {
      expect(result).toMatchObject({ code: 1 });
      expect(record.reason).toContain('Could not replace application');
    }
    expect(await readFile(logPath, 'utf8')).toEqual(expect.any(String));
  });

  it('extracts and validates bundle identity/version and rejects mismatches or duplicate apps', async () => {
    for (const mode of ['valid', 'identifier', 'version', 'duplicate']) {
      const root = await fixture();
      const source = path.join(root, 'source');
      const current = path.join(source, 'Harness Manager.app');
      await app(current, mode === 'version' ? '0.1.0' : '0.2.0', mode === 'identifier' ? 'evil.bundle' : undefined);
      if (mode === 'duplicate') await app(path.join(source, 'Other.app'), '0.2.0');
      const file = path.join(root, 'update.zip');
      await exec('/usr/bin/ditto', ['-c', '-k', source, file]);
      if (mode === 'valid') {
        expect(await stageMacUpdate(file, '0.2.0')).toBe(path.join(root, 'staging', 'Harness Manager.app'));
        expect(await macLocationReason(path.join(current, 'Contents', 'MacOS', 'Harness Manager'))).toBeUndefined();
      } else await expect(stageMacUpdate(file, '0.2.0')).rejects.toThrow();
    }
  });
});
