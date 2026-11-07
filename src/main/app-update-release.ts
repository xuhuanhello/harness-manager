import { appError } from './messages';
import { z } from 'zod';
import { APP_RELEASES_URL } from '../shared/app-update';

export const DOWNLOAD_PREFIX = `${APP_RELEASES_URL}/download/`;
export const FEED_URL = 'https://api.github.com/repos/xuhuanhello/harness-manager/releases?per_page=30';
export const MAX_UPDATE_BYTES = 1024 ** 3;
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseVersion(value: string) {
  const normalized = value.replace(/^v/, '');
  const match = versionPattern.exec(normalized);
  if (!match || match[0] !== normalized || match[4]?.split('.').some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === '0'))
    return null;
  return { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') ?? [] };
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw appError('APP_UPDATE_INVALID_VERSION');
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

const assetSchema = z.object({
  name: z.string().max(256),
  size: z.number().int().nonnegative(),
  browser_download_url: z.string().max(4096),
});
const releaseSchema = z.object({
  tag_name: z.string().max(128),
  draft: z.boolean(),
  prerelease: z.boolean(),
  body: z.string().nullable().default(''),
  published_at: z.string().nullable(),
  html_url: z.string().max(4096),
  assets: z.array(assetSchema).max(100),
});
export type Release = z.infer<typeof releaseSchema>;
export type ReleaseAsset = z.infer<typeof assetSchema>;

export function selectRelease(input: unknown, current: string): Release | undefined {
  const releases = z.array(releaseSchema).max(100).parse(input);
  const parsed = parseVersion(current);
  if (!parsed) throw appError('APP_UPDATE_INVALID_VERSION');
  const includePreview = parsed.core[0] === 0n || parsed.pre.length > 0;
  return releases
    .filter((release) => {
      const version = parseVersion(release.tag_name);
      return (
        !release.draft &&
        version &&
        (includePreview || (!release.prerelease && !version.pre.length)) &&
        compareVersions(release.tag_name, current) > 0
      );
    })
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
}

export function updateFeed(override?: string) {
  if (!override) return { url: FEED_URL, prefix: DOWNLOAD_PREFIX, local: false };
  const port = /^http:\/\/127\.0\.0\.1:(\d+)\/$/.exec(override)?.[1];
  if (!port || Number(port) < 1 || Number(port) > 65535) throw appError('APP_UPDATE_INVALID_FEED');
  const url = new URL(override);
  return { url: url.href, prefix: url.href, local: true };
}

export function validAssetUrl(value: string, prefix: string): boolean {
  try {
    const url = new URL(value);
    return (
      (value.startsWith(prefix) || prefix.startsWith('http://127.0.0.1')) &&
      url.href.startsWith(prefix) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function validReleaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === 'https://github.com' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.pathname === '/xuhuanhello/harness-manager/releases' ||
        /^\/xuhuanhello\/harness-manager\/releases\/tag\/[^/]+$/.test(url.pathname))
    );
  } catch {
    return false;
  }
}

export function selectAsset(release: Release, platform: string, arch: string, prefix = DOWNLOAD_PREFIX): ReleaseAsset | undefined {
  const suffix =
    platform === 'darwin' && arch === 'arm64' ? 'mac-arm64.zip' : platform === 'win32' && arch === 'x64' ? 'win-x64-setup.exe' : undefined;
  if (!suffix) return undefined;
  const name = `harness-manager-${release.tag_name.replace(/^v/, '')}-${suffix}`;
  const matches = release.assets.filter((asset) => asset.name === name);
  const asset = matches.length === 1 ? matches[0] : undefined;
  return asset && asset.size > 0 && asset.size <= MAX_UPDATE_BYTES && validAssetUrl(asset.browser_download_url, prefix) ? asset : undefined;
}

export function parseChecksums(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-fA-F0-9]{64}) [ *]([^/\\\r\n]+)$/.exec(line);
    if (!match || result.has(match[2]) || match[2] === '.' || match[2] === '..') throw appError('APP_UPDATE_INVALID_CHECKSUMS');
    result.set(match[2], match[1].toLowerCase());
  }
  if (!result.size) throw appError('APP_UPDATE_INVALID_CHECKSUMS');
  return result;
}
