import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { appendFile, lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const tag = process.env.RELEASE_TAG;
if (!tag || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(tag) || tag !== `v${pkg.version}`) {
  throw new Error(`Release tag must match package.json: v${pkg.version}`);
}
const prerelease = pkg.version.startsWith('0.') || pkg.version.includes('-');
if (process.argv[2] === 'metadata') {
  const metadata = `tag=${tag}\nprerelease=${prerelease}\n`;
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, metadata);
  else process.stdout.write(metadata);
} else if (process.argv[2] === 'prepare' && process.argv[3]) {
  const directory = path.resolve(process.argv[3]);
  const prefix = `${pkg.productName}-${pkg.version}`;
  const expected = [
    `${prefix}-mac-arm64.dmg`,
    `${prefix}-mac-arm64.zip`,
    `${prefix}-win-x64-portable.exe`,
    `${prefix}-win-x64-setup.exe`,
  ].sort();
  const generated = ['SHA256SUMS.txt', 'RELEASE_NOTES.md'];
  const unexpected = (await readdir(directory)).filter((name) => !expected.includes(name) && !generated.includes(name));
  if (unexpected.length) throw new Error(`Unexpected release files: ${unexpected.join(', ')}`);
  // Validate the complete inventory before reading files or generating public release metadata.
  for (const name of expected) {
    const info = await lstat(path.join(directory, name));
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error(`Invalid release asset: ${name}`);
  }
  const checksums = [];
  for (const name of expected) {
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(path.join(directory, name))) digest.update(chunk);
    checksums.push(`${digest.digest('hex')}  ${name}`);
  }
  await writeFile(path.join(directory, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`);
  await writeFile(
    path.join(directory, 'RELEASE_NOTES.md'),
    `# ${pkg.productName} ${tag}\n\n` +
      '- Windows x64：安装版 setup.exe、便携版 portable.exe。\n' +
      '- macOS Apple Silicon（arm64）：DMG 安装包、ZIP 应用包。\n' +
      '- SHA256SUMS.txt：四个安装文件的 SHA-256 校验值。\n\n' +
      '本次附件由 GitHub Actions 在对应平台构建，并通过打包后应用的自动 smoke 检查。\n' +
      '当前为未签名测试包，macOS 未公证；人工安装、升级及具体 Harness 的实机发现仍需验收。\n' +
      'Windows 便携版默认仍使用 %APPDATA%\\harness-manager 保存数据。\n\n' +
      '源码采用 MIT 许可证；第三方许可声明随应用分发。\n',
  );
  console.log(`Prepared ${expected.length} verified release assets and SHA-256 checksums.`);
} else {
  throw new Error('Usage: RELEASE_TAG=v<version> node scripts/release.mjs metadata|prepare <asset-directory>');
}
