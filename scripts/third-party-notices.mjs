import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const packages = Object.entries(lock.packages)
  .filter(([directory, metadata]) => directory.startsWith('node_modules/') && !metadata.dev)
  .sort(([left], [right]) => left.localeCompare(right, 'en'));
const sections = [
  '# Third-party notices',
  'Generated from the installed production dependencies and package-lock.json by `npm run notices`. Regenerate after changing dependencies.',
  'These packages retain their original licenses. Electron and Chromium notices are also included in the packaged Electron distribution.',
];
for (const [directory] of packages) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const licenses = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^(licen[cs]e|copying|notice)(?:[.-]|$)/i.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (!licenses.length) throw new Error(`Missing license text for ${manifest.name}`);
  sections.push(`## ${manifest.name} ${manifest.version}\n\nLicense: ${manifest.license || 'See the license text below.'}`);
  for (const filename of licenses) {
    const text = (await readFile(path.join(directory, filename), 'utf8')).trim();
    sections.push(`### ${filename}\n\n\`\`\`text\n${text}\n\`\`\``);
  }
}
await writeFile('THIRD_PARTY_NOTICES.md', `${sections.join('\n\n')}\n`);
console.log(`Wrote third-party notices for ${packages.length} production dependencies.`);
