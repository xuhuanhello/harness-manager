import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { errorMessage } from '../shared/errors';
import { ID_PATTERNS } from '../shared/limits';
import type { BatchResult, ItemResult, Skill, SkillUpdate, Source, SourceUpdates, UpdateCheck, UpdateRequest } from '../shared/types';
import { copySkillDirectory, hashDirectory } from './content';
import { isWithin, pathExists } from './fs-utils';
import { Journal, type JournalRecord } from './journal';
import {
  assertManagedDirectory,
  checkoutGithub,
  ensureManagedDirectory,
  gitEnvironment,
  isRealDirectory,
  isValidSkillName,
  parseLocalDirectory,
  readSkillMetadata,
  runGit,
  tryParseGithub,
} from './library';
import { appError, message } from './messages';
import type { Store } from './store';

/** How long the result of a check can still be applied. */
const CHECK_TTL_MS = 2 * 60 * 60_000;
const CHECK_CONCURRENCY = 4;
const COMMIT_RE = /^[0-9a-f]{40,64}$/i;

interface CheckedSkill {
  update: SkillUpdate;
  upstreamDirectory: string;
  upstreamHash: string;
  /** The central content when checked; an update only replaces exactly this. */
  localHash: string;
}

interface CheckedSource {
  commit?: string;
  /** The temporary checkout of a GitHub source, removed once nothing in it is pending. */
  checkout?: string;
  skills: Map<string, CheckedSkill>;
}

interface CheckSession {
  id: string;
  createdAt: number;
  /** `.staging/update-<id>`, holding the GitHub checkouts that still have updates. */
  root: string;
  sources: Map<string, CheckedSource>;
  /** Applies in progress; the session and its checkouts stay until they finish. */
  users: number;
}

interface UpdateOperation extends JournalRecord {
  owner: 'update';
  kind: 'update';
  phase: 'preparing' | 'prepared' | 'old_moved' | 'new_placed' | 'committed' | 'failed' | 'blocked';
  createdAt: string;
  skillId: string;
  centralPath: string;
  stagePath: string;
  previousPath: string;
  oldHash: string;
  newHash?: string;
  commit?: string;
  description: string;
  /** Local edits being replaced go to the system trash instead of being deleted. */
  trashPrevious: boolean;
}

/**
 * Checks installed skills against their sources and replaces central copies with the upstream
 * version the user confirmed. A check never writes to the library; an update swaps the whole
 * skill directory through a journaled stage so startup recovery can finish or undo it.
 */
export class UpdateService {
  private readonly journal: Journal;
  private readonly sessions = new Map<string, CheckSession>();
  private latest?: string;
  private checking?: Promise<UpdateCheck>;
  /** Sources found up to date at a remote commit, so an unchanged remote is not fetched again. */
  private readonly upToDate = new Map<string, { remote: string; fingerprint: string; result: SourceUpdates }>();

  constructor(
    private readonly store: Store,
    private readonly options: { trashItem?: (path: string) => Promise<void> } = {},
  ) {
    this.journal = new Journal(store);
  }

  /** Concurrent callers share one check. */
  check(): Promise<UpdateCheck> {
    this.checking ??= this.runCheck().finally(() => {
      this.checking = undefined;
    });
    return this.checking;
  }

  async apply(request: UpdateRequest): Promise<BatchResult> {
    const session = this.sessions.get(request.checkId);
    if (!session || Date.now() - session.createdAt > CHECK_TTL_MS) throw appError('UPDATE_CHECK_EXPIRED');
    session.users += 1;
    try {
      const replace = new Set(request.replaceModified ?? []);
      const items: ItemResult[] = [];
      const skillIds: string[] = [];
      for (const skillId of new Set(request.skillIds)) {
        const [sourceId, source] = [...session.sources.entries()].find(([, item]) => item.skills.has(skillId)) ?? [];
        const checked = source?.skills.get(skillId);
        if (!source || !checked) {
          items.push({
            id: skillId,
            label: this.store.get<Skill>('skills', skillId)?.name ?? skillId,
            status: 'error',
            message: message('UPDATE_SKILL_UNKNOWN'),
          });
          continue;
        }
        try {
          const outcome = await this.updateOne(source, checked, replace.has(skillId));
          items.push({ id: skillId, label: checked.update.name, ...outcome });
          if (outcome.status === 'success') {
            skillIds.push(skillId);
            source.skills.delete(skillId);
            if (!source.skills.size) {
              session.sources.delete(sourceId!);
              const done = session.sources.size ? source.checkout : session.root;
              if (done) await this.removeManaged(done).catch(() => undefined);
            }
          }
        } catch (error) {
          items.push({ id: skillId, label: checked.update.name, status: 'error', message: errorMessage(error) });
        }
      }
      return { items, skillIds };
    } finally {
      session.users -= 1;
      await this.evictSessions();
    }
  }

