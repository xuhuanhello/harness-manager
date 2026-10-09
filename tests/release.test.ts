import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/release.mjs', import.meta.url));
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const prefix = `${pkg.name}-${pkg.version}`;
const names = [`${prefix}-mac-arm64.dmg`, `${prefix}-mac-arm64.zip`, `${prefix}-win-x64-portable.exe`, `${prefix}-win-x64-setup.exe`];
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'harness-release-test-'));
  roots.push(root);
  for (const name of names) await writeFile(path.join(root, name), `installer fixture: ${name}`);
  return root;
}
function run(root: string, args: string[], tag = `v${pkg.version}`) {
  return exec(process.execPath, [script, ...args], {
    env: { ...process.env, RELEASE_TAG: tag, GITHUB_OUTPUT: path.join(root, 'metadata-output') },
  });
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('release publication boundary', () => {
  it('rejects mismatched and unsafe tags before emitting metadata', async () => {
    const root = await fixture();
    for (const tag of ['v999.0.0', `v${pkg.version}; echo unwanted`, '../main']) {
      await expect(run(root, ['metadata'], tag)).rejects.toMatchObject({ code: 1 });
    }
    await expect(readFile(path.join(root, 'metadata-output'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects extra private files and symbolic links before preparing uploads', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'internal-report.md'), 'private report fixture');
    await expect(run(root, ['prepare', root])).rejects.toMatchObject({ code: 1 });
    await expect(readFile(path.join(root, 'SHA256SUMS.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(path.join(root, 'internal-report.md'));
    await rm(path.join(root, names[0]));
    await symlink(path.join(root, names[1]), path.join(root, names[0]));
    await expect(run(root, ['prepare', root])).rejects.toMatchObject({ code: 1 });
    await expect(readFile(path.join(root, 'SHA256SUMS.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires all platform installers and hashes only the complete inventory', async () => {
    const root = await fixture();
    await rm(path.join(root, names[0]));
    await expect(run(root, ['prepare', root])).rejects.toMatchObject({ code: 1 });
    await expect(readFile(path.join(root, 'RELEASE_NOTES.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path.join(root, names[0]), `installer fixture: ${names[0]}`);
    await run(root, ['prepare', root]);
    const expected = [...names].sort().map((name) => {
      const hash = createHash('sha256').update(`installer fixture: ${name}`).digest('hex');
      return `${hash}  ${name}`;
    });
    expect(await readFile(path.join(root, 'SHA256SUMS.txt'), 'utf8')).toBe(`${expected.join('\n')}\n`);
    expect(await readFile(path.join(root, 'RELEASE_NOTES.md'), 'utf8')).toContain('未签名测试包');
  });
});
