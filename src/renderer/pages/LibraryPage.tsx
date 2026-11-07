import { Trans } from '../i18n';
import { formatDateTime } from '../i18n';
import { useT } from '../i18n';
import { CheckCheck, Folder, Github, LoaderCircle, RefreshCw, Search, Sparkles, X } from 'lucide-react';
import type { Snapshot } from '../../shared/types';
import ListActions from '../components/ListActions';
import { EmptyLibrary, SkillSection, ViewMenu } from '../components/LibraryList';
import { UpdatesView } from '../components/UpdatesView';
import { formatCount, harnessGlyph, modeTitle } from '../format';
import type { LibraryData } from '../hooks/useLibraryData';
import type { LibraryView } from '../hooks/useLibraryView';
import type { Updates } from '../hooks/useUpdates';
import type { Page } from '../view-types';
import { EmptyHarness } from './AgentHarnessPage';

/** Skills installed for one Harness at user level. */
function userInstallCount(snapshot: Snapshot, harnessId: string): number {
  return snapshot.skills.filter((skill) =>
    snapshot.intents.some(
      (intent) =>
        intent.skillId === skill.id &&
        snapshot.bindings.some((binding) => binding.id === intent.bindingId && binding.scope === 'user' && binding.harnessId === harnessId),
    ),
  ).length;
}

export function LibraryPage({
  snapshot,
  view,
  data,
  updates,
  onNavigate,
  onAddSource,
  onLeaveSelection,
  onPickSkillsToApply,
}: {
  snapshot: Snapshot;
  view: LibraryView;
  data: LibraryData;
  updates: Updates;
  onNavigate: (page: Page) => void;
  onAddSource: () => void;
  onLeaveSelection: () => void;
  onPickSkillsToApply: (message: string) => void;
}) {
  const t = useT();
  const { mode, search, setSearch, selectMode } = view;
  const checkedAt = updates.lastCheckedAt ? formatDateTime(updates.lastCheckedAt, { hour: '2-digit', minute: '2-digit' }) : undefined;
  return (
    <>
      <section className="library-toolbar" aria-label={t('library.libraryFilters')}>
        <ViewMenu
          value={mode}
          onChange={(value) => {
            updates.leave();
            void data.setMode(value);
          }}
          updates={{ count: updates.count, available: updates.entries.length > 0, active: updates.viewing, onOpen: updates.open }}
        />
        <div className="toolbar-divider" />
        <div className="search-box">
          <Search size={16} />
          <input
            ref={view.searchRef}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('library.searchSkillsDescriptionsOrSources')}
            aria-label={t('library.searchSkills')}
          />
          <kbd>⌘ K</kbd>
          {search && (
            <button className="clear-search" aria-label={t('library.clearSearch')} onClick={() => setSearch('')}>
              <X size={13} />
            </button>
          )}
        </div>
        <button
          data-testid="check-updates"
          className="toolbar-select toolbar-check"
          disabled={updates.checking}
          title={
            updates.checkError
              ? t('library.lastCheckFailed', { checkError: updates.checkError })
              : checkedAt
                ? t('library.lastChecked', { checkedAt: checkedAt })
                : t('library.checkInstalledSkillsForUpstreamUpdates')
          }
          onClick={() => void updates.runCheck(true)}
        >
          {updates.checking ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
          {updates.checking ? t('library.checking') : t('library.checkUpdates')}
          {updates.checkError && !updates.checking && <span className="toolbar-check-error" aria-hidden="true" />}
        </button>
        {!updates.viewing && (
          <button
            data-testid="start-selection"
            className={`toolbar-select ${selectMode ? 'selected' : ''}`}
            onClick={() => (selectMode ? onLeaveSelection() : view.beginSelection())}
          >
            {selectMode ? <X size={15} /> : <CheckCheck size={15} />}
            {selectMode ? t('library.exitSelection') : t('library.selectMultiple')}
          </button>
        )}
      </section>

      {updates.viewing ? (
        <UpdatesView updates={updates} snapshot={snapshot} search={search} onClearSearch={() => setSearch('')} />
      ) : (
        <LibraryContent
          snapshot={snapshot}
          view={view}
          data={data}
          onNavigate={onNavigate}
          onAddSource={onAddSource}
          onPickSkillsToApply={onPickSkillsToApply}
        />
      )}
    </>
  );
}