  /** Finishes or undoes interrupted updates and removes checkouts left by an earlier run. */
  async recover(): Promise<void> {
    const staging = join(this.store.root, '.staging');
    await ensureManagedDirectory(staging, this.store.root);
    for (const operation of this.journal.list<UpdateOperation>('update')) {
      if (!ID_PATTERNS.uuid.test(operation.id) || operation.phase === 'blocked') continue;
      if (operation.phase === 'failed' || operation.phase === 'committed') {
        if (await pathExists(join(staging, operation.id))) await this.recoverOne(operation.id);
        continue;
      }
      await this.recoverOne(operation.id);
    }
    for (const entry of await readdir(staging, { withFileTypes: true })) {
      if (entry.name.startsWith('update-') && ![...this.sessions.values()].some((session) => session.root === join(staging, entry.name)))
        await this.removeManaged(join(staging, entry.name));
    }
  }

  private async runCheck(): Promise<UpdateCheck> {
    const staging = join(this.store.root, '.staging');
    await ensureManagedDirectory(staging, this.store.root);
    const id = randomUUID();
    const session: CheckSession = { id, createdAt: Date.now(), root: join(staging, `update-${id}`), sources: new Map(), users: 0 };
    this.sessions.set(id, session);
    const skills = this.store.list<Skill>('skills');
    const sources = this.store.list<Source>('sources').filter((source) => skills.some((skill) => skill.sourceId === source.id));
    let results: SourceUpdates[];
    try {
      results = await mapLimit(sources, CHECK_CONCURRENCY, (source, index) =>
        this.checkSource(
          session,
          source,
          skills.filter((skill) => skill.sourceId === source.id),
          index,
        ).catch((error): SourceUpdates => ({ sourceId: source.id, updates: [], missing: [], error: errorMessage(error) })),
      );
    } catch (error) {
      this.sessions.delete(id);
      await this.removeManaged(session.root).catch(() => undefined);
      throw error;
    }
    this.latest = id;
    await this.evictSessions();
    return { id, checkedAt: new Date(session.createdAt).toISOString(), sources: results };
  }

  private async checkSource(session: CheckSession, source: Source, skills: Skill[], index: number): Promise<SourceUpdates> {
    if (source.type === 'local') return this.compare(session, source, skills, parseLocalDirectory(source.uri).path);
    const github = tryParseGithub(source.uri);
    if (!github) throw appError('UPDATE_SOURCE_UNSUPPORTED');
    // A commit ID as ref pins the source; there is nothing newer to fetch.
    if (COMMIT_RE.test(source.ref)) return { sourceId: source.id, commit: source.ref.toLowerCase(), updates: [], missing: [] };

    const remote = remoteCommit(await runGit(['ls-remote', github.cloneUrl, source.ref], undefined, gitEnvironment()), source.ref);
    const fingerprint = JSON.stringify(skills.map((skill) => [skill.id, skill.sourcePath, skill.baseHash]).sort());
    if (remote) {
      if (skills.every((skill) => skill.resolvedCommit?.toLowerCase() === remote))
        return { sourceId: source.id, commit: remote, updates: [], missing: [] };
      const known = this.upToDate.get(source.id);
      if (known?.remote === remote && known.fingerprint === fingerprint) return known.result;
    }

    const directory = join(session.root, String(index));
    const checkoutPath = join(directory, 'checkout');
    await ensureManagedDirectory(session.root, dirname(session.root));
    await mkdir(checkoutPath, { recursive: true, mode: 0o700 });
    try {
      await checkoutGithub(github, source.ref, checkoutPath);
      const repositoryRoot = await realpath(checkoutPath);
      const commit = (await runGit(['-C', repositoryRoot, 'rev-parse', '--verify', 'HEAD'])).trim().toLowerCase();
      if (!COMMIT_RE.test(commit)) throw appError('SCAN_INVALID_COMMIT');
      await rm(join(repositoryRoot, '.git'), { recursive: true, force: true });
      const result = await this.compare(session, source, skills, repositoryRoot, commit);
      const checked = session.sources.get(source.id);
      if (checked) checked.checkout = directory;
      if (!result.updates.length) {
        await this.removeManaged(directory);
        if (remote === commit) this.upToDate.set(source.id, { remote, fingerprint, result });
      }
      return result;
    } catch (error) {
      await this.removeManaged(directory).catch(() => undefined);
      throw error;
    }
  }

