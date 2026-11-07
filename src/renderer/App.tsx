import { useT } from './i18n';
import { useEffect } from 'react';
import { Boxes, Check, CircleHelp, LoaderCircle, ShieldCheck, X } from 'lucide-react';
import MarketplaceCatalog, { type CatalogMarketplaceId } from './components/MarketplaceCatalog';
import { PageHeading, PageNotices, pageTitle } from './components/PageHeading';
import { SelectionDock } from './components/SelectionDock';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { UpdateDock } from './components/UpdatesView';
import { ApplyDialog } from './dialogs/ApplyDialog';
import { MigrationDialog, RemoveDialog } from './dialogs/HarnessDialogs';
import { OnboardingDialog, SelectedDialog, SourceDialog } from './dialogs/LibraryDialogs';
import { HarnessFormDialog, MarketplaceFormDialog, MarketplaceRemoveDialog } from './dialogs/SettingsDialogs';
import { UpdateDialog } from './dialogs/UpdateDialog';
import { useApplyFlow } from './hooks/useApplyFlow';
import { useGroupDraft } from './hooks/useGroupDraft';
import { useHarnessEditor } from './hooks/useHarnessEditor';
import { useLibraryData } from './hooks/useLibraryData';
import { useLibraryView } from './hooks/useLibraryView';
import { useMarketplaceSettings } from './hooks/useMarketplaceSettings';
import { useMigrationFlow } from './hooks/useMigrationFlow';
import { useShell } from './hooks/useShell';
import { useSourceWizard } from './hooks/useSourceWizard';
import { useUpdates } from './hooks/useUpdates';
import { useWorkspaceFlow } from './hooks/useWorkspaceFlow';
import { AgentHarnessPage } from './pages/AgentHarnessPage';
import { LibraryPage } from './pages/LibraryPage';
import { MarketplacePage } from './pages/MarketplacePage';
import { SettingsPage } from './pages/SettingsPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { planHarnessRemoval } from './removal-plan';
import { useAppUpdate } from './hooks/useAppUpdate';
import { AppUpdateDialog } from './components/AppUpdate';

const CATALOG_MARKETPLACES = ['skills-sh', 'skillsmp'];

