import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appError } from './messages';

type RecordWithId = { id: string };

/** A forward-only data migration. `up` runs inside a transaction together with the version bump. */
export interface StoreMigration {
  version: number;
  description: string;
  up(store: Store): void;
}

/** Synchronous JSON-record store used by both main-process services. */
export class Store {
  readonly root: string;
  private readonly database: DatabaseSync;
  private transactionDepth = 0;

  constructor(root: string) {
    if (!root || root.includes('\0')) throw appError('STORE_ROOT_INVALID');
    const requestedRoot = resolve(root);
    mkdirSync(requestedRoot, { recursive: true });
    this.root = realpathSync(requestedRoot);

    const databasePath = join(this.root, 'manager.sqlite');
    try {
      if (lstatSync(databasePath).isSymbolicLink()) {
        throw appError('STORE_DATABASE_SYMLINK');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS records (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (collection, id)
      ) WITHOUT ROWID;
    `);
  }

  /** Schema version, kept in SQLite's `user_version` header field. */
  get version(): number {
    return (this.database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  }

  /**
   * Applies pending migrations in version order, each in its own transaction with its version bump,
   * so a failure leaves the database at the last completed version. A non-empty database is first
   * copied to `manager.sqlite.bak-v<from>-<time>` in the library root.
   */
  migrate(migrations: readonly StoreMigration[]): { from: number; to: number; backupPath?: string } {
    const from = this.version;
    const pending = migrations.filter((migration) => migration.version > from).sort((left, right) => left.version - right.version);
    if (!pending.length) return { from, to: from };
    for (const migration of pending) {
      if (!Number.isSafeInteger(migration.version) || migration.version < 1)
        throw appError('INTERNAL_MIGRATION_VERSION', { version: migration.version });
    }
    let backupPath: string | undefined;
    if (this.database.prepare('SELECT 1 FROM records LIMIT 1').get()) {
      backupPath = join(this.root, `manager.sqlite.bak-v${from}-${Date.now()}`);
      this.database.prepare('VACUUM INTO ?').run(backupPath);
    }
    for (const migration of pending) {
      this.transaction(() => {
        migration.up(this);
        this.database.exec(`PRAGMA user_version = ${migration.version}`);
      });
    }
    return { from, to: pending[pending.length - 1].version, backupPath };
  }

  list<T>(collection: string): T[] {
    const rows = this.database
      .prepare('SELECT value FROM records WHERE collection = ? ORDER BY id')
      .all(this.collectionName(collection)) as Array<{ value: string }>;
    return rows.map(({ value }) => this.decode<T>(collection, value));
  }

  get<T>(collection: string, id: string): T | undefined {
    if (!id) return undefined;
    const row = this.database
      .prepare('SELECT value FROM records WHERE collection = ? AND id = ?')
      .get(this.collectionName(collection), id) as { value: string } | undefined;
    return row ? this.decode<T>(collection, row.value) : undefined;
  }

  put<T extends RecordWithId>(collection: string, value: T): void {
    const name = this.collectionName(collection);
    if (!value || typeof value.id !== 'string' || value.id.length === 0) {
      throw appError('INTERNAL_RECORD_ID', { collection: name });
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw appError('INTERNAL_RECORD_NOT_SERIALIZABLE', { id: value.id, collection: name });
    }
    if (serialized === undefined) throw appError('INTERNAL_RECORD_NOT_SERIALIZABLE', { id: value.id, collection: name });
    this.database
      .prepare(`
      INSERT INTO records (collection, id, value) VALUES (?, ?, ?)
      ON CONFLICT(collection, id) DO UPDATE SET value = excluded.value
    `)
      .run(name, value.id, serialized);
  }

  delete(collection: string, id: string): void {
    this.database.prepare('DELETE FROM records WHERE collection = ? AND id = ?').run(this.collectionName(collection), id);
  }

  transaction<T>(fn: () => T): T {
    if (typeof fn !== 'function') throw appError('INTERNAL_TRANSACTION_CALLBACK');
    const entryDepth = this.transactionDepth;
    const savepoint = `store_nested_${entryDepth}`;
    this.database.exec(entryDepth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.transactionDepth = entryDepth + 1;
    try {
      const value = fn();
      if (value && typeof (value as { then?: unknown }).then === 'function') {
        throw appError('INTERNAL_TRANSACTION_ASYNC');
      }
      this.database.exec(entryDepth === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
      return value;
    } catch (error) {
      try {
        this.database.exec(entryDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
      } catch {
        // Preserve the operation's original error if SQLite has already rolled back.
      }
      throw error;
    } finally {
      this.transactionDepth = entryDepth;
    }
  }

  close(): void {
    this.database.close();
  }

  private collectionName(collection: string): string {
    if (!/^[a-z][a-z0-9_]*$/.test(collection)) {
      throw appError('INTERNAL_COLLECTION_INVALID', { collection });
    }
    return collection;
  }

  private decode<T>(collection: string, value: string): T {
    try {
      return JSON.parse(value) as T;
    } catch {
      throw appError('STORE_DATA_CORRUPT', { collection });
    }
  }
}
