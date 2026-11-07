import { harnessDisplayName } from '../../shared/harness-registry';
import { useT, useLocalePreference, useSystemLocale } from '../i18n';
import { useAppInfo } from './useAppInfo';
import { fileManagerLabels } from '../file-manager';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { errorMessage } from '../../shared/errors';
import { isHarnessEnabled } from '../../shared/harness-enabled';
import type { HarnessAPI } from '../../shared/ipc-contract';
import type { Settings, Snapshot, ViewMode } from '../../shared/types';
import type { Shell } from './useShell';

/** The library snapshot from the main process, a view of it limited to enabled Harnesses, and saved preferences. */
export function useLibraryData(api: HarnessAPI | undefined, shell: Shell) {
  const t = useT();
  const setLocalePreference = useLocalePreference();
  const setSystemLocale = useSystemLocale();
  const appInfo = useAppInfo();
  useEffect(() => {
    if (appInfo?.systemLocale) setSystemLocale(appInfo.systemLocale);
  }, [appInfo?.systemLocale, setSystemLocale]);
  const fileManager = fileManagerLabels(useAppInfo()?.platform);
  const { setError, setToast, setBusy } = shell;
  const [storedSnapshot, setAllSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);

  const allSnapshot = useMemo(
    () =>
      storedSnapshot
        ? {
            ...storedSnapshot,
            harnesses: storedSnapshot.harnesses.map((harness) => ({ ...harness, name: harnessDisplayName(harness, t) })),
          }
        : null,
    [storedSnapshot, t],
  );

  const snapshot = useMemo<Snapshot | null>(() => {
    if (!allSnapshot) return null;
    const harnesses = allSnapshot.harnesses.filter(isHarnessEnabled);
    const active = new Set(harnesses.map((item) => item.id));
    const bindings = allSnapshot.bindings.filter((item) => active.has(item.harnessId));
    const bindingIds = new Set(bindings.map((item) => item.id));
    const intents = allSnapshot.intents.filter((item) => bindingIds.has(item.bindingId));
    const visibleManagedSkills = allSnapshot.visibleManagedSkills?.filter((item) => active.has(item.harnessId));
    const visibleDistributionIds = new Set(visibleManagedSkills?.map((item) => item.distributionId));
    const targetIds = new Set(bindings.map((item) => item.targetId));
    return {
      ...allSnapshot,
      harnesses,
      bindings,
      intents,
      visibleManagedSkills,
      distributions: allSnapshot.distributions.filter((item) => targetIds.has(item.targetId) || visibleDistributionIds.has(item.id)),
      externalSkills: allSnapshot.externalSkills.filter((item) => active.has(item.harnessId)),
      visibleExternalSkills: allSnapshot.visibleExternalSkills?.filter((item) => active.has(item.harnessId)),
    };
  }, [allSnapshot]);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const next = await api.snapshot();
      setLocalePreference(next.settings.locale);
      setAllSnapshot(next);
      setError('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [api, setError, setLocalePreference]);

  useEffect(() => {
    void refresh();
    if (!api) return;
    return api.onChanged(() => {
      void refresh();
    });
  }, [api, refresh]);

  const retry = () => {
    setLoading(true);
    void refresh();
  };

  /** Shows a settings change at once; the full (unfiltered) snapshot keeps every Harness. */
  const patchSettings = (patch: Partial<Settings>) =>
    setAllSnapshot((current) => (current ? { ...current, settings: { ...current.settings, ...patch } } : current));

  const setLocale = async (locale: Settings['locale']) => {
    if (!api || !allSnapshot) return;
    const previous = allSnapshot.settings.locale;
    patchSettings({ locale });
    try {
      await api.saveSettings({ locale });
      setLocalePreference(locale);
    } catch (cause) {
      patchSettings({ locale: previous });
      setToast(errorMessage(cause));
    }
  };

  const setMode = async (mode: ViewMode) => {
    if (!snapshot || mode === snapshot.settings.viewMode) return;
    const settings: Partial<Settings> = { viewMode: mode };
    patchSettings(settings);
    try {
      await api?.saveSettings(settings);
    } catch (cause) {
      setToast(t('library.couldNotSaveViewPreference', { reason: errorMessage(cause) }));
      void refresh();
    }
  };

  const setActiveTab = async (mode: ViewMode, tab: string) => {
    if (!snapshot) return;
    const activeTabs = { ...snapshot.settings.activeTabs, [mode]: tab };
    patchSettings({ activeTabs });
    try {
      await api?.saveSettings({ activeTabs });
    } catch (cause) {
      setToast(t('library.couldNotSaveTabPreference', { reason: errorMessage(cause) }));
    }
  };

  const setActiveMarketplace = async (marketplaceId: string) => {
    if (!snapshot || snapshot.settings.activeTabs.marketplace === marketplaceId) return;
    const activeTabs = { ...snapshot.settings.activeTabs, marketplace: marketplaceId };
    patchSettings({ activeTabs });
    try {
      await api?.saveSettings({ activeTabs });
    } catch (cause) {
      setToast(t('library.couldNotSaveMarketplaceSelection', { reason: errorMessage(cause) }));
      void refresh();
    }
  };

  const marketplaces = snapshot?.marketplaces ?? [];
  const defaultMarketplace = marketplaces.find((marketplace) => marketplace.id === 'skills-sh') ?? marketplaces[0];
  const activeMarketplace =
    marketplaces.find((marketplace) => marketplace.id === snapshot?.settings.activeTabs.marketplace) ?? defaultMarketplace;

  useEffect(() => {
    if (!snapshot || !defaultMarketplace) return;
    const selectedId = snapshot.settings.activeTabs.marketplace;
    if (selectedId && snapshot.marketplaces.some((marketplace) => marketplace.id === selectedId)) return;
    void setActiveMarketplace(defaultMarketplace.id);
  }, [snapshot?.marketplaces, snapshot?.settings.activeTabs, defaultMarketplace?.id]);

  const runHealthCheck = async () => {
    if (!api) return;
    setBusy('health');
    try {
      await api.checkHealth();
      await refresh();
      setToast(t('library.installationCheckCompleted'));
    } catch (cause) {
      setToast(t('library.checkFailed', { reason: errorMessage(cause) }));
    } finally {
      setBusy('');
    }
  };

  const openSkillWebpage = async (skillId: string) => {
    try {
      await api?.openSkillSource({ skillId });
    } catch (cause) {
      setToast(t('library.couldNotOpenSkillWebpage', { reason: errorMessage(cause) }));
    }
  };

  const reveal = async (request: () => Promise<void> | undefined) => {
    try {
      await request();
    } catch (cause) {
      setToast(fileManager.skillError(errorMessage(cause)));
    }
  };
  const revealSkillDirectory = (skillId: string) => reveal(() => api?.revealSkill({ skillId }));
  const revealExternalSkill = (externalSkillId: string) => reveal(() => api?.revealExternalSkill({ externalSkillId }));
  const revealDistribution = (distributionId: string) => reveal(() => api?.revealDistribution({ distributionId }));

  return {
    allSnapshot,
    setAllSnapshot,
    snapshot,
    loading,
    refresh,
    retry,
    patchSettings,
    setMode,
    setLocale,
    setActiveTab,
    setActiveMarketplace,
    activeMarketplace,
    runHealthCheck,
    openSkillWebpage,
    revealSkillDirectory,
    revealExternalSkill,
    revealDistribution,
  };
}

export type LibraryData = ReturnType<typeof useLibraryData>;