  private async compare(
    session: CheckSession,
    source: Source,
    skills: Skill[],
    repositoryRoot: string,
    commit?: string,
  ): Promise<SourceUpdates> {
    const checked: CheckedSource = { commit, skills: new Map() };
    const updates: SkillUpdate[] = [];
    const missing: string[] = [];
    for (const skill of skills) {
      const upstream = await upstreamDirectory(repositoryRoot, skill);
      if (upstream === 'missing') {
        missing.push(skill.id);
        continue;
      }
      if (upstream === 'same') continue;
      let upstreamHash = '';
      let blocked: string | undefined;
      try {
        upstreamHash = await hashDirectory(upstream);
      } catch (error) {
        blocked = message('UPDATE_UPSTREAM_INVALID', { reason: errorMessage(error) });
      }
      if (!blocked && upstreamHash === skill.baseHash) continue;
      const localHash = await hashDirectory(skill.directory).catch(() => '');
      if (!blocked && localHash === upstreamHash) continue;
      const metadata = await readSkillMetadata(upstream).catch((error) => ({
        name: undefined,
        description: undefined,
        issues: [errorMessage(error)],
      }));
      if (!blocked && metadata.issues.length) blocked = message('UPDATE_UPSTREAM_INVALID', { reason: metadata.issues.join(' ') });
      else if (!blocked && metadata.name !== skill.name) blocked = message('UPDATE_UPSTREAM_RENAMED', { name: metadata.name ?? '' });
      else if (!blocked && !localHash) blocked = message('UPDATE_CENTRAL_MISSING');
      const update: SkillUpdate = {
        skillId: skill.id,
        name: skill.name,
        description: metadata.description ?? skill.description,
        localModified: !!localHash && localHash !== skill.baseHash,
        ...(blocked ? { blocked } : {}),
      };
      updates.push(update);
      checked.skills.set(skill.id, { update, upstreamDirectory: upstream, upstreamHash, localHash });
    }
    if (checked.skills.size) session.sources.set(source.id, checked);
    return { sourceId: source.id, ...(commit ? { commit } : {}), updates, missing };
  }

  private async updateOne(
    source: CheckedSource,
    checked: CheckedSkill,
    replaceModified: boolean,
  ): Promise<{ status: ItemResult['status']; message: string }> {
    const { update } = checked;
    if (update.blocked) return { status: 'skipped', message: update.blocked };
    if (update.localModified && !replaceModified) return { status: 'skipped', message: message('UPDATE_LOCAL_MODIFIED_SKIPPED') };
    if (update.localModified && !this.options.trashItem) return { status: 'skipped', message: message('UPDATE_TRASH_UNAVAILABLE') };
    const skill = this.store.get<Skill>('skills', update.skillId);
    if (!skill) throw appError('UPDATE_SKILL_MISSING');
    const centralPath = join(this.store.root, 'skills', skill.id, skill.name);
    if (skill.directory !== centralPath || skill.name !== update.name) throw appError('UPDATE_DESTINATION_UNEXPECTED');
    await assertManagedDirectory(dirname(centralPath), join(this.store.root, 'skills'));
    if (!(await isRealDirectory(centralPath))) throw appError('UPDATE_CENTRAL_MISSING');
    if ((await hashDirectory(centralPath)) !== checked.localHash) throw appError('UPDATE_LOCAL_CHANGED');

    const id = randomUUID();
    const staging = join(this.store.root, '.staging');
    const operationDirectory = join(staging, id);
    const operation: UpdateOperation = {
      id,
      owner: 'update',
      kind: 'update',
      phase: 'preparing',
      createdAt: new Date().toISOString(),
      skillId: skill.id,
      centralPath,
      stagePath: join(operationDirectory, 'content'),
      // Named after the skill so a version moved to the trash is recognizable there.
      previousPath: join(operationDirectory, 'previous', skill.name),
      oldHash: checked.localHash,
      ...(source.commit ? { commit: source.commit } : {}),
      description: update.description,
      trashPrevious: update.localModified,
    };
    this.putOperation(operation);
    try {
      await mkdir(operationDirectory, { mode: 0o700 });
      await assertManagedDirectory(operationDirectory, staging);
      await mkdir(dirname(operation.previousPath), { mode: 0o700 });
      await copySkillDirectory(checked.upstreamDirectory, operation.stagePath);
      const stagedHash = await hashDirectory(operation.stagePath);
      if (stagedHash !== checked.upstreamHash) throw appError('UPDATE_SOURCE_CHANGED');
      this.updateOperation(id, { phase: 'prepared', newHash: stagedHash });

      if ((await hashDirectory(centralPath)) !== checked.localHash) throw appError('UPDATE_LOCAL_CHANGED');
      await rename(centralPath, operation.previousPath);
      this.updateOperation(id, { phase: 'old_moved' });
      await rename(operation.stagePath, centralPath);
      this.updateOperation(id, { phase: 'new_placed' });
      if ((await hashDirectory(centralPath)) !== stagedHash) throw appError('UPDATE_PLACED_HASH_MISMATCH');
      this.commit(id);
      return await this.disposePrevious(id);
    } catch (error) {
      await this.recoverOne(id).catch(() => false);
      const latest = this.journal.get<UpdateOperation>(id);
      if (latest?.phase === 'committed') return { status: 'success', message: message('UPDATE_COMPLETED_BY_RECOVERY') };
      // The item result already reports this failure; keep it out of the pending-issues list.
      if (latest?.phase === 'failed') this.updateOperation(id, { error: undefined });
      throw error;
    }
  }

