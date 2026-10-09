import { useState } from 'react';
import { errorMessage } from '../../shared/errors';
import type { HarnessAPI } from '../../shared/ipc-contract';
import type { BatchResult, ScanResult } from '../../shared/types';
import type { SourceInstallOptions } from '../view-types';
import type { GroupDraft } from './useGroupDraft';
import type { LibraryData } from './useLibraryData';
import type { LibraryView } from './useLibraryView';
import type { Shell } from './useShell';

/** Adding a source: scan a GitHub or local source, pick candidates, import them, then offer grouping. */
export function useSourceWizard(api: HarnessAPI | undefined, shell: Shell, data: LibraryData, view: LibraryView, groups: GroupDraft) {
  const { setBusy, setError, setDialog, busy } = shell;
  const [scanMode, setScanMode] = useState<'github' | 'local'>('github');
  const [sourceInput, setSourceInput] = useState('');
  const [sourceRef, setSourceRef] = useState('');
  const [sourceSubpath, setSourceSubpath] = useState('');
  const [scan, setScan] = useState<ScanResult | null>(null);
  const [candidateIds, setCandidateIds] = useState<Set<string>>(new Set());
  const [candidateSearch, setCandidateSearch] = useState('');
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
  const [createdDetectedGroups, setCreatedDetectedGroups] = useState(false);

  const openNew = () => {
    setError('');
    setScanMode('github');
    setScan(null);
    setBatchResult(null);
    setCandidateIds(new Set());
    setCandidateSearch('');
    setSourceInput('');
    setSourceRef('');
    setSourceSubpath('');
    setDialog('add-source');
  };

  const scanMarketplaceSource = async (source: string, skillId = '') => {
    if (!api || !source.trim()) return;
    const uri = source.trim();
    setError('');
    setScanMode('github');
    setSourceInput(uri);
    setSourceRef('');
    setSourceSubpath('');
    setScan(null);
    setBatchResult(null);
    setCandidateIds(new Set());
    setCandidateSearch(skillId);
    setDialog('add-source');
    setBusy('scan');
    try {
      setScan(await api.scan({ uri }));
    } catch (cause) {
      setScan(null);
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  };

  const changeMode = (nextMode: 'github' | 'local') => {
    setScanMode(nextMode);
    if (nextMode === 'local') {
      setSourceRef('');
      setSourceSubpath('');
    }
    setScan(null);
    setCandidateSearch('');
  };

  const browse = async () => {
    const path = await api?.chooseDirectory();
    if (path) {
      setSourceInput(path);
      setScan(null);
    }
  };

  const runScan = async () => {
    setBusy('scan');
    setError('');
    setScan(null);
    setCandidateIds(new Set());
    try {
      const value = await api!.scan({
        uri: sourceInput.trim(),
        ...(scanMode === 'github' && sourceRef.trim() ? { ref: sourceRef.trim() } : {}),
        ...(scanMode === 'github' && sourceSubpath.trim() ? { subpath: sourceSubpath.trim() } : {}),
      });
      setScan(value);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  };

  const install = async ({ createDetectedGroups, customGroupName, mergeExistingGroups }: SourceInstallOptions) => {
    if (!scan) return;
    await shell.runTask('install', async () => {
      const value = await api!.install({
        scanId: scan.id,
        candidateIds: [...candidateIds],
        ...(createDetectedGroups ? { createDetectedGroups } : {}),
        ...(customGroupName !== undefined ? { customGroupName } : {}),
        ...(mergeExistingGroups ? { mergeExistingGroups } : {}),
      });
      setCreatedDetectedGroups(!!createDetectedGroups || !!customGroupName?.trim());
      setBatchResult(value);
      await data.refresh();
    });
  };

  const close = () => {
    if (busy === 'scan' || busy === 'install') return;
    setDialog(null);
    setScan(null);
    setBatchResult(null);
  };

  /** Closes the results and offers grouping unless the import already grouped the new skills. */
  const finish = () => {
    if (!batchResult) return;
    const successes = batchResult.items.filter((item) => item.status === 'success');
    const ids = batchResult.skillIds ?? successes.map((item) => item.id);
    setDialog(null);
    setScan(null);
    setBatchResult(null);
    setSourceInput('');
    view.setSelected(new Set());
    view.setSelectMode(false);
    void data.refresh();
    if (ids.length && !createdDetectedGroups) groups.openOnboarding(ids);
  };

  return {
    scanMode,
    sourceInput,
    setSourceInput,
    sourceRef,
    setSourceRef,
    sourceSubpath,
    setSourceSubpath,
    scan,
    setScan,
    candidateIds,
    setCandidateIds,
    candidateSearch,
    setCandidateSearch,
    batchResult,
    openNew,
    scanMarketplaceSource,
    changeMode,
    browse,
    runScan,
    install,
    close,
    finish,
  };
}

export type SourceWizardState = ReturnType<typeof useSourceWizard>;
