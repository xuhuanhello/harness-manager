import { useState } from 'react';
import { errorMessage } from '../../shared/errors';
import type { HarnessAPI } from '../../shared/ipc-contract';
import type { BatchResult, ExternalMigrationPreview, ExternalSkill, ManagedLinkRepairPreview } from '../../shared/types';
import type { ManagedRepairOutcome } from '../view-types';
import type { LibraryData } from './useLibraryData';
import type { Shell } from './useShell';

/** Migrating an external skill into the central library, including repairing managed links that block it. */
export function useMigrationFlow(api: HarnessAPI | undefined, shell: Shell, data: LibraryData) {
  const { setBusy, setDialog, setToast } = shell;
  const [target, setTarget] = useState<ExternalSkill | null>(null);
  const [preview, setPreview] = useState<ExternalMigrationPreview | null>(null);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [error, setError] = useState('');
  const [repairs, setRepairs] = useState<ManagedLinkRepairPreview[]>([]);
  const [repairsChecked, setRepairsChecked] = useState(false);
  const [repairsError, setRepairsError] = useState('');
  const [expandedRepairId, setExpandedRepairId] = useState('');
  const [repairOutcomes, setRepairOutcomes] = useState<ManagedRepairOutcome[]>([]);

  const resetIssues = () => {
    setError('');
    setRepairs([]);
    setRepairsChecked(false);
    setRepairsError('');
    setExpandedRepairId('');
  };

  const loadPreview = async (externalSkillId: string) => {
    setPreview(null);
    resetIssues();
    setBusy('migration-preview');
    try {
      if (!api) throw new Error('桌面应用连接不可用。');
      const next = await api.previewMigrateExternal({ externalSkillId });
      if (next.externalSkillId !== externalSkillId) throw new Error('预览返回的技能与所选技能不匹配。');
      setPreview(next);
    } catch (cause) {
      setError(errorMessage(cause));
      if (api) {
        setBusy('migration-repairs');
        try {
          setRepairs(await api.migrationRepairs({ externalSkillId }));
          setRepairsChecked(true);
        } catch (repairCause) {
          setRepairsError(errorMessage(repairCause));
          setRepairsChecked(true);
        }
      }
    } finally {
      setBusy('');
    }
  };

  const open = (skill: ExternalSkill) => {
    setTarget(skill);
    setPreview(null);
    setResult(null);
    resetIssues();
    setRepairOutcomes([]);
    setDialog('migrate-external');
    void loadPreview(skill.id);
  };

  const repair = async (item: ManagedLinkRepairPreview) => {
    if (!api || !target) return;
    setBusy('repair-managed-link');
    setError('');
    setRepairsError('');
    try {
      const outcome = { repair: item, result: await api.repairManagedLink({ repairId: item.repairId }) };
      setRepairOutcomes((current) => [...current.filter((entry) => entry.repair.repairId !== item.repairId), outcome]);
      setExpandedRepairId('');
      await data.refresh();
      const succeeded = outcome.result.items.length > 0 && outcome.result.items.every((entry) => entry.status !== 'error');
      if (succeeded) await loadPreview(target.id);
      else {
        setRepairs([]);
        setRepairsChecked(false);
        setError('链接修复未全部完成。请查看逐项结果，确认路径或权限后重新检测。');
      }
    } catch (cause) {
      const reason = errorMessage(cause);
      setRepairOutcomes((current) => [
        ...current.filter((entry) => entry.repair.repairId !== item.repairId),
        { repair: item, error: reason },
      ]);
      setExpandedRepairId('');
      setRepairs([]);
      setRepairsChecked(false);
      setError(`链接修复没有完成：${reason} 请检查 Harness 设置或目录权限后重新检测。`);
    } finally {
      setBusy('');
    }
  };

  const confirm = async () => {
    if (!api || !target || !preview) return;
    setBusy('migration');
    setError('');
    try {
      setResult(await api.migrateExternal({ externalSkillId: target.id, previewId: preview.previewId }));
      await data.refresh();
    } catch {
      setPreview(null);
      setToast('迁移时目录状态发生变化，正在重新检测来源和引用。');
      await loadPreview(target.id);
    } finally {
      setBusy('');
    }
  };

  /** Closes the dialog. Opening it again resets everything, so no partial state carries over. */
  const close = () => {
    setDialog(null);
    setTarget(null);
    setPreview(null);
    setResult(null);
    resetIssues();
    setRepairOutcomes([]);
  };

  const done = () => {
    close();
    void data.refresh();
  };

  const repreview = () => {
    if (!target) return;
    setResult(null);
    void loadPreview(target.id);
  };

  const toggleRepair = (repairId: string) => setExpandedRepairId((current) => (current === repairId ? '' : repairId));

  return {
    target,
    preview,
    result,
    error,
    repairs,
    repairsChecked,
    repairsError,
    expandedRepairId,
    repairOutcomes,
    loadPreview,
    open,
    repair,
    confirm,
    close,
    done,
    repreview,
    toggleRepair,
  };
}

export type MigrationFlow = ReturnType<typeof useMigrationFlow>;
