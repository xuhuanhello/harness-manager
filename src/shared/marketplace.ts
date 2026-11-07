import { t } from './i18n';
export const MARKETPLACE_URL = 'https://skills.sh/';

/** Accept repository identifiers and public skills.sh detail links, never commands. */
export function parseMarketplaceSource(input: string): { uri: string; skillName?: string } {
  const value = input.trim();
  const segment = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) {
    const parts = value.split('/');
    if (parts.every((part) => segment.test(part))) return { uri: parts.join('/') };
  }
  let url: URL;
  try {
    url = new URL(/^(www\.)?skills\.sh\//i.test(value) ? `https://${value}` : value);
  } catch {
    throw new Error(t('errors.marketplaceSourceRequired'));
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error(t('errors.marketplacePublicHttps'));
  const parts = url.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  if (!parts.every((part) => segment.test(part))) throw new Error(t('errors.marketplaceInvalidPath'));
  if (['skills.sh', 'www.skills.sh'].includes(url.hostname) && parts.length === 3) {
    return { uri: `${parts[0]}/${parts[1]}`, skillName: parts[2] };
  }
  if (url.hostname === 'github.com' && parts.length === 2) return { uri: `${parts[0]}/${parts[1].replace(/\.git$/, '')}` };
  throw new Error(t('errors.marketplaceDetailLink'));
}
