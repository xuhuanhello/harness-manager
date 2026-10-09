import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readlink, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { errorMessage } from '../shared/errors';
import { isHarnessEnabled } from '../shared/harness-enabled';
import { harnessReadPaths } from '../shared/harness-paths';
import type {
  Binding,
  Distribution,
  ExternalMigrationReference,
  ExternalSkill,
  Harness,
  ItemResult,
  Skill,
  Target,
  Workspace,
} from '../shared/types';
import { hashDirectory } from './content';
import type { BindingEffect, JournalOperation, MigrationEntryPlan } from './distribution-types';
import { canonicalizeLexical, entryMatchesPlanned, isSafeEntryName, removeEntryIfMatches } from './entries';
import type { ExternalSkillScanner } from './external-skills';
import { createDirectoryLink, inspectEntry, isMissingEntryError } from './fs-utils';
import { recordId } from './ids';
import { Journal } from './journal';
import {
  assertNoPathOverlap,
  assertWorkspaceContainment,
  canonicalizePath,
  expandUserPath,
  requireDirectory,
  validateWorkspaceRelativePath,
} from './paths';
import type { Store } from './store';
import type { TargetResolver } from './targets';
import { appError, message } from './messages';

/**
 * Carries out an external-skill migration that MigrationService has previewed and confirmed:
 * repoints every recorded reference to the central copy, then removes the old source.
 */
export class MigrationExecutor {
  private readonly journal: Journal;

  constructor(
    private readonly store: Store,
    private readonly targets: TargetResolver,
    private readonly external: ExternalSkillScanner,
  ) {
    this.journal = new Journal(store);
  }

