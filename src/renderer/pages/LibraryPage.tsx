import { CheckCheck, Folder, Github, LoaderCircle, RefreshCw, Search, Sparkles, Trash2, X } from 'lucide-react';
import type { Snapshot } from '../../shared/types';
import ListActions from '../components/ListActions';
import { EmptyLibrary, SkillSection, ViewMenu } from '../components/LibraryList';
import { UpdatesView } from '../components/UpdatesView';
import { formatCount, harnessGlyph, modeTitle } from '../format';
import type { LibraryData } from '../hooks/useLibraryData';
import type { LibraryView } from '../hooks/useLibraryView';
import type { Updates } from '../hooks/useUpdates';
import type { Page, RemovalDraft } from '../view-types';
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
  busy,
  onNavigate,
  onAddSource,
  onRemove,
  onLeaveSelection,
  onPickSkillsToApply,
}: {
  snapshot: Snapshot;
  view: LibraryView;
  data: LibraryData;
  updates: Updates;
  busy: string;
  onNavigate: (page: Page) => void;
  onAddSource: () => void;
  onRemove: (draft: RemovalDraft) => void;
  onLeaveSelection: () => void;
  onPickSkillsToApply: (message: string) => void;
}) {
  const { mode, activeTab, search, setSearch, selectMode } = view;
  const harnessTab = activeTab === 'all' ? 'universal' : activeTab;
  const checkedAt = updates.lastCheckedAt?.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return (
    <>
      <section className="library-toolbar" aria-label="技能库筛选工具">
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
            placeholder="搜索技能、描述或来源…"
            aria-label="搜索技能"
          />
          <kbd>⌘ K</kbd>
          {search && (
            <button className="clear-search" aria-label="清除搜索" onClick={() => setSearch('')}>
              <X size={13} />
            </button>
          )}
        </div>
        <button
          data-testid="check-updates"
          className="toolbar-select toolbar-check"
          disabled={updates.checking}
          title={
            updates.checkError ? `上次检查失败：${updates.checkError}` : checkedAt ? `上次检查：${checkedAt}` : '检查已安装技能的上游更新'
          }
          onClick={() => void updates.runCheck(true)}
        >
          {updates.checking ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
          {updates.checking ? '正在检查…' : '检查更新'}
          {updates.checkError && !updates.checking && <span className="toolbar-check-error" aria-hidden="true" />}
        </button>
        {!updates.viewing && (
          <button
            data-testid="start-selection"
            className={`toolbar-select ${selectMode ? 'selected' : ''}`}
            onClick={() => (selectMode ? onLeaveSelection() : view.beginSelection())}
          >
            {selectMode ? <X size={15} /> : <CheckCheck size={15} />}
            {selectMode ? '退出多选' : '选择多个'}
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
          busy={busy}
          harnessTab={harnessTab}
          onNavigate={onNavigate}
          onAddSource={onAddSource}
          onRemove={onRemove}
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
  busy,
  harnessTab,
  onNavigate,
  onAddSource,
  onRemove,
  onPickSkillsToApply,
}: {
  snapshot: Snapshot;
  view: LibraryView;
  data: LibraryData;
  busy: string;
  harnessTab: string;
  onNavigate: (page: Page) => void;
  onAddSource: () => void;
  onRemove: (draft: RemovalDraft) => void;
  onPickSkillsToApply: (message: string) => void;
}) {
  const { mode, activeTab, search, setSearch, selectMode, selected, skillOnCurrentView } = view;
  return (
    <>
      {selectMode && (
        <div className="selection-hint">
          <CheckCheck size={15} />
          <span>
            已选择 <strong>{view.selectedCount}</strong> 项。可勾选来源或分组来批量选择；当前搜索会限制批量范围。
          </span>
        </div>
      )}

      {mode !== 'flat' && (
        <div className="category-tabs" role="tablist" aria-label={`${modeTitle(mode)}分类`}>
          {mode === 'source' && (
            <>
              <button
                role="tab"
                aria-selected={activeTab === 'all'}
                className={activeTab === 'all' ? 'active' : ''}
                onClick={() => void data.setActiveTab(mode, 'all')}
              >
                全部来源<span>{snapshot.skills.length}</span>
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
                全部分组<span>{snapshot.skills.length}</span>
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
                未分组
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
                  用户级通用
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
            ? '用户级受管安装'
            : mode === 'flat'
              ? '所有已安装技能'
              : mode === 'group'
                ? '业务分组是技能的组织方式，可跨来源组合。'
                : '按来源查看已安装技能'}
        </span>
        <div className="content-meta-actions">
          <ListActions
            allExpanded={view.allSectionsExpanded}
            onToggleExpanded={view.setAllSectionsExpanded}
            expandableCount={view.expandableSections.length}
            selectableCount={selectMode ? skillOnCurrentView.size : 0}
            allSelected={skillOnCurrentView.size > 0 && [...skillOnCurrentView].every((id) => selected.has(id))}
            onToggleSelection={() => view.toggleMany([...skillOnCurrentView])}
          />
          <span className="content-result-count">
            {formatCount(skillOnCurrentView.size, '个技能')}
            {search ? ' · 搜索结果' : ''}
          </span>
        </div>
      </div>

      {mode === 'harness' &&
        selectMode &&
        snapshot.bindings
          .filter((binding) => binding.scope === 'user' && binding.harnessId === harnessTab)
          .map((binding) => {
            const ids = snapshot.intents
              .filter((intent) => intent.bindingId === binding.id && selected.has(intent.skillId))
              .map((intent) => intent.skillId);
            const harnessName = snapshot.harnesses.find((item) => item.id === binding.harnessId)?.name || 'Harness';
            return (
              ids.length > 0 && (
                <button
                  key={binding.id}
                  className="button subtle danger-quiet"
                  disabled={!!busy}
                  onClick={() =>
                    onRemove({
                      bindingId: binding.id,
                      harnessName,
                      skillIds: ids,
                      skillNames: snapshot.skills.filter((skill) => ids.includes(skill.id)).map((skill) => skill.name),
                    })
                  }
                >
                  <Trash2 size={14} />从 {harnessName} 移除所选 {ids.length} 项
                </button>
              )
            );
          })}

      {mode === 'harness' && !snapshot.harnesses.length ? (
        <div className="empty-search">
          <strong>尚未启用任何 Harness</strong>
          <span>在设置中开启需要管理的工具。</span>
          <button className="button subtle" onClick={() => onNavigate('settings')}>
            前往设置
          </button>
        </div>
      ) : snapshot.skills.length === 0 ? (
        <EmptyLibrary onAdd={onAddSource} />
      ) : skillOnCurrentView.size === 0 && mode === 'harness' ? (
        <EmptyHarness
          snapshot={snapshot}
          harnessId={harnessTab}
          onApply={() => onPickSkillsToApply('选择要应用的技能后，使用右下角“应用”。')}
          onOpenHarness={() => onNavigate('agent-harness')}
        />
      ) : skillOnCurrentView.size === 0 && search ? (
        <div className="empty-search">
          <Search size={20} />
          <strong>没有匹配的技能</strong>
          <span>试试其他关键词，或清除搜索条件。</span>
          <button className="button subtle" onClick={() => setSearch('')}>
            清除搜索
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
