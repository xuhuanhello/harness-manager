import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { candidateGroup } from '../../shared/candidate-groups';
import { errorMessage } from '../../shared/errors';
import type { HarnessAPI } from '../../shared/ipc-contract';
import type { BatchResult, Skill, SkillUpdate, Source, UpdateCheck } from '../../shared/types';
import type { LibraryData } from './useLibraryData';
import type { Shell } from './useShell';

/** Opening the library re-checks only when the last check is older than this. */
const STALE_AFTER_MS = 30 * 60_000;

export type UpdateEntry = SkillUpdate & { skill: Skill; category: string };
export type UpdateSource = { source: Source; commit?: string; entries: UpdateEntry[]; missing: Skill[]; error?: string };

/** Skills an update selects by default: every applicable one without local edits. */
function defaultSelection(check: UpdateCheck): Set<string> {
  return new Set(
    check.sources.flatMap((source) => source.updates.filter((item) => !item.blocked && !item.localModified).map((item) => item.skillId)),
  );
}

/** Upstream update checks, the transient “可更新” view with its own selection, and applying updates. */
export function useUpdates(api: HarnessAPI | undefined, shell: Shell, data: LibraryData) {
  const { setToast, setDialog, runTask } = shell;
  const { snapshot } = data;
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const [viewing, setViewing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<BatchResult | null>(null);
  const lastCheckedAt = useRef(0);
  const pending = useRef(false);

  const sources = useMemo<UpdateSource[]>(() => {
    if (!check || !snapshot) return [];
    return check.sources.flatMap((status) => {
      const source = snapshot.sources.find((item) => item.id === status.sourceId);
      if (!source) return [];
      const entries = status.updates.flatMap((update) => {
        const skill = snapshot.skills.find((item) => item.id === update.skillId);
        return skill ? [{ ...update, skill, category: candidateGroup(skill.sourcePath) ?? '' }] : [];
      });
      const missing = status.missing.flatMap((id) => snapshot.skills.find((item) => item.id === id) ?? []);
      return entries.length || missing.length || status.error
        ? [{ source, commit: status.commit, entries, missing, error: status.error }]
        : [];
    });
  }, [check, snapshot]);

  const entries = useMemo(() => sources.flatMap((item) => item.entries), [sources]);
  const applicable = useMemo(() => entries.filter((entry) => !entry.blocked), [entries]);
  const applicableIds = useMemo(() => new Set(applicable.map((entry) => entry.skillId)), [applicable]);
  const selectedIds = useMemo(() => [...selected].filter((id) => applicableIds.has(id)), [selected, applicableIds]);
  const replacingModified = useMemo(
    () => applicable.filter((entry) => entry.localModified && selected.has(entry.skillId)),
    [applicable, selected],
  );
  const failures = useMemo(() => sources.filter((item) => item.error), [sources]);
  /** What the badge counts: updates the user can apply here. */
  const count = applicable.length;

  const runCheck = useCallback(
    async (manual: boolean) => {
      if (!api) return;
      pending.current = true;
      setChecking(true);
      try {
        const next = await api.checkUpdates();
        lastCheckedAt.current = Date.now();
        setCheck(next);
        setCheckError('');
        setSelected(defaultSelection(next));
        if (manual) {
          const found = next.sources.reduce((total, source) => total + source.updates.filter((item) => !item.blocked).length, 0);
          const failed = next.sources.filter((source) => source.error).length;
          setToast(
            found
              ? `发现 ${found} 个技能可更新${failed ? `；${failed} 个来源无法检查` : ''}。`
              : failed
                ? `${failed} 个来源无法检查，其余技能都已是最新版本。`
                : '所有技能都已是最新版本。',
          );
        }
      } catch (cause) {
        setCheckError(errorMessage(cause));
        if (manual) setToast(`检查更新失败：${errorMessage(cause)}`);
      } finally {
        pending.current = false;
        setChecking(false);
      }
    },
    [api, setToast],
  );

  /** Runs a quiet check when the library opens, unless a recent one is still fresh. */
  const checkIfStale = useCallback(() => {
    if (pending.current || Date.now() - lastCheckedAt.current < STALE_AFTER_MS) return;
    void runCheck(false);
  }, [runCheck]);

  useEffect(() => {
    if (viewing && !entries.length && !checking) setViewing(false);
  }, [viewing, entries.length, checking]);

  const toggleOne = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Selects all of `ids` unless they are all selected already, then clears them. */
  const toggleMany = (ids: string[]) =>
    setSelected((current) => {
      const unique = ids.filter((id) => applicableIds.has(id));
      const all = unique.length > 0 && unique.every((id) => current.has(id));
      const next = new Set(current);
      for (const id of unique) {
        if (all) next.delete(id);
        else next.add(id);
      }
      return next;
    });

  const openConfirm = () => {
    setResult(null);
    shell.setError('');
    setDialog('updates');
  };

  const apply = () =>
    runTask('updates', async () => {
      if (!api || !check || !selectedIds.length) return;
      const replaceModified = replacingModified.map((entry) => entry.skillId);
      const value = await api.applyUpdates({
        checkId: check.id,
        skillIds: selectedIds,
        ...(replaceModified.length ? { replaceModified } : {}),
      });
      setResult(value);
      const done = new Set(value.skillIds ?? []);
      setCheck(
        (current) =>
          current && {
            ...current,
            sources: current.sources.map((item) => ({ ...item, updates: item.updates.filter((update) => !done.has(update.skillId)) })),
          },
      );
      setSelected((current) => new Set([...current].filter((id) => !done.has(id))));
      await data.refresh();
    });

  const closeDialog = () => {
    if (shell.busy === 'updates') return;
    setDialog(null);
    setResult(null);
    // Nothing left to apply: go back to the library instead of showing an empty update list.
    if (result && !count) {
      setViewing(false);
      setToast('可用的更新都已完成。');
    }
  };

  const recheck = () => {
    closeDialog();
    void runCheck(true);
  };

  return {
    check,
    checking,
    checkError,
    lastCheckedAt: check ? new Date(check.checkedAt) : null,
    sources,
    entries,
    count,
    failures,
    viewing,
    open: () => setViewing(true),
    leave: () => setViewing(false),
    selected,
    selectedIds,
    replacingModified,
    toggleOne,
    toggleMany,
    result,
    runCheck,
    checkIfStale,
    openConfirm,
    apply,
    closeDialog,
    recheck,
  };
}

export type Updates = ReturnType<typeof useUpdates>;