  /** Repoints every configured skill entry that resolves to sourcePath, then removes that source. */
  async migrateExternalReferences(request: {
    skill: Skill;
    sourcePath: string;
    sourceHash: string;
    references: ExternalMigrationReference[];
  }): Promise<{ items: ItemResult[]; complete: boolean }> {
    const { skill, sourcePath, sourceHash, references } = request;
    if (
      !skill ||
      !path.isAbsolute(sourcePath) ||
      !/^[a-f0-9]{64}$/.test(sourceHash) ||
      !Array.isArray(references) ||
      references.length === 0
    ) {
      throw appError('MIGRATION_REQUEST_INVALID');
    }
    const registeredSkill = this.store.get<Skill>('skills', skill.id);
    if (
      !registeredSkill ||
      registeredSkill.directory !== skill.directory ||
      !/^skill_[a-f0-9]{64}$/.test(skill.id) ||
      !isSafeEntryName(skill.name)
    ) {
      throw appError('MIGRATION_CENTRAL_CHANGED_AFTER_IMPORT');
    }
    const expectedCentralPath = path.join(this.store.root, 'skills', skill.id, skill.name);
    if (path.resolve(skill.directory) !== expectedCentralPath) throw appError('MIGRATION_CENTRAL_OUTSIDE_LIBRARY');
    const [skillsRoot, skillParent, central, source] = await Promise.all([
      lstat(path.join(this.store.root, 'skills')),
      lstat(path.join(this.store.root, 'skills', skill.id)),
      requireDirectory(skill.directory, message('LABEL_CENTRAL_SKILL', { name: skill.name })),
      requireDirectory(sourcePath, message('LABEL_ORIGINAL_EXTERNAL_SKILL')),
    ]);
    if (
      skillsRoot.isSymbolicLink() ||
      !skillsRoot.isDirectory() ||
      skillParent.isSymbolicLink() ||
      !skillParent.isDirectory() ||
      central.path !== expectedCentralPath
    ) {
      throw appError('MIGRATION_CENTRAL_PATH_UNSAFE');
    }
    if (source.path !== path.resolve(sourcePath) || central.path === source.path) {
      throw appError('MIGRATION_SOURCE_OVERLAPS');
    }
    await assertNoPathOverlap(source.path, [this.store.root]);
    const [centralHash, sourceHashNow] = await Promise.all([hashDirectory(central.path), hashDirectory(source.path)]);
    if (centralHash !== sourceHash || sourceHashNow !== sourceHash) {
      throw appError('MIGRATION_CHANGED_AFTER_PREVIEW');
    }

    const allCurrentExternal = await this.external.externalSkills({ strict: true, includeDisabled: true });
    const currentReferences: ExternalSkill[] = [];
    const disabledReferences: ExternalSkill[] = [];
    for (const external of allCurrentExternal) {
      const realEntry = await realpath(external.path).catch((error) => {
        if (isMissingEntryError(error)) return undefined;
        throw appError('MIGRATION_ENTRY_UNRESOLVABLE', { path: external.path, reason: errorMessage(error) });
      });
      if (realEntry === source.path) {
        if (isHarnessEnabled(this.store.get<Harness>('harnesses', external.harnessId))) currentReferences.push(external);
        else disabledReferences.push(external);
      }
    }
    const enabledEntryPaths = new Set(currentReferences.map((reference) => canonicalizeLexical(reference.path)));
    const independentDisabledReferences = disabledReferences.filter(
      (reference) => !enabledEntryPaths.has(canonicalizeLexical(reference.path)),
    );
    if (independentDisabledReferences.length) {
      const names = [
        ...new Set(
          independentDisabledReferences.map(
            (reference) => this.store.get<Harness>('harnesses', reference.harnessId)?.name ?? reference.harnessId,
          ),
        ),
      ].join(', ');
      throw appError('MIGRATION_DISABLED_REFERENCES', { names });
    }
    for (const reference of currentReferences) {
      const canonicalParent = await canonicalizePath(path.dirname(reference.path));
      const disabledBinding = await this.targets.disabledHarnessForTargetKey(canonicalParent.key);
      if (disabledBinding) throw appError('MIGRATION_DISABLED_BINDING', { name: disabledBinding });
    }
    if (!sameMigrationReferenceSet(references, currentReferences)) {
      throw appError('MIGRATION_REFERENCES_CHANGED');
    }

    for (const distribution of this.store.list<Distribution>('distributions')) {
      const realEntry = await realpath(distribution.entryPath).catch((error) => {
        if (isMissingEntryError(error)) return undefined;
        throw appError('MIGRATION_MANAGED_ENTRY_UNREADABLE', { path: distribution.entryPath, reason: errorMessage(error) });
      });
      if (realEntry === source.path) {
        throw appError('MIGRATION_MANAGED_ENTRY_CONFLICT', { path: distribution.entryPath });
      }
    }

    const operationId = randomUUID();
    const targetRecords = new Map<string, Target>();
    const referencesByPath = new Map<
      string,
      {
        path: string;
        target: Target;
        originalEntryKind: 'directory' | 'symlink';
        originalLinkText?: string;
        bindings: BindingEffect[];
      }
    >();
    const currentBindings = this.store.list<Binding>('bindings');

    for (const external of currentReferences) {
      const externalEntryPath = path.resolve(external.path);
      const targetCanonical = await requireDirectory(path.dirname(externalEntryPath), message('LABEL_EXTERNAL_TARGET'));
      const entryPath = path.join(targetCanonical.path, path.basename(externalEntryPath));
      const entryInfo = await lstat(entryPath);
      let originalEntryKind: 'directory' | 'symlink';
      let originalLinkText: string | undefined;
      if (entryInfo.isSymbolicLink()) {
        originalEntryKind = 'symlink';
        originalLinkText = await readlink(entryPath);
      } else if (entryInfo.isDirectory()) {
        originalEntryKind = 'directory';
      } else {
        throw appError('MIGRATION_ENTRY_TYPE_CHANGED', { path: entryPath });
      }
      const resolvedEntry = await realpath(entryPath);
      if (resolvedEntry !== source.path) throw appError('MIGRATION_ENTRY_CHANGED', { path: entryPath });

      await this.targets.assertSafeTarget(targetCanonical.path);
      const parentPath = targetCanonical.path;
      const targetKey = targetCanonical.key;
      let target = targetRecords.get(targetKey);
      if (!target) {
        target = (await this.targets.findTarget(parentPath)) ?? { id: recordId('target', targetKey), path: parentPath };
        targetRecords.set(targetKey, target);
      }
      const harness = this.store.get<Harness>('harnesses', external.harnessId);
      if (!harness) throw appError('MIGRATION_HARNESS_GONE', { id: external.harnessId });
      let workspaceId: string | undefined;
      if (external.scope === 'workspace') {
        if (!external.workspaceId) throw appError('MIGRATION_WORKSPACE_REFERENCE_INCOMPLETE', { path: entryPath });
        const workspace = this.store.get<Workspace>('workspaces', external.workspaceId);
        if (!workspace) throw appError('MIGRATION_WORKSPACE_GONE', { id: external.workspaceId });
        const canonicalWorkspace = await requireDirectory(workspace.path, message('LABEL_EXTERNAL_WORKSPACE'));
        if (canonicalWorkspace.path !== path.resolve(workspace.path)) throw appError('OPERATION_WORKSPACE_REDIRECTED');
        const configured = await Promise.all(
          harnessReadPaths(harness, 'workspace').map((item) =>
            canonicalizePath(path.resolve(canonicalWorkspace.path, validateWorkspaceRelativePath(item.path))),
          ),
        );
        if (!configured.some((item) => item.key === targetKey)) throw appError('MIGRATION_WORKSPACE_TARGET_CHANGED', { path: entryPath });
        await assertWorkspaceContainment(canonicalWorkspace.path, parentPath);
        workspaceId = workspace.id;
      } else {
        const configured = await Promise.all(
          harnessReadPaths(harness, 'user').map((item) => canonicalizePath(expandUserPath(item.path, this.targets.home))),
        );
        if (!configured.some((item) => item.key === targetKey)) throw appError('MIGRATION_USER_TARGET_CHANGED', { path: entryPath });
      }

      const existingTargetDistribution = this.store
        .list<Distribution>('distributions')
        .find((dist) => dist.targetId === target.id && canonicalizeLexical(dist.entryPath) === canonicalizeLexical(entryPath));
      if (existingTargetDistribution) throw appError('MIGRATION_OWNERSHIP_CHANGED', { path: entryPath });
      const previousBinding = currentBindings.find(
        (binding) =>
          binding.targetId === target!.id &&
          binding.harnessId === harness.id &&
          binding.scope === external.scope &&
          binding.workspaceId === workspaceId,
      );
      const binding: BindingEffect = {
        id: previousBinding?.id ?? recordId('binding', `${external.scope}\0${workspaceId ?? ''}\0${target.id}\0${harness.id}`),
        targetId: target.id,
        harnessId: harness.id,
        scope: external.scope,
        ...(workspaceId ? { workspaceId } : {}),
      };
      let entry = referencesByPath.get(entryPath);
      if (!entry) {
        entry = {
          path: entryPath,
          target,
          originalEntryKind,
          ...(originalLinkText !== undefined ? { originalLinkText } : {}),
          bindings: [],
        };
        referencesByPath.set(entryPath, entry);
      } else if (entry.originalEntryKind !== originalEntryKind || entry.originalLinkText !== originalLinkText) {
        throw appError('MIGRATION_SHARED_METADATA_MISMATCH', { path: entryPath });
      }
      if (!entry.bindings.some((item) => item.id === binding.id)) entry.bindings.push(binding);
    }

    const entries = [...referencesByPath.values()]
      .sort(
        (left, right) =>
          Number(left.originalEntryKind === 'directory') - Number(right.originalEntryKind === 'directory') ||
          left.path.localeCompare(right.path),
      )
      .map(
        (entry, index): MigrationEntryPlan => ({
          ...entry,
          stagePath: path.join(entry.target.path, `.harness-manager-stage-${operationId}-${index}`),
          backupPath: path.join(entry.target.path, '.harness-manager-trash', operationId, `entry-${index}`),
          phase: 'planned',
        }),
      );
    const directSourceEntry = entries.find((entry) => entry.originalEntryKind === 'directory' && entry.path === source.path);
    const originalSourcePath = source.path;
    const sourceBackupPath =
      directSourceEntry?.backupPath ??
      path.join(path.dirname(source.path), `.${path.basename(source.path)}.harness-manager-trash`, operationId, 'source');
    const allBindings = entries
      .flatMap((entry) => entry.bindings)
      .filter((binding, index, all) => all.findIndex((item) => item.id === binding.id) === index);
    const operation: JournalOperation = {
      id: operationId,
      owner: 'distribution',
      kind: 'migration',
      phase: 'planned',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      skillId: skill.id,
      targetId: entries[0].target.id,
      entryPath: entries[0].path,
      sourcePath: central.path,
      strategy: 'symlink',
      newHash: sourceHash,
      originalHash: sourceHash,
      migration: {
        references: entries,
        targets: [...targetRecords.values()],
        bindings: allBindings,
        originalSourcePath,
        sourceBackupPath,
        sourceMoved: false,
      },
    };
    this.putOperation(operation);

    const results: ItemResult[] = [];
    for (const entry of entries) {
      try {
        await this.migrateReferenceEntry(operation, entry);
        results.push({
          id: entry.path,
          label: this.migrationEntryLabel(entry),
          status: 'success',
          message: message('MIGRATION_LINKED'),
        });
      } catch (error) {
        await this.recoverOne(operationId).catch(() => false);
        const latest = this.journal.get<JournalOperation>(operationId) ?? operation;
        if (latest.phase === 'committed') {
          return {
            items: entries.map((recoveredEntry) => ({
              id: recoveredEntry.path,
              label: this.migrationEntryLabel(recoveredEntry),
              status: 'success' as const,
              message: message('MIGRATION_LINKED_BY_RECOVERY'),
            })),
            complete: true,
          };
        }
        if (!['blocked', 'failed'].includes(latest.phase)) {
          this.updateOperation(operationId, {
            phase: 'blocked',
            error: message('MIGRATION_STOPPED', { reason: errorMessage(error) }),
          });
        }
        results.push({
          id: entry.path,
          label: this.migrationEntryLabel(entry),
          status: 'error',
          message: message('MIGRATION_ENTRY_FAILED', { reason: errorMessage(error) }),
        });
        for (const remaining of entries.slice(entries.indexOf(entry) + 1)) {
          results.push({
            id: remaining.path,
            label: this.migrationEntryLabel(remaining),
            status: 'skipped',
            message: message('MIGRATION_ENTRY_SKIPPED'),
          });
        }
        return { items: results, complete: false };
      }
    }

    try {
      await this.finishMigrationCleanup(operationId);
    } catch (error) {
      this.updateOperation(operationId, {
        phase: 'cleanup',
        error: message('MIGRATION_CLEANUP_PENDING', { reason: errorMessage(error) }),
      });
      results.push({
        id: 'source-cleanup',
        label: source.path,
        status: 'error',
        message: message('MIGRATION_CLEANUP_PENDING_RESULT', { reason: errorMessage(error) }),
      });
      return { items: results, complete: false };
    }
    this.updateOperation(operationId, { phase: 'committed', error: undefined });
    return { items: results, complete: true };
  }

