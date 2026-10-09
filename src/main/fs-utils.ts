import type { Stats } from 'node:fs';
import { lstat, symlink } from 'node:fs/promises';
import path from 'node:path';

/** Junctions let Windows manage directory links without administrator or Developer Mode privileges. */
export function createDirectoryLink(source: string, destination: string): Promise<void> {
  return symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir');
}

/** True when child is parent itself or lies beneath it. Compares spellings; resolve symlinks first where that matters. */
export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** True when either path contains the other. */
export function overlaps(first: string, second: string): boolean {
  return isWithin(first, second) || isWithin(second, first);
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
}

/** ENOENT, or ENOTDIR when a component of the path is not a directory. */
export function isMissingEntryError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export interface EntryState {
  exists: boolean;
  stat?: Stats;
}

/** lstat that reports a missing entry instead of throwing. Other errors still propagate. */
export async function inspectEntry(entryPath: string): Promise<EntryState> {
  try {
    return { exists: true, stat: await lstat(entryPath) };
  } catch (error) {
    if (isMissingEntryError(error)) return { exists: false };
    throw error;
  }
}

export async function pathExists(entryPath: string): Promise<boolean> {
  return (await inspectEntry(entryPath)).exists;
}
