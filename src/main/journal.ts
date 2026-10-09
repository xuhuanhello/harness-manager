import type { Store } from './store';
import { appError } from './messages';

export type JournalOwner = 'library' | 'distribution' | 'repair' | 'update';

/**
 * Common shape of an operations-journal record. Each owner adds its own fields and intermediate
 * phases; every owner ends in `committed`, `failed` or `blocked` (waiting for the user).
 */
export interface JournalRecord {
  id: string;
  owner: JournalOwner;
  phase: string;
  error?: string;
  updatedAt?: string;
}

const COLLECTION = 'operations';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The operations journal. A multi-step file operation records each phase here before the next disk
 * change so startup recovery can finish or undo it. This class owns record bookkeeping only; each
 * owner keeps its own recovery algorithm.
 */
export class Journal {
  constructor(
    private readonly store: Store,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get<T extends JournalRecord>(id: string): T | undefined {
    return this.store.get<T>(COLLECTION, id);
  }

  list<T extends JournalRecord>(owner: JournalOwner): T[] {
    return this.store.list<T>(COLLECTION).filter((record) => record.owner === owner);
  }

  /** Persists the record as given and stamps `updatedAt`. */
  put<T extends JournalRecord>(record: T): void {
    this.store.put(COLLECTION, { ...record, updatedAt: this.now().toISOString() });
  }

  /** Merges a patch into the stored record. */
  update<T extends JournalRecord>(id: string, patch: Partial<T>): T {
    const current = this.get<T>(id);
    if (!current) throw appError('JOURNAL_RECORD_MISSING', { id });
    const updated = { ...current, ...patch, updatedAt: this.now().toISOString() };
    this.store.put(COLLECTION, updated);
    return updated;
  }

  /** Recorded errors the user has not seen resolved: every record with an error that did not commit. */
  issues(): Array<{ id: string; message: string }> {
    return this.store
      .list<JournalRecord>(COLLECTION)
      .filter((record) => record.error && record.phase !== 'committed')
      .map((record) => ({ id: record.id, message: record.error! }));
  }

  /** Deletes committed and failed records older than `maxAgeDays`. Blocked records stay until the user resolves them. */
  prune(maxAgeDays = 30): number {
    const cutoff = this.now().getTime() - maxAgeDays * DAY_MS;
    const expired = this.store.list<JournalRecord>(COLLECTION).filter((record) => {
      if (record.phase !== 'committed' && record.phase !== 'failed') return false;
      const updated = record.updatedAt ? Date.parse(record.updatedAt) : Number.NaN;
      return Number.isFinite(updated) && updated < cutoff;
    });
    this.store.transaction(() => {
      for (const record of expired) this.store.delete(COLLECTION, record.id);
    });
    return expired.length;
  }
}
