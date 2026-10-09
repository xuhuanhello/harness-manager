import { randomUUID } from 'node:crypto';
import { mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage } from '../shared/errors';
import { isHarnessEnabled } from '../shared/harness-enabled';
import { harnessReadPaths } from '../shared/harness-paths';
import type {
  ApplyPlan,
  ApplyRequest,
  Binding,
  Distribution,
  Harness,
  Intent,
  ItemResult,
  PlanItem,
  RemoveRequest,
  Skill,
  Target,
  Workspace,
} from '../shared/types';
import { copySkillDirectory, hashDirectory } from './content';
import type { ApplyEffects, JournalOperation, ResolvedTarget } from './distribution-types';
import {
  canonicalizeLexical,
  entryMatchesDistribution,
  entryMatchesPlanned,
  entryPathsEqual,
  isSafeEntryName,
  makeStagePath,
  makeTrashPath,
  removeEntryIfMatches,
  verifyDistributionEntry,
} from './entries';
import { createDirectoryLink, type EntryState, inspectEntry } from './fs-utils';
import { recordId } from './ids';
import { Journal } from './journal';
import {
  assertWorkspaceContainment,
  canonicalizePath,
  createPathCache,
  expandUserPath,
  requireDirectory,
  type ResolvePath,
  validateWorkspaceRelativePath,
} from './paths';
import type { Store } from './store';
import type { TargetResolver } from './targets';
import { appError, message } from './messages';

/**
 * Lookups shared by one preview or apply request. `resolve` is memoized (see createPathCache), and
 * the distribution index is rebuilt after each metadata commit, so later items see earlier ones.
 */
interface PlanningContext {
  resolve: ResolvePath;
  sourceHashes: Map<string, string>;
  distributionsForTarget(targetId: string): Distribution[];
  invalidate(): void;
}

/** Applies central skills to Harness directories and removes them, journaling each step for recovery. */
export class DistributionService {
  private readonly journal: Journal;

  constructor(
    private readonly store: Store,
    private readonly targets: TargetResolver,
  ) {
    this.journal = new Journal(store);
  }

  async previewApply(request: ApplyRequest, context: PlanningContext = this.planningContext()): Promise<ApplyPlan> {
    const normalized = normalizeApplyRequest(request);
    const skills = await this.resolveSkills(normalized.skillIds);
    const targets = await this.targets.resolveTargets(normalized);
    const sourceHashes = context.sourceHashes;
    for (const skill of skills) {
      const skillDirectory = await requireDirectory(skill.directory, message('LABEL_SKILL', { name: skill.name }));
      if (!isSafeEntryName(skill.name)) throw appError('APPLY_SKILL_NAME_UNSAFE', { name: skill.name });
      sourceHashes.set(skill.id, await hashDirectory(skillDirectory.path));
    }

    const items: PlanItem[] = [];
    const plannedNames = new Map<string, PlanItem[]>();
    for (const target of targets) {
      const targetRecord = await this.targets.findTarget(target.path, context.resolve);
      for (const skill of skills) {
        const managedEntries = targetRecord
          ? context.distributionsForTarget(targetRecord.id).filter((dist) => dist.skillId === skill.id)
          : [];
        const entryPaths = managedEntries.length
          ? [...new Set(managedEntries.map((dist) => path.resolve(dist.entryPath)))].sort()
          : [path.join(target.path, skill.name)];
        for (const entryPath of entryPaths) {
          const entryParent = await context.resolve(path.dirname(entryPath));
          if (entryParent.key !== target.key || !isSafeEntryName(path.basename(entryPath))) {
            throw appError('APPLY_ALIAS_OUTSIDE_TARGET', { path: entryPath });
          }
          const item = await this.inspectPlanItem(skill, target, entryPath, sourceHashes.get(skill.id)!, normalized.strategy, context);
          items.push(item);
          const collisionKey = targetEntryKey(target, path.basename(entryPath));
          const peers = plannedNames.get(collisionKey) ?? [];
          peers.push(item);
          plannedNames.set(collisionKey, peers);
        }
      }
    }

    for (const peers of plannedNames.values()) {
      if (peers.length < 2 || peers.every((item) => item.skillId === peers[0].skillId)) continue;
      const names = [...new Set(peers.map((item) => item.skillName))].join(', ');
      for (const item of peers) {
        item.status = 'conflict';
        item.message = message('APPLY_NAME_COLLISION', { names });
      }
    }
    return { request: normalized, items };
  }

