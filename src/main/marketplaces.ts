import { randomUUID } from 'node:crypto';
import type { Marketplace, MarketplaceInput } from '../shared/types';
import type { Store } from './store';
import { appError } from './messages';

const MARKETPLACES = 'marketplaces';
export const DEFAULT_MARKETPLACE_ID = 'skills-sh';

const BUILTIN_MARKETPLACES: Marketplace[] = [
  { id: 'skills-sh', name: 'skills.sh', url: 'https://skills.sh/', origin: 'builtin' },
  { id: 'skillsmp', name: 'SkillsMP', url: 'https://skillsmp.com/', origin: 'builtin' },
];

/** Stores custom marketplace entry points. Import parsing remains separate and intentionally limited. */
export class MarketplaceService {
  constructor(private readonly store: Store) {
    this.seedBuiltins();
  }

  list(): Marketplace[] {
    const rank = new Map(BUILTIN_MARKETPLACES.map((marketplace, index) => [marketplace.id, index]));
    return this.store.list<Marketplace>(MARKETPLACES).sort((a, b) => {
      const aRank = rank.get(a.id);
      const bRank = rank.get(b.id);
      if (aRank !== undefined || bRank !== undefined) {
        if (aRank === undefined) return 1;
        if (bRank === undefined) return -1;
        return aRank - bRank;
      }
      return a.name.localeCompare(b.name, 'zh-Hans-CN') || a.id.localeCompare(b.id);
    });
  }

  save(input: MarketplaceInput): Marketplace {
    const name = input.name.trim();
    const url = normalizeMarketplaceUrl(input.url);
    const id = input.id?.trim();

    return this.store.transaction(() => {
      let existing: Marketplace | undefined;
      if (id) {
        existing = this.store.get<Marketplace>(MARKETPLACES, id);
        if (!existing) throw appError('MARKET_EDIT_NOT_FOUND');
        if (existing.origin !== 'custom') throw appError('MARKET_BUILTIN_READONLY');
      }

      const marketplaces = this.store.list<Marketplace>(MARKETPLACES);
      const nameKey = normalizeName(name);
      const duplicateName = marketplaces.find((item) => item.id !== id && normalizeName(item.name) === nameKey);
      if (duplicateName) throw appError('MARKET_NAME_TAKEN', { name: duplicateName.name });

      const urlKey = marketplaceUrlKey(url);
      const duplicateUrl = marketplaces.find((item) => item.id !== id && marketplaceUrlKey(item.url) === urlKey);
      if (duplicateUrl) throw appError('MARKET_URL_TAKEN', { name: duplicateUrl.name });

      const marketplace: Marketplace = {
        id: existing?.id ?? `marketplace-${randomUUID()}`,
        name,
        url,
        origin: 'custom',
      };
      this.store.put(MARKETPLACES, marketplace);
      return marketplace;
    });
  }

  delete(id: string): void {
    this.store.transaction(() => {
      const existing = this.store.get<Marketplace>(MARKETPLACES, id);
      if (!existing) throw appError('MARKET_NOT_FOUND');
      if (existing.origin !== 'custom') throw appError('MARKET_BUILTIN_UNDELETABLE');
      this.store.delete(MARKETPLACES, id);
    });
  }

  resolveUrl(id?: string): string {
    const marketplaceId = id?.trim() || DEFAULT_MARKETPLACE_ID;
    const marketplace = this.store.get<Marketplace>(MARKETPLACES, marketplaceId);
    if (!marketplace) throw appError('MARKET_SELECTED_NOT_FOUND');
    // Validate persisted data again before opening it in the external browser.
    return normalizeMarketplaceUrl(marketplace.url);
  }

  private seedBuiltins(): void {
    this.store.transaction(() => {
      for (const marketplace of BUILTIN_MARKETPLACES) {
        if (!this.store.get(MARKETPLACES, marketplace.id)) this.store.put(MARKETPLACES, marketplace);
      }
    });
  }
}

export function normalizeMarketplaceUrl(input: unknown): string {
  if (typeof input !== 'string') throw appError('MARKET_URL_INVALID');
  const value = input.trim();
  if (!value || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value) || !/^https?:\/\//i.test(value)) {
    throw appError('MARKET_URL_INVALID');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw appError('MARKET_URL_INVALID');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw appError('MARKET_URL_PROTOCOL');
  }
  if (url.username || url.password) throw appError('MARKET_URL_CREDENTIALS');
  if (!url.hostname) throw appError('MARKET_URL_HOST');

  return url.href;
}

function normalizeName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function marketplaceUrlKey(value: string): string {
  const url = new URL(normalizeMarketplaceUrl(value));
  url.hash = '';
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
}
