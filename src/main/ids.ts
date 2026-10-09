import { createHash } from 'node:crypto';

// Both formats are persisted in user libraries. Changing either one orphans existing records.

/** `<prefix>_<64 hex>` over JSON-encoded identity parts. Used for source and skill IDs. */
export function contentId(prefix: 'source' | 'skill', identity: unknown[]): string {
  return `${prefix}_${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

/** `<namespace>-<32 hex>`. Used for target, workspace, binding, intent, distribution, external and result IDs. */
export function recordId(namespace: string, value: string): string {
  const hash = createHash('sha256').update(`${namespace}\0${value}`).digest('hex').slice(0, 32);
  return `${namespace}-${hash}`;
}
