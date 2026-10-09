import { useState } from 'react';
import type { HarnessAPI } from '../../shared/ipc-contract';
import type { BatchResult } from '../../shared/types';
import type { RemovalDraft } from '../view-types';
import type { LibraryData } from './useLibraryData';
import type { LibraryView } from './useLibraryView';
import type { Shell } from './useShell';

/** The workspace page, applying skills to a workspace via the library, and removing managed installations. */
export function useWorkspaceFlow(api: HarnessAPI | undefined, shell: Shell, data: LibraryData, view: LibraryView) {
  const [selectedPath, setSelectedPath] = useState('');
  /** A workspace the user left to pick skills for; the library selection returns there. */
  const [returnPath, setReturnPath] = useState('');
  const [removeDraft, setRemoveDraft] = useState<RemovalDraft | null>(null);
  const [removeResult, setRemoveResult] = useState<BatchResult | null>(null);

  const chooseWorkspace = async () => {
    const path = await api?.chooseDirectory();
    if (path) setSelectedPath(path);
  };

  const addSkills = (path: string) => {
    setReturnPath(path);
    view.setSelected(new Set());
    view.setSearch('');
    shell.setPage('library');
    view.setSelectMode(true);
    shell.setToast('先选择要应用的技能，再从右下角应用到此工作区。');
  };

  const leaveSelection = () => {
    view.setSelectMode(false);
    view.setSelected(new Set());
    if (returnPath) {
      shell.setPage('workspaces');
      setSelectedPath(returnPath);
      setReturnPath('');
    }
  };

  const openRemove = (draft: RemovalDraft) => {
    setRemoveDraft(draft);
    setRemoveResult(null);
    shell.setDialog('remove');
  };

  const closeRemove = () => {
    shell.setDialog(null);
    setRemoveDraft(null);
  };

  const confirmRemove = () => {
    if (!removeDraft) return;
    return shell.runTask('remove', async () => {
      setRemoveResult(await api!.remove({ bindingId: removeDraft.bindingId, skillIds: removeDraft.skillIds }));
      await data.refresh();
    });
  };

  const finishRemove = () => {
    closeRemove();
    void data.refresh();
  };

  return {
    selectedPath,
    setSelectedPath,
    returnPath,
    removeDraft,
    removeResult,
    chooseWorkspace,
    addSkills,
    leaveSelection,
    openRemove,
    closeRemove,
    confirmRemove,
    finishRemove,
  };
}

export type WorkspaceFlow = ReturnType<typeof useWorkspaceFlow>;
