import { appError } from './messages';
import { spawn, execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { t } from '../shared/i18n';

const exec = promisify(execFile);
export const currentMacApp = (execPath: string) => path.resolve(execPath, '../../..');
export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function macLocationReason(execPath: string): Promise<string | undefined> {
  const appPath = currentMacApp(execPath);
  if (!appPath.endsWith('.app') || /\/(?:AppTranslocation|Volumes)\//.test(appPath)) return t('appUpdate.moveToApplications');
  try {
    if ((await lstat(appPath)).isSymbolicLink() || /\/(?:AppTranslocation|Volumes)\//.test(await realpath(appPath)))
      return t('appUpdate.moveToApplications');
    await access(path.dirname(appPath), constants.W_OK);
  } catch {
    return t('appUpdate.moveToApplications');
  }
}

/** Values are fixed by the main process; every value is still quoted as one shell argument. */
export function macInstallScript(input: {
  pid: number;
  currentApp: string;
  stagedApp: string;
  resultPath: string;
  logPath: string;
  version: string;
}): string {
  const q = shellQuote;
  return `#!/bin/sh
umask 077
current=${q(input.currentApp)}
staged=${q(input.stagedApp)}
backup=${q(`${input.currentApp}.update-backup-${input.pid}`)}
result=${q(input.resultPath)}
log=${q(input.logPath)}
version=${q(input.version)}
exec > "$log" 2>&1
record() {
  permission=false
  if /usr/bin/grep -Eiq 'Operation not permitted|Permission denied|Read-only file system' "$log"; then permission=true; fi
  reason=$(/usr/bin/tail -c 4096 "$log" | /usr/bin/tr '\\n\\r' '  ' | /usr/bin/sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g')
  /usr/bin/printf '{"success":%s,"version":"%s","reason":"%s","permissionRequired":%s}\\n' "$1" "$version" "$reason" "$permission" > "$result.tmp"
  /bin/mv -f "$result.tmp" "$result"
}
fail() { echo "$1"; record false; exit 1; }
attempt=0
while /bin/kill -0 ${q(String(input.pid))} 2>/dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 6000 ] || fail 'Timed out waiting for application exit'
  /bin/sleep 0.1
done
[ ! -e "$backup" ] || fail 'Backup already exists'
/bin/mv "$current" "$backup" || fail 'Could not back up application'
restore() {
  /bin/rm -rf "$current"
  /bin/mv "$backup" "$current" || echo 'Could not restore backup'
  fail "$1"
}
/bin/mv "$staged" "$current" || restore 'Could not replace application'
/usr/bin/xattr -dr com.apple.quarantine "$current" || true
/usr/bin/open "$current" || restore 'Could not reopen application'
/bin/rm -rf "$backup" || fail 'Could not remove backup'
record true
`;
}

export async function spawnDetached(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export async function stageMacUpdate(file: string, version: string): Promise<string> {
  const staging = path.join(path.dirname(file), 'staging');
  await mkdir(staging, { recursive: false, mode: 0o700 });
  // Reject path traversal before extraction. The release checksum is verified separately.
  const { stdout: inventory } = await exec('/usr/bin/zipinfo', ['-1', file], { maxBuffer: 16 * 1024 * 1024 });
  if (inventory.split('\n').some((entry) => entry.startsWith('/') || entry.includes('\\') || entry.split('/').includes('..')))
    throw appError('APP_UPDATE_INVALID_BUNDLE');
  await exec('/usr/bin/ditto', ['-x', '-k', file, staging], { timeout: 120_000 });
  const entries = (await readdir(staging)).filter((entry) => entry !== '__MACOSX');
  if (entries.length !== 1 || entries[0] !== 'Harness Manager.app') throw appError('APP_UPDATE_INVALID_BUNDLE');
  const stagedApp = path.join(staging, entries[0]);
  const info = await lstat(stagedApp);
  if (!info.isDirectory() || info.isSymbolicLink()) throw appError('APP_UPDATE_INVALID_BUNDLE');
  const plist = path.join(stagedApp, 'Contents', 'Info.plist');
  const read = async (key: string) => (await exec('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plist])).stdout.trim();
  if (
    (await read('CFBundleIdentifier')) !== 'io.github.xuhuanhello.harness-manager' ||
    (await read('CFBundleShortVersionString')) !== version
  )
    throw appError('APP_UPDATE_INVALID_BUNDLE');
  return stagedApp;
}

export async function installMacUpdate(file: string, version: string, execPath: string, updatesRoot: string): Promise<void> {
  const reason = await macLocationReason(execPath);
  if (reason) throw appError('APP_UPDATE_LOCATION');
  const stagedApp = await stageMacUpdate(file, version);
  const scriptPath = path.join(path.dirname(file), 'install.sh');
  await writeFile(
    scriptPath,
    macInstallScript({
      pid: process.pid,
      currentApp: currentMacApp(execPath),
      stagedApp,
      version,
      resultPath: path.join(updatesRoot, 'last-result.json'),
      logPath: path.join(updatesRoot, 'install.log'),
    }),
    { mode: 0o700 },
  );
  await spawnDetached('/bin/sh', [scriptPath]);
}
