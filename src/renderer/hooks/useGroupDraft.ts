import { useT } from '../i18n';
import { useState } from 'react';
import type { HarnessAPI } from '../../shared/ipc-contract';
import type { LibraryData } from './useLibraryData';
import type { Shell } from './useShell';

/** Choosing an existing group or naming a new one, used after an import and when grouping a selection. */
export function useGroupDraft(api: HarnessAPI | undefined, shell: Shell, data: LibraryData) {
  const t = useT();
  const [onboardingIds, setOnboardingIds] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState('');

  const chooseGroup = (id: string) => {
    setGroupId(id);
    setName('');
  };
  const typeName = (value: string) => {
    setName(value);
    setGroupId('');
  };
  const reset = () => {
    setName('');
    setGroupId('');
  };
  const request = (skillIds: string[]) => (groupId ? { groupId, skillIds } : { name: name.trim(), skillIds });

  const openOnboarding = (ids: string[]) => {
    setOnboardingIds(ids);
    reset();
    shell.setDialog('onboarding');
  };
  const closeOnboarding = () => {
    shell.setDialog(null);
    setOnboardingIds([]);
  };
  const saveOnboarding = () =>
    shell.runTask('group', async () => {
      if (!api) return;
      await api.saveGroup(request(onboardingIds));
      await data.refresh();
      closeOnboarding();
      shell.setToast(t('library.skillGroupsUpdated'));
    });

  return { onboardingIds, name, groupId, chooseGroup, typeName, reset, request, openOnboarding, closeOnboarding, saveOnboarding };
}

export type GroupDraft = ReturnType<typeof useGroupDraft>;