  private async migrateReferenceEntry(operation: JournalOperation, entry: MigrationEntryPlan): Promise<void> {
    await this.assertMigrationJournalPaths(operation);
    const stage = await inspectEntry(entry.stagePath);
    if (stage.exists) {
      if (!(await entryMatchesPlanned(entry.stagePath, operation))) throw appError('MIGRATION_STAGE_OCCUPIED', { path: entry.stagePath });
    } else {
      await createDirectoryLink(operation.sourcePath!, entry.stagePath);
      if (!(await entryMatchesPlanned(entry.stagePath, operation))) throw appError('MIGRATION_STAGE_INVALID', { path: entry.path });
    }
    entry.phase = 'staged';
    this.putOperation(operation);

    await this.assertMigrationJournalPaths(operation);
    const originalSourcePath = operation.migration!.originalSourcePath;
    const originalAtEntry = await this.matchesMigrationOriginal(
      entry.path,
      entry,
      originalSourcePath,
      operation.newHash!,
      true,
      operation.migration!.sourceBackupPath,
    );
    if (!originalAtEntry) throw appError('MIGRATION_EXTERNAL_ENTRY_CHANGED', { path: entry.path });
    if ((await inspectEntry(entry.backupPath)).exists) throw appError('MIGRATION_BACKUP_OCCUPIED', { path: entry.backupPath });
    await mkdir(path.dirname(entry.backupPath), { recursive: true });
    await this.assertMigrationJournalPaths(operation);
    await rename(entry.path, entry.backupPath);
    entry.phase = 'old_moved';
    if (entry.originalEntryKind === 'directory' && entry.path === originalSourcePath) {
      operation.migration!.sourceMoved = true;
    }
    operation.phase = 'old_moved';
    this.putOperation(operation);
    if (
      !(await this.matchesMigrationOriginal(
        entry.backupPath,
        entry,
        originalSourcePath,
        operation.newHash!,
        false,
        operation.migration!.sourceBackupPath,
      ))
    ) {
      throw appError('MIGRATION_BACKUP_INVALID', { path: entry.backupPath });
    }

    await this.assertMigrationJournalPaths(operation);
    if ((await inspectEntry(entry.path)).exists) throw appError('MIGRATION_TARGET_OCCUPIED', { path: entry.path });
    await rename(entry.stagePath, entry.path);
    entry.phase = 'new_placed';
    operation.phase = 'new_placed';
    this.putOperation(operation);
    if (
      !(await entryMatchesPlanned(entry.path, operation)) ||
      (await hashDirectory(operation.sourcePath!).catch(() => '')) !== operation.newHash
    ) {
      throw appError('MIGRATION_LINK_INVALID', { path: entry.path });
    }
    this.commitMigrationEntryMetadata(operation, entry);
  }