  async apply(request: ApplyRequest): Promise<{ items: ItemResult[]; skillIds?: string[] }> {
    const context = this.planningContext();
    const plan = await this.previewApply(request, context);
    const normalized = plan.request;
    const targets = await this.targets.resolveTargets(normalized);
    const targetByKey = new Map(targets.map((target) => [target.key, target]));
    const skillsById = new Map(this.store.list<Skill>('skills').map((skill) => [skill.id, skill]));
    const results: ItemResult[] = [];
    const completedSkills = new Set<string>();

    for (const item of plan.items) {
      const label = `${item.skillName} → ${item.targetPath}`;
      if (item.status === 'conflict') {
        results.push({ id: resultId(item), label, status: 'error', message: item.message ?? message('APPLY_CONFLICT') });
        continue;
      }
      const skill = skillsById.get(item.skillId);
      try {
        const targetKey = (await context.resolve(path.dirname(item.targetPath))).key;
        const target = targetByKey.get(targetKey);
        if (!skill || !target) throw appError('APPLY_PLAN_CHANGED');
        const outcome = await this.applyOne(skill, target, item, normalized.strategy, context);
        results.push({ id: resultId(item), label, status: outcome.status, message: outcome.message });
        if (outcome.status === 'success') completedSkills.add(skill.id);
      } catch (error) {
        results.push({ id: resultId(item), label, status: 'error', message: errorMessage(error) });
      }
    }
    return { items: results, skillIds: [...completedSkills] };
  }

  async remove(request: RemoveRequest): Promise<{ items: ItemResult[] }> {
    const binding = this.store.get<Binding>('bindings', request.bindingId);
    if (!binding) throw appError('REMOVE_BINDING_NOT_FOUND', { id: request.bindingId });
    const bindingHarness = this.store.get<Harness>('harnesses', binding.harnessId);
    if (!isHarnessEnabled(bindingHarness)) throw appError('REMOVE_HARNESS_DISABLED');
    const skillIds = [...new Set(request.skillIds)];
    const target = this.store.get<Target>('targets', binding.targetId);
    if (!target) throw appError('REMOVE_TARGET_MISSING');
    const targetCanonical = await canonicalizePath(target.path);
    if (targetCanonical.path !== path.resolve(target.path)) {
      throw appError('REMOVE_TARGET_REDIRECTED');
    }
    const disabledReader = await this.targets.disabledHarnessForTargetKey(targetCanonical.key);
    if (disabledReader) throw appError('REMOVE_SHARED_WITH_DISABLED', { name: disabledReader });
    await this.targets.assertSafeTarget(targetCanonical.path);
    await this.targets.assertBindingTarget(binding, targetCanonical.path);

    const results: ItemResult[] = [];
    for (const skillId of skillIds) {
      const skill = this.store.get<Skill>('skills', skillId);
      if (!skill) {
        results.push({ id: skillId, label: skillId, status: 'skipped', message: message('REMOVE_SKILL_GONE') });
        continue;
      }
      const intent = this.store.list<Intent>('intents').find((item) => item.bindingId === binding.id && item.skillId === skillId);
      if (!intent) {
        results.push({
          id: skillId,
          label: skill.name,
          status: 'skipped',
          message: message('REMOVE_NO_INTENT'),
        });
        continue;
      }
      const distributions = this.store
        .list<Distribution>('distributions')
        .filter((item) => item.skillId === skillId && item.targetId === target.id)
        .sort((left, right) => left.entryPath.localeCompare(right.entryPath));
      const otherIntents = this.store.list<Intent>('intents').filter((item) => {
        if (item.id === intent.id || item.skillId !== skillId) return false;
        const otherBinding = this.store.get<Binding>('bindings', item.bindingId);
        return otherBinding?.targetId === target.id;
      });

      if (otherIntents.length) {
        this.store.transaction(() => this.store.delete('intents', intent.id));
        results.push({
          id: skillId,
          label: skill.name,
          status: 'success',
          message: message('REMOVE_BINDING_ONLY'),
        });
        continue;
      }
      if (!distributions.length) {
        this.store.transaction(() => this.store.delete('intents', intent.id));
        results.push({
          id: skillId,
          label: skill.name,
          status: 'success',
          message: message('REMOVE_INTENT_ONLY'),
        });
        continue;
      }

      const checkedEntries: Array<{ distribution: Distribution; entryPath: string; state: EntryState }> = [];
      let preflightError: string | undefined;
      for (const distribution of distributions) {
        const entryPath = path.resolve(distribution.entryPath);
        const entryParent = await canonicalizePath(path.dirname(entryPath));
        if (entryParent.key !== targetCanonical.key || !isSafeEntryName(path.basename(entryPath))) {
          preflightError = message('REMOVE_ENTRY_OUTSIDE_TARGET', { path: entryPath });
          break;
        }
        const state = await inspectEntry(entryPath);
        if (state.exists) {
          const ownership = await verifyDistributionEntry(this.store, distribution, skill, entryPath);
          if (!ownership.ok) {
            preflightError = ownership.message;
            break;
          }
        }
        checkedEntries.push({ distribution, entryPath, state });
      }
      if (preflightError) {
        results.push({ id: skillId, label: skill.name, status: 'error', message: preflightError });
        continue;
      }

      let failedRemoval: string | undefined;
      let removedEntryCount = 0;
      for (let index = 0; index < checkedEntries.length; index += 1) {
        const { distribution, entryPath, state } = checkedEntries[index];
        const removeIntentOnCommit = index === checkedEntries.length - 1;
        if (!state.exists) {
          this.store.transaction(() => {
            this.store.delete('distributions', distribution.id);
            if (removeIntentOnCommit) this.store.delete('intents', intent.id);
          });
          removedEntryCount += 1;
          continue;
        }

        const operationId = randomUUID();
        const trashPath = await makeTrashPath(targetCanonical.path, operationId);
        const operation: JournalOperation = {
          id: operationId,
          owner: 'distribution',
          kind: 'remove',
          phase: 'planned',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          skillId,
          targetId: target.id,
          entryPath,
          backupPath: trashPath,
          previousDistribution: distribution,
          bindingId: binding.id,
          removedIntentId: intent.id,
          removeIntentOnCommit,
        };
        this.putOperation(operation);
        try {
          await this.assertJournalPaths(operation);
          const recheck = await verifyDistributionEntry(this.store, distribution, skill, entryPath);
          if (!recheck.ok) throw appError('ENTRY_NOT_OWNED', { reason: recheck.message });
          const current = await inspectEntry(entryPath);
          if (!current.exists) throw appError('REMOVE_ENTRY_CHANGED');
          const safeTrashPath = await this.prepareBackupPath(targetCanonical.path, operation);
          if ((await inspectEntry(safeTrashPath)).exists) throw appError('REMOVE_RECOVERY_OCCUPIED');
          await rename(entryPath, safeTrashPath);
          this.updateOperation(operationId, { phase: 'old_moved' });
          this.commitRemoval(operationId, intent.id, distribution.id);
          removedEntryCount += 1;
        } catch (error) {
          const recovered = await this.recoverOne(operationId).catch(() => false);
          const latest = this.journal.get<JournalOperation>(operationId);
          const succeeded = recovered && latest?.phase === 'committed';
          if (succeeded) {
            removedEntryCount += 1;
          } else {
            failedRemoval = errorMessage(error);
            break;
          }
        }
      }
      results.push({
        id: skillId,
        label: skill.name,
        status: failedRemoval ? 'error' : 'success',
        message: failedRemoval
          ? message('REMOVE_FAILED', { removed: removedEntryCount, reason: failedRemoval })
          : message('REMOVE_DONE', { count: checkedEntries.length }),
      });
    }
    return { items: results };
  }

