import { candidateGroup } from '../shared/candidate-groups';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { type Dirent, lstatSync, realpathSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { load as loadYaml } from 'js-yaml';
import type {
  BatchResult,
  Candidate,
  Group,
  GroupInput,
  InstallRequest,
  ItemResult,
  ScanRequest,
  ScanResult,
  Settings,
  Skill,
  Source,
} from '../shared/types';
import { errorCodeOf, errorMessage } from '../shared/errors';
import { ID_PATTERNS } from '../shared/limits';
import { copySkillDirectory, hashDirectory } from './content';
import { isWithin, pathExists } from './fs-utils';
import { contentId } from './ids';
import { Journal } from './journal';
import type { Store } from './store';
import { appError, message } from './messages';

const execFileAsync = promisify(execFile);
const SETTINGS_ID = 'ui';
const DEFAULT_SETTINGS: Settings = { viewMode: 'source', activeTabs: {} };
const SKILL_ID_RE = ID_PATTERNS.skill;
const SOURCE_ID_RE = ID_PATTERNS.source;
const OPERATION_ID_RE = ID_PATTERNS.uuid;
const MAX_SKILL_MARKDOWN_BYTES = 256 * 1024;
const RECOVERY_PATH_ERRORS = new Set(['LIBRARY_RECOVERY_PATH_INVALID', 'LIBRARY_RECOVERY_PATH_OUTSIDE']);
/** Scans the user abandoned without installing keep a temporary checkout; cap how many and how long. */
const MAX_SCAN_SESSIONS = 16;
const SCAN_SESSION_TTL_MS = 30 * 60_000;

type StoredSkill = Skill;
type StoredSource = Source & { subpath?: string };

interface CachedCandidate {
  candidate: Candidate;
  sourceDirectory: string;
  validationName?: string;
  validationDescription?: string;
}

interface ScanSession {
  id: string;
  source: StoredSource;
  repositoryRoot: string;
  scanRoot: string;
  temporaryRoot?: string;
  candidates: Map<string, CachedCandidate>;
  createdAt: number;
}

interface LibraryInstallOperation {
  id: string;
  owner: 'library';
  kind: 'install';
  phase: 'preparing' | 'prepared' | 'renamed' | 'committed' | 'failed';
  createdAt: string;
  candidateId: string;
  stagePath: string;
  finalPath: string;
  source: StoredSource;
  skill: StoredSkill;
  newHash?: string;
  error?: string;
}

export interface ParsedSkill {
  name?: string;
  description?: string;
  issues: string[];
}

export interface ParsedGithub {
  uri: string;
  cloneUrl: string;
  identity: string;
  label: string;
}

/** Source scanning, local import, central library installs, and group/settings persistence. */
export class LibraryService {
  private readonly sessions = new Map<string, ScanSession>();
  private readonly activeScanRoots = new Set<string>();

  private readonly journal: Journal;

  constructor(private readonly store: Store) {
    this.journal = new Journal(store);
  }

  async scan(request: ScanRequest): Promise<ScanResult> {
    await this.ensureLibraryDirectories();

    const github = tryParseGithub(request.uri);
    const sourceType = github ? 'github' : 'local';
    if (!github && request.ref?.trim()) throw appError('SCAN_REF_REQUIRES_GITHUB');
    const requestedRef = github ? normalizeRef(request.ref) : 'local';
    const scanId = randomUUID();
    const tempRoot = github ? join(this.store.root, '.staging', `scan-${scanId}`) : undefined;
    let repositoryRoot: string;
    let commit: string;
    let sourceUri: string;
    let sourceIdentity: string;
    let label: string;

    if (github) {
      await mkdir(tempRoot!, { recursive: false, mode: 0o700 });
      this.activeScanRoots.add(tempRoot!);
      const checkoutPath = join(tempRoot!, 'checkout');
      try {
        await mkdir(checkoutPath, { recursive: true, mode: 0o700 });
        await checkoutGithub(github, requestedRef, checkoutPath);
        repositoryRoot = await realpath(checkoutPath);
        commit = (await runGit(['-C', repositoryRoot, 'rev-parse', '--verify', 'HEAD'])).trim();
        if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw appError('SCAN_INVALID_COMMIT');
        // Remove Git metadata before scanning/copying. Skills are content snapshots, not repositories.
        await rm(join(repositoryRoot, '.git'), { recursive: true, force: true });
        sourceUri = github.uri;
        sourceIdentity = github.identity;
        label = github.label;
      } catch (error) {
        await this.removeScanRoot(tempRoot!);
        throw error;
      }
    } else {
      const local = parseLocalDirectory(request.uri);
      repositoryRoot = local.path;
      sourceUri = request.uri.trim();
      sourceIdentity = local.identity;
      label = basename(repositoryRoot) || repositoryRoot;
      try {
        commit = (await runGit(['-C', repositoryRoot, 'rev-parse', '--verify', 'HEAD'])).trim();
        if (!/^[0-9a-f]{40,64}$/i.test(commit)) commit = 'local';
      } catch {
        commit = 'local';
      }
    }

    let scanRoot: string;
    try {
      scanRoot = await resolveScanRoot(repositoryRoot, request.subpath);
    } catch (error) {
      if (tempRoot) await this.removeScanRoot(tempRoot);
      throw error;
    }

    const sourceId = contentId('source', [sourceType, sourceIdentity, requestedRef]);
    const source: StoredSource = {
      id: sourceId,
      type: sourceType,
      uri: sourceUri,
      ref: requestedRef,
      commit,
      label,
      ...(request.subpath?.trim() ? { subpath: normalizeSubpath(request.subpath) } : {}),
    };
    let rawCandidates: CachedCandidate[];
    try {
      rawCandidates = await discoverCandidates(repositoryRoot, scanRoot, sourceId, this.store);
    } catch (error) {
      if (tempRoot) await this.removeScanRoot(tempRoot);
      throw error;
    }
    const session: ScanSession = {
      id: scanId,
      source,
      repositoryRoot,
      scanRoot,
      temporaryRoot: tempRoot,
      candidates: new Map(rawCandidates.map((item) => [item.candidate.id, item])),
      createdAt: Date.now(),
    };
    await this.evictScanSessions(MAX_SCAN_SESSIONS - 1);
    this.sessions.set(scanId, session);
    if (rawCandidates.length === 0 && tempRoot) await this.removeScanRoot(tempRoot);

    return { id: scanId, source, candidates: rawCandidates.map(({ candidate }) => candidate) };
  }

  async install(request: InstallRequest): Promise<BatchResult> {
    await this.evictScanSessions(MAX_SCAN_SESSIONS);
    const session = this.sessions.get(request.scanId);
    if (!session) throw appError('SCAN_EXPIRED');
    const uniqueIds = [...new Set(request.candidateIds)];
    for (const id of uniqueIds) {
      if (!session.candidates.has(id)) throw appError('SCAN_CANDIDATE_UNKNOWN');
    }

    const targetGroupNames =
      request.customGroupName !== undefined
        ? [request.customGroupName.trim()]
        : request.createDetectedGroups
          ? [
              ...new Set(
                uniqueIds.map((id) => candidateGroup(session.candidates.get(id)!.candidate.path)).filter((name): name is string => !!name),
              ),
            ]
          : [];
    // Persisted group names are never empty, whoever calls this.
    if (targetGroupNames.some((name) => !name)) throw appError('GROUP_NAME_REQUIRED');
    const existingGroups = this.store.list<Group>('groups');
    const conflicts = targetGroupNames
      .map((name) => existingGroups.find((group) => normalizeGroupName(group.name) === normalizeGroupName(name)))
      .filter((group): group is Group => !!group);
    if (conflicts.length && !request.mergeExistingGroups) {
      const names = [...new Set(conflicts.map((group) => group.name))];
      throw appError('GROUP_NAMES_TAKEN', { names: names.map((name) => `“${name}”`).join('、') });
    }

    const items: ItemResult[] = [];
    const skillIds: string[] = [];
    for (const candidateId of uniqueIds) {
      const cached = session.candidates.get(candidateId)!;
      const skillId = cached.candidate.id;
      try {
        const result = await this.installCandidate(session, cached);
        items.push(result.item);
        if (result.skillId) skillIds.push(result.skillId);
      } catch (error) {
        items.push({ id: skillId, label: cached.candidate.name, status: 'error', message: errorMessage(error) });
      }
    }

    if (request.createDetectedGroups) {
      const groups = new Map<string, string[]>();
      for (const id of uniqueIds) {
        if (!items.some((item) => item.id === id && item.status === 'success')) continue;
        const name = candidateGroup(session.candidates.get(id)!.candidate.path);
        if (name) groups.set(name, [...(groups.get(name) ?? []), id]);
      }
      for (const [name, ids] of groups) {
        try {
          const existing = this.store.list<Group>('groups').find((group) => normalizeGroupName(group.name) === normalizeGroupName(name));
          this.saveGroup(existing ? { groupId: existing.id, skillIds: ids } : { name, skillIds: ids });
        } catch (error) {
          items.push({ id: `group:${name}`, label: `分组 ${name}`, status: 'error', message: errorMessage(error) });
        }
      }
    } else if (request.customGroupName !== undefined) {
      const groupName = request.customGroupName.trim();
      const successfulIds = items.filter((item) => item.status === 'success').map((item) => item.id);
      if (successfulIds.length) {
        try {
          const existing = this.store
            .list<Group>('groups')
            .find((group) => normalizeGroupName(group.name) === normalizeGroupName(groupName));
          this.saveGroup(existing ? { groupId: existing.id, skillIds: successfulIds } : { name: groupName, skillIds: successfulIds });
        } catch (error) {
          items.push({ id: `group:${groupName}`, label: `分组 ${groupName}`, status: 'error', message: errorMessage(error) });
        }
      }
    }

    if (session.temporaryRoot && this.sessionFullyResolved(session)) {
      await this.removeScanRoot(session.temporaryRoot);
      this.sessions.delete(session.id);
    }
    return { items, skillIds: [...new Set(skillIds)] };
  }

  saveGroup(request: GroupInput): Group {
    const selectedSkillIds = [...new Set(request.skillIds)];
    for (const id of selectedSkillIds) {
      if (!this.store.get<Skill>('skills', id)) throw appError('GROUP_SKILL_NOT_INSTALLED', { id });
    }

    const existing = request.groupId ? this.store.get<Group>('groups', request.groupId) : undefined;
    if (request.groupId && !existing) throw appError('GROUP_NOT_FOUND');
    const name = (request.name ?? existing?.name ?? '').trim();
    if (!name) throw appError('GROUP_NAME_REQUIRED');
    const key = normalizeGroupName(name);
    const duplicate = this.store.list<Group>('groups').find((group) => normalizeGroupName(group.name) === key && group.id !== existing?.id);
    if (duplicate) throw appError('GROUP_NAME_TAKEN', { name: duplicate.name });

    const group: Group = {
      id: existing?.id ?? `group_${randomUUID()}`,
      name,
      skillIds: [...new Set([...(existing?.skillIds ?? []), ...selectedSkillIds])],
      color: existing?.color ?? '#64748b',
    };
    this.store.transaction(() => this.store.put('groups', group));
    return group;
  }

  deleteGroup(id: string): void {
    this.store.transaction(() => this.store.delete('groups', id));
  }

  saveSettings(settings: Partial<Settings>): void {
    const current = this.store.get<Settings>('settings', SETTINGS_ID) ?? DEFAULT_SETTINGS;
    const next: Settings = {
      viewMode: settings.viewMode ?? current.viewMode,
      activeTabs: { ...current.activeTabs, ...(settings.activeTabs ?? {}) },
    };
    this.store.transaction(() => this.store.put('settings', { id: SETTINGS_ID, ...next }));
  }

  /** Reconciles incomplete library installs from journal records and disk hashes. */
  async recover(): Promise<void> {
    await this.ensureLibraryDirectories();
    const operations = this.journal
      .list<LibraryInstallOperation>('library')
      .filter((operation) => operation.owner === 'library' && operation.kind === 'install');

    for (const operation of operations) {
      if (!OPERATION_ID_RE.test(operation.id)) continue;
      if (operation.phase === 'committed' || operation.phase === 'failed') {
        await this.removeOperationDirectory(operation.id);
        continue;
      }
      if (!this.operationPathsAreManaged(operation)) {
        this.markOperationFailed(operation, message('LIBRARY_RECOVERY_PATHS_MISMATCH'));
        continue;
      }
      if (operation.phase === 'preparing' || !operation.newHash) {
        await this.removeOperationDirectory(operation.id);
        this.markOperationFailed(operation, message('LIBRARY_RECOVERY_INCOMPLETE_STAGE'));
        continue;
      }

      try {
        const finalExists = await pathExists(operation.finalPath);
        const stageExists = await pathExists(operation.stagePath);
        await this.assertOperationParents(operation, stageExists, finalExists);
        if (finalExists) {
          if (stageExists) {
            this.markOperationFailed(operation, message('LIBRARY_RECOVERY_AMBIGUOUS'));
            continue;
          }
          if (!(await isRealDirectory(operation.finalPath))) {
            this.markOperationFailed(operation, message('LIBRARY_RECOVERY_DESTINATION_UNMANAGED'));
            continue;
          }
          const finalHash = await hashDirectory(operation.finalPath);
          if (finalHash !== operation.newHash) {
            this.markOperationFailed(operation, message('LIBRARY_RECOVERY_DESTINATION_CHANGED'));
            continue;
          }
          await this.commitInstallOperation(operation);
          await this.removeOperationDirectory(operation.id);
          continue;
        }

        if (stageExists && (await isRealDirectory(operation.stagePath))) {
          const stageHash = await hashDirectory(operation.stagePath);
          if (stageHash !== operation.newHash) {
            this.markOperationFailed(operation, message('LIBRARY_RECOVERY_STAGE_CHANGED'));
            continue;
          }
          await this.ensureSkillsParent(operation.skill.id);
          await assertManagedDirectory(dirname(operation.stagePath), join(this.store.root, '.staging'));
          if (await pathExists(operation.finalPath)) {
            this.markOperationFailed(operation, message('LIBRARY_RECOVERY_DESTINATION_OCCUPIED'));
            continue;
          }
          await rename(operation.stagePath, operation.finalPath);
          if ((await hashDirectory(operation.finalPath)) !== operation.newHash) {
            this.markOperationFailed(operation, message('LIBRARY_RECOVERY_HASH_MISMATCH'));
            continue;
          }
          operation.phase = 'renamed';
          this.journal.put(operation);
          await this.commitInstallOperation(operation);
          await this.removeOperationDirectory(operation.id);
          continue;
        }

        this.markOperationFailed(operation, message('LIBRARY_RECOVERY_NOTHING_LEFT'));
      } catch (error) {
        const reason = errorMessage(error);
        // A recovery path that is not a real managed directory will not fix itself: stop retrying.
        if (RECOVERY_PATH_ERRORS.has(errorCodeOf(error))) this.markOperationFailed(operation, reason);
        else {
          operation.error = reason;
          this.journal.put(operation);
        }
      }
    }

    for (const entry of await readdir(join(this.store.root, '.staging'), { withFileTypes: true })) {
      if (!entry.name.startsWith('scan-')) continue;
      const path = join(this.store.root, '.staging', entry.name);
      if (!this.activeScanRoots.has(path)) await this.removeScanRoot(path);
    }
  }

  private async installCandidate(session: ScanSession, cached: CachedCandidate): Promise<{ item: ItemResult; skillId?: string }> {
    const candidate = cached.candidate;
    if (candidate.issues.length) throw appError('INSTALL_CANDIDATE_INVALID', { reason: candidate.issues.join(' ') });
    const sourceDirectory = await this.verifyCandidatePath(session, cached);
    const metadata = await readSkillMetadata(sourceDirectory);
    if (metadata.issues.length) throw appError('INSTALL_CANDIDATE_INVALID', { reason: metadata.issues.join(' ') });
    if (metadata.name !== cached.validationName || metadata.description !== cached.validationDescription) {
      throw appError('INSTALL_MANIFEST_CHANGED');
    }

    const existing = this.store.get<StoredSkill>('skills', candidate.id);
    if (existing) {
      if (existing.sourceId !== session.source.id || existing.sourcePath !== candidate.path) {
        throw appError('INSTALL_ID_OTHER_SOURCE');
      }
      const actualHash = await hashDirectory(existing.directory);
      const existingSource = this.store.get<Source>('sources', session.source.id);
      this.store.transaction(() => {
        if (actualHash !== existing.currentHash) this.store.put('skills', { ...existing, currentHash: actualHash });
        this.store.put(
          'sources',
          existingSource ? { ...existingSource, commit: session.source.commit, subpath: session.source.subpath } : session.source,
        );
      });
      return {
        item: {
          id: existing.id,
          label: existing.name,
          status: 'skipped',
          message: message('INSTALL_ALREADY_INSTALLED'),
        },
        skillId: existing.id,
      };
    }

    const safeName = metadata.name!;
    const skillParent = join(this.store.root, 'skills', candidate.id);
    const finalPath = join(skillParent, safeName);
    if (await pathExists(finalPath)) throw appError('INSTALL_DESTINATION_UNMANAGED');
    const parentExists = await pathExists(skillParent);
    if (parentExists) {
      await this.assertSafeLibraryPath(skillParent, join(this.store.root, 'skills'));
      if ((await readdir(skillParent)).length > 0) throw appError('INSTALL_ID_DIRECTORY_UNMANAGED');
    }

    const operationId = randomUUID();
    const operationDirectory = join(this.store.root, '.staging', operationId);
    const stagePath = join(operationDirectory, 'content');
    const installedAt = new Date().toISOString();
    const skill: StoredSkill = {
      id: candidate.id,
      name: metadata.name!,
      description: metadata.description!,
      sourceId: session.source.id,
      sourcePath: candidate.path,
      directory: finalPath,
      baseHash: '',
      currentHash: '',
      installedAt,
      resolvedCommit: session.source.type === 'github' ? session.source.commit : undefined,
      upstreamSignal: session.source.type === 'github' ? { algo: 'git-commit', value: session.source.commit } : undefined,
    };
    const operation: LibraryInstallOperation = {
      id: operationId,
      owner: 'library',
      kind: 'install',
      phase: 'preparing',
      createdAt: installedAt,
      candidateId: candidate.id,
      stagePath,
      finalPath,
      source: session.source,
      skill,
    };
    this.journal.put(operation);

    try {
      await mkdir(operationDirectory, { recursive: false, mode: 0o700 });
      await assertManagedDirectory(operationDirectory, join(this.store.root, '.staging'));
      const beforeHash = await hashDirectory(sourceDirectory);
      await copySkillDirectory(sourceDirectory, stagePath);
      const stagedHash = await hashDirectory(stagePath);
      const afterHash = await hashDirectory(sourceDirectory);
      if (beforeHash !== afterHash || beforeHash !== stagedHash) {
        throw appError('INSTALL_SOURCE_CHANGED');
      }

      skill.baseHash = stagedHash;
      skill.currentHash = stagedHash;
      operation.skill = skill;
      operation.newHash = stagedHash;
      operation.phase = 'prepared';
      this.journal.put(operation);

      await this.ensureSkillsParent(candidate.id);
      await assertManagedDirectory(operationDirectory, join(this.store.root, '.staging'));
      if (await pathExists(finalPath)) throw appError('INSTALL_DESTINATION_OCCUPIED');
      await rename(stagePath, finalPath);
      if ((await hashDirectory(finalPath)) !== stagedHash) {
        throw appError('INSTALL_CHANGED_DURING_MOVE');
      }
      operation.phase = 'renamed';
      this.journal.put(operation);
      await this.commitInstallOperation(operation);
      await this.removeOperationDirectory(operation.id);
      return { item: { id: skill.id, label: skill.name, status: 'success' }, skillId: skill.id };
    } catch (error) {
      if (operation.phase === 'preparing') {
        operation.phase = 'failed';
        operation.error = errorMessage(error);
        this.journal.put(operation);
        await this.removeOperationDirectory(operation.id);
      } else {
        // A verified stage or renamed directory remains journaled for recover() to inspect.
        try {
          await this.recoverOne(operation);
          const committed = this.store.get<Skill>('skills', skill.id);
          if (committed?.directory === skill.directory) {
            return { item: { id: committed.id, label: committed.name, status: 'success' }, skillId: committed.id };
          }
        } catch {
          // Keep the journal intact; startup recovery will repeat the evidence check.
        }
      }
      throw error;
    }
  }

  private async recoverOne(operation: LibraryInstallOperation): Promise<void> {
    if (!this.operationPathsAreManaged(operation) || !operation.newHash) return;
    if (await pathExists(operation.finalPath)) {
      if (await pathExists(operation.stagePath)) return;
      await this.assertOperationParents(operation, false, true);
      if (!(await isRealDirectory(operation.finalPath))) return;
      if ((await hashDirectory(operation.finalPath)) === operation.newHash) {
        await this.commitInstallOperation(operation);
        await this.removeOperationDirectory(operation.id);
      }
      return;
    }
    if (await pathExists(operation.stagePath)) {
      await this.assertOperationParents(operation, true, false);
      if (!(await isRealDirectory(operation.stagePath)) || (await hashDirectory(operation.stagePath)) !== operation.newHash) return;
      await this.ensureSkillsParent(operation.skill.id);
      if (await pathExists(operation.finalPath)) return;
      await rename(operation.stagePath, operation.finalPath);
      operation.phase = 'renamed';
      this.journal.put(operation);
      await this.commitInstallOperation(operation);
      await this.removeOperationDirectory(operation.id);
    }
  }

  private async commitInstallOperation(operation: LibraryInstallOperation): Promise<void> {
    const existing = this.store.get<Skill>('skills', operation.skill.id);
    if (existing && existing.directory !== operation.skill.directory) {
      throw appError('INSTALL_ID_COMMITTED_ELSEWHERE');
    }
    const existingSource = this.store.get<Source>('sources', operation.source.id);
    this.store.transaction(() => {
      this.store.put(
        'sources',
        existingSource ? { ...existingSource, commit: operation.source.commit, subpath: operation.source.subpath } : operation.source,
      );
      if (!existing) this.store.put('skills', operation.skill);
      operation.phase = 'committed';
      operation.error = undefined;
      this.journal.put(operation);
    });
  }

  private async verifyCandidatePath(session: ScanSession, cached: CachedCandidate): Promise<string> {
    const relativePath = cached.candidate.path;
    const segments = relativePath === '.' ? [] : relativePath.split('/');
    if (segments.some((part) => !part || part === '.' || part === '..' || part.includes('\0'))) {
      throw appError('CANDIDATE_PATH_INVALID');
    }
    const candidatePath = resolve(session.repositoryRoot, ...segments);
    if (!isWithin(session.repositoryRoot, candidatePath)) throw appError('CANDIDATE_PATH_ESCAPED');
    const resolvedCandidate = await realpath(candidatePath);
    if (!isWithin(session.repositoryRoot, resolvedCandidate)) throw appError('CANDIDATE_PATH_RESOLVES_OUTSIDE');
    if (!(await lstat(candidatePath)).isDirectory()) throw appError('CANDIDATE_DIRECTORY_MISSING');
    return resolvedCandidate;
  }

  private async ensureLibraryDirectories(): Promise<void> {
    await ensureManagedDirectory(join(this.store.root, '.staging'), this.store.root);
    await ensureManagedDirectory(join(this.store.root, 'skills'), this.store.root);
  }

  private async ensureSkillsParent(skillId: string): Promise<void> {
    if (!SKILL_ID_RE.test(skillId)) throw appError('LIBRARY_SKILL_ID_INVALID');
    const skillsRoot = join(this.store.root, 'skills');
    await ensureManagedDirectory(skillsRoot, this.store.root);
    await ensureManagedDirectory(join(skillsRoot, skillId), skillsRoot);
  }

  private async assertOperationParents(operation: LibraryInstallOperation, stageExists: boolean, finalExists: boolean): Promise<void> {
    if (stageExists) await assertManagedDirectory(dirname(operation.stagePath), join(this.store.root, '.staging'));
    if (finalExists) await assertManagedDirectory(dirname(operation.finalPath), join(this.store.root, 'skills'));
  }

  private async assertSafeLibraryPath(path: string, parent: string): Promise<void> {
    const resolvedParent = await realpath(parent);
    const resolvedPath = await realpath(path);
    if (!isWithin(resolvedParent, resolvedPath) || (await lstat(path)).isSymbolicLink()) {
      throw appError('LIBRARY_PATH_UNSAFE');
    }
  }

  private operationPathsAreManaged(operation: LibraryInstallOperation): boolean {
    if (!SKILL_ID_RE.test(operation.skill?.id ?? '') || !SOURCE_ID_RE.test(operation.source?.id ?? '')) return false;
    if (typeof operation.skill.name !== 'string' || !isValidSkillName(operation.skill.name)) return false;
    return (
      operation.stagePath === join(this.store.root, '.staging', operation.id, 'content') &&
      operation.finalPath === join(this.store.root, 'skills', operation.skill.id, operation.skill.name) &&
      operation.skill.directory === operation.finalPath &&
      operation.skill.sourceId === operation.source.id &&
      operation.candidateId === operation.skill.id
    );
  }

  private markOperationFailed(operation: LibraryInstallOperation, message: string): void {
    operation.phase = 'failed';
    operation.error = message;
    this.journal.put(operation);
  }

  private async removeOperationDirectory(operationId: string): Promise<void> {
    if (!OPERATION_ID_RE.test(operationId)) return;
    const path = join(this.store.root, '.staging', operationId);
    await this.removeManagedEntry(path, join(this.store.root, '.staging'));
  }

  private async removeScanRoot(path: string): Promise<void> {
    try {
      if (!isWithin(join(this.store.root, '.staging'), path) || basename(path).startsWith('scan-') === false) return;
      await this.removeManagedEntry(path, join(this.store.root, '.staging'));
    } finally {
      this.activeScanRoots.delete(path);
    }
  }

  private async removeManagedEntry(path: string, parent: string): Promise<void> {
    const managedParent = await realpath(parent);
    const resolvedPath = resolve(path);
    if (!isWithin(managedParent, resolvedPath)) return;
    try {
      await lstat(resolvedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    // rm does not traverse a symlink at the named entry; this path is always generated internally.
    await rm(resolvedPath, { recursive: true, force: true });
  }

  /** Drops expired scan sessions, then the oldest ones beyond `keep`, removing their temporary checkouts. */
  private async evictScanSessions(keep: number): Promise<void> {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      const expired = now - session.createdAt > SCAN_SESSION_TTL_MS;
      if (!expired && this.sessions.size <= keep) continue;
      this.sessions.delete(session.id);
      // A leftover checkout is also swept by recover() on the next start, so a failed removal must not block scanning.
      if (session.temporaryRoot) await this.removeScanRoot(session.temporaryRoot).catch(() => undefined);
    }
  }

  private sessionFullyResolved(session: ScanSession): boolean {
    return [...session.candidates.values()].every(
      ({ candidate }) => candidate.issues.length > 0 || Boolean(this.store.get<Skill>('skills', candidate.id)),
    );
  }
}

function normalizeGroupName(name: string): string {
  return name.normalize('NFKC').toLocaleLowerCase('en-US');
}

async function discoverCandidates(repositoryRoot: string, scanRoot: string, sourceId: string, store: Store): Promise<CachedCandidate[]> {
  const directories: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let children: Dirent[];
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw appError('SCAN_DIRECTORY_FAILED', { path: relative(repositoryRoot, directory) || '.', reason: errorMessage(error) });
    }
    children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    const skillEntry = children.find((child) => child.name === 'SKILL.md');
    if (skillEntry) directories.push(directory);
    for (const child of children) {
      if (child.name === '.git' || child.name === '.svn' || child.name === '.hg') continue;
      const childPath = join(directory, child.name);
      if (!child.isDirectory()) continue; // In particular, never recurse through a source symlink.
      await walk(childPath);
    }
  };
  await walk(scanRoot);

  const candidates: CachedCandidate[] = [];
  for (const directory of directories) {
    const sourcePath = relative(repositoryRoot, directory).split(sep).join('/') || '.';
    const id = contentId('skill', [sourceId, sourcePath]);
    const parsed: ParsedSkill = await readSkillMetadata(directory).catch((error) => ({
      name: undefined,
      description: undefined,
      issues: [errorMessage(error)],
    }));
    const name = parsed.name?.trim() || basename(directory) || message('SKILL_INVALID_PLACEHOLDER');
    const skill: StoredSkill | undefined = store.get('skills', id);
    const candidate: Candidate = {
      id,
      name,
      description: parsed.description ?? '',
      path: sourcePath,
      issues: [...parsed.issues],
      installed: Boolean(skill),
    };
    candidates.push({
      candidate,
      sourceDirectory: directory,
      validationName: parsed.name,
      validationDescription: parsed.description,
    });
  }
  return candidates;
}