  /** Records the new content as the skill's baseline, in the same transaction as the journal phase. */
  private commit(id: string): void {
    const operation = this.journal.get<UpdateOperation>(id);
    const newHash = operation?.newHash;
    if (!operation || !newHash) throw appError('JOURNAL_RECORD_MISSING', { id });
    const skill = this.store.get<Skill>('skills', operation.skillId);
    if (!skill || skill.directory !== operation.centralPath) throw appError('UPDATE_SKILL_MISSING');
    const source = this.store.get<Source>('sources', skill.sourceId);
    this.store.transaction(() => {
      this.store.put('skills', {
        ...skill,
        description: operation.description,
        baseHash: newHash,
        currentHash: newHash,
        ...(operation.commit ? { resolvedCommit: operation.commit, upstreamSignal: { algo: 'git-commit', value: operation.commit } } : {}),
      } satisfies Skill);
      if (source && operation.commit && source.commit !== operation.commit)
        this.store.put('sources', { ...source, commit: operation.commit });
      this.updateOperation(id, { phase: 'committed', error: undefined });
    });
  }

  /** Deletes the replaced version, or moves it to the trash when it held local edits. */
  private async disposePrevious(id: string): Promise<{ status: ItemResult['status']; message: string }> {
    const operation = this.journal.get<UpdateOperation>(id)!;
    if (operation.trashPrevious && (await pathExists(operation.previousPath))) {
      try {
        if (!this.options.trashItem) throw appError('PLATFORM_UNAVAILABLE');
        await assertManagedDirectory(dirname(dirname(operation.previousPath)), join(this.store.root, '.staging'));
        await this.options.trashItem(operation.previousPath);
      } catch (error) {
        const kept = message('UPDATE_PREVIOUS_KEPT', { path: operation.previousPath, reason: errorMessage(error) });
        this.updateOperation(id, { phase: 'blocked', error: kept });
        return { status: 'success', message: kept };
      }
    }
    await this.removeManaged(join(this.store.root, '.staging', id));
    return { status: 'success', message: message(operation.trashPrevious ? 'UPDATE_APPLIED_LOCAL_TRASHED' : 'UPDATE_APPLIED') };
  }

  private putOperation(operation: UpdateOperation): void {
    this.journal.put(operation);
  }

  private updateOperation(id: string, patch: Partial<UpdateOperation>): void {
    this.journal.update(id, patch);
  }

