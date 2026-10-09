import type { MarketplaceCatalog, MarketplaceCatalogRequest, MarketplaceSkill } from '../shared/types';
import { appError } from './messages';

const SKILLS_SH_ORIGIN = 'https://skills.sh';
const SKILLSMP_ORIGIN = 'https://skillsmp.com';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_SKILLS = 1_000;
const MAX_CACHE_ENTRIES = 64;
const SKILLS_SH_BOARD_PAGE_SIZE = 200;
const SKILLSMP_PAGE_SIZE = 50;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

type CacheEntry = { value: MarketplaceCatalog; savedAt: number };
type ParsedCatalogPage = { skills: MarketplaceSkill[]; page: number; pageSize: number; hasMore: boolean; total?: number };
type CatalogOptions = { fetcher?: typeof fetch; now?: () => number; ttlMs?: number };

/** Fixed-origin adapters for skills.sh and the query-only anonymous SkillsMP API. */
export class MarketplaceCatalogService {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<MarketplaceCatalog>>();

  constructor(options: CatalogOptions = {}) {
    // Keep this as a dynamic wrapper so the Electron main process can observe a stubbed global fetch.
    this.fetcher = options.fetcher ?? ((...args) => globalThis.fetch(...args));
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  async get(request: MarketplaceCatalogRequest): Promise<MarketplaceCatalog> {
    const marketplaceId = request.marketplaceId ?? 'skills-sh';
    const query = request.query?.trim() ?? '';
    const board = request.board ?? 'all-time';
    const page = request.page ?? 0;
    if (marketplaceId === 'skillsmp' && !query) {
      throw appError('CATALOG_SKILLSMP_QUERY_REQUIRED');
    }
    if (marketplaceId === 'skillsmp' && request.board !== undefined) {
      throw appError('CATALOG_SKILLSMP_NO_BOARD');
    }
    if (query && query.length < 2) throw appError('CATALOG_QUERY_TOO_SHORT');
    if (marketplaceId === 'skills-sh' && query && page > 0) {
      throw appError('CATALOG_SKILLSSH_SEARCH_NO_PAGING');
    }

    const key =
      marketplaceId === 'skillsmp'
        ? `skillsmp:search:${query.toLocaleLowerCase()}:page:${page}`
        : query
          ? `skills-sh:search:${query.toLocaleLowerCase()}`
          : `skills-sh:board:${board}:page:${page}`;
    const now = this.now();
    this.pruneCache(now);
    const cached = this.cache.get(key);
    if (!request.refresh && cached && now - cached.savedAt < this.ttlMs) {
      return { ...cached.value, cached: true };
    }
    const pending = !request.refresh ? this.pending.get(key) : undefined;
    if (pending) return pending;

    const task = this.load(marketplaceId, query, board, page);
    if (!request.refresh) this.pending.set(key, task);
    try {
      const result = await task;
      this.cache.set(key, { value: result, savedAt: this.now() });
      this.pruneCache(this.now());
      return result;
    } finally {
      if (this.pending.get(key) === task) this.pending.delete(key);
    }
  }

  private async load(
    marketplaceId: 'skills-sh' | 'skillsmp',
    query: string,
    board: NonNullable<MarketplaceCatalogRequest['board']>,
    page: number,
  ): Promise<MarketplaceCatalog> {
    const url =
      marketplaceId === 'skillsmp' ? skillsmpSearchUrl(query, page + 1) : query ? skillsShSearchUrl(query) : skillsShBoardUrl(board, page);
    const text = await this.readText(url, marketplaceId);
    const parsed: ParsedCatalogPage =
      marketplaceId === 'skillsmp'
        ? parseSkillsmpSearchResponse(text, page + 1)
        : query
          ? parseSkillsShSearchResponse(text)
          : parseSkillsShBoardPageResponse(text, page);
    return {
      skills: parsed.skills,
      page: parsed.page,
      pageSize: parsed.pageSize,
      hasMore: parsed.hasMore,
      ...(parsed.total === undefined ? {} : { total: parsed.total }),
      fetchedAt: new Date(this.now()).toISOString(),
      cached: false,
    };
  }

  private async readText(url: URL, marketplaceId: 'skills-sh' | 'skillsmp'): Promise<string> {
    let response: Response;
    let currentUrl = url;
    const visited = new Set<string>([currentUrl.href]);
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    try {
      for (let redirects = 0; ; redirects += 1) {
        response = await this.fetcher(currentUrl, {
          method: 'GET',
          headers: {
            accept: marketplaceId === 'skills-sh' && !currentUrl.pathname.startsWith('/api/') ? 'text/html' : 'application/json',
            'user-agent': 'Harness-Manager/0.1',
          },
          redirect: 'manual',
          signal,
        });
        if (response.status < 300 || response.status >= 400) break;
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (redirects >= 2 || !location) throw appError('CATALOG_REDIRECT_UNSAFE', { market: marketplaceLabel(marketplaceId) });
        let nextUrl: URL;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          throw appError('CATALOG_REDIRECT_INVALID', { market: marketplaceLabel(marketplaceId) });
        }
        if (!isAllowedRedirect(nextUrl, marketplaceId) || visited.has(nextUrl.href)) {
          throw appError('CATALOG_REDIRECT_LOOP', { market: marketplaceLabel(marketplaceId) });
        }
        currentUrl = nextUrl;
        visited.add(currentUrl.href);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('重定向')) throw error;
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw appError('CATALOG_TIMEOUT', { market: marketplaceLabel(marketplaceId) });
      }
      throw appError('CATALOG_OFFLINE', { market: marketplaceLabel(marketplaceId) });
    }

