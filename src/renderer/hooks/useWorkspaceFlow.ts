import { useT } from '../i18n';
import { useEffect, useState } from 'react';
import { errorMessage } from '../../shared/errors';
import { mergeBatchResults, pruneSelection } from '../removal-plan';
import type { HarnessAPI } from '../../shared/ipc-contract';
import type { BatchResult } from '../../shared/types';
import type { RemovalDraft } from '../view-types';
import type { LibraryData } from './useLibraryData';
import type { LibraryView } from './useLibraryView';
import type { Shell } from './useShell';

/** The workspace page, applying skills to a workspace via the library, and removing managed installations. */
export function useWorkspaceFlow(api: HarnessAPI | undefined, shell: Shell, data: LibraryData, view: LibraryView) {
  const t = useT();
  const [selectedPath, setSelectedPath] = useState('');
  const [removalSelections, setRemovalSelections] = useState<Record<string, string[]>>({});
  useEffect(() => setRemovalSelections({}), [selectedPath]);
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
    shell.setToast(t('workspace.selectSkillsFirstThenApplyThemToThisWorkspaceUsing'));
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
    shell.setError('');
    setRemoveDraft(draft);
    setRemoveResult(null);
    shell.setDialog('remove');
  };

  const closeRemove = () => {
    shell.setDialog(null);
    setRemoveDraft(null);
    setRemoveResult(null);
  };

  const confirmRemove = () => {
    if (!removeDraft || !api) return;
    const draft = removeDraft;
    return shell.runTask('remove', async () => {
      const results: BatchResult[] = [];
      for (const part of draft.parts) {
        try {
          results.push(await api.remove(part));
        } catch (cause) {
          results.push({
            items: part.skillIds.map((id) => ({
              id,
              label: data.allSnapshot?.skills.find((skill) => skill.id === id)?.name || id,
              status: 'error',
              message: errorMessage(cause),
            })),
          });
        }
      }
      const result = mergeBatchResults(results);
      if (draft.origin === 'library') {
        const remaining = pruneSelection(view.selected, result);
        view.setSelected(remaining);
        if (!remaining.size) view.setSelectMode(false);
      } else {
        setRemovalSelections((current) => {
          const next = { ...current };
          for (let index = 0; index < draft.parts.length; index += 1) {
            const { bindingId } = draft.parts[index];
            next[bindingId] = [...pruneSelection(new Set(current[bindingId] ?? []), results[index])];
          }
          return next;
        });
      }
      const complete = result.items.every((item) => item.status === 'success');
      if (!complete) setRemoveResult(result);
      await data.refresh();
      if (complete) {
        closeRemove();
        const count = result.items.length;
        const subject = count === 1 ? draft.skills[0].name : t('workspace.skills', { count: count });
        shell.setToast(
          t('workspace.unappliedFrom', {
            harnessName: draft.harnessName,
            subject: subject,
            value: draft.sharedCount ? t('workspace.itemsKeptInSharedDirectories', { sharedCount: draft.sharedCount }) : '',
          }),
        );
      }
    });
  };

  const finishRemove = () => {
    if (removeResult) {
      const succeeded = removeResult.items.filter((item) => item.status === 'success').length;
      const incomplete = removeResult.items.length - succeeded;
      shell.setToast(
        succeeded
          ? t('workspace.unappliedItemsIncompleteItemsRemainSelected', { succeeded: succeeded, incomplete: incomplete })
          : t('workspace.couldNotUnapplyItemsTheyRemainSelected', { incomplete: incomplete }),
      );
    }
    closeRemove();
  };

  return {
    selectedPath,
    removalSelections,
    setRemovalSelections,
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
