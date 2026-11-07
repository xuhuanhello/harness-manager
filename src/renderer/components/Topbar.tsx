import { useT } from '../i18n';
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
  const t = useT();
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
            {t('library.addSource')}
          </button>
        )}
        <button
          className="icon-button top-more"
          aria-label={t('library.moreActions')}
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
                {t('library.selectMultipleSkills')}
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
              {t('library.checkInstallationHealth')}
            </button>
            <div className="action-menu-note">
              <Command size={12} /> {t('library.searchShortcutK')}
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