    if (marketplaceId === 'skillsmp' && response.status === 429) {
      const body = await readResponseText(response, marketplaceId, 16 * 1024).catch(() => '');
      if (body.includes('DAILY_QUOTA_EXCEEDED')) {
        throw appError('CATALOG_SKILLSMP_DAILY_LIMIT');
      }
      throw appError('CATALOG_SKILLSMP_RATE_LIMIT');
    }
    if (response.redirected) {
      throw appError('CATALOG_REDIRECT_STOPPED', { market: marketplaceLabel(marketplaceId) });
    }
    if (!response.ok) {
      throw appError('CATALOG_HTTP_ERROR', { market: marketplaceLabel(marketplaceId), status: response.status });
    }
    const lengthHeader = response.headers.get('content-length');
    if (lengthHeader && Number(lengthHeader) > MAX_RESPONSE_BYTES) {
      throw appError('CATALOG_RESPONSE_TOO_LARGE', { market: marketplaceLabel(marketplaceId) });
    }
    return readResponseText(response, marketplaceId);
  }

  private pruneCache(now: number): void {
    for (const [key, entry] of this.cache) {
      if (now - entry.savedAt >= this.ttlMs) this.cache.delete(key);
    }
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }
}

/** Re-checks a catalog skill page before it is opened in the browser: only the marketplace's own HTTPS site. */
export function marketplaceSkillPageUrl(marketplaceId: 'skills-sh' | 'skillsmp', value: string): string {
  const url = safeSkillPageUrl(marketplaceId, value);
  if (!url) throw appError('CATALOG_SKILL_PAGE_INVALID', { market: marketplaceLabel(marketplaceId) });
  return url;
}

function safeSkillPageUrl(marketplaceId: 'skills-sh' | 'skillsmp', value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  const origin = marketplaceId === 'skillsmp' ? SKILLSMP_ORIGIN : SKILLS_SH_ORIGIN;
  if (url.origin !== origin || url.username || url.password || url.pathname === '/') return undefined;
  return url.href;
}

function isAllowedRedirect(url: URL, marketplaceId: 'skills-sh' | 'skillsmp'): boolean {
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  if (marketplaceId === 'skillsmp') return url.origin === SKILLSMP_ORIGIN;
  return url.hostname === 'skills.sh' || url.hostname === 'www.skills.sh';
}

export function parseSkillsShSearchResponse(text: string): ParsedCatalogPage {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw appError('CATALOG_SKILLSSH_SEARCH_JSON');
  }
  if (!isRecord(value) || !Array.isArray(value.skills)) {
    throw appError('CATALOG_SKILLSSH_SEARCH_NO_LIST');
  }
  const skills = normalizeSkills(value.skills, 'skills-sh');
  if (value.skills.length && !skills.length) throw appError('CATALOG_SKILLSSH_SEARCH_EMPTY');
  return { skills, page: 0, pageSize: SKILLS_SH_BOARD_PAGE_SIZE, hasMore: false };
}

export function parseSkillsmpSearchResponse(text: string, requestedPage = 1): ParsedCatalogPage {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw appError('CATALOG_SKILLSMP_JSON');
  }
  if (
    !isRecord(value) ||
    value.success !== true ||
    !isRecord(value.data) ||
    !Array.isArray(value.data.skills) ||
    !isRecord(value.data.pagination) ||
    typeof value.data.pagination.hasNext !== 'boolean'
  ) {
    throw appError('CATALOG_SKILLSMP_FORMAT');
  }
  const skills = normalizeSkillsmpSkills(value.data.skills);
  if (value.data.skills.length && !skills.length) throw appError('CATALOG_SKILLSMP_EMPTY');
  const pagination = value.data.pagination;
  const hasMore = pagination.hasNext as boolean;
  if (hasMore && !skills.length) throw appError('CATALOG_SKILLSMP_STALLED');
  const page = nonNegativeInteger(pagination.page) ?? requestedPage;
  if (page !== requestedPage) throw appError('CATALOG_SKILLSMP_PAGE_MISMATCH');
  const pageSize = nonNegativeInteger(pagination.limit) ?? SKILLSMP_PAGE_SIZE;
  const total = pagination.totalIsExact === false ? undefined : nonNegativeInteger(pagination.total);
  return { skills, page: page - 1, pageSize, hasMore, ...(total === undefined ? {} : { total }) };
}