  private commitMigrationEntryMetadata(operation: JournalOperation, entry: MigrationEntryPlan): void {
    const plan = operation.migration;
    if (!plan) throw appError('MIGRATION_METADATA_MISSING');
    const distribution: Distribution = {
      id: recordId('distribution', `${entry.target.id}\0${operation.skillId}\0${entry.path}`),
      skillId: operation.skillId,
      targetId: entry.target.id,
      entryPath: entry.path,
      strategy: 'symlink',
      lastWrittenHash: operation.newHash!,
      health: 'healthy',
      verification: 'untested',
    };
    this.store.transaction(() => {
      this.store.put('targets', entry.target);
      for (const binding of entry.bindings) {
        this.store.put('bindings', binding);
        this.store.put('intents', {
          id: recordId('intent', `${binding.id}\0${operation.skillId}`),
          bindingId: binding.id,
          skillId: operation.skillId,
        });
      }
      const previous = this.store
        .list<Distribution>('distributions')
        .find(
          (item) =>
            item.skillId === operation.skillId &&
            item.targetId === entry.target.id &&
            canonicalizeLexical(item.entryPath) === canonicalizeLexical(entry.path),
        );
      this.store.put('distributions', { ...distribution, id: previous?.id ?? distribution.id });
    });
  }

  private migrationEntryLabel(entry: MigrationEntryPlan): string {
    const names = [
      ...new Set(entry.bindings.map((binding) => this.store.get<Harness>('harnesses', binding.harnessId)?.name ?? binding.harnessId)),
    ];
    return `${entry.path} (${names.join(', ')})`;
  }

