import { readlink, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Distribution, Skill, Target } from '../shared/types';
import { hashDirectory } from './content';
import type { JournalOperation } from './distribution-types';
import { inspectEntry } from './fs-utils';
import { type CanonicalPath, canonicalizePath, type ResolvePath } from './paths';
import type { Store } from './store';
import { message } from './messages';

/** Checks on a single Harness entry (the link or copy inside a skill directory) and its temporary paths. */

export async function verifyDistributionEntry(
  store: Store,
  distribution: Distribution,
  skill: Skill,
  entryPath: string,
  sourceHash?: string,
): Promise<{ ok: boolean; message: string; health: Distribution['health']; actualHash?: string }> {
  const entry = await inspectEntry(entryPath);
  if (!entry.exists) return { ok: false, message: message('ENTRY_MISSING'), health: 'missing' };
  const target = store.get<Target>('targets', distribution.targetId);
  if (target) {
    try {
      const [recordedTarget, actualParent] = await Promise.all([canonicalizePath(target.path), canonicalizePath(path.dirname(entryPath))]);
      if (recordedTarget.path !== path.resolve(target.path) || recordedTarget.key !== actualParent.key) {
        return {
          ok: false,
          message: message('ENTRY_OUTSIDE_TARGET'),
          health: 'conflict',
        };
      }
    } catch {
      return { ok: false, message: message('ENTRY_TARGET_UNRESOLVABLE'), health: 'conflict' };
    }
  }
  const sourceExists = await stat(skill.directory)
    .then((value) => value.isDirectory())
    .catch(() => false);
  if (!sourceExists) return { ok: false, message: message('ENTRY_SOURCE_MISSING'), health: 'broken' };
  const hash = sourceHash ?? (await hashDirectory(skill.directory));
  if (distribution.strategy === 'symlink') {
    if (!entry.stat!.isSymbolicLink()) return { ok: false, message: message('ENTRY_LINK_REPLACED'), health: 'conflict' };
    const rawLink = await readlink(entryPath);
    const linkPath = path.resolve(path.dirname(entryPath), rawLink);
    let linkCanonical: CanonicalPath;
    let sourceCanonical: CanonicalPath;
    try {
      [linkCanonical, sourceCanonical] = await Promise.all([canonicalizePath(linkPath), canonicalizePath(skill.directory)]);
    } catch {
      return { ok: false, message: message('ENTRY_LINK_BROKEN'), health: 'broken' };
    }
    if (linkCanonical.key !== sourceCanonical.key) {
      return { ok: false, message: message('ENTRY_LINK_REDIRECTED'), health: 'conflict' };
    }
    return { ok: true, message: message('ENTRY_LINK_HEALTHY'), health: 'healthy', actualHash: hash };
  }
  if (entry.stat!.isSymbolicLink() || !entry.stat!.isDirectory()) {
    return { ok: false, message: message('ENTRY_COPY_REPLACED'), health: 'conflict' };
  }
  const actualHash = await hashDirectory(entryPath).catch(() => undefined);
  if (!actualHash) return { ok: false, message: message('ENTRY_COPY_UNREADABLE'), health: 'conflict' };
  if (actualHash !== distribution.lastWrittenHash) {
    return {
      ok: false,
      message: message('ENTRY_COPY_MODIFIED'),
      health: 'conflict',
      actualHash,
    };
  }
  if (actualHash !== hash) {
    return { ok: true, message: message('ENTRY_COPY_STALE'), health: 'stale', actualHash };
  }
  return { ok: true, message: message('ENTRY_COPY_HEALTHY'), health: 'healthy', actualHash };
}

export async function entryMatchesPlanned(entryPath: string, operation: JournalOperation): Promise<boolean> {
  const state = await inspectEntry(entryPath);
  if (!state.exists || !operation.strategy || !operation.sourcePath || !operation.newHash) return false;
  if (operation.strategy === 'symlink') {
    if (!state.stat!.isSymbolicLink()) return false;
    const raw = await readlink(entryPath);
    return canonicalizeLexical(path.resolve(path.dirname(entryPath), raw)) === canonicalizeLexical(operation.sourcePath);
  }
  if (state.stat!.isSymbolicLink() || !state.stat!.isDirectory()) return false;
  return (await hashDirectory(entryPath).catch(() => '')) === operation.newHash;
}

export async function entryMatchesDistribution(
  store: Store,
  entryPath: string,
  distribution: Distribution,
  skillId: string,
): Promise<boolean> {
  const entry = await inspectEntry(entryPath);
  if (!entry.exists) return false;
  if (distribution.strategy === 'symlink') {
    if (!entry.stat!.isSymbolicLink()) return false;
    const skill = store.get<Skill>('skills', skillId);
    const sourcePath = skill?.directory;
    if (!sourcePath) return false;
    const raw = await readlink(entryPath);
    const actualLinkPath = path.resolve(path.dirname(entryPath), raw);
    try {
      const [actual, expected] = await Promise.all([canonicalizePath(actualLinkPath), canonicalizePath(sourcePath)]);
      return actual.key === expected.key;
    } catch {
      return canonicalizeLexical(actualLinkPath) === canonicalizeLexical(sourcePath);
    }
  }
  if (entry.stat!.isSymbolicLink() || !entry.stat!.isDirectory()) return false;
  return (await hashDirectory(entryPath).catch(() => '')) === distribution.lastWrittenHash;
}

export async function removeEntryIfMatches(entryPath: string, operation: JournalOperation): Promise<void> {
  if (!(await entryMatchesPlanned(entryPath, operation))) return;
  const state = await inspectEntry(entryPath);
  if (state.stat?.isDirectory() && !state.stat.isSymbolicLink()) await rm(entryPath, { recursive: true, force: false });
  else await rm(entryPath, { force: false });
}

export async function makeTrashPath(targetPath: string, operationId: string): Promise<string> {
  const targetStat = await stat(targetPath).catch(() => undefined);
  const parent = path.dirname(targetPath);
  const parentStat = await stat(parent).catch(() => undefined);
  let trashRoot = path.join(parent, `.${path.basename(targetPath) || 'target'}.harness-manager-trash`);
  if (targetStat && parentStat && targetStat.dev !== parentStat.dev) {
    trashRoot = path.join(targetPath, '.harness-manager-trash');
  }
  return path.join(trashRoot, operationId, 'entry');
}

export function makeStagePath(targetPath: string, operationId: string): string {
  const parent = path.dirname(targetPath);
  return path.join(parent, `.${path.basename(targetPath) || 'target'}.harness-manager-stage-${operationId}`);
}

export async function entryPathsEqual(left: string, right: string, resolve: ResolvePath = canonicalizePath): Promise<boolean> {
  try {
    const [leftParent, rightParent] = await Promise.all([resolve(path.dirname(left)), resolve(path.dirname(right))]);
    if (leftParent.key !== rightParent.key) return false;
    const leftName = path.basename(left);
    const rightName = path.basename(right);
    return leftParent.caseSensitive ? leftName === rightName : leftName.toLocaleLowerCase('en-US') === rightName.toLocaleLowerCase('en-US');
  } catch {
    return canonicalizeLexical(left) === canonicalizeLexical(right);
  }
}

export function isSafeEntryName(name: string): boolean {
  return Boolean(
    name && name.trim() === name && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\') && !name.includes('\0'),
  );
}

export function canonicalizeLexical(value: string): string {
  // Windows junction readlink results can use the \\?\ namespace for the same absolute path.
  return path.toNamespacedPath(path.resolve(value)).replace(/\\/g, '/');
}