  /** Finishes or undoes interrupted apply and remove operations. Migrations recover in MigrationExecutor. */
  async recover(): Promise<void> {
    const pending = this.journal
      .list<JournalOperation>('distribution')
      .filter(
        (operation) =>
          operation.owner === 'distribution' &&
          (operation.kind === 'apply' || operation.kind === 'remove') &&
          operation.phase !== 'committed' &&
          operation.phase !== 'failed' &&
          operation.phase !== 'blocked',
      );
    for (const operation of pending) await this.recoverOne(operation.id);
  }

  private planningContext(): PlanningContext {
    let byTarget: Map<string, Distribution[]> | undefined;
    return {
      resolve: createPathCache(),
      sourceHashes: new Map(),
      distributionsForTarget: (targetId) => {
        if (!byTarget) {
          byTarget = new Map();
          for (const dist of this.store.list<Distribution>('distributions'))
            byTarget.set(dist.targetId, [...(byTarget.get(dist.targetId) ?? []), dist]);
        }
        return byTarget.get(targetId) ?? [];
      },
      invalidate: () => {
        byTarget = undefined;
      },
    };
  }

  private async resolveSkills(skillIds: string[]): Promise<Skill[]> {
    const skills: Skill[] = [];
    for (const id of skillIds) {
      const skill = this.store.get<Skill>('skills', id);
      if (!skill) throw appError('APPLY_SKILL_NOT_FOUND', { id });
      skills.push(skill);
    }
    if (!skills.length) throw appError('APPLY_NO_SKILL');
    return skills;
  }

