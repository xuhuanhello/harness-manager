import { useState } from 'react';
import type { HarnessAPI } from '../../shared/ipc-contract';
import type { ApplyPlan, ApplyRequest, BatchResult } from '../../shared/types';
import type { ApplyDraft } from '../view-types';
import type { GroupDraft } from './useGroupDraft';
import type { LibraryData } from './useLibraryData';
import type { LibraryView } from './useLibraryView';
import type { Shell } from './useShell';

const EMPTY_DRAFT: ApplyDraft = { mode: 'harness', scope: 'user', harnessIds: [], workspacePath: '', strategy: 'symlink' };

/** Applying the selected skills to Harnesses (preview, then apply) or adding them to a group. */
export function useApplyFlow(api: HarnessAPI | undefined, shell: Shell, data: LibraryData, view: LibraryView, groups: GroupDraft) {
  const [draft, setDraft] = useState<ApplyDraft>(EMPTY_DRAFT);
  const [plan, setPlan] = useState<ApplyPlan | null>(null);
  const [results, setResults] = useState<BatchResult | null>(null);

  const open = (ids?: string[], prefilledWorkspace = '') => {
    if (ids) view.setSelected(new Set(ids));
    groups.reset();
    setDraft({ ...EMPTY_DRAFT, scope: prefilledWorkspace ? 'workspace' : 'user', workspacePath: prefilledWorkspace });
    setPlan(null);
    setResults(null);
    shell.setDialog('apply');
  };

  /** Any change to the target invalidates the preview. */
  const update = (patch: Partial<ApplyDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setPlan(null);
  };

  const chooseWorkspace = async () => {
    const path = await api?.chooseDirectory();
    if (path) update({ workspacePath: path });
  };

  const addHarness = (harnessId: string) => setDraft((prev) => ({ ...prev, harnessIds: [...new Set([...prev.harnessIds, harnessId])] }));

  const preview = () =>
    shell.runTask('preview', async () => {
      const request: ApplyRequest = {
        skillIds: [...view.selected],
        harnessIds: draft.harnessIds,
        scope: draft.scope,
        ...(draft.scope === 'workspace' ? { workspacePath: draft.workspacePath.trim() } : {}),
        strategy: draft.strategy,
      };
      setPlan(await api!.previewApply(request));
    });

  const confirm = () => {
    if (!plan) return;
    const hasConflict = plan.items.some((item) => item.status === 'conflict');
    return shell.runTask('apply', async () => {
      setResults(await api!.apply(plan.request));
      await data.refresh();
      if (hasConflict) shell.setToast('已提交无冲突项；冲突项由主进程保留并报告。');
    });
  };

  const leaveSelection = () => {
    shell.setDialog(null);
    view.setSelected(new Set());
    view.setSelectMode(false);
  };

  const saveToGroup = () =>
    shell.runTask('group', async () => {
      await api!.saveGroup(groups.request([...view.selected]));
      await data.refresh();
      leaveSelection();
      shell.setToast('技能已加入分组。');
    });

  const finish = () => {
    leaveSelection();
    void data.refresh();
  };

  return { draft, plan, results, open, update, chooseWorkspace, addHarness, preview, confirm, saveToGroup, finish };
}

export type ApplyFlow = ReturnType<typeof useApplyFlow>;