  private async finishMigrationCleanup(operationId: string): Promise<void> {
    const operation = this.journal.get<JournalOperation>(operationId);
    if (!operation?.migration || !operation.sourcePath || !operation.newHash || !operation.migration.originalSourcePath)
      throw appError('MIGRATION_RECORD_INCOMPLETE');
    await this.assertMigrationJournalPaths(operation);
    for (const entry of operation.migration.references) {
      if (!(await entryMatchesPlanned(entry.path, operation)))
        throw appError('MIGRATION_LINK_CHANGED_BEFORE_CLEANUP', { path: entry.path });
      this.commitMigrationEntryMetadata(operation, entry);
    }

    const directSource = operation.migration.references.find(
      (entry) => entry.originalEntryKind === 'directory' && entry.path === operation.migration!.originalSourcePath,
    );
    if (!directSource && !operation.migration.sourceMoved) {
      await this.assertMigrationSourceParent(operation);
      const sourceEntry = await inspectEntry(operation.migration.originalSourcePath);
      const sourceBackup = await inspectEntry(operation.migration.sourceBackupPath);
      if (!sourceEntry.exists && sourceBackup.exists) {
        if (
          !sourceBackup.stat!.isDirectory() ||
          sourceBackup.stat!.isSymbolicLink() ||
          (await hashDirectory(operation.migration.sourceBackupPath).catch(() => '')) !== operation.newHash
        ) {
          throw appError('MIGRATION_SOURCE_BACKUP_CHANGED');
        }
      } else {
        if (
          !sourceEntry.exists ||
          sourceEntry.stat!.isSymbolicLink() ||
          !sourceEntry.stat!.isDirectory() ||
          (await hashDirectory(operation.migration.originalSourcePath).catch(() => '')) !== operation.newHash
        ) {
          throw appError('MIGRATION_SOURCE_CHANGED_BEFORE_CLEANUP');
        }
        if (sourceBackup.exists) throw appError('MIGRATION_SOURCE_BACKUP_OCCUPIED');
        await mkdir(path.dirname(operation.migration.sourceBackupPath), { recursive: true });
        await this.assertMigrationSourceParent(operation);
        await rename(operation.migration.originalSourcePath, operation.migration.sourceBackupPath);
      }
      operation.migration.sourceMoved = true;
      operation.phase = 'cleanup';
      this.putOperation(operation);
    }
    if (directSource) operation.migration.sourceMoved = true;
    operation.phase = 'cleanup';
    this.putOperation(operation);

    for (const entry of operation.migration.references) {
      await this.assertMigrationJournalPaths(operation);
      const backup = await inspectEntry(entry.backupPath);
      if (!backup.exists) continue;
      if (entry.originalEntryKind === 'symlink') {
        if (!backup.stat!.isSymbolicLink() || (await readlink(entry.backupPath)) !== entry.originalLinkText) {
          throw appError('MIGRATION_RETAINED_LINK_CHANGED', { path: entry.backupPath });
        }
        await rm(entry.backupPath, { force: false });
      } else {
        if (entry.path !== operation.migration.originalSourcePath || entry.backupPath !== operation.migration.sourceBackupPath) {
          throw appError('MIGRATION_UNEXPECTED_DIRECTORY_BACKUP');
        }
        if (
          !backup.stat!.isDirectory() ||
          backup.stat!.isSymbolicLink() ||
          (await hashDirectory(entry.backupPath).catch(() => '')) !== operation.newHash
        ) {
          throw appError('MIGRATION_OLD_SOURCE_BACKUP_CHANGED');
        }
        await rm(entry.backupPath, { recursive: true, force: false });
      }
    }
    if (!directSource) {
      const backup = await inspectEntry(operation.migration.sourceBackupPath);
      if (backup.exists) {
        if (
          !backup.stat!.isDirectory() ||
          backup.stat!.isSymbolicLink() ||
          (await hashDirectory(operation.migration.sourceBackupPath).catch(() => '')) !== operation.newHash
        ) {
          throw appError('MIGRATION_OLD_SOURCE_BACKUP_CHANGED');
        }
        await this.assertMigrationCentral(operation);
        await this.assertMigrationSourceParent(operation);
        await rm(operation.migration.sourceBackupPath, { recursive: true, force: false });
      }
    }
  }