  private async inspectPlanItem(
    skill: Skill,
    target: ResolvedTarget,
    entryPath: string,
    sourceHash: string,
    strategy: 'symlink' | 'copy',
    context: PlanningContext,
  ): Promise<PlanItem> {
    // Record matching may use the request's path cache; the entry itself is inspected afresh below.
    const targetRecord = await this.targets.findTarget(target.path, context.resolve);
    let matching: Distribution | undefined;
    let sameNameOtherSkill: Distribution | undefined;
    if (targetRecord) {
      for (const dist of context.distributionsForTarget(targetRecord.id)) {
        if (!(await entryPathsEqual(dist.entryPath, entryPath, context.resolve))) continue;
        if (dist.skillId === skill.id) matching = dist;
        else sameNameOtherSkill = dist;
      }
    }
    const entry = await inspectEntry(entryPath);
    let status: PlanItem['status'] = 'new';
    let detail: string | undefined;
    if (sameNameOtherSkill) {
      status = 'conflict';
      detail = message('APPLY_NAME_OWNED_BY_OTHER');
    } else if (!matching && entry.exists) {
      status = 'conflict';
      detail = message('APPLY_UNOWNED_ENTRY');
    } else if (matching && !entry.exists) {
      status = 'sync';
      detail = message('APPLY_RESTORE_MISSING');
    } else if (matching) {
      const checked = await verifyDistributionEntry(this.store, matching, skill, entryPath, sourceHash);
      if (!checked.ok) {
        status = 'conflict';
        detail = checked.message;
      } else if (matching.strategy !== strategy) {
        status = 'sync';
        detail = message('APPLY_STRATEGY_SWITCH', { from: matching.strategy, to: strategy });
      } else if (matching.strategy === 'copy' && checked.actualHash !== sourceHash) {
        status = 'sync';
        detail = message('APPLY_COPY_BEHIND');
      } else {
        status = 'existing';
        detail = message('APPLY_HEALTHY');
      }
    }
    const harnessNames = target.harnesses.map((item) => item.name);
    if (harnessNames.length > 1) {
      detail = [detail, message('APPLY_SHARED_DIRECTORY', { names: harnessNames.join('、') })].filter(Boolean).join(' ');
    }
    const alsoVisible = await this.entriesReadElsewhere(skill, target, context);
    if (alsoVisible.length) {
      detail = [detail, message('APPLY_ALSO_READ_ELSEWHERE', { paths: alsoVisible.join('、') })].filter(Boolean).join(' ');
    }
    return {
      skillId: skill.id,
      skillName: skill.name,
      targetPath: entryPath,
      harnessIds: target.harnesses.map((harness) => harness.id),
      status,
      ...(detail ? { message: detail } : {}),
    };
  }

  /**
   * Managed entries of this skill in other directories the target's Harnesses also read, such as
   * an install in the shared `.agents/skills` from before a product's own root became primary.
   */
  private async entriesReadElsewhere(skill: Skill, target: ResolvedTarget, context: PlanningContext): Promise<string[]> {
    const readKeys = new Set<string>();
    for (const harness of target.harnesses) {
      for (const read of harnessReadPaths(harness, target.scope)) {
        try {
          const directory =
            target.scope === 'user'
              ? expandUserPath(read.path, this.targets.home)
              : path.resolve(target.workspace!.path, validateWorkspaceRelativePath(read.path));
          const { key } = await context.resolve(directory);
          if (key !== target.key) readKeys.add(key);
        } catch {
          // An unusable read root cannot hold a visible entry.
        }
      }
    }
    if (!readKeys.size) return [];
    const entries: string[] = [];
    for (const dist of this.store.list<Distribution>('distributions')) {
      if (dist.skillId !== skill.id) continue;
      const parent = await context.resolve(path.dirname(dist.entryPath)).catch(() => undefined);
      if (parent && readKeys.has(parent.key)) entries.push(dist.entryPath);
    }
    return entries.sort();
  }

