import { ArrowRight, Boxes, FolderOpen, HardDrive, LibraryBig, Settings2, Store } from 'lucide-react';
import type { Marketplace, Snapshot } from '../../shared/types';
import type { Page } from '../view-types';

export function Sidebar({
  snapshot,
  page,
  activeMarketplaceId,
  updateCount,
  onNavigate,
  onSelectMarketplace,
}: {
  snapshot: Snapshot;
  page: Page;
  activeMarketplaceId?: string;
  updateCount: number;
  onNavigate: (page: Page) => void;
  onSelectMarketplace: (marketplace: Marketplace) => void;
}) {
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
      <div className="sidebar-label">工作台</div>
      <nav className="main-nav" aria-label="主导航">
        <button className={`nav-item ${page === 'library' ? 'active' : ''}`} onClick={() => onNavigate('library')}>
          <LibraryBig size={17} />
          <span>中央技能库</span>
          {updateCount > 0 && <span className="nav-update-dot" title={`${updateCount} 个技能可更新`} aria-hidden="true" />}
          <span className={`nav-count ${updateCount > 0 ? 'with-dot' : ''}`}>{snapshot.skills.length}</span>
        </button>
        <button className={`nav-item ${page === 'agent-harness' ? 'active' : ''}`} onClick={() => onNavigate('agent-harness')}>
          <Boxes size={17} />
          <span>Agent Harness</span>
        </button>
        <button className={`nav-item ${page === 'workspaces' ? 'active' : ''}`} onClick={() => onNavigate('workspaces')}>
          <FolderOpen size={17} />
          <span>工作区</span>
          <span className="nav-count">{snapshot.workspaces.length}</span>
        </button>
      </nav>
      <div className="sidebar-label sidebar-label-spaced">市场</div>
      <nav className="main-nav sidebar-market-nav" aria-label="技能市场">
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
      <div className="sidebar-label sidebar-label-spaced">管理</div>
      <nav className="main-nav" aria-label="管理">
        <button className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => onNavigate('settings')}>
          <Settings2 size={17} />
          <span>设置</span>
        </button>
      </nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-library">
        <div className="sidebar-library-icon">
          <HardDrive size={15} />
        </div>
        <div className="sidebar-library-copy">
          <span>技能库位置</span>
          <strong title={snapshot.libraryRoot}>{snapshot.libraryRoot.split(/[\\/]/).slice(-2).join('/') || snapshot.libraryRoot}</strong>
        </div>
        <button className="icon-button small" aria-label="打开设置" onClick={() => onNavigate('settings')}>
          <ArrowRight size={14} />
        </button>
      </div>
      <div className="sidebar-footer">
        <span className="online-dot" />
        本机运行 <span className="footer-version">M1</span>
      </div>
    </aside>
  );
}