  private async assertMigrationSourceParent(operation: JournalOperation): Promise<void> {
    if (!operation.migration?.originalSourcePath) throw appError('MIGRATION_SOURCE_PATH_MISSING');
    const parent = await canonicalizePath(path.dirname(operation.migration.originalSourcePath));
    if (parent.path !== path.resolve(path.dirname(operation.migration.originalSourcePath)))
      throw appError('MIGRATION_SOURCE_PARENT_REDIRECTED');
    const backupParent = await canonicalizePath(path.dirname(operation.migration.sourceBackupPath));
    if (backupParent.path !== path.resolve(path.dirname(operation.migration.sourceBackupPath)))
      throw appError('MIGRATION_SOURCE_BACKUP_PARENT_REDIRECTED');
  }

  private async assertMigrationJournalPaths(operation: JournalOperation): Promise<void> {
    const plan = operation.migration;
    if (!plan || !operation.sourcePath || !plan.originalSourcePath || !operation.newHash || !plan.references.length)
      throw appError('MIGRATION_RECORD_INCOMPLETE');
    await this.assertMigrationCentral(operation);
    await this.assertMigrationSourceParent(operation);
    for (const entry of plan.references) {
      const target = await canonicalizePath(entry.target.path);
      if (target.path !== path.resolve(entry.target.path)) throw appError('MIGRATION_TARGET_REDIRECTED');
      await this.targets.assertSafeTarget(target.path);
      const parent = await canonicalizePath(path.dirname(entry.path));
      if (parent.key !== target.key) throw appError('MIGRATION_REFERENCE_OUTSIDE_TARGET', { path: entry.path });
      for (const binding of entry.bindings) {
        if (binding.scope === 'workspace') await this.targets.assertBindingTarget(binding, target.path);
      }
      const expectedStage = path.join(target.path, `.harness-manager-stage-${operation.id}-${plan.references.indexOf(entry)}`);
      const expectedBackup = path.join(target.path, '.harness-manager-trash', operation.id, `entry-${plan.references.indexOf(entry)}`);
      if (path.resolve(entry.stagePath) !== expectedStage || path.resolve(entry.backupPath) !== expectedBackup) {
        throw appError('MIGRATION_PATHS_UNEXPECTED');
      }
      const stageParent = await canonicalizePath(path.dirname(entry.stagePath));
      if (stageParent.path !== path.dirname(entry.stagePath)) throw appError('MIGRATION_STAGE_PARENT_REDIRECTED');
      const backupParent = await canonicalizePath(path.dirname(entry.backupPath));
      if (backupParent.path !== path.resolve(path.dirname(entry.backupPath))) throw appError('MIGRATION_BACKUP_PARENT_REDIRECTED');
    }
    const directSource = plan.references.find((entry) => entry.originalEntryKind === 'directory' && entry.path === plan.originalSourcePath);
    const originalState = await inspectEntry(plan.originalSourcePath);
    const originalBackup = await inspectEntry(plan.sourceBackupPath);
    if (directSource && originalState.exists && originalState.stat!.isSymbolicLink()) {
      if (!(await entryMatchesPlanned(plan.originalSourcePath, operation))) throw appError('MIGRATION_SOURCE_REPLACED_BY_LINK');
    } else if (originalState.exists) {
      if (
        originalState.stat!.isSymbolicLink() ||
        !originalState.stat!.isDirectory() ||
        (await hashDirectory(plan.originalSourcePath).catch(() => '')) !== operation.newHash
      ) {
        throw appError('MIGRATION_SOURCE_CHANGED');
      }
    } else if (originalBackup.exists) {
      if (
        originalBackup.stat!.isSymbolicLink() ||
        !originalBackup.stat!.isDirectory() ||
        (await hashDirectory(plan.sourceBackupPath).catch(() => '')) !== operation.newHash
      ) {
        throw appError('MIGRATION_RETAINED_SOURCE_CHANGED');
      }
    } else {
      const allLinksVerified =
        operation.phase === 'cleanup' &&
        (await Promise.all(plan.references.map((entry) => entryMatchesPlanned(entry.path, operation))).then((matches) =>
          matches.every(Boolean),
        ));
      if (!allLinksVerified) throw appError('MIGRATION_SOURCE_AND_BACKUP_MISSING');
    }
    if (!(directSource && originalState.exists && originalState.stat!.isSymbolicLink())) {
      const canonicalOriginal = await canonicalizePath(plan.originalSourcePath);
      if (canonicalOriginal.path !== path.resolve(plan.originalSourcePath)) throw appError('MIGRATION_SOURCE_REDIRECTED');
    }
    const backupParent = await canonicalizePath(path.dirname(plan.sourceBackupPath));
    if (backupParent.path !== path.resolve(path.dirname(plan.sourceBackupPath)))
      throw appError('MIGRATION_SOURCE_BACKUP_PARENT_REDIRECTED');
    const expectedSourceBackup =
      directSource?.backupPath ??
      path.join(
        path.dirname(plan.originalSourcePath),
        `.${path.basename(plan.originalSourcePath)}.harness-manager-trash`,
        operation.id,
        'source',
      );
    if (path.resolve(plan.sourceBackupPath) !== expectedSourceBackup) throw appError('MIGRATION_SOURCE_BACKUP_UNEXPECTED');
  }