  private async applyOne(
    skill: Skill,
    target: ResolvedTarget,
    item: PlanItem,
    strategy: 'symlink' | 'copy',
    context: PlanningContext,
  ): Promise<{ status: 'success' | 'skipped'; message: string }> {
    const source = await requireDirectory(skill.directory, message('LABEL_SKILL', { name: skill.name }));
    const entryPath = path.resolve(item.targetPath);
    // The preview's hash; the staged copy and the source are both checked against it again before commit.
    const sourceHash = context.sourceHashes.get(skill.id) ?? (await hashDirectory(source.path));
    const effects = await this.targets.buildEffects(target, skill.id, context.resolve);
    const initial = await this.inspectPlanItem(skill, target, entryPath, sourceHash, strategy, context);
    if (initial.status === 'conflict') throw appError('APPLY_TARGET_CONFLICT', { reason: initial.message ?? message('APPLY_CONFLICT') });

    if (initial.status === 'existing') {
      const dist = this.findDistribution(skill.id, effects.target.id, entryPath);
      if (!dist) throw appError('APPLY_RECORD_CHANGED');
      this.commitApplyMetadata(effects, {
        ...dist,
        strategy,
        lastWrittenHash: sourceHash,
        health: 'healthy',
      });
      context.invalidate();
      return { status: 'skipped', message: message('APPLY_ALREADY_CURRENT') };
    }

    const operationId = randomUUID();
    let stagePath = makeStagePath(target.path, operationId);
    let backupPath = await makeTrashPath(target.path, operationId);
    const previous = this.findDistribution(skill.id, effects.target.id, entryPath);
    const operation: JournalOperation = {
      id: operationId,
      owner: 'distribution',
      kind: 'apply',
      phase: 'planned',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      skillId: skill.id,
      targetId: effects.target.id,
      entryPath,
      sourcePath: source.path,
      strategy,
      newHash: sourceHash,
      stagePath,
      backupPath,
      ...(previous ? { previousDistribution: previous } : {}),
      effects,
    };
    this.putOperation(operation);

    try {
      await mkdir(target.path, { recursive: true });
      const resolvedTarget = await canonicalizePath(target.path);
      if (resolvedTarget.key !== target.key) throw appError('APPLY_TARGET_PATH_CHANGED');
      await this.targets.assertSafeTarget(resolvedTarget.path);
      if (target.workspace) await assertWorkspaceContainment(target.workspace.path, resolvedTarget.path);
      const [targetInfo, parentInfo] = await Promise.all([stat(target.path), stat(path.dirname(target.path)).catch(() => undefined)]);
      if (!parentInfo || targetInfo.dev !== parentInfo.dev) {
        stagePath = path.join(target.path, `.harness-manager-stage-${operationId}`);
        backupPath = path.join(target.path, '.harness-manager-trash', operationId, 'entry');
        operation.stagePath = stagePath;
        operation.backupPath = backupPath;
        this.putOperation(operation);
      }
      await this.assertJournalPaths(operation);
      if ((await inspectEntry(stagePath)).exists) throw appError('APPLY_STAGE_OCCUPIED');
      if (strategy === 'symlink') await createDirectoryLink(source.path, stagePath);
      else await copySkillDirectory(source.path, stagePath);
      const staged = await inspectEntry(stagePath);
      if (!staged.exists) throw appError('APPLY_STAGE_MISSING');
      const stagedHash = await hashDirectory(stagePath);
      if (stagedHash !== sourceHash) throw appError('APPLY_STAGE_HASH_MISMATCH');
      this.updateOperation(operationId, { phase: 'staged' });

      const latestSourceHash = await hashDirectory(source.path);
      if (latestSourceHash !== sourceHash) throw appError('APPLY_SOURCE_CHANGED');
      const latest = await this.inspectPlanItem(skill, target, entryPath, sourceHash, strategy, context);
      if (latest.status === 'conflict')
        throw appError('APPLY_TARGET_CONFLICT', { reason: latest.message ?? message('APPLY_TARGET_CHANGED') });
      const hasFinal = (await inspectEntry(entryPath)).exists;
      if (hasFinal) {
        if (!previous) throw appError('APPLY_UNMANAGED_ENTRY_APPEARED');
        const ownership = await verifyDistributionEntry(this.store, previous, skill, entryPath, sourceHash);
        if (!ownership.ok) throw appError('ENTRY_NOT_OWNED', { reason: ownership.message });
        backupPath = await this.prepareBackupPath(target.path, operation);
        if ((await inspectEntry(backupPath)).exists) throw appError('APPLY_RECOVERY_OCCUPIED');
        await rename(entryPath, backupPath);
        this.updateOperation(operationId, { phase: 'old_moved' });
      }
      if ((await inspectEntry(entryPath)).exists) throw appError('APPLY_TARGET_OCCUPIED');
      await rename(stagePath, entryPath);
      this.updateOperation(operationId, { phase: 'new_placed' });
      const placedHash = await hashDirectory(entryPath);
      if (placedHash !== sourceHash) throw appError('APPLY_PLACED_HASH_MISMATCH');
      this.commitApplyMetadata(effects, {
        id: recordId('distribution', `${effects.target.id}\0${skill.id}`),
        skillId: skill.id,
        targetId: effects.target.id,
        entryPath,
        strategy,
        lastWrittenHash: sourceHash,
        health: 'healthy',
        verification: previous?.verification ?? 'untested',
      });
      context.invalidate();
      this.updateOperation(operationId, { phase: 'committed' });
      return { status: 'success', message: message(strategy === 'symlink' ? 'APPLY_LINKED' : 'APPLY_COPIED') };
    } catch (error) {
      await this.recoverOne(operationId).catch(() => false);
      context.invalidate();
      const latest = this.journal.get<JournalOperation>(operationId);
      if (latest?.phase === 'committed') return { status: 'success', message: message('APPLY_COMPLETED_BY_RECOVERY') };
      throw error;
    }
  }