export function parseSkillsShBoardPageResponse(text: string, requestedPage: number): ParsedCatalogPage {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw appError('CATALOG_BOARD_JSON');
  }
  if (
    !isRecord(value) ||
    !Array.isArray(value.skills) ||
    typeof value.hasMore !== 'boolean' ||
    !Number.isSafeInteger(value.page) ||
    typeof value.total !== 'number' ||
    !Number.isSafeInteger(value.total) ||
    value.total < 0
  ) {
    throw appError('CATALOG_BOARD_FORMAT');
  }
  if (value.page !== requestedPage) throw appError('CATALOG_BOARD_PAGE_MISMATCH');
  const skills = normalizeSkills(value.skills, 'skills-sh');
  if (value.skills.length && !skills.length) throw appError('CATALOG_BOARD_EMPTY');
  if (value.hasMore && !skills.length) throw appError('CATALOG_BOARD_STALLED');
  return { skills, page: requestedPage, pageSize: SKILLS_SH_BOARD_PAGE_SIZE, hasMore: value.hasMore, total: value.total };
}

export function parseSkillsShBoardHtml(html: string): { skills: MarketplaceSkill[] } {
  const nextData = readNextData(html);
  if (nextData !== undefined) {
    const items = findSkillArray(nextData);
    if (items) {
      const skills = normalizeSkills(items, 'skills-sh');
      if (skills.length) return { skills };
    }
  }

  for (const flightChunk of readFlightStrings(html)) {
    for (const line of flightChunk.split('\n')) {
      const delimiter = line.indexOf(':');
      if (delimiter <= 0) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(line.slice(delimiter + 1));
      } catch {
        continue;
      }
      const items = findSkillArray(payload);
      if (!items) continue;
      const skills = normalizeSkills(items, 'skills-sh');
      if (skills.length) return { skills };
    }
  }
  throw appError('CATALOG_BOARD_HTML');
}

function skillsShSearchUrl(query: string): URL {
  const url = new URL('/api/search', SKILLS_SH_ORIGIN);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(SKILLS_SH_BOARD_PAGE_SIZE));
  return url;
}

function skillsShBoardUrl(board: NonNullable<MarketplaceCatalogRequest['board']>, page: number): URL {
  const path = `/api/skills/${board}/${page}`;
  return new URL(path, SKILLS_SH_ORIGIN);
}

function skillsmpSearchUrl(query: string, page: number): URL {
  const url = new URL('/api/v1/skills/search', SKILLSMP_ORIGIN);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(SKILLSMP_PAGE_SIZE));
  url.searchParams.set('page', String(page));
  return url;
}

async function readResponseText(
  response: Response,
  marketplaceId: 'skills-sh' | 'skillsmp',
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw appError(maxBytes === MAX_RESPONSE_BYTES ? 'CATALOG_RESPONSE_TOO_LARGE' : 'CATALOG_ERROR_BODY_TOO_LARGE', {
          market: marketplaceLabel(marketplaceId),
        });
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('超过')) throw error;
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw appError('CATALOG_TIMEOUT', { market: marketplaceLabel(marketplaceId) });
    }
    throw appError('CATALOG_READ_FAILED', { market: marketplaceLabel(marketplaceId) });
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw appError('CATALOG_INVALID_UTF8', { market: marketplaceLabel(marketplaceId) });
  }
}

function readNextData(html: string): unknown | undefined {
  const marker = 'id="__NEXT_DATA__"';
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const scriptStart = html.lastIndexOf('<script', markerIndex);
  const contentStart = html.indexOf('>', markerIndex);
  const contentEnd = html.indexOf('</script>', contentStart + 1);
  if (scriptStart < 0 || contentStart < 0 || contentEnd < 0) return undefined;
  try {
    return JSON.parse(html.slice(contentStart + 1, contentEnd));
  } catch {
    return undefined;
  }
}

