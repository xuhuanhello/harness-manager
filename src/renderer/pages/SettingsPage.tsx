import { useT } from '../i18n';
import { useAppInfo } from '../hooks/useAppInfo';
import { Activity, Check, CircleHelp, Clock3, HardDrive, LoaderCircle, Plus, ShieldCheck, Store } from 'lucide-react';
import HarnessSettingsPanel from '../components/HarnessSettingsPanel';
import type { Harness, Marketplace, Snapshot, ViewMode } from '../../shared/types';
import { modeItems } from '../format';
import { AppUpdateSettings } from '../components/AppUpdate';
import type { AppUpdateController } from '../hooks/useAppUpdate';

export function SettingsPage({
  snapshot,
  onCreate,
  onEdit,
  onMarketplaceCreate,
  onMarketplaceEdit,
  onMarketplaceRemove,
  onHealth,
  busy,
  onViewMode,
  onLocale,
  appUpdate,
  onAutoCheck,
}: {
  snapshot: Snapshot;
  onCreate: () => void;
  onEdit: (harness: Harness) => void;
  onMarketplaceCreate: () => void;
  onMarketplaceEdit: (marketplace: Marketplace) => void;
  onMarketplaceRemove: (marketplace: Marketplace) => void;
  onHealth: () => void;
  busy: string;
  onViewMode: (mode: ViewMode) => void;
  onLocale: (locale: Snapshot['settings']['locale']) => void;
  appUpdate: AppUpdateController;
  onAutoCheck: (value: boolean) => void;
}) {
  const t = useT();
  const appInfo = useAppInfo();
  return (
    <div className="settings-page">
      <AppUpdateSettings update={appUpdate} autoCheck={snapshot.settings.appUpdates?.autoCheck ?? true} onAutoCheck={onAutoCheck} />
      <section className="settings-section">
        <div className="settings-section-heading">
          <div>
            <h2>{t('settings.language')}</h2>
            <p>{t('settings.languageDescription')}</p>
          </div>
        </div>
        <select
          className="form-input"
          aria-label={t('settings.language')}
          data-testid="language-select"
          value={snapshot.settings.locale}
          onChange={(event) => onLocale(event.target.value as Snapshot['settings']['locale'])}
        >
          <option value="system">{t('settings.followSystem')}</option>
          <option value="zh-CN">{t('settings.simplifiedChinese')}</option>
          <option value="en">English</option>
        </select>
      </section>
      <section className="settings-section">
        <div className="settings-section-heading">
          <div>
            <h2>{t('settings.defaultView')}</h2>
            <p>{t('settings.chooseTheViewUsedWhenOpeningTheSkillLibrary')}</p>
          </div>
          <div className="settings-badge">
            <Clock3 size={13} />
            {t('settings.saved')}
          </div>
        </div>
        <div className="preference-options">
          {modeItems().map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={`preference-option ${snapshot.settings.viewMode === item.id ? 'active' : ''}`}
                onClick={() => onViewMode(item.id)}
              >
                <span className="preference-icon">
                  <Icon size={16} />
                </span>
                <span>
                  <strong>{item.label}</strong>
                  <small>
                    {item.id === 'source'
                      ? t('settings.whereSkillsWereImportedFrom')
                      : item.id === 'harness'
                        ? t('settings.userInstallationsInEachHarness')
                        : item.id === 'group'
                          ? t('settings.topicsAndCollections')
                          : t('settings.allSkillsInOnePlace')}
                  </small>
                </span>
                {snapshot.settings.viewMode === item.id && (
                  <span className="preference-check">
                    <Check size={13} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-section-heading">
          <div>
            <h2>{t('settings.marketplaceSources')}</h2>
            <p>{t('settings.manageWebsiteLinksUnderMarketplaceInTheSidebar')}</p>
          </div>
          <button className="button subtle" data-testid="add-marketplace" onClick={onMarketplaceCreate}>
            <Plus size={15} />
            {t('settings.addMarketplace')}
          </button>
        </div>
        <div className="marketplace-settings-list">
          {snapshot.marketplaces.map((marketplace) => (
            <div className="marketplace-settings-row" data-testid="marketplace-source-row" key={marketplace.id}>
              <span className="marketplace-settings-icon">
                <Store size={15} />
              </span>
              <div className="marketplace-settings-main">
                <strong>
                  {marketplace.name}
                  <span className={`custom-pill ${marketplace.origin === 'builtin' ? 'builtin-pill' : ''}`}>
                    {marketplace.origin === 'builtin' ? t('settings.builtIn') : t('settings.custom')}
                  </span>
                </strong>
                <code title={marketplace.url}>{marketplace.url}</code>
              </div>
              {marketplace.origin === 'custom' && (
                <div className="marketplace-settings-actions">
                  <button
                    className="button subtle compact"
                    aria-label={t('settings.edit', { name: marketplace.name })}
                    onClick={() => onMarketplaceEdit(marketplace)}
                  >
                    {t('settings.editAction')}
                  </button>
                  <button
                    className="button subtle compact marketplace-delete-button"
                    aria-label={t('settings.delete', { name: marketplace.name })}
                    onClick={() => onMarketplaceRemove(marketplace)}
                  >
                    {t('settings.deleteAction')}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        <p className="settings-footnote">
          <ShieldCheck size={14} />
          {t('settings.builtInMarketplacesAreAlwaysAvailableAddedUrlsOpenIn')}
        </p>
      </section>
      <HarnessSettingsPanel harnesses={snapshot.harnesses} onCreate={onCreate} onEdit={onEdit} />
      <section className="settings-section library-settings">
        <div className="settings-section-heading">
          <div>
            <h2>{t('settings.skillLibrary')}</h2>
            <p>{t('settings.skillFilesAndManagementDataAreStoredHere')}</p>
          </div>
          <button className="button subtle" onClick={onHealth} disabled={busy === 'health'}>
            {busy === 'health' ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}
            {t('settings.checkInstallations')}
          </button>
        </div>
        <div className="library-path-card">
          <div className="library-path-icon">
            <HardDrive size={17} />
          </div>
          <div>
            <strong>{snapshot.libraryRoot}</strong>
            <span>{t('settings.localLibrarySqliteDataAndSkillFiles')}</span>
          </div>
          <span className="path-state">
            <span className="tiny-status" />
            {t('settings.available')}
          </span>
        </div>
        <div className="settings-footnote">
          <CircleHelp size={14} />
          {t('settings.libraryRelocationAndBackupExportArePlannedForAFuture')}
        </div>
      </section>
      <footer className="settings-footer">
        <span>Harness Manager</span>
        <span>{t('settings.versionLabel', { version: appInfo ? `v${appInfo.version}` : '…' })}</span>
      </footer>
    </div>
  );
}