  private commitApplyMetadata(effects: ApplyEffects, distribution: Distribution): void {
    this.store.transaction(() => {
      if (effects.workspace) this.store.put('workspaces', effects.workspace);
      this.store.put('targets', effects.target);
      for (const binding of effects.bindings) this.store.put('bindings', binding);
      for (const binding of effects.bindings) {
        const intent: Intent = {
          id: recordId('intent', `${binding.id}\0${effects.skillId}`),
          bindingId: binding.id,
          skillId: effects.skillId,
        };
        this.store.put('intents', intent);
      }
      const existing = this.findDistribution(effects.skillId, effects.target.id, distribution.entryPath);
      const record: Distribution = {
        ...distribution,
        id: existing?.id ?? distribution.id,
      };
      this.store.put('distributions', record);
    });
  }

  private commitRemoval(operationId: string, intentId: string, distributionId: string): void {
    const operation = this.journal.get<JournalOperation>(operationId);
    if (!operation) throw appError('REMOVE_JOURNAL_MISSING');
    this.store.transaction(() => {
      if (operation.removeIntentOnCommit !== false) this.store.delete('intents', intentId);
      this.store.delete('distributions', distributionId);
      const committed: JournalOperation = { ...operation, phase: 'committed', updatedAt: new Date().toISOString() };
      this.journal.put(committed);
    });
  }

  private findDistribution(skillId: string, targetId: string, entryPath: string): Distribution | undefined {
    return this.store
      .list<Distribution>('distributions')
      .find(
        (dist) =>
          dist.skillId === skillId && dist.targetId === targetId && canonicalizeLexical(dist.entryPath) === canonicalizeLexical(entryPath),
      );
  }

  private putOperation(operation: JournalOperation): void {
    this.journal.put(operation);
  }

  private updateOperation(id: string, patch: Partial<JournalOperation>): void {
    this.journal.update(id, patch);
  }

  private async prepareBackupPath(targetPath: string, operation: JournalOperation): Promise<string> {
    if (!operation.backupPath) throw appError('OPERATION_NO_RECOVERY_PATH');
    let backupPath = operation.backupPath;
    await this.assertJournalPaths(operation);
    await mkdir(path.dirname(backupPath), { recursive: true });
    await this.assertJournalPaths(operation);
    let [targetInfo, backupParentInfo] = await Promise.all([stat(targetPath), stat(path.dirname(backupPath))]);
    if (targetInfo.dev !== backupParentInfo.dev) {
      backupPath = path.join(targetPath, '.harness-manager-trash', operation.id, 'entry');
      operation.backupPath = backupPath;
      this.putOperation(operation);
      await this.assertJournalPaths(operation);
      await mkdir(path.dirname(backupPath), { recursive: true });
      await this.assertJournalPaths(operation);
      [targetInfo, backupParentInfo] = await Promise.all([stat(targetPath), stat(path.dirname(backupPath))]);
      if (targetInfo.dev !== backupParentInfo.dev) {
        throw appError('OPERATION_RECOVERY_VOLUME');
      }
    }
    return backupPath;
  }

  private async recoverOne(id: string): Promise<boolean> {
    const operation = this.journal.get<JournalOperation>(id);
    if (operation?.owner !== 'distribution') return false;
    if (operation.phase === 'committed' || operation.phase === 'failed' || operation.phase === 'blocked') return true;
    try {
      if (operation.kind === 'apply') {
        await this.assertJournalPaths(operation);
        return await this.recoverApply(operation);
      }
      if (operation.kind === 'remove') {
        await this.assertJournalPaths(operation);
        return await this.recoverRemove(operation);
      }
      return false;
    } catch (error) {
      this.updateOperation(id, { phase: 'blocked', error: message('RECOVERY_STOPPED', { reason: errorMessage(error) }) });
      return false;
    }
  }

