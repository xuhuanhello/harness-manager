import { DEFAULT_ENABLED_HARNESS_IDS } from '../shared/harness-registry';
import type { Binding, Harness } from '../shared/types';
import type { StoreMigration } from './store';

/**
 * Data migrations, applied in order at startup. Append new ones with the next version number;
 * never edit a migration that has shipped. Registry sync of built-in Harness rules is not a
 * migration: it runs on every start because the registry changes with each release.
 */
export const MIGRATIONS: readonly StoreMigration[] = [
  {
    version: 1,
    description: 'Baseline: the records table as created by the first release.',
    up: () => {},
  },
  {
    version: 2,
    description: 'Give every Harness an explicit enabled flag instead of the implicit legacy default.',
    up(store) {
      const bound = new Set(store.list<Binding>('bindings').map((binding) => binding.harnessId));
      for (const harness of store.list<Harness>('harnesses')) {
        if (typeof harness.enabled === 'boolean') continue;
        // Old custom records were enabled; old built-ins were enabled if they were defaults or already had installations.
        const enabled = harness.origin === 'custom' || DEFAULT_ENABLED_HARNESS_IDS.has(harness.id) || bound.has(harness.id);
        store.put('harnesses', { ...harness, enabled });
      }
    },
  },
  {
    version: 3,
    description: 'Use one committed phase for every journal owner and timestamp every journal record.',
    up(store) {
      const now = new Date().toISOString();
      for (const record of store.list<{ id: string; phase?: string; createdAt?: string; updatedAt?: string }>('operations')) {
        const phase = record.phase === 'complete' ? 'committed' : record.phase;
        const updatedAt = record.updatedAt ?? record.createdAt ?? now;
        if (phase !== record.phase || updatedAt !== record.updatedAt) store.put('operations', { ...record, phase, updatedAt });
      }
    },
  },
];