export async function readSkillMetadata(directory: string): Promise<ParsedSkill> {
  const filePath = join(directory, 'SKILL.md');
  const fileStat = await lstat(filePath);
  if (!fileStat.isFile()) return { issues: [message('SKILL_MANIFEST_NOT_FILE')] };
  if (fileStat.size > MAX_SKILL_MARKDOWN_BYTES) return { issues: [message('SKILL_MANIFEST_TOO_LARGE')] };
  const text = (await readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
  const parsed = parseSkillFrontmatter(text);
  const issues = [...parsed.issues];
  if (!parsed.name) issues.push(message('SKILL_NAME_MISSING'));
  else if (!isValidSkillName(parsed.name)) issues.push(message('SKILL_NAME_INVALID'));
  if (!parsed.description?.trim()) issues.push(message('SKILL_DESCRIPTION_MISSING'));
  else if (parsed.description.length > 1024) issues.push(message('SKILL_DESCRIPTION_TOO_LONG'));
  return { name: parsed.name, description: parsed.description, issues: [...new Set(issues)] };
}

function parseSkillFrontmatter(text: string): ParsedSkill {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { issues: [message('SKILL_FRONTMATTER_MISSING')] };
  const closing = lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/.test(line));
  if (closing < 0) return { issues: [message('SKILL_FRONTMATTER_INVALID')] };
  try {
    // Parse only the bounded YAML header. No executable language engines or custom tags are registered.
    const data: unknown = loadYaml(lines.slice(1, closing).join('\n'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { issues: [message('SKILL_FRONTMATTER_NOT_MAPPING')] };
    }
    const fields = data as Record<string, unknown>;
    const name = Object.hasOwn(fields, 'name') && typeof fields.name === 'string' ? fields.name : undefined;
    const description = Object.hasOwn(fields, 'description') && typeof fields.description === 'string' ? fields.description : undefined;
    const issues: string[] = [];
    if (Object.hasOwn(fields, 'name') && name === undefined) issues.push(message('SKILL_NAME_NOT_STRING'));
    if (Object.hasOwn(fields, 'description') && description === undefined) issues.push(message('SKILL_DESCRIPTION_NOT_STRING'));
    return { name, description, issues };
  } catch {
    return { issues: [message('SKILL_FRONTMATTER_INVALID')] };
  }
}

export function isValidSkillName(name: string): boolean {
  return name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name);
}

