import type { Harness } from './types';

/** Stored Harness records always carry an explicit flag (store migration v2 filled in older records). */
export function isHarnessEnabled(harness: Harness | undefined): boolean {
  return harness?.enabled === true;
}
