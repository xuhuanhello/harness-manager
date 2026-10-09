import { useCallback, useState } from 'react';
import { errorMessage } from '../../shared/errors';
import type { HarnessAPI } from '../../shared/ipc-contract';
import type { Marketplace, MarketplaceCatalog, MarketplaceCatalogRequest } from '../../shared/types';
import type { LibraryData } from './useLibraryData';
import type { Shell } from './useShell';

/** Marketplace pages, their catalog search input, and adding, editing or removing custom marketplaces. */
export function useMarketplaceSettings(api: HarnessAPI | undefined, shell: Shell, data: LibraryData) {
  const { setBusy, setDialog, setToast } = shell;
  const [input, setInput] = useState('');
  const [pageError, setPageError] = useState('');
  const [catalogActionError, setCatalogActionError] = useState('');
  const [draft, setDraft] = useState<{ id?: string; name: string; url: string }>({ name: '', url: '' });
  const [formError, setFormError] = useState('');
  const [toRemove, setToRemove] = useState<Marketplace | null>(null);

  const loadCatalog = useCallback(
    (request: MarketplaceCatalogRequest): Promise<MarketplaceCatalog> => {
      if (!api) return Promise.reject(new Error('桌面应用连接不可用。'));
      return api.marketplaceCatalog(request);
    },
    [api],
  );

  /** Opens a marketplace page from the sidebar; switching marketplaces clears the previous one's input and errors. */
  const select = (marketplace: Marketplace) => {
    if (data.activeMarketplace?.id !== marketplace.id) {
      setInput('');
      setPageError('');
      setCatalogActionError('');
    }
    shell.setPage('marketplace');
    void data.setActiveMarketplace(marketplace.id);
  };

  /** Opens the marketplace website; failures show on the catalog or on the plain page. */
  const openWebsite = async (marketplaceId: string, surface: 'catalog' | 'page') => {
    const setSurfaceError = surface === 'catalog' ? setCatalogActionError : setPageError;
    setBusy('marketplace');
    setSurfaceError('');
    try {
      await api?.openMarketplace({ marketplaceId });
    } catch (cause) {
      setSurfaceError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  };

  /** Opens one catalog skill's page on its marketplace website; failures show on the catalog. */
  const openSkillPage = async (marketplaceId: 'skills-sh' | 'skillsmp', url: string) => {
    setCatalogActionError('');
    try {
      await api?.openMarketplaceSkill({ marketplaceId, url });
    } catch (cause) {
      setCatalogActionError(errorMessage(cause));
    }
  };

  const openForm = (marketplace?: Marketplace) => {
    setDraft(marketplace ? { id: marketplace.id, name: marketplace.name, url: marketplace.url } : { name: '', url: 'https://' });
    setFormError('');
    setDialog('marketplace-form');
  };

  const closeForm = () => {
    setFormError('');
    setDialog(null);
  };

  const save = async () => {
    const name = draft.name.trim();
    let url: URL;
    try {
      url = new URL(draft.url.trim());
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error();
    } catch {
      setFormError('请输入有效的 HTTP 或 HTTPS 网站地址。');
      return;
    }
    if (!name) {
      setFormError('请输入市场名称。');
      return;
    }
    setBusy('marketplace-save');
    setFormError('');
    try {
      const saved = await api?.saveMarketplace({ ...(draft.id ? { id: draft.id } : {}), name, url: url.href });
      if (!saved) throw new Error('桌面应用连接不可用。');
      const activeTabs = { ...data.snapshot!.settings.activeTabs, marketplace: saved.id };
      await api?.saveSettings({ activeTabs });
      data.patchSettings({ activeTabs });
      setDialog(null);
      setToast(`${saved.name} 已保存。`);
      await data.refresh();
    } catch (cause) {
      setFormError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  };

  const askRemove = (marketplace: Marketplace) => {
    setFormError('');
    setToRemove(marketplace);
    setDialog('marketplace-remove');
  };

  const closeRemove = () => {
    setFormError('');
    setToRemove(null);
    setDialog(null);
  };

  const confirmRemove = async () => {
    if (!api || !toRemove || toRemove.origin !== 'custom') return;
    setBusy('marketplace-delete');
    setFormError('');
    try {
      const removedId = toRemove.id;
      await api.deleteMarketplace(removedId);
      const next = await api.snapshot();
      if (next.settings.activeTabs.marketplace === removedId) {
        const fallback = next.marketplaces.find((marketplace) => marketplace.id === 'skills-sh') ?? next.marketplaces[0];
        if (fallback) {
          const activeTabs = { ...next.settings.activeTabs, marketplace: fallback.id };
          await api.saveSettings({ activeTabs });
          next.settings.activeTabs = activeTabs;
        }
      }
      data.setAllSnapshot(next);
      setDialog(null);
      setToRemove(null);
      setToast(`${toRemove.name} 已删除。`);
    } catch (cause) {
      setFormError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  };

  return {
    input,
    setInput,
    pageError,
    setPageError,
    catalogActionError,
    draft,
    setDraft,
    formError,
    setFormError,
    toRemove,
    loadCatalog,
    select,
    openWebsite,
    openSkillPage,
    openForm,
    closeForm,
    save,
    askRemove,
    closeRemove,
    confirmRemove,
  };
}

export type MarketplaceSettings = ReturnType<typeof useMarketplaceSettings>;