function App() {
  const t = useT();
  const api = typeof window !== 'undefined' ? window.harness : undefined;
  const shell = useShell();
  const data = useLibraryData(api, shell);
  const { snapshot, allSnapshot, activeMarketplace } = data;
  const view = useLibraryView(snapshot, data, shell);
  const groups = useGroupDraft(api, shell, data);
  const wizard = useSourceWizard(api, shell, data, view, groups);
  const apply = useApplyFlow(api, shell, data, view, groups);
  const harnessEditor = useHarnessEditor(api, shell, data, apply);
  const migration = useMigrationFlow(api, shell, data);
  const market = useMarketplaceSettings(api, shell, data);
  const workspace = useWorkspaceFlow(api, shell, data, view);
  const updates = useUpdates(api, shell, data);
  const appUpdate = useAppUpdate(api);
  const { page, setPage, dialog, busy, error, setError, toast, setToast } = shell;
  const { checkIfStale } = updates;

  useEffect(() => {
    if (page === 'library') checkIfStale();
  }, [page, checkIfStale]);

  if (!api) {
    return (
      <div className="bridge-screen">
        <div className="bridge-card">
          <div className="brand-mark">
            <Boxes size={21} />
          </div>
          <p className="eyebrow">HARNESS MANAGER</p>
          <h1>{t('app.desktopConnectionRequired')}</h1>
          <p>{t('app.openThisPageInHarnessManagerToAccessSourceRepositories')}</p>
          <div className="bridge-line">
            <ShieldCheck size={16} /> {t('app.localFileOperationsRunInTheElectronMainProcess')}
          </div>
        </div>
      </div>
    );
  }

  if (data.loading && !snapshot)
    return (
      <div className="loading-screen">
        <LoaderCircle className="spin" size={24} />
        <span>{t('app.connectingToLibrary')}</span>
      </div>
    );
  if (!snapshot || !allSnapshot)
    return (
      <div className="loading-screen">
        <div className="error-card">
          <CircleHelp size={22} />
          <h2>{t('app.couldNotLoadLibrary')}</h2>
          <p>{error || t('app.checkTheAppAndTryAgain')}</p>
          <button className="button primary" onClick={data.retry}>
            {t('app.reconnect')}
          </button>
        </div>
      </div>
    );

  const removalPlan = planHarnessRemoval(allSnapshot, view.harnessId, view.selected);
  const harnessName = snapshot.harnesses.find((harness) => harness.id === view.harnessId)?.name || 'Harness';

  const pickSkillsToApply = (message: string) => {
    setPage('library');
    view.setSelectMode(true);
    setToast(message);
  };
  const scanFromMarketplace = (source: string, skillId?: string) => {
    market.setPageError('');
    void wizard.scanMarketplaceSource(source, skillId);
  };

  return (
    <div className="app-shell">
      <Sidebar
        appUpdate={appUpdate}
        snapshot={snapshot}
        page={page}
        activeMarketplaceId={activeMarketplace?.id}
        updateCount={updates.count}
        onNavigate={setPage}
        onSelectMarketplace={market.select}
      />

      <main className="main-panel">
        <Topbar
          page={page}
          title={pageTitle(page, activeMarketplace)}
          menuOpen={shell.menuOpen}
          setMenuOpen={shell.setMenuOpen}
          onAddSource={wizard.openNew}
          onBeginSelection={view.beginSelection}
          onHealthCheck={() => void data.runHealthCheck()}
        />

        <div className="page-scroll" onClick={() => shell.menuOpen && shell.setMenuOpen(false)}>
          <PageNotices snapshot={snapshot} error={error} onDismissError={() => setError('')} />
          <PageHeading page={page} snapshot={snapshot} marketplace={activeMarketplace} />

          {page === 'library' && (
            <LibraryPage
              snapshot={snapshot}
              view={view}
              data={data}
              updates={updates}
              onNavigate={setPage}
              onAddSource={() => {
                setError('');
                shell.setDialog('add-source');
              }}
              onLeaveSelection={workspace.leaveSelection}
              onPickSkillsToApply={pickSkillsToApply}
            />
          )}

          {page === 'agent-harness' && (
            <AgentHarnessPage
              snapshot={snapshot}
              busy={busy}
              onMigrate={migration.open}
              onRevealExternal={data.revealExternalSkill}
              onRevealDistribution={data.revealDistribution}
              onApply={() => pickSkillsToApply(t('app.selectLibrarySkillsToApplyThemToAHarness'))}
              onOpenWorkspaces={() => setPage('workspaces')}
              onManageLibrary={async (harnessId) => {
                updates.leave();
                view.setSearch('');
                await data.setMode('harness');
                await data.setActiveTab('harness', harnessId);
                setPage('library');
                view.beginSelection();
                setToast(t('app.selectSkillsOrSectionsToUnapplyThemBelow'));
              }}
              onManageWorkspace={(path) => {
                workspace.setSelectedPath(path);
                setPage('workspaces');
              }}
            />
          )}

          {page === 'marketplace' && activeMarketplace && CATALOG_MARKETPLACES.includes(activeMarketplace.id) && (
            <MarketplaceCatalog
              key={activeMarketplace.id}
              marketplace={activeMarketplace}
              input={market.input}
              onInput={market.setInput}
              actionError={market.catalogActionError}
              loadCatalog={market.loadCatalog}
              onImportSkill={(source, skillId) => scanFromMarketplace(source, skillId)}
              onImportSource={(source) => scanFromMarketplace(source)}
              onOpen={() => market.openWebsite(activeMarketplace.id, 'catalog')}
              onOpenSkill={(url) => market.openSkillPage(activeMarketplace.id as CatalogMarketplaceId, url)}
              opening={busy === 'marketplace'}
            />
          )}

          {page === 'marketplace' && activeMarketplace && !CATALOG_MARKETPLACES.includes(activeMarketplace.id) && (
            <MarketplacePage
              marketplace={activeMarketplace}
              error={market.pageError}
              opening={busy === 'marketplace'}
              onOpen={() => market.openWebsite(activeMarketplace.id, 'page')}
            />
          )}

          {page === 'workspaces' && (
            <WorkspacePage
              snapshot={snapshot}
              selectedPath={workspace.selectedPath}
              onChoose={workspace.chooseWorkspace}
              onBack={() => workspace.setSelectedPath('')}
              onOpen={(entry) => workspace.setSelectedPath(entry.path)}
              onHealth={data.runHealthCheck}
              busy={busy}
              onAddSkills={workspace.addSkills}
              onRemove={workspace.openRemove}
              removalSelections={workspace.removalSelections}
              setRemovalSelections={workspace.setRemovalSelections}
            />
          )}

          {page === 'settings' && (
            <SettingsPage
              appUpdate={appUpdate}
              onAutoCheck={(autoCheck) => {
                data.patchSettings({ appUpdates: { autoCheck } });
                void api.saveSettings({ appUpdates: { autoCheck } }).catch((error) => {
                  setError(String(error));
                  void data.refresh();
                });
              }}
              onLocale={data.setLocale}
              snapshot={allSnapshot}
              onCreate={() => harnessEditor.open(undefined, 'settings')}
              onEdit={(harness) => harnessEditor.open(harness, 'settings')}
              onMarketplaceCreate={() => market.openForm()}
              onMarketplaceEdit={(marketplace) => market.openForm(marketplace)}
              onMarketplaceRemove={market.askRemove}
              onHealth={data.runHealthCheck}
              busy={busy}
              onViewMode={(next) => void data.setMode(next)}
            />
          )}
        </div>

        {updates.viewing && page === 'library' && <UpdateDock updates={updates} />}
        {view.selectMode && page === 'library' && !updates.viewing && (
          <SelectionDock
            view={view}
            unapply={
              view.mode === 'harness'
                ? {
                    harnessName,
                    count: removalPlan.skillIds.length,
                    outsideCount: removalPlan.outsideCount,
                    onClick: () => workspace.openRemove({ ...removalPlan, harnessName, origin: 'library', scopeLabel: t('app.user') }),
                  }
                : undefined
            }
            onReview={() => shell.setDialog('selected')}
            onApply={() => apply.open(undefined, workspace.returnPath)}
          />
        )}
      </main>

      {toast && (
        <div className="toast" role="status">
          <Check size={15} />
          {toast}
          <button className="icon-button small" aria-label={t('app.dismissNotification')} onClick={() => setToast('')}>
            <X size={13} />
          </button>
        </div>
      )}

      {dialog === 'add-source' && <SourceDialog shell={shell} wizard={wizard} groups={snapshot.groups} />}
      <AppUpdateDialog update={appUpdate} />
      {dialog === 'onboarding' && <OnboardingDialog shell={shell} draft={groups} groups={snapshot.groups} />}
      {dialog === 'apply' && (
        <ApplyDialog
          shell={shell}
          snapshot={snapshot}
          view={view}
          apply={apply}
          draft={groups}
          onAddHarness={() => harnessEditor.open(undefined, 'library')}
        />
      )}
      {dialog === 'harness-form' && <HarnessFormDialog shell={shell} allSnapshot={allSnapshot} editor={harnessEditor} />}
      {dialog === 'marketplace-form' && <MarketplaceFormDialog shell={shell} market={market} />}
      {dialog === 'marketplace-remove' && <MarketplaceRemoveDialog shell={shell} market={market} />}
      {dialog === 'selected' && <SelectedDialog shell={shell} snapshot={snapshot} view={view} onApply={() => apply.open()} />}
      {dialog === 'remove' && <RemoveDialog shell={shell} workspace={workspace} />}
      {dialog === 'migrate-external' && <MigrationDialog shell={shell} migration={migration} />}
      {dialog === 'updates' && <UpdateDialog shell={shell} snapshot={snapshot} updates={updates} />}
    </div>
  );
}

export default App;