export function tryParseGithub(uri: string): ParsedGithub | undefined {
  const trimmed = uri.trim();
  let owner: string;
  let repository: string;
  const short = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*?)(?:\.git)?\/?$/.exec(trimmed);
  if (short && !isAbsolute(trimmed) && !trimmed.startsWith('.')) {
    owner = short[1];
    repository = short[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname.toLowerCase() !== 'github.com' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }
    const parts = parsed.pathname.replace(/\/$/, '').split('/').filter(Boolean);
    if (parts.length !== 2) return undefined;
    [owner, repository] = parts;
    repository = repository.replace(/\.git$/i, '');
  }
  if (!owner! || !repository! || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(owner) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)) {
    return undefined;
  }
  const label = `${owner}/${repository}`;
  const normalized = `https://github.com/${owner.toLowerCase()}/${repository.toLowerCase()}.git`;
  return { uri: trimmed, cloneUrl: `https://github.com/${owner}/${repository}.git`, identity: normalized, label };
}

function normalizeRef(ref: string | undefined): string {
  const normalized = ref?.trim() || 'HEAD';
  if (normalized.length > 512 || normalized.startsWith('-') || /[\u0000-\u0020~^:?*[\\]/.test(normalized) || normalized.endsWith('.')) {
    throw appError('SCAN_REF_INVALID');
  }
  return normalized;
}

export function parseLocalDirectory(uri: string): { path: string; identity: string } {
  const trimmed = uri.trim();
  let requestedPath: string;
  if (trimmed.startsWith('file://')) {
    try {
      requestedPath = fileURLToPath(trimmed);
    } catch {
      throw appError('SCAN_FILE_URL_INVALID');
    }
  } else {
    requestedPath = trimmed;
  }
  if (!isAbsolute(requestedPath)) throw appError('SCAN_LOCAL_NOT_ABSOLUTE');
  let path: string;
  try {
    path = realpathSync(requestedPath);
  } catch {
    throw appError('SCAN_LOCAL_MISSING');
  }
  const info = lstatSync(path);
  if (!info.isDirectory()) throw appError('SCAN_LOCAL_NOT_DIRECTORY');
  return { path, identity: path };
}

async function resolveScanRoot(repositoryRoot: string, subpath?: string): Promise<string> {
  const normalized = normalizeSubpath(subpath ?? '');
  if (!normalized) return repositoryRoot;
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..' || part === '.' || !part)) throw appError('SCAN_SUBPATH_ESCAPES');
  const requested = resolve(repositoryRoot, ...parts);
  if (!isWithin(repositoryRoot, requested)) throw appError('SCAN_SUBPATH_ESCAPES');
  let result: string;
  try {
    result = await realpath(requested);
  } catch {
    throw appError('SCAN_SUBPATH_MISSING');
  }
  if (!isWithin(repositoryRoot, result)) throw appError('SCAN_SUBPATH_RESOLVES_OUTSIDE');
  if (!(await stat(result)).isDirectory()) throw appError('SCAN_SUBPATH_NOT_DIRECTORY');
  return result;
}

function normalizeSubpath(subpath: string): string {
  const value = subpath.trim();
  if (!value) return '';
  if (value.includes('\\') || isAbsolute(value) || value.startsWith('/')) throw appError('SCAN_SUBPATH_NOT_RELATIVE');
  return value
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/$/, '');
}

