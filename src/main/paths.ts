import { constants } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isWithin } from './fs-utils';
import { appError } from './messages';

export interface CanonicalPath {
  /** Absolute spelling with existing symlinks resolved and missing suffixes preserved. */
  path: string;
  /** Comparison key honoring the case behavior of the containing volume. */
  key: string;
  caseSensitive: boolean;
}

export type ResolvePath = (input: string) => Promise<CanonicalPath>;

/**
 * Memoizes canonicalizePath for one request, for matching stored records while planning.
 * Never use it for the checks made right before changing a file: those must see the disk as it is now.
 */
export function createPathCache(): ResolvePath {
  const cache = new Map<string, Promise<CanonicalPath>>();
  return (input) => {
    let pending = cache.get(input);
    if (!pending) {
      pending = canonicalizePath(input);
      cache.set(input, pending);
    }
    return pending;
  };
}

export function expandUserPath(value: string, home = os.homedir()): string {
  const trimmed = value.trim();
  if (trimmed === '~') return path.resolve(home);
  if (trimmed.startsWith(`~${path.sep}`) || trimmed.startsWith('~/')) {
    return path.resolve(home, trimmed.slice(2));
  }
  if (!path.isAbsolute(trimmed)) {
    throw appError('PATH_USER_NOT_ABSOLUTE');
  }
  return path.resolve(trimmed);
}

export function validateWorkspaceRelativePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  // Treat either separator as a separator so configurations remain safe if moved between platforms.
  const portable = trimmed.replace(/\\/g, '/');
  if (portable.startsWith('/') || /^[a-zA-Z]:/.test(portable) || portable.startsWith('//')) {
    throw appError('PATH_WORKSPACE_NOT_RELATIVE');
  }
  const parts = portable.split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..')) {
    throw appError('PATH_WORKSPACE_ESCAPE');
  }
  if (parts.some((part) => part.includes('\0'))) throw appError('PATH_WORKSPACE_INVALID');
  return parts.join(path.sep);
}

/**
 * Resolve all existing symlinked ancestors without requiring the final path to exist.
 * A broken symlink in the path is rejected rather than treated as a missing directory.
 */
export async function canonicalizePath(input: string): Promise<CanonicalPath> {
  if (!path.isAbsolute(input)) throw appError('PATH_NOT_ABSOLUTE', { path: input });
  const absolute = path.resolve(input);
  let cursor = absolute;
  const missing: string[] = [];
  let ancestorReal: string;

  while (true) {
    try {
      await lstat(cursor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw appError('PATH_INSPECT_FAILED', { path: cursor, reason: (error as Error).message });
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw appError('PATH_NO_ANCESTOR', { path: absolute });
      missing.push(path.basename(cursor));
      cursor = parent;
      continue;
    }
    // Once lstat says the path exists, a failing realpath means a broken/unresolvable symlink,
    // never a missing suffix that may safely be appended to its parent.
    try {
      ancestorReal = await realpath(cursor);
    } catch (error) {
      throw appError('PATH_RESOLVE_FAILED', { path: cursor, reason: (error as Error).message });
    }
    break;
  }

  if (
    missing.length &&
    !(await stat(ancestorReal!)
      .then((value) => value.isDirectory())
      .catch(() => false))
  ) {
    throw appError('PATH_COMPONENT_NOT_DIRECTORY', { path: cursor });
  }
  const resolved = path.resolve(ancestorReal!, ...missing.reverse());
  const caseSensitive = await volumeIsCaseSensitive(ancestorReal!);
  const key = caseSensitive ? resolved : resolved.toLocaleLowerCase('en-US');
  return { path: resolved, key, caseSensitive };
}

export async function assertNoPathOverlap(target: string, protectedPaths: string[]): Promise<void> {
  const targetPath = await canonicalizePath(target);
  for (const protectedPath of protectedPaths) {
    const protectedCanonical = await canonicalizePath(protectedPath);
    const targetWithinProtected = isWithinKey(protectedCanonical, targetPath);
    const protectedWithinTarget = isWithinKey(targetPath, protectedCanonical);
    if (targetWithinProtected || protectedWithinTarget) {
      throw appError('PATH_OVERLAPS_APP_DATA', { path: targetPath.path });
    }
  }
}

export async function assertWorkspaceContainment(workspacePath: string, targetPath: string): Promise<void> {
  const [workspace, target] = await Promise.all([canonicalizePath(workspacePath), canonicalizePath(targetPath)]);
  if (!isWithinKey(workspace, target)) {
    throw appError('PATH_OUTSIDE_WORKSPACE', { path: target.path });
  }
}

export async function requireDirectory(input: string, description: string): Promise<CanonicalPath> {
  const canonical = await canonicalizePath(input);
  try {
    const info = await stat(canonical.path);
    if (!info.isDirectory()) throw appError('PATH_NOT_DIRECTORY', { label: description, path: canonical.path });
    await access(canonical.path, constants.R_OK | constants.X_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw appError('PATH_MISSING', { label: description, path: canonical.path });
    }
    throw error;
  }
  return canonical;
}

function isWithinKey(parent: CanonicalPath, child: CanonicalPath): boolean {
  return isWithin(parent.key, child.key);
}

/** Probe an existing alphabetic path component. This handles case-sensitive APFS volumes too. */
async function volumeIsCaseSensitive(existingPath: string): Promise<boolean> {
  let cursor = path.resolve(existingPath);
  while (true) {
    const name = path.basename(cursor);
    const index = name.search(/[a-zA-Z]/);
    if (index >= 0) {
      const letter = name[index];
      const swapped = letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase();
      const alternate = `${name.slice(0, index)}${swapped}${name.slice(index + 1)}`;
      const alternatePath = path.join(path.dirname(cursor), alternate);
      try {
        const [originalStat, alternateReal] = await Promise.all([stat(cursor), realpath(alternatePath)]);
        const alternateStat = await stat(alternateReal);
        return originalStat.dev !== alternateStat.dev || originalStat.ino !== alternateStat.ino;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return true;
        // If metadata access is restricted, move up and probe another existing component.
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  // Most Windows volumes are insensitive; POSIX defaults to sensitive when no probe is possible.
  return process.platform !== 'win32';
}
