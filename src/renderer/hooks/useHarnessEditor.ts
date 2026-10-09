import { useState } from 'react';
import type { HarnessAPI } from '../../shared/ipc-contract';
import type { Harness, HarnessInput } from '../../shared/types';
import type { Page } from '../view-types';
import type { ApplyFlow } from './useApplyFlow';
import type { LibraryData } from './useLibraryData';
import type { Shell } from './useShell';

const NEW_HARNESS = {
  origin: 'custom' as const,
  name: '',
  icon: '',
  userSkillsPath: '',
  workspaceSkillsRelativePath: '',
  kind: 'cli' as const,
  readsUserAgents: false,
  readsWorkspaceAgents: false,
  versionArgs: ['--version'],
};

/** Adding or editing a Harness, from Settings or from the apply dialog (which it returns to). */
export function useHarnessEditor(api: HarnessAPI | undefined, shell: Shell, data: LibraryData, apply: ApplyFlow) {
  const [input, setInput] = useState<HarnessInput>({ name: '', icon: '', userSkillsPath: '', workspaceSkillsRelativePath: '' });
  const [returnPage, setReturnPage] = useState<Page>('settings');

  const open = (harness?: Harness, from: Page = shell.page) => {
    const { origin: _origin, ...editable } = harness ?? NEW_HARNESS;
    setInput(editable);
    setReturnPage(from);
    shell.setDialog('harness-form');
  };

  const close = () => shell.setDialog(returnPage === 'library' ? 'apply' : null);

  const save = () =>
    shell.runTask('harness', async () => {
      const saved = await api!.saveHarness(input);
      await data.refresh();
      close();
      if (returnPage === 'library') apply.addHarness(saved.id);
      shell.setToast(`${saved.name} 已保存。`);
    });

  return { input, setInput, open, close, save };
}

export type HarnessEditor = ReturnType<typeof useHarnessEditor>;
