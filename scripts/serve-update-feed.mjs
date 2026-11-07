import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';

const [directory, version] = process.argv.slice(2);
if (!directory || !version || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) {
  throw new Error('Usage: node scripts/serve-update-feed.mjs <release-directory> <target-version>');
}
const root = path.resolve(directory);
const names = (await readdir(root)).filter((name) =>
  [`harness-manager-${version}-mac-arm64.zip`, `harness-manager-${version}-win-x64-setup.exe`].includes(name),
);
if (!names.length) throw new Error('No matching ZIP or setup.exe found in the release directory.');
const assets = await Promise.all(
  names.map(async (name) => {
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(path.join(root, name))) digest.update(chunk);
    return { name, size: (await stat(path.join(root, name))).size, digest: digest.digest('hex') };
  }),
);
const checksums = assets.map((asset) => `${asset.digest}  ${asset.name}\n`).join('');
let base = '';
const server = createServer((request, response) => {
  if (request.url === '/') {
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify([
        {
          tag_name: `v${version}`,
          draft: false,
          prerelease: version.startsWith('0.') || version.includes('-'),
          body: 'Local app update acceptance fixture.',
          published_at: new Date().toISOString(),
          html_url: `https://github.com/xuhuanhello/harness-manager/releases/tag/v${version}`,
          assets: [...assets, { name: 'SHA256SUMS.txt', size: Buffer.byteLength(checksums) }].map((asset) => ({
            name: asset.name,
            size: asset.size,
            browser_download_url: `${base}${asset.name}`,
          })),
        },
      ]),
    );
  } else if (request.url === '/SHA256SUMS.txt') response.end(checksums);
  else {
    const asset = assets.find((entry) => request.url === `/${entry.name}`);
    if (!asset) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.setHeader('Content-Length', asset.size);
    const stream = createReadStream(path.join(root, asset.name));
    stream.on('error', () => response.destroy());
    response.on('close', () => stream.destroy());
    stream.pipe(response);
  }
});
server.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${server.address().port}/`;
  console.log(`HARNESS_UPDATE_FEED_URL=${base}`);
  console.log('Keep this server running while testing an isolated app installation.');
});
