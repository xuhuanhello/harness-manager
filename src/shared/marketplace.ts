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
    throw new Error('请输入 GitHub 仓库或 skills.sh 技能详情链接。');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('请使用公开的 HTTPS 技能或仓库链接。');
  const parts = url.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
  if (!parts.every((part) => segment.test(part))) throw new Error('链接包含无效路径。');
  if (['skills.sh', 'www.skills.sh'].includes(url.hostname) && parts.length === 3) {
    return { uri: `${parts[0]}/${parts[1]}`, skillName: parts[2] };
  }
  if (url.hostname === 'github.com' && parts.length === 2) return { uri: `${parts[0]}/${parts[1].replace(/\.git$/, '')}` };
  throw new Error('请粘贴 skills.sh 的单个技能详情链接，或 GitHub 仓库首页链接。');
}