  private async assertJournalPaths(operation: JournalOperation): Promise<void> {
    let target: Target | undefined;
    let workspacePath: string | undefined;
    if (operation.kind === 'apply') {
      target = operation.effects?.target;
      workspacePath = operation.effects?.workspace?.path;
    } else {
      target = operation.targetId ? this.store.get<Target>('targets', operation.targetId) : undefined;
      const binding = operation.bindingId ? this.store.get<Binding>('bindings', operation.bindingId) : undefined;
      if (binding?.scope === 'workspace' && binding.workspaceId) {
        workspacePath = this.store.get<Workspace>('workspaces', binding.workspaceId)?.path;
      }
    }
    if (!target) throw appError('OPERATION_TARGET_MISSING');
    const canonicalTarget = await canonicalizePath(target.path);
    if (canonicalTarget.path !== path.resolve(target.path)) throw appError('OPERATION_TARGET_REDIRECTED');
    await this.targets.assertSafeTarget(canonicalTarget.path);
    const entryParent = await canonicalizePath(path.dirname(operation.entryPath));
    if (entryParent.key !== canonicalTarget.key) throw appError('OPERATION_ENTRY_OUTSIDE_TARGET');
    if (workspacePath) {
      const workspace = await requireDirectory(workspacePath, message('LABEL_RECORDED_WORKSPACE'));
      if (workspace.path !== path.resolve(workspacePath)) throw appError('OPERATION_WORKSPACE_REDIRECTED');
      await assertWorkspaceContainment(workspace.path, canonicalTarget.path);
    }

    if (operation.kind === 'apply') {
      const id = operation.id;
      const expectedStagePaths = [
        path.join(path.dirname(target.path), `.${path.basename(target.path) || 'target'}.harness-manager-stage-${id}`),
        path.join(target.path, `.harness-manager-stage-${id}`),
      ];
      const expectedBackupPaths = [
        path.join(path.dirname(target.path), `.${path.basename(target.path) || 'target'}.harness-manager-trash`, id, 'entry'),
        path.join(target.path, '.harness-manager-trash', id, 'entry'),
      ];
      if (!operation.stagePath || !expectedStagePaths.includes(path.resolve(operation.stagePath))) {
        throw appError('OPERATION_STAGE_UNEXPECTED');
      }
      if (!operation.backupPath || !expectedBackupPaths.includes(path.resolve(operation.backupPath))) {
        throw appError('OPERATION_BACKUP_UNEXPECTED');
      }
      const stageParent = await canonicalizePath(path.dirname(operation.stagePath));
      if (stageParent.path !== path.resolve(path.dirname(operation.stagePath))) throw appError('OPERATION_STAGE_PARENT_REDIRECTED');
      const backupParent = await canonicalizePath(path.dirname(operation.backupPath));
      if (backupParent.path !== path.resolve(path.dirname(operation.backupPath))) throw appError('OPERATION_BACKUP_PARENT_REDIRECTED');
    } else {
      const expectedBackupPaths = [
        path.join(path.dirname(target.path), `.${path.basename(target.path) || 'target'}.harness-manager-trash`, operation.id, 'entry'),
        path.join(target.path, '.harness-manager-trash', operation.id, 'entry'),
      ];
      if (!operation.backupPath || !expectedBackupPaths.includes(path.resolve(operation.backupPath))) {
        throw appError('REMOVE_BACKUP_UNEXPECTED');
      }
      const backupParent = await canonicalizePath(path.dirname(operation.backupPath));
      if (backupParent.path !== path.resolve(path.dirname(operation.backupPath))) throw appError('REMOVE_BACKUP_PARENT_REDIRECTED');
      const binding = operation.bindingId ? this.store.get<Binding>('bindings', operation.bindingId) : undefined;
      if (!binding) throw appError('REMOVE_JOURNAL_BINDING_MISSING');
      await this.targets.assertBindingTarget(binding, canonicalTarget.path);
    }
  }