function readFlightStrings(html: string): string[] {
  const marker = 'self.__next_f.push([1,';
  const payloads: string[] = [];
  let searchAt = 0;
  while (true) {
    const markerAt = html.indexOf(marker, searchAt);
    if (markerAt < 0) break;
    let start = markerAt + marker.length;
    while (start < html.length && /\s/.test(html[start])) start += 1;
    searchAt = start + 1;
    if (html[start] !== '"') continue;

    let end = start + 1;
    let escaped = false;
    for (; end < html.length; end += 1) {
      const character = html[end];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === '"') break;
    }
    if (end >= html.length) continue;
    searchAt = end + 1;
    try {
      const value: unknown = JSON.parse(html.slice(start, end + 1));
      if (typeof value === 'string') payloads.push(value);
    } catch {
      // Invalid Flight string segments are ignored; a useful skills payload is required below.
    }
  }
  return payloads;
}

function findSkillArray(value: unknown, depth = 0): unknown[] | undefined {
  if (depth > 32) return undefined;
  if (Array.isArray(value)) {
    if (value.some(isSkillRecord)) return value;
    for (const item of value) {
      const found = findSkillArray(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of ['initialSkills', 'skills', 'items']) {
    const candidate = value[key];
    if (Array.isArray(candidate) && candidate.some(isSkillRecord)) return candidate;
  }
  for (const child of Object.values(value)) {
    const found = findSkillArray(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function normalizeSkills(items: unknown[], marketplaceId: 'skills-sh'): MarketplaceSkill[] {
  const result: MarketplaceSkill[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isRecord(item)) continue;
    const source = normalizeSource(item.source);
    const skillId = normalizeSkillId(item.skillId ?? item.skill_id ?? item.id);
    if (!source || !skillId) continue;
    const key = `${source}/${skillId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = boundedText(item.name, 200) || skillId;
    const installs = nonNegativeInteger(item.installs);
    const description = boundedText(item.description, 2_000);
    result.push({
      id: `${marketplaceId}:${key}`,
      source,
      skillId,
      name,
      ...(installs === undefined ? {} : { installs }),
      ...(description ? { description } : {}),
      url: new URL(`/${key.split('/').map(encodeURIComponent).join('/')}`, SKILLS_SH_ORIGIN).href,
    });
    if (result.length >= MAX_SKILLS) break;
  }
  return result;
}

function normalizeSkillsmpSkills(items: unknown[]): MarketplaceSkill[] {
  const result: MarketplaceSkill[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!isRecord(item)) continue;
    const github = parseSkillsmpGithubUrl(item.githubUrl, item.name);
    if (!github) continue;
    const recordId = boundedText(item.id, 128) ?? github.canonicalUrl;
    const key = recordId.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const skill: MarketplaceSkill = {
      id: `skillsmp:${encodeURIComponent(recordId)}`,
      source: github.source,
      skillId: github.skillId,
      name: boundedText(item.name, 200) || github.skillId,
    };
    const stars = nonNegativeInteger(item.stars);
    const description = boundedText(item.description, 2_000);
    const url = safeSkillPageUrl('skillsmp', item.skillUrl);
    if (stars !== undefined) skill.stars = stars;
    if (description) skill.description = description;
    if (url) skill.url = url;
    result.push(skill);
    if (result.length >= MAX_SKILLS) break;
  }
  return result;
}

function parseSkillsmpGithubUrl(
  value: unknown,
  fallbackName: unknown,
): { source: string; skillId: string; canonicalUrl: string } | undefined {
  if (typeof value !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) return undefined;
  let parts: string[];
  try {
    parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return undefined;
  }
  if (parts.length < 5 || !['tree', 'blob'].includes(parts[2])) return undefined;
  const owner = normalizeRepoSegment(parts[0]);
  const repo = normalizeRepoSegment(parts[1]);
  const path = parts.slice(4).filter(Boolean);
  if (!owner || !repo || !path.length || path.some((part) => part.includes('/'))) return undefined;
  let last = path[path.length - 1];
  if (last.toLocaleLowerCase() === 'skill.md') last = path[path.length - 2] ?? '';
  const skillId = normalizeSkillId(last) ?? normalizeSkillId(slugFromName(fallbackName));
  if (!skillId) return undefined;
  url.search = '';
  url.hash = '';
  return { source: `${owner}/${repo}`, skillId, canonicalUrl: url.href };
}

function slugFromName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const slug = value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || undefined;
}

function normalizeSource(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parts = value.trim().split('/');
  if (parts.length !== 2) return undefined;
  const owner = normalizeRepoSegment(parts[0]);
  const repo = normalizeRepoSegment(parts[1]);
  return owner && repo ? `${owner}/${repo}` : undefined;
}

function normalizeRepoSegment(value: string): string | undefined {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value) ? value : undefined;
}

function normalizeSkillId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) ? value : undefined;
}

function isSkillRecord(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.source === 'string' &&
    (typeof value.skillId === 'string' || typeof value.skill_id === 'string' || typeof value.id === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function marketplaceLabel(id: 'skills-sh' | 'skillsmp'): string {
  return id === 'skillsmp' ? 'SkillsMP' : 'skills.sh';
}
