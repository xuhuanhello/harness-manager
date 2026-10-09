import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readdir, realpath, readlink, rm, symlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isWithin } from './fs-utils';
import { appError } from './messages';

type Entry = { absolutePath: string; relativePath: string; kind: 'directory' | 'file' | 'symlink'; mode: number };

/** Hashes the complete tree, including entry types, executable bits, and internal link text. */
export async function hashDirectory(path: string): Promise<string> {
  const root = await realpath(path);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw appError('CONTENT_NOT_DIRECTORY', { path });

  const entries = await collectEntries(root);
  const digest = createHash('sha256');
  for (const entry of entries) {
    if (entry.kind === 'directory') {
      digest.update(JSON.stringify([entry.relativePath, 'directory', entry.mode]));
      digest.update('\n');
    } else if (entry.kind === 'symlink') {
      const linkText = await readlink(entry.absolutePath);
      await assertInternalSymlink(root, entry.absolutePath, linkText);
      digest.update(JSON.stringify([entry.relativePath, 'symlink', linkText]));
      digest.update('\n');
    } else {
      const fileHash = await hashFile(entry.absolutePath);
      digest.update(JSON.stringify([entry.relativePath, 'file', entry.mode, fileHash]));
      digest.update('\n');
    }
  }
  return digest.digest('hex');
}

/** Copies a complete skill tree without following any contained symlink. */
export async function copySkillDirectory(source: string, destination: string): Promise<void> {
  const sourceRoot = await realpath(source);
  const sourceStat = await lstat(sourceRoot);
  if (!sourceStat.isDirectory()) throw appError('CONTENT_SOURCE_NOT_DIRECTORY', { path: source });
  await collectEntries(sourceRoot); // Validate the entire tree before creating a destination.

  const requestedDestination = resolve(destination);
  const destinationParent = await realpath(dirname(requestedDestination));
  const destinationPath = join(destinationParent, basename(requestedDestination));
  if (isWithin(sourceRoot, destinationPath)) {
    throw appError('CONTENT_COPY_INTO_SOURCE');
  }
  try {
    await lstat(destinationPath);
    throw appError('CONTENT_DESTINATION_EXISTS', { path: destinationPath });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const beforeHash = await hashDirectory(sourceRoot);
  let destinationCreated = false;
  try {
    // mkdir is exclusive. If a competing entry appears after lstat, this throws and is never
    // treated as content owned by this operation.
    await mkdir(destinationPath, { mode: 0o700 });
    destinationCreated = true;
    await copyTree(sourceRoot, destinationPath, sourceRoot, true);
    const [afterHash, copiedHash] = await Promise.all([hashDirectory(sourceRoot), hashDirectory(destinationPath)]);
    if (beforeHash !== afterHash || beforeHash !== copiedHash) {
      throw appError('CONTENT_CHANGED_DURING_COPY');
    }
  } catch (error) {
    // The destination was created by this call and rm removes links themselves, not their targets.
    if (destinationCreated) await rm(destinationPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function collectEntries(root: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  const directoryEdges = new Map<string, Set<string>>();
  const visit = async (directory: string): Promise<void> => {
    const physicalDirectory = await realpath(directory);
    if (!directoryEdges.has(physicalDirectory)) directoryEdges.set(physicalDirectory, new Set());
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const child of children) {
      const absolutePath = join(directory, child.name);
      const relativePath = relative(root, absolutePath).split(sep).join('/');
      if (!relativePath || relativePath.startsWith('../') || isAbsolute(relativePath)) {
        throw appError('CONTENT_PATH_OUTSIDE_ROOT');
      }
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        const linkText = await readlink(absolutePath);
        await assertInternalSymlink(root, absolutePath, linkText);
        entries.push({ absolutePath, relativePath, kind: 'symlink', mode: 0 });
        const targetPath = await realpath(resolve(dirname(absolutePath), linkText));
        const targetStat = await lstat(targetPath);
        if (targetStat.isDirectory()) directoryEdges.get(physicalDirectory)!.add(targetPath);
      } else if (stat.isDirectory()) {
        entries.push({ absolutePath, relativePath, kind: 'directory', mode: stat.mode & 0o111 });
        const physicalChild = await realpath(absolutePath);
        directoryEdges.get(physicalDirectory)!.add(physicalChild);
        await visit(absolutePath);
      } else if (stat.isFile()) {
        entries.push({ absolutePath, relativePath, kind: 'file', mode: stat.mode & 0o111 });
      } else {
        throw appError('CONTENT_SPECIAL_FILE', { name: relativePath });
      }
    }
  };
  await visit(root);
  assertAcyclic(directoryEdges, root);
  return entries;
}

function assertAcyclic(graph: Map<string, Set<string>>, root: string): void {
  const active = new Set<string>();
  const visited = new Set<string>();
  const visit = (directory: string): void => {
    if (active.has(directory)) throw appError('CONTENT_SYMLINK_CYCLE', { path: relative(root, directory) || '.' });
    if (visited.has(directory)) return;
    active.add(directory);
    for (const child of graph.get(directory) ?? []) visit(child);
    active.delete(directory);
    visited.add(directory);
  };
  for (const directory of graph.keys()) visit(directory);
}

async function assertInternalSymlink(root: string, linkPath: string, linkText: string): Promise<void> {
  if (!linkText || isAbsolute(linkText)) {
    throw appError('CONTENT_SYMLINK_ABSOLUTE', { path: relative(root, linkPath) });
  }
  const lexicalTarget = resolve(dirname(linkPath), linkText);
  if (!isWithin(root, lexicalTarget)) {
    throw appError('CONTENT_SYMLINK_ESCAPES', { path: relative(root, linkPath) });
  }
  let resolvedTarget: string;
  try {
    resolvedTarget = await realpath(lexicalTarget);
  } catch {
    throw appError('CONTENT_SYMLINK_BROKEN', { path: relative(root, linkPath) });
  }
  if (!isWithin(root, resolvedTarget)) {
    throw appError('CONTENT_SYMLINK_RESOLVES_OUTSIDE', { path: relative(root, linkPath) });
  }
}

async function copyTree(source: string, destination: string, root: string, destinationExists = false): Promise<void> {
  const sourceStat = await lstat(source);
  if (!destinationExists) await mkdir(destination, { mode: 0o700 });
  const children = await readdir(source, { withFileTypes: true });
  children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  for (const child of children) {
    const sourceChild = join(source, child.name);
    const destinationChild = join(destination, child.name);
    const stat = await lstat(sourceChild);
    if (stat.isSymbolicLink()) {
      const linkText = await readlink(sourceChild);
      await assertInternalSymlink(root, sourceChild, linkText);
      await symlink(linkText, destinationChild);
    } else if (stat.isDirectory()) {
      await copyTree(sourceChild, destinationChild, root);
    } else if (stat.isFile()) {
      await copyFile(sourceChild, destinationChild);
      await chmod(destinationChild, stat.mode & 0o777);
    } else {
      throw appError('CONTENT_SPECIAL_FILE', { name: child.name });
    }
  }
  // Set directory permissions after populating it, while discarding setuid/setgid/sticky bits.
  await chmod(destination, sourceStat.mode & 0o777);
}

async function hashFile(path: string): Promise<string> {
  const digest = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => {
      digest.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', resolvePromise);
  });
  return digest.digest('hex');
}
