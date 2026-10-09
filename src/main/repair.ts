import { randomUUID } from 'node:crypto';
import { lstat, readlink, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { BatchResult, Binding, Distribution, Harness, ManagedLinkRepairPreview, Skill } from '../shared/types';
import { hashDirectory } from './content';
import { errorMessage } from '../shared/errors';
import { isHarnessEnabled } from '../shared/harness-enabled';
import type { ExternalSkillScanner } from './external-skills';
import { canonicalizeLexical } from './entries';
import { createDirectoryLink, pathExists } from './fs-utils';
import { Journal } from './journal';
import type { Store } from './store';
import { appError, message } from './messages';

interface RepairRecord extends ManagedLinkRepairPreview {
  id: string;
  owner: 'repair';
  phase: 'planned' | 'committed' | 'failed' | 'blocked';
  skillId: string;
  originalLink: string;
  centralHash: string;
  stagePath: string;
  backupPath: string;
  originalDev: number;
  originalIno: number;
  distributionJson: string;
  expiresAt: number;
  error?: string;
}

/** Explicit repair restores only a manager-owned symlink, preserving both content directories. */
export class ManagedLinkRepairService {
  private readonly previews = new Map<string, RepairRecord>();
  private readonly journal: Journal;

  constructor(
    private readonly store: Store,
    private readonly external: ExternalSkillScanner,
  ) {
    this.journal = new Journal(store);
  }

  async preview({ externalSkillId }: { externalSkillId: string }): Promise<ManagedLinkRepairPreview[]> {
    const selected = (await this.external.externalSkills()).find((item) => item.id === externalSkillId);
    if (!selected) return [];
    const oldSource = await realpath(selected.path);
    const result: ManagedLinkRepairPreview[] = [];
    for (const distribution of this.store.list<Distribution>('distributions')) {
      if (!this.canOperateTarget(distribution.targetId)) continue;
      if (distribution.strategy !== 'symlink') continue;
      const info = await lstat(distribution.entryPath).catch(() => undefined);
      if (!info?.isSymbolicLink() || (await realpath(distribution.entryPath).catch(() => '')) !== oldSource) continue;
      const skill = this.store.get<Skill>('skills', distribution.skillId);
      if (!skill) continue;
      const centralPath = await realpath(skill.directory).catch(() => '');
      if (!centralPath || centralPath === oldSource) continue;
      const repairId = randomUUID();
      const parent = await realpath(path.dirname(distribution.entryPath));
      const entryPath = path.join(parent, path.basename(distribution.entryPath));
      const record: RepairRecord = {
        id: repairId,
        repairId,
        owner: 'repair',
        phase: 'planned',
        distributionId: distribution.id,
        skillId: skill.id,
        skillName: skill.name,
        entryPath,
        currentTarget: oldSource,
        centralPath,
        originalLink: await readlink(entryPath),
        centralHash: await hashDirectory(centralPath),
        stagePath: path.join(parent, `.harness-manager-stage-${repairId}`),
        backupPath: path.join(parent, `.harness-manager-repair-${repairId}`),
        originalDev: info.dev,
        originalIno: info.ino,
        distributionJson: ownership(distribution),
        expiresAt: Date.now() + 15 * 60_000,
      };
      await this.validatePaths(record);
      for (const [id, preview] of this.previews) if (preview.expiresAt < Date.now()) this.previews.delete(id);
      while (this.previews.size >= 64) this.previews.delete(this.previews.keys().next().value!);
      this.previews.set(repairId, record);
      result.push({ repairId, distributionId: distribution.id, skillName: skill.name, entryPath, currentTarget: oldSource, centralPath });
    }
    return result;
  }

  async repair({ repairId }: { repairId: string }): Promise<BatchResult> {
    const record = this.previews.get(repairId);
    this.previews.delete(repairId);
    if (!record || record.expiresAt < Date.now()) throw appError('REPAIR_PREVIEW_EXPIRED');
    const distribution = this.store.get<Distribution>('distributions', record.distributionId);
    if (!distribution || !this.canOperateTarget(distribution.targetId)) throw appError('REPAIR_HARNESS_DISABLED');
    await this.validatePaths(record);
    const stat = await lstat(record.entryPath);
    if (
      stat.dev !== record.originalDev ||
      stat.ino !== record.originalIno ||
      !(await this.isOriginal(record.entryPath, record)) ||
      (await realpath(record.entryPath)) !== record.currentTarget
    )
      throw appError('REPAIR_LINK_CHANGED');
    if (ownership(this.store.get<Distribution>('distributions', record.distributionId)) !== record.distributionJson)
      throw appError('REPAIR_RECORD_CHANGED');
    if ((await hashDirectory(record.centralPath)) !== record.centralHash) throw appError('REPAIR_CENTRAL_CHANGED');
    if ((await pathExists(record.stagePath)) || (await pathExists(record.backupPath))) throw appError('REPAIR_STAGE_OCCUPIED');
    this.journal.put(record);
    try {
      await createDirectoryLink(record.centralPath, record.stagePath);
      await this.validatePaths(record);
      if (!(await this.isOriginal(record.entryPath, record))) throw appError('REPAIR_ORIGINAL_CHANGED');
      await rename(record.entryPath, record.backupPath);
      await this.validatePaths(record);
      if (await pathExists(record.entryPath)) throw appError('REPAIR_ENTRY_OCCUPIED');
      await rename(record.stagePath, record.entryPath);
      await this.finish(record);
    } catch (error) {
      await this.recoverRecord(record);
      if (this.journal.get<RepairRecord>(repairId)?.phase !== 'committed') {
        return {
          items: [
            {
              id: repairId,
              label: record.skillName,
              status: 'error',
              message: message('REPAIR_FAILED', { reason: errorMessage(error) }),
            },
          ],
        };
      }
    }
    return {
      items: [{ id: repairId, label: record.skillName, status: 'success', message: message('REPAIR_DONE') }],
    };
  }

  async recover() {
    for (const record of this.journal
      .list<RepairRecord>('repair')
      .filter((item) => item.owner === 'repair' && ['planned', 'blocked'].includes(item.phase)))
      await this.recoverRecord(record);
  }

  private canOperateTarget(targetId: string): boolean {
    const bindings = this.store.list<Binding>('bindings').filter((binding) => binding.targetId === targetId);
    if (!bindings.length) return false;
    return bindings.every((binding) => isHarnessEnabled(this.store.get<Harness>('harnesses', binding.harnessId)));
  }

  private async recoverRecord(record: RepairRecord) {
    try {
      await this.validatePaths(record);
      if (await this.isCentral(record.entryPath, record)) {
        await this.finish(record);
        return;
      }
      if (!(await pathExists(record.entryPath)) && (await this.isOriginal(record.backupPath, record))) {
        await rename(record.backupPath, record.entryPath);
      }
      if (!(await this.isOriginal(record.entryPath, record))) throw appError('REPAIR_RECOVERY_CHANGED');
      if (await this.isCentral(record.stagePath, record)) await rm(record.stagePath);
      else if (await pathExists(record.stagePath)) throw appError('REPAIR_STAGE_MODIFIED');
      this.journal.put({ ...record, phase: 'failed', error: message('REPAIR_INTERRUPTED') });
    } catch (error) {
      this.journal.put({
        ...record,
        phase: 'blocked',
        error: message('REPAIR_BLOCKED', { reason: errorMessage(error) }),
      });
    }
  }

  private async finish(record: RepairRecord) {
    await this.validatePaths(record);
    if (!(await this.isCentral(record.entryPath, record)) || (await hashDirectory(record.centralPath)) !== record.centralHash)
      throw appError('REPAIR_VERIFY_FAILED');
    if (await pathExists(record.backupPath)) {
      if (!(await this.isOriginal(record.backupPath, record))) throw appError('REPAIR_BACKUP_CHANGED');
      await rm(record.backupPath); // Only a verified symlink; never its target.
    }
    if (await this.isCentral(record.stagePath, record)) await rm(record.stagePath);
    const distribution = this.store.get<Distribution>('distributions', record.distributionId)!;
    this.store.transaction(() => {
      this.store.put('distributions', { ...distribution, health: 'healthy', lastWrittenHash: record.centralHash });
      this.journal.put({ ...record, phase: 'committed', error: undefined });
    });
  }

  private async validatePaths(record: RepairRecord) {
    const distribution = this.store.get<Distribution>('distributions', record.distributionId);
    const skill = this.store.get<Skill>('skills', record.skillId);
    if (!distribution || !skill || distribution.skillId !== record.skillId || distribution.strategy !== 'symlink')
      throw appError('REPAIR_RECORD_MISMATCH');
    const expected = path.join(this.store.root, 'skills', skill.id, skill.name);
    if (skill.directory !== expected || record.centralPath !== expected || (await realpath(expected)) !== expected)
      throw appError('REPAIR_CENTRAL_PATH_INVALID');
    const parent = path.dirname(record.entryPath);
    if ((await realpath(parent)) !== parent || path.resolve(distribution.entryPath) !== record.entryPath)
      throw appError('REPAIR_HARNESS_PATH_CHANGED');
    if (
      record.stagePath !== path.join(parent, `.harness-manager-stage-${record.id}`) ||
      record.backupPath !== path.join(parent, `.harness-manager-repair-${record.id}`)
    )
      throw appError('REPAIR_PATHS_MISMATCH');
  }

  private async isOriginal(entry: string, record: RepairRecord) {
    return (await lstat(entry).catch(() => undefined))?.isSymbolicLink() === true && (await readlink(entry)) === record.originalLink;
  }
  private async isCentral(entry: string, record: RepairRecord) {
    if ((await lstat(entry).catch(() => undefined))?.isSymbolicLink() !== true) return false;
    const destination = path.resolve(path.dirname(entry), await readlink(entry));
    return canonicalizeLexical(destination) === canonicalizeLexical(record.centralPath);
  }
}

function ownership(distribution?: Distribution): string {
  return JSON.stringify(
    distribution && [distribution.id, distribution.skillId, distribution.targetId, distribution.entryPath, distribution.strategy],
  );
}