  private async assertMigrationCentral(operation: JournalOperation): Promise<void> {
    if (!operation.skillId || !operation.sourcePath || !operation.newHash) throw appError('MIGRATION_CENTRAL_MISSING');
    const skill = this.store.get<Skill>('skills', operation.skillId);
    if (!skill || skill.directory !== operation.sourcePath || !isSafeEntryName(skill.name))
      throw appError('MIGRATION_CENTRAL_RECORD_CHANGED');
    const expected = path.join(this.store.root, 'skills', operation.skillId, skill.name);
    if (path.resolve(operation.sourcePath) !== expected) throw appError('MIGRATION_CENTRAL_PATH_CHANGED');
    const [storeRoot, skillsRoot, skillParent, central] = await Promise.all([
      lstat(this.store.root),
      lstat(path.join(this.store.root, 'skills')),
      lstat(path.join(this.store.root, 'skills', operation.skillId)),
      lstat(operation.sourcePath),
    ]);
    const canonicalStore = await canonicalizePath(this.store.root);
    const canonicalCentral = await canonicalizePath(operation.sourcePath);
    if (
      storeRoot.isSymbolicLink() ||
      !storeRoot.isDirectory() ||
      canonicalStore.path !== this.store.root ||
      skillsRoot.isSymbolicLink() ||
      !skillsRoot.isDirectory() ||
      skillParent.isSymbolicLink() ||
      !skillParent.isDirectory() ||
      central.isSymbolicLink() ||
      !central.isDirectory() ||
      canonicalCentral.path !== expected
    ) {
      throw appError('MIGRATION_CENTRAL_PATH_UNSAFE');
    }
    if ((await hashDirectory(operation.sourcePath)) !== operation.newHash) throw appError('MIGRATION_CENTRAL_CONTENT_CHANGED');
  }

  private async matchesMigrationOriginal(
    entryPath: string,
    entry: MigrationEntryPlan,
    sourcePath: string,
    sourceHash: string,
    atOriginalLocation: boolean,
    sourceBackupPath: string,
  ): Promise<boolean> {
    const state = await inspectEntry(entryPath);
    if (!state.exists) return false;
    if (entry.originalEntryKind === 'directory') {
      if (state.stat!.isSymbolicLink() || !state.stat!.isDirectory()) return false;
      return (await hashDirectory(entryPath).catch(() => '')) === sourceHash;
    }
    if (!state.stat!.isSymbolicLink() || !entry.originalLinkText || (await readlink(entryPath)) !== entry.originalLinkText) return false;
    if (atOriginalLocation && (await realpath(entryPath).catch(() => '')) !== sourcePath) return false;
    const actualHash = (await hashDirectory(sourcePath).catch(() => '')) || (await hashDirectory(sourceBackupPath).catch(() => ''));
    return actualHash === sourceHash;
  }

  /** Finishes or stops interrupted migrations recorded in the journal. */
  async recover(): Promise<void> {
    const pending = this.journal
      .list<JournalOperation>('distribution')
      .filter(
        (operation) =>
          operation.kind === 'migration' &&
          operation.phase !== 'committed' &&
          operation.phase !== 'failed' &&
          operation.phase !== 'blocked',
      );
    for (const operation of pending) await this.recoverOne(operation.id);
  }

  private async recoverOne(id: string): Promise<boolean> {
    const operation = this.journal.get<JournalOperation>(id);
    if (operation?.owner !== 'distribution' || operation.kind !== 'migration') return false;
    if (operation.phase === 'committed' || operation.phase === 'failed' || operation.phase === 'blocked') return true;
    try {
      await this.assertMigrationJournalPaths(operation);
      return await this.recoverMigration(operation);
    } catch (error) {
      this.updateOperation(id, { phase: 'blocked', error: message('RECOVERY_STOPPED', { reason: errorMessage(error) }) });
      return false;
    }
  }

