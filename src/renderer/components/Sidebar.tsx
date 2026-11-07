import { useT } from '../i18n';
import { useAppInfo } from '../hooks/useAppInfo';
import { ArrowRight, Boxes, FolderOpen, HardDrive, LibraryBig, Settings2, Store } from 'lucide-react';
import type { Marketplace, Snapshot } from '../../shared/types';
import type { Page } from '../view-types';
import { AppUpdateFooter } from './AppUpdate';
import type { AppUpdateController } from '../hooks/useAppUpdate';

export function Sidebar({
  snapshot,
  page,
  activeMarketplaceId,
  updateCount,
  onNavigate,
  onSelectMarketplace,
  appUpdate,
}: {
  snapshot: Snapshot;
  page: Page;
  activeMarketplaceId?: string;
  updateCount: number;
  onNavigate: (page: Page) => void;
  onSelectMarketplace: (marketplace: Marketplace) => void;
  appUpdate: AppUpdateController;
}) {
  const t = useT();
  const appInfo = useAppInfo();
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <Boxes size={19} />
        </div>
        <div>
          <strong>Harness</strong>
          <span>MANAGER</span>
        </div>
      </div>
      <div className="sidebar-label">{t('library.sidebarWorkspace')}</div>
      <nav className="main-nav" aria-label={t('library.mainNavigation')}>
        <button className={`nav-item ${page === 'library' ? 'active' : ''}`} onClick={() => onNavigate('library')}>
          <LibraryBig size={17} />
          <span>{t('library.skillLibrary')}</span>
          {updateCount > 0 && (
            <span className="nav-update-dot" title={t('library.skillsHaveUpdates', { updateCount: updateCount })} aria-hidden="true" />
          )}
          <span className={`nav-count ${updateCount > 0 ? 'with-dot' : ''}`}>{snapshot.skills.length}</span>
        </button>
        <button className={`nav-item ${page === 'agent-harness' ? 'active' : ''}`} onClick={() => onNavigate('agent-harness')}>
          <Boxes size={17} />
          <span>Agent Harness</span>
        </button>
        <button className={`nav-item ${page === 'workspaces' ? 'active' : ''}`} onClick={() => onNavigate('workspaces')}>
          <FolderOpen size={17} />
          <span>{t('library.workspaces')}</span>
          <span className="nav-count">{snapshot.workspaces.length}</span>
        </button>
      </nav>
      <div className="sidebar-label sidebar-label-spaced">{t('library.marketplace')}</div>
      <nav className="main-nav sidebar-market-nav" aria-label={t('library.skillMarketplace')}>
        {snapshot.marketplaces.map((marketplace) => {
          const active = page === 'marketplace' && activeMarketplaceId === marketplace.id;
          return (
            <button
              key={marketplace.id}
              title={marketplace.name}
              aria-label={marketplace.name}
              aria-current={active ? 'page' : undefined}
              className={`nav-item ${active ? 'active' : ''}`}
              onClick={() => onSelectMarketplace(marketplace)}
            >
              <Store size={17} />
              <span>{marketplace.name}</span>
              {marketplace.origin === 'custom' && (
                <span className="nav-custom-dot" aria-hidden="true">
                  •
                </span>
              )}
            </button>
          );
        })}
      </nav>
      <div className="sidebar-label sidebar-label-spaced">{t('library.manage')}</div>
      <nav className="main-nav" aria-label={t('library.manage')}>
        <button className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => onNavigate('settings')}>
          <Settings2 size={17} />
          <span>{t('library.settings')}</span>
        </button>
      </nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-library">
        <div className="sidebar-library-icon">
          <HardDrive size={15} />
        </div>
        <div className="sidebar-library-copy">
          <span>{t('library.libraryLocation')}</span>
          <strong title={snapshot.libraryRoot}>{snapshot.libraryRoot.split(/[\\/]/).slice(-2).join('/') || snapshot.libraryRoot}</strong>
        </div>
        <button className="icon-button small" aria-label={t('library.openSettings')} onClick={() => onNavigate('settings')}>
          <ArrowRight size={14} />
        </button>
      </div>
      <div className="sidebar-footer">
        <span className="online-dot" />
        {t('library.runningLocally')}
        <span className="footer-version">
          {['idle', 'checking', 'upToDate'].includes(appUpdate.state.status) ? (
            appInfo ? (
              `v${appInfo.version}`
            ) : (
              '…'
            )
          ) : (
            <AppUpdateFooter update={appUpdate} />
          )}
        </span>
      </div>
    </aside>
  );
}