  /** Brings one journaled update to `committed`, `failed` (restored) or `blocked` from what is on disk. */
  private async recoverOne(id: string): Promise<boolean> {
    const operation = this.journal.get<UpdateOperation>(id);
    if (operation?.owner !== 'update') return false;
    if (operation.phase === 'blocked') return true;
    try {
      if (!this.operationPathsAreManaged(operation)) {
        this.updateOperation(id, { phase: 'blocked', error: message('UPDATE_RECOVERY_PATHS_MISMATCH') });
        return false;
      }
      const staging = join(this.store.root, '.staging');
      if (operation.phase === 'committed') {
        await this.disposePrevious(id);
        return true;
      }
      if (operation.phase === 'failed' || operation.phase === 'preparing' || !operation.newHash) {
        await this.removeManaged(join(staging, id));
        if (operation.phase !== 'failed') this.updateOperation(id, { phase: 'failed', error: message('UPDATE_RECOVERY_INCOMPLETE_STAGE') });
        return true;
      }

      await assertManagedDirectory(dirname(operation.centralPath), join(this.store.root, 'skills'));
      if (await pathExists(join(staging, id))) await assertManagedDirectory(join(staging, id), staging);
      const central = (await isRealDirectory(operation.centralPath))
        ? await hashDirectory(operation.centralPath).catch(() => 'unreadable')
        : undefined;
      const previous = await isRealDirectory(operation.previousPath);
      const staged = await pathExists(operation.stagePath);

      if (central === operation.newHash && !staged && previous) {
        this.commit(id);
        await this.disposePrevious(id);
        return true;
      }
      if (central === undefined && previous && operation.phase !== 'new_placed') {
        await rename(operation.previousPath, operation.centralPath);
        await this.removeManaged(join(staging, id));
        this.updateOperation(id, { phase: 'failed', error: message('UPDATE_RECOVERY_ROLLED_BACK') });
        return true;
      }
      if (central !== undefined && !previous && operation.phase === 'prepared') {
        await this.removeManaged(join(staging, id));
        this.updateOperation(id, { phase: 'failed', error: message('UPDATE_RECOVERY_ROLLED_BACK') });
        return true;
      }
      this.updateOperation(id, { phase: 'blocked', error: message('UPDATE_RECOVERY_AMBIGUOUS', { path: operation.previousPath }) });
      return false;
    } catch (error) {
      this.updateOperation(id, { phase: 'blocked', error: message('RECOVERY_STOPPED', { reason: errorMessage(error) }) });
      return false;
    }
  }

  private operationPathsAreManaged(operation: UpdateOperation): boolean {
    const name = basename(operation.centralPath ?? '');
    const directory = join(this.store.root, '.staging', operation.id);
    return (
      ID_PATTERNS.skill.test(operation.skillId ?? '') &&
      isValidSkillName(name) &&
      operation.centralPath === join(this.store.root, 'skills', operation.skillId, name) &&
      operation.stagePath === join(directory, 'content') &&
      operation.previousPath === join(directory, 'previous', name)
    );
  }

  /** Drops every session except the latest unexpired one, unless an apply still uses it. */
  private async evictSessions(): Promise<void> {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (session.users > 0) continue;
      if (session.id === this.latest && now - session.createdAt <= CHECK_TTL_MS) continue;
      this.sessions.delete(session.id);
      await this.removeManaged(session.root).catch(() => undefined);
    }
  }

  /** Removes an entry the service created under `.staging`, never following a link out of it. */
  private async removeManaged(path: string): Promise<void> {
    const staging = join(this.store.root, '.staging');
    const resolved = resolve(path);
    if (!isWithin(staging, resolved) || resolved === staging) return;
    try {
      await lstat(resolved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    await rm(resolved, { recursive: true, force: true });
  }
}

/**
 * The commit `git fetch origin <ref>` would resolve to, from `git ls-remote` output. Follows Git's
 * ref lookup order and prefers the peeled commit of an annotated tag.
 */
export function remoteCommit(output: string, ref: string): string | undefined {
  const refs = new Map<string, string>();
  for (const line of output.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (sha && name && COMMIT_RE.test(sha)) refs.set(name, sha.toLowerCase());
  }
  for (const name of [ref, `refs/${ref}`, `refs/tags/${ref}`, `refs/heads/${ref}`]) {
    const commit = refs.get(`${name}^{}`) ?? refs.get(name);
    if (commit) return commit;
  }
  return undefined;
}

/**
 * The skill's directory in a checked-out source: `missing` when the source no longer has it,
 * `same` when it resolves to the central copy itself (the original was migrated into the library).
 */
async function upstreamDirectory(repositoryRoot: string, skill: Skill): Promise<string | 'missing' | 'same'> {
  const segments = skill.sourcePath === '.' ? [] : skill.sourcePath.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..' || part.includes('\0'))) throw appError('CANDIDATE_PATH_INVALID');
  const candidate = resolve(repositoryRoot, ...segments);
  if (!isWithin(repositoryRoot, candidate)) throw appError('CANDIDATE_PATH_ESCAPED');
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    return 'missing';
  }
  const central = await realpath(skill.directory).catch(() => undefined);
  if (central && central === resolved) return 'same';
  if (!isWithin(repositoryRoot, resolved)) throw appError('CANDIDATE_PATH_RESOLVES_OUTSIDE');
  if (!(await isRealDirectory(resolved))) return 'missing';
  const manifest = await lstat(join(resolved, 'SKILL.md')).catch(() => undefined);
  return manifest?.isFile() ? resolved : 'missing';
}

async function mapLimit<T, R>(items: T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