/** The regular category views: tabs, sections and rows of installed skills. */
function LibraryContent({
  snapshot,
  view,
  data,
  onNavigate,
  onAddSource,
  onPickSkillsToApply,
}: {
  snapshot: Snapshot;
  view: LibraryView;
  data: LibraryData;
  onNavigate: (page: Page) => void;
  onAddSource: () => void;
  onPickSkillsToApply: (message: string) => void;
}) {
  const t = useT();
  const { mode, activeTab, harnessId, search, setSearch, selectMode, selected, skillOnCurrentView } = view;
  const harnessName = snapshot.harnesses.find((harness) => harness.id === harnessId)?.name || 'Harness';
  return (
    <>
      {selectMode && (
        <div className="selection-hint">
          <CheckCheck size={15} />
          <span>
            {mode === 'harness' ? (
              <Trans
                id="library.harnessSelectionHint"
                values={{ count: view.selectedCount, harnessName }}
                render={{ count: (count) => <strong>{count}</strong> }}
              />
            ) : (
              <Trans
                id="library.selectionHint"
                values={{ count: view.selectedCount }}
                render={{ count: (count) => <strong>{count}</strong> }}
              />
            )}
          </span>
        </div>
      )}

      {mode !== 'flat' && (
        <div className="category-tabs" role="tablist" aria-label={t('library.categoryViewLabel', { value: modeTitle(mode) })}>
          {mode === 'source' && (
            <>
              <button
                role="tab"
                aria-selected={activeTab === 'all'}
                className={activeTab === 'all' ? 'active' : ''}
                onClick={() => void data.setActiveTab(mode, 'all')}
              >
                {t('library.allSources')}
                <span>{snapshot.skills.length}</span>
              </button>
              {snapshot.sources.map((source) => (
                <button
                  role="tab"
                  aria-selected={activeTab === source.id}
                  className={activeTab === source.id ? 'active' : ''}
                  key={source.id}
                  onClick={() => void data.setActiveTab(mode, source.id)}
                >
                  {source.type === 'github' ? <Github size={14} /> : <Folder size={14} />}
                  {source.label}
                  <span>{snapshot.skills.filter((skill) => skill.sourceId === source.id).length}</span>
                </button>
              ))}
            </>
          )}
          {mode === 'group' && (
            <>
              <button
                role="tab"
                aria-selected={activeTab === 'all'}
                className={activeTab === 'all' ? 'active' : ''}
                onClick={() => void data.setActiveTab(mode, 'all')}
              >
                {t('library.allGroups')}
                <span>{snapshot.skills.length}</span>
              </button>
              {snapshot.groups.map((group) => (
                <button
                  role="tab"
                  aria-selected={activeTab === group.id}
                  className={activeTab === group.id ? 'active' : ''}
                  key={group.id}
                  onClick={() => void data.setActiveTab(mode, group.id)}
                >
                  <span className="tab-color" style={{ backgroundColor: group.color }} />
                  {group.name}
                  <span>{group.skillIds.length}</span>
                </button>
              ))}
              <button
                role="tab"
                aria-selected={activeTab === 'ungrouped'}
                className={activeTab === 'ungrouped' ? 'active' : ''}
                onClick={() => void data.setActiveTab(mode, 'ungrouped')}
              >
                {t('library.ungrouped')}
                <span>{snapshot.skills.filter((skill) => !snapshot.groups.some((group) => group.skillIds.includes(skill.id))).length}</span>
              </button>
            </>
          )}
          {mode === 'harness' && (
            <>
              {snapshot.harnesses.some((item) => item.id === 'universal') && (
                <button
                  role="tab"
                  aria-selected={activeTab === 'all' || activeTab === 'universal'}
                  className={activeTab === 'all' || activeTab === 'universal' ? 'active' : ''}
                  onClick={() => void data.setActiveTab(mode, 'universal')}
                >
                  <Sparkles size={14} />
                  {snapshot.harnesses.find((harness) => harness.id === 'universal')?.name}
                  <span>{userInstallCount(snapshot, 'universal')}</span>
                </button>
              )}
              {snapshot.harnesses
                .filter((harness) => harness.id !== 'universal')
                .map((harness) => (
                  <button
                    role="tab"
                    aria-selected={activeTab === harness.id}
                    className={activeTab === harness.id ? 'active' : ''}
                    key={harness.id}
                    onClick={() => void data.setActiveTab(mode, harness.id)}
                  >
                    <span className="tab-agent-icon">{harnessGlyph(harness.icon, harness.name)}</span>
                    {harness.name}
                    <span>{userInstallCount(snapshot, harness.id)}</span>
                  </button>
                ))}
            </>
          )}
        </div>
      )}

      <div className="content-meta">
        <span>
          {mode === 'harness'
            ? t('library.managedUserInstallations')
            : mode === 'flat'
              ? t('library.allInstalledSkills')
              : mode === 'group'
                ? t('library.groupsOrganizeSkillsAcrossSources')
                : t('library.browseInstalledSkillsBySource')}
        </span>
        <div className="content-meta-actions">
          {mode === 'harness' && userInstallCount(snapshot, harnessId) > 0 && (
            <fieldset className="harness-grouping">
              <legend>{t('library.harnessViewSections')}</legend>
              <span aria-hidden="true">{t('library.sections')}</span>
              <div className="agent-scope-tabs">
                {(
                  [
                    ['group', t('library.groups')],
                    ['source', t('library.source')],
                    ['flat', t('library.noSections')],
                  ] as const
                ).map(([value, label]) => (
                  <label
                    key={value}
                    className={view.effectiveHarnessGroupBy === value ? 'active' : ''}
                    title={value === 'group' && !snapshot.groups.length ? t('library.noGroupsYet') : undefined}
                  >
                    <input
                      type="radio"
                      name="harness-group-by"
                      value={value}
                      checked={view.effectiveHarnessGroupBy === value}
                      aria-checked={view.effectiveHarnessGroupBy === value}
                      disabled={value === 'group' && !snapshot.groups.length}
                      title={value === 'group' && !snapshot.groups.length ? t('library.noGroupsYet') : undefined}
                      onChange={() => view.setHarnessGroupBy(value)}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <ListActions
            allExpanded={view.allSectionsExpanded}
            onToggleExpanded={view.setAllSectionsExpanded}
            expandableCount={view.expandableSections.length}
            selectableCount={selectMode ? skillOnCurrentView.size : 0}
            allSelected={skillOnCurrentView.size > 0 && [...skillOnCurrentView].every((id) => selected.has(id))}
            onToggleSelection={() => view.toggleMany([...skillOnCurrentView])}
          />
          <span className="content-result-count">
            {formatCount(skillOnCurrentView.size, 'skill')}
            {search ? t('library.searchResults') : ''}
          </span>
        </div>
      </div>

      {mode === 'harness' && !snapshot.harnesses.length ? (
        <div className="empty-search">
          <strong>{t('library.noHarnessesEnabled')}</strong>
          <span>{t('library.enableTheToolsYouWantToManageInSettings')}</span>
          <button className="button subtle" onClick={() => onNavigate('settings')}>
            {t('library.goToSettings')}
          </button>
        </div>
      ) : snapshot.skills.length === 0 ? (
        <EmptyLibrary onAdd={onAddSource} />
      ) : skillOnCurrentView.size === 0 && mode === 'harness' && !search.trim() ? (
        <EmptyHarness
          snapshot={snapshot}
          harnessId={harnessId}
          onApply={() => onPickSkillsToApply(t('library.selectSkillsThenUseApplyAtTheBottomRight'))}
          onOpenHarness={() => onNavigate('agent-harness')}
        />
      ) : skillOnCurrentView.size === 0 && search ? (
        <div className="empty-search">
          <Search size={20} />
          <strong>{t('library.noMatchingSkills')}</strong>
          <span>{t('library.tryDifferentKeywordsOrClearTheSearch')}</span>
          <button className="button subtle" onClick={() => setSearch('')}>
            {t('library.clearSearch')}
          </button>
        </div>
      ) : (
        <div className="skill-sections">
          {view.renderedSections.map((section) => (
            <SkillSection
              key={section.id}
              section={section}
              snapshot={snapshot}
              selected={selected}
              selectMode={selectMode}
              collapsed={view.isSectionCollapsed(section.id)}
              onToggle={() => view.setSectionCollapsed(section.id, !view.isSectionCollapsed(section.id))}
              onToggleMany={view.toggleMany}
              onToggleOne={view.toggleOne}
              onOpenSkillSource={data.openSkillWebpage}
              onRevealSkill={data.revealSkillDirectory}
            />
          ))}
        </div>
      )}
    </>
  );
}