  private async recoverMigration(operation: JournalOperation): Promise<boolean> {
    if (
      !operation.migration ||
      !operation.sourcePath ||
      !operation.migration.originalSourcePath ||
      !operation.newHash ||
      !operation.migration.references.length
    ) {
      this.updateOperation(operation.id, { phase: 'blocked', error: message('RECOVERY_MIGRATION_INCOMPLETE') });
      return false;
    }
    try {
      const originalSourcePath = operation.migration.originalSourcePath;
      const sourceBackupPath = operation.migration.sourceBackupPath;
      if (operation.phase === 'cleanup') {
        await this.finishMigrationCleanup(operation.id);
        this.updateOperation(operation.id, { phase: 'committed', error: undefined });
        return true;
      }
      for (const entry of operation.migration.references) {
        await this.assertMigrationJournalPaths(operation);
        const final = await inspectEntry(entry.path);
        const backup = await inspectEntry(entry.backupPath);
        const stage = await inspectEntry(entry.stagePath);
        const finalMatches = final.exists && (await entryMatchesPlanned(entry.path, operation));
        const stageMatches = stage.exists && (await entryMatchesPlanned(entry.stagePath, operation));
        const originalAtFinal =
          final.exists &&
          (await this.matchesMigrationOriginal(entry.path, entry, originalSourcePath, operation.newHash, true, sourceBackupPath));
        const originalAtBackup =
          backup.exists &&
          (await this.matchesMigrationOriginal(entry.backupPath, entry, originalSourcePath, operation.newHash, false, sourceBackupPath));

        if (finalMatches) {
          if (!originalAtBackup) {
            this.updateOperation(operation.id, {
              phase: 'blocked',
              error: message('RECOVERY_MIGRATION_ORIGINAL_CHANGED', { path: entry.path }),
            });
            return false;
          }
          entry.phase = 'new_placed';
          this.putOperation(operation);
          this.commitMigrationEntryMetadata(operation, entry);
          continue;
        }
        if (originalAtFinal && !backup.exists) {
          if (stage.exists && !stageMatches) {
            this.updateOperation(operation.id, {
              phase: 'blocked',
              error: message('RECOVERY_MIGRATION_STAGE_CHANGED', { path: entry.path }),
            });
            return false;
          }
          await this.migrateReferenceEntry(operation, entry);
          continue;
        }
        if (!final.exists && originalAtBackup) {
          if (stageMatches && (await hashDirectory(operation.sourcePath).catch(() => '')) === operation.newHash) {
            await this.assertMigrationJournalPaths(operation);
            if ((await inspectEntry(entry.path)).exists) {
              this.updateOperation(operation.id, {
                phase: 'blocked',
                error: message('RECOVERY_MIGRATION_TARGET_OCCUPIED', { path: entry.path }),
              });
              return false;
            }
            await rename(entry.stagePath, entry.path);
            entry.phase = 'new_placed';
            operation.phase = 'new_placed';
            this.putOperation(operation);
            if (!(await entryMatchesPlanned(entry.path, operation))) {
              this.updateOperation(operation.id, {
                phase: 'blocked',
                error: message('RECOVERY_MIGRATION_LINK_INVALID', { path: entry.path }),
              });
              return false;
            }
            this.commitMigrationEntryMetadata(operation, entry);
            continue;
          }
          await this.assertMigrationJournalPaths(operation);
          if ((await inspectEntry(entry.path)).exists) {
            this.updateOperation(operation.id, {
              phase: 'blocked',
              error: message('RECOVERY_MIGRATION_RESTORE_OCCUPIED', { path: entry.path }),
            });
            return false;
          }
          await rename(entry.backupPath, entry.path);
          if (!(await this.matchesMigrationOriginal(entry.path, entry, originalSourcePath, operation.newHash, true, sourceBackupPath))) {
            this.updateOperation(operation.id, {
              phase: 'blocked',
              error: message('RECOVERY_MIGRATION_RESTORE_INVALID', { path: entry.path }),
            });
            return false;
          }
          if (stageMatches) await removeEntryIfMatches(entry.stagePath, operation);
          this.updateOperation(operation.id, {
            phase: 'blocked',
            error: message('RECOVERY_MIGRATION_RESTORED', { path: entry.path }),
          });
          return false;
        }
        this.updateOperation(operation.id, {
          phase: 'blocked',
          error: message('RECOVERY_MIGRATION_CHANGED', { path: entry.path }),
        });
        return false;
      }
      await this.finishMigrationCleanup(operation.id);
      this.updateOperation(operation.id, { phase: 'committed', error: undefined });
      return true;
    } catch (error) {
      this.updateOperation(operation.id, {
        phase: 'blocked',
        error: message('RECOVERY_MIGRATION_STOPPED', { reason: errorMessage(error) }),
      });
      return false;
    }
  }

  private putOperation(operation: JournalOperation): void {
    this.journal.put(operation);
  }

  private updateOperation(id: string, patch: Partial<JournalOperation>): void {
    this.journal.update(id, patch);
  }
}

function sameMigrationReferenceSet(expected: ExternalMigrationReference[], actual: ExternalSkill[]): boolean {
  const key = (item: Pick<ExternalMigrationReference, 'path' | 'harnessId' | 'scope' | 'workspaceId'>): string =>
    JSON.stringify([canonicalizeLexical(item.path), item.harnessId, item.scope, item.workspaceId ?? '']);
  const left = expected.map(key).sort();
  const right = actual.map(key).sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