  private async recoverApply(operation: JournalOperation): Promise<boolean> {
    if (!operation.effects || !operation.sourcePath || !operation.stagePath || !operation.entryPath || !operation.newHash) {
      this.updateOperation(operation.id, { phase: 'blocked', error: message('RECOVERY_APPLY_INCOMPLETE') });
      return false;
    }
    const finalNew = await entryMatchesPlanned(operation.entryPath, operation);
    if (finalNew) {
      const sourceHash = await hashDirectory(operation.sourcePath).catch(() => undefined);
      if (sourceHash !== operation.newHash || !this.store.get<Skill>('skills', operation.skillId)) {
        this.updateOperation(operation.id, {
          phase: 'blocked',
          error: message('RECOVERY_APPLY_SOURCE_CHANGED'),
        });
        return false;
      }
      this.commitApplyMetadata(operation.effects, {
        id: recordId('distribution', `${operation.effects.target.id}\0${operation.skillId}`),
        skillId: operation.skillId,
        targetId: operation.effects.target.id,
        entryPath: operation.entryPath,
        strategy: operation.strategy!,
        lastWrittenHash: operation.newHash,
        health: 'healthy',
        verification: operation.previousDistribution?.verification ?? 'untested',
      });
      this.updateOperation(operation.id, { phase: 'committed' });
      return true;
    }

    const stage = await inspectEntry(operation.stagePath);
    const stageMatches = stage.exists && (await entryMatchesPlanned(operation.stagePath, operation));
    const final = await inspectEntry(operation.entryPath);
    const backup = operation.backupPath ? await inspectEntry(operation.backupPath) : ({ exists: false } as EntryState);
    if (final.exists && !stageMatches) {
      this.updateOperation(operation.id, {
        phase: 'blocked',
        error: message('RECOVERY_APPLY_TARGET_CHANGED'),
      });
      return false;
    }
    if (final.exists && stageMatches && backup.exists) {
      this.updateOperation(operation.id, {
        phase: 'blocked',
        error: message('RECOVERY_APPLY_AMBIGUOUS'),
      });
      return false;
    }
    if (!final.exists && backup.exists) {
      if (
        !operation.previousDistribution ||
        !(await entryMatchesDistribution(this.store, operation.backupPath!, operation.previousDistribution, operation.skillId))
      ) {
        this.updateOperation(operation.id, {
          phase: 'blocked',
          error: message('RECOVERY_APPLY_BACKUP_MISMATCH'),
        });
        return false;
      }
      await rename(operation.backupPath!, operation.entryPath);
    } else if (!final.exists && !backup.exists && operation.phase === 'old_moved') {
      this.updateOperation(operation.id, { phase: 'blocked', error: message('RECOVERY_APPLY_BOTH_MISSING') });
      return false;
    }
    if (stageMatches) await removeEntryIfMatches(operation.stagePath, operation);
    this.updateOperation(operation.id, { phase: 'failed', error: message('RECOVERY_APPLY_ROLLED_BACK') });
    return true;
  }

  private async recoverRemove(operation: JournalOperation): Promise<boolean> {
    if (!operation.backupPath || !operation.previousDistribution || !operation.removedIntentId) {
      this.updateOperation(operation.id, { phase: 'blocked', error: message('RECOVERY_REMOVE_INCOMPLETE') });
      return false;
    }
    const backup = await inspectEntry(operation.backupPath);
    const final = await inspectEntry(operation.entryPath);
    const backupMatches =
      backup.exists &&
      (await entryMatchesDistribution(this.store, operation.backupPath, operation.previousDistribution, operation.skillId));
    const currentIntents = this.store.list<Intent>('intents').filter((intent) => {
      if (intent.id === operation.removedIntentId || intent.skillId !== operation.skillId) return false;
      return this.store.get<Binding>('bindings', intent.bindingId)?.targetId === operation.targetId;
    });
    if (backupMatches && !final.exists) {
      if (currentIntents.length) {
        await rename(operation.backupPath, operation.entryPath);
        this.updateOperation(operation.id, { phase: 'failed', error: message('RECOVERY_REMOVE_RESTORED_SHARED') });
      } else {
        this.commitRemoval(operation.id, operation.removedIntentId, operation.previousDistribution.id);
      }
      return true;
    }
    if (!backup.exists && final.exists) {
      this.updateOperation(operation.id, {
        phase: 'failed',
        error: message('RECOVERY_REMOVE_NOT_STARTED'),
      });
      return true;
    }
    if (!backup.exists && !final.exists) {
      this.updateOperation(operation.id, {
        phase: 'blocked',
        error: message('RECOVERY_REMOVE_BOTH_MISSING'),
      });
      return false;
    }
    this.updateOperation(operation.id, {
      phase: 'blocked',
      error: message('RECOVERY_REMOVE_CHANGED'),
    });
    return false;
  }
}

/** Shape is validated at the IPC boundary; this only removes duplicates and resolves the workspace path. */
function normalizeApplyRequest(request: ApplyRequest): ApplyRequest {
  return {
    ...request,
    harnessIds: [...new Set(request.harnessIds)],
    skillIds: [...new Set(request.skillIds)],
    ...(request.workspacePath ? { workspacePath: path.resolve(request.workspacePath) } : {}),
  };
}

function resultId(item: PlanItem): string {
  return recordId('result', `${item.skillId}\0${item.targetPath}`);
}

function targetEntryKey(target: ResolvedTarget, name: string): string {
  const entryName = target.caseSensitive ? name : name.toLocaleLowerCase('en-US');
  return path.join(target.key, entryName);
}
