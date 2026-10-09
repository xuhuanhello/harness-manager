import type { Store } from '../../src/main/store';

export class SimulatedCrash extends Error {
  constructor() {
    super('Simulated process crash');
  }
}

type JournalRecord = { id: string; [key: string]: unknown };

interface JournalWriter {
  putOperation(operation: JournalRecord): void;
  updateOperation(id: string, patch: Partial<JournalRecord>): void;
  recoverOne(id: string): Promise<boolean>;
}

/**
 * Simulates the process dying at a journal write. After the crash no further
 * journal writes persist and in-process recovery does not run, so the store and
 * disk are left exactly as a real crash would leave them for startup recovery.
 * `when: 'after'` crashes right after the matching record is persisted;
 * `when: 'before'` crashes instead of persisting it.
 */
export function crashAtJournalWrite(
  service: object,
  store: Store,
  matches: (record: JournalRecord) => boolean,
  when: 'before' | 'after' = 'after',
): { restore(): void; readonly crashed: boolean } {
  const writer = service as unknown as JournalWriter;
  const original = {
    putOperation: writer.putOperation,
    updateOperation: writer.updateOperation,
    recoverOne: writer.recoverOne,
  };
  let crashed = false;
  const write = (next: JournalRecord, persist: () => void) => {
    if (crashed) return;
    const hit = matches(structuredClone(next));
    if (hit && when === 'before') {
      crashed = true;
      throw new SimulatedCrash();
    }
    persist();
    if (hit) {
      crashed = true;
      throw new SimulatedCrash();
    }
  };
  writer.putOperation = (operation) => write(operation, () => original.putOperation.call(service, operation));
  writer.updateOperation = (id, patch) => {
    const current = store.get<JournalRecord>('operations', id);
    write({ ...(current ?? { id }), ...patch }, () => original.updateOperation.call(service, id, patch));
  };
  writer.recoverOne = async () => false;
  return {
    restore() {
      Object.assign(writer, original);
    },
    get crashed() {
      return crashed;
    },
  };
}

/** Throws a simulated crash from the n-th call of a private method, skipping the method body. */
export function crashOnCall(service: object, method: string, callNumber = 1): { restore(): void; readonly crashed: boolean } {
  const target = service as Record<string, (...args: unknown[]) => unknown>;
  const original = target[method];
  let calls = 0;
  let crashed = false;
  target[method] = function (this: unknown, ...args: unknown[]) {
    calls += 1;
    if (calls === callNumber) {
      crashed = true;
      throw new SimulatedCrash();
    }
    return original.apply(this, args);
  };
  return {
    restore() {
      target[method] = original;
    },
    get crashed() {
      return crashed;
    },
  };
}

/** Replaces a private method with a no-op for the duration of a simulated crash. */
export function skipMethod(service: object, method: string, value?: unknown): { restore(): void } {
  const target = service as Record<string, unknown>;
  const original = target[method];
  target[method] = async () => value;
  return {
    restore() {
      target[method] = original;
    },
  };
}
