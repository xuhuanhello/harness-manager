import { Activity, CheckCheck, ChevronLeft, Command, MoreHorizontal, Plus } from 'lucide-react';
import type { Page } from '../view-types';

export function Topbar({
  page,
  title,
  menuOpen,
  setMenuOpen,
  onAddSource,
  onBeginSelection,
  onHealthCheck,
}: {
  page: Page;
  title: string;
  menuOpen: boolean;
  setMenuOpen: (update: (open: boolean) => boolean) => void;
  onAddSource: () => void;
  onBeginSelection: () => void;
  onHealthCheck: () => void;
}) {
  return (
    <header className="topbar">
      <div className="breadcrumbs">
        <span>Harness Manager</span>
        <ChevronLeft size={13} className="crumb-chevron" />
        <strong>{title}</strong>
      </div>
      <div className="topbar-actions">
        {page === 'library' && (
          <button className="button primary top-add" onClick={onAddSource}>
            <Plus size={16} />
            添加来源
          </button>
        )}
        <button
          className="icon-button top-more"
          aria-label="更多操作"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <MoreHorizontal size={19} />
        </button>
        {menuOpen && (
          <div className="action-menu" role="menu">
            {page === 'library' && (
              <button role="menuitem" onClick={onBeginSelection}>
                <CheckCheck size={15} />
                选择多个技能
              </button>
            )}
            <button
              role="menuitem"
              onClick={() => {
                setMenuOpen(() => false);
                onHealthCheck();
              }}
            >
              <Activity size={15} />
              检查安装健康
            </button>
            <div className="action-menu-note">
              <Command size={12} /> 搜索快捷键 ⌘K
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