export async function ensureManagedDirectory(path: string, parent: string): Promise<void> {
  try {
    await mkdir(path, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw appError('LIBRARY_MANAGED_NOT_DIRECTORY', { path });
  const [realParent, realPath] = await Promise.all([realpath(parent), realpath(path)]);
  if (!isWithin(realParent, realPath)) throw appError('LIBRARY_MANAGED_OUTSIDE_PARENT', { path });
}

export async function assertManagedDirectory(path: string, parent: string): Promise<void> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw appError('LIBRARY_RECOVERY_PATH_INVALID', { path });
  const [realParent, realPath] = await Promise.all([realpath(parent), realpath(path)]);
  if (!isWithin(realParent, realPath)) throw appError('LIBRARY_RECOVERY_PATH_OUTSIDE', { path });
}

export async function isRealDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Git without prompts or repository hooks, for every command run against a remote source. */
export function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: process.platform === 'win32' ? 'NUL' : '/dev/null',
  };
}

/** Shallow-checks out `ref` into an existing empty directory. */
export async function checkoutGithub(github: ParsedGithub, ref: string, checkoutPath: string): Promise<void> {
  const env = gitEnvironment();
  await runGit(['init', '--quiet', checkoutPath], undefined, env);
  await runGit(['-C', checkoutPath, 'remote', 'add', 'origin', github.cloneUrl], undefined, env);
  await runGit(['-C', checkoutPath, 'fetch', '--quiet', '--depth=1', 'origin', ref], undefined, env);
  await runGit(['-C', checkoutPath, 'checkout', '--quiet', '--detach', 'FETCH_HEAD'], undefined, env);
}

export async function runGit(args: string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return result.stdout;
  } catch (error) {
    const cause = error as { stderr?: string; message?: string };
    const details = sanitizeGitOutput(cause.stderr || cause.message || message('UNKNOWN_ERROR'));
    throw appError('SCAN_GIT_FAILED', { details });
  }
}

function sanitizeGitOutput(value: string): string {
  return value
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, 'https://[redacted]@')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted token]')
    .replace(/\b(token|password|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 500);
}
