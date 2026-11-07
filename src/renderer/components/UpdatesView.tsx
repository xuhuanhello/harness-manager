import { formatList } from '../i18n';
import { compareNames, formatDateTime } from '../i18n';
import { t, useT } from '../i18n';
import { useState } from 'react';
import {
  ArrowLeft,
  ArrowUpFromLine,
  ChevronDown,
  CircleAlert,
  CircleArrowUp,
  Folder,
  FolderTree,
  GitCommitHorizontal,
  Github,
  Info,
  Search,
  TriangleAlert,
} from 'lucide-react';
import type { Snapshot } from '../../shared/types';
import { formatCount, initial } from '../format';
import type { UpdateEntry, UpdateSource, Updates } from '../hooks/useUpdates';
import ListActions from './ListActions';

/** A checkbox that shows a partial selection of `ids` as indeterminate. */
function TriCheckbox({ ids, selected, label, onToggle }: { ids: string[]; selected: Set<string>; label: string; onToggle: () => void }) {
  const count = ids.filter((id) => selected.has(id)).length;
  return (
    <input
      className="tri-checkbox"
      type="checkbox"
      aria-label={label}
      disabled={!ids.length}
      checked={ids.length > 0 && count === ids.length}
      ref={(node) => {
        if (node) node.indeterminate = count > 0 && count < ids.length;
      }}
      onChange={onToggle}
    />
  );
}

function checkedAtLabel(date: Date | null) {
  if (!date) return '';
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return t('library.checkedJustNow');
  if (minutes < 60) return t('library.checkedMinutesAgo', { minutes: minutes });
  return t('library.checkedAt', { value: formatDateTime(date, { hour: '2-digit', minute: '2-digit' }) });
}

const applicableIds = (entries: UpdateEntry[]) => entries.filter((entry) => !entry.blocked).map((entry) => entry.skillId);

/** The “可更新” view of the central library: updatable skills folded by source. */
export function UpdatesView({
  updates,
  snapshot,
  search,
  onClearSearch,
}: {
  updates: Updates;
  snapshot: Snapshot;
  search: string;
  onClearSearch: () => void;
}) {
  const t = useT();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const query = search.trim().toLocaleLowerCase();
  const visible = updates.sources
    .map((item) => ({
      ...item,
      entries: item.entries.filter(
        (entry) =>
          !query ||
          `${entry.name} ${entry.description} ${entry.skill.description} ${item.source.label}`.toLocaleLowerCase().includes(query),
      ),
    }))
    .filter((item) => item.entries.length);
  const visibleIds = visible.flatMap((item) => applicableIds(item.entries));
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => updates.selected.has(id));
  const allExpanded = visible.every((item) => !collapsed.has(item.source.id));
  const sourceCount = updates.sources.filter((item) => item.entries.length).length;
  const blockedCount = updates.entries.length - updates.count;

  return (
    <>
      <section className="update-summary" aria-label={t('library.skillUpdatesOverview')}>
        <div className="update-summary-icon">
          <CircleArrowUp size={18} />
        </div>
        <div className="update-summary-copy">
          <strong>
            {updates.count
              ? t('library.upstreamUpdateCount', { count: updates.count })
              : t('library.upstreamChangesNeedManualAttention', { blockedCount: blockedCount })}
          </strong>
          <span>
            {updates.count > 0 && blockedCount > 0
              ? t('library.updateSourceSummaryWithAttention', {
                  count: sourceCount,
                  checkedAt: checkedAtLabel(updates.lastCheckedAt),
                  blocked: blockedCount,
                })
              : t('library.updateSourceSummary', { count: sourceCount, checkedAt: checkedAtLabel(updates.lastCheckedAt) })}
          </span>
        </div>
        <div className="update-summary-note">
          <Info size={13} />
          <span>{t('library.updatesReplaceLibraryContentSymlinkInstallsUseTheNewVersion')}</span>
        </div>
      </section>

      {updates.failures.length > 0 && (
        <div className="update-notice" role="status">
          <TriangleAlert size={14} />
          <div>
            <strong>{t('library.failedSourceCount', { count: updates.failures.length })}</strong>
            {updates.failures.map((item) => (
              <span key={item.source.id}>{t('common.namedDetail', { name: item.source.label, detail: item.error || '' })}</span>
            ))}
          </div>
        </div>
      )}

      <div className="content-meta">
        <span>{t('library.viewUpdatesBySourceSkillsWithoutLocalChangesAreSelected')}</span>
        <div className="content-meta-actions">
          <ListActions
            allExpanded={allExpanded}
            onToggleExpanded={() => setCollapsed(allExpanded ? new Set(visible.map((item) => item.source.id)) : new Set())}
            expandableCount={visible.length}
            selectableCount={visibleIds.length}
            allSelected={allSelected}
            onToggleSelection={() => updates.toggleMany(visibleIds)}
          />
          <span className="content-result-count">
            {formatCount(
              visible.reduce((total, item) => total + item.entries.length, 0),
              'item',
            )}
            {search ? t('library.searchResults') : ''}
          </span>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="empty-search">
          <Search size={20} />
          <strong>{t('library.noMatchingUpdates')}</strong>
          <span>{t('library.tryDifferentKeywordsOrClearTheSearch')}</span>
          <button className="button subtle" onClick={onClearSearch}>
            {t('library.clearSearch')}
          </button>
        </div>
      ) : (
        <div className="skill-sections">
          {visible.map((item) => (
            <UpdateSourceSection
              key={item.source.id}
              item={item}
              snapshot={snapshot}
              updates={updates}
              showMissing={!query}
              collapsed={collapsed.has(item.source.id)}
              onToggleCollapsed={() =>
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(item.source.id)) next.delete(item.source.id);
                  else next.add(item.source.id);
                  return next;
                })
              }
            />
          ))}
        </div>
      )}
    </>
  );
}

function UpdateSourceSection({
  item,
  snapshot,
  updates,
  showMissing,
  collapsed,
  onToggleCollapsed,
}: {
  item: UpdateSource;
  snapshot: Snapshot;
  updates: Updates;
  showMissing: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const t = useT();
  const { source, entries, missing, commit } = item;
  const ids = applicableIds(entries);
  const selectedCount = ids.filter((id) => updates.selected.has(id)).length;
  const categories = [...new Set(entries.map((entry) => entry.category))].sort((left, right) =>
    !left ? 1 : !right ? -1 : compareNames(left, right),
  );
  const rows = (members: UpdateEntry[]) =>
    members.map((entry) => (
      <UpdateRow
        key={entry.skillId}
        entry={entry}
        snapshot={snapshot}
        selected={updates.selected.has(entry.skillId)}
        onToggle={() => updates.toggleOne(entry.skillId)}
      />
    ));
  return (
    <section className="skill-section update-section">
      <div className="section-heading">
        <TriCheckbox
          ids={ids}
          selected={updates.selected}
          label={t('library.selectUpdatesIn', { label: source.label, count: ids.length })}
          onToggle={() => updates.toggleMany(ids)}
        />
        <button
          className="section-collapse"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? t('library.expand') : t('library.collapse')}${source.label}`}
          onClick={onToggleCollapsed}
        >
          <ChevronDown size={15} className={collapsed ? 'collapsed' : ''} />
        </button>
        <span className="section-kind-icon source">{source.type === 'github' ? <Github size={15} /> : <Folder size={15} />}</span>
        <strong>{source.label}</strong>
        <span className="section-count">
          {entries.length > ids.length
            ? t('library.updateCounts', { count: ids.length, blocked: entries.length - ids.length })
            : t('library.availableUpdateCount', { count: ids.length })}
        </span>
        {commit && (
          <span className="update-commit" title={t('library.upstreamCommit', { commit: commit })}>
            <GitCommitHorizontal size={11} />
            {commit.slice(0, 7)}
          </span>
        )}
        <span className="update-section-selected">{t('library.selectedFraction', { selected: selectedCount, count: ids.length })}</span>
      </div>
      {!collapsed && (
        <div className="skill-list">
          {categories.length > 1
            ? categories.map((category) => {
                const members = entries.filter((entry) => entry.category === category);
                const memberIds = applicableIds(members);
                return (
                  <div className="update-subgroup" key={category || '.'}>
                    <div className="update-subgroup-heading">
                      <TriCheckbox
                        ids={memberIds}
                        selected={updates.selected}
                        label={t('library.selectUpdateGroup', { value: category || t('library.rootDirectory') })}
                        onToggle={() => updates.toggleMany(memberIds)}
                      />
                      <FolderTree size={13} />
                      <strong>{category || t('library.rootDirectory')}</strong>
                      <span>
                        {t('library.itemSelectionCount', {
                          count: members.length,
                          selected: memberIds.filter((id) => updates.selected.has(id)).length,
                        })}
                      </span>
                    </div>
                    {rows(members)}
                  </div>
                );
              })
            : rows(entries)}
          {showMissing && missing.length > 0 && (
            <div className="update-missing">
              <CircleAlert size={13} />
              <span>{t('library.missingSkills', { count: missing.length, names: formatList(missing.map((skill) => skill.name)) })}</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function UpdateRow({
  entry,
  snapshot,
  selected,
  onToggle,
}: {
  entry: UpdateEntry;
  snapshot: Snapshot;
  selected: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const distributions = snapshot.distributions.filter((item) => item.skillId === entry.skillId);
  const copies = distributions.filter((item) => item.strategy === 'copy').length;
  const groups = snapshot.groups.filter((group) => group.skillIds.includes(entry.skillId));
  const blocked = !!entry.blocked;
  const descriptionChanged = entry.description !== entry.skill.description;
  return (
    <article
      className={`skill-row selectable update-row ${selected ? 'selected' : ''} ${blocked ? 'blocked' : ''}`}
      onClick={blocked ? undefined : onToggle}
    >
      <input
        className="row-checkbox"
        type="checkbox"
        checked={selected && !blocked}
        disabled={blocked}
        onChange={onToggle}
        onClick={(event) => event.stopPropagation()}
        aria-label={t('library.selectUpdateFor', { name: entry.name })}
      />
      <div className="skill-avatar">{initial(entry.name)}</div>
      <div className="skill-main">
        <div className="skill-name-line">
          <h3>{entry.name}</h3>
          {blocked ? (
            <span className="update-pill blocked">{t('library.needsManualAttention')}</span>
          ) : entry.localModified ? (
            <span className="update-pill modified" title={t('library.libraryContentHasChangedSinceImportSelectingThisSkillReplaces')}>
              {t('library.locallyModified')}
            </span>
          ) : (
            <span className="update-pill">{t('library.updates')}</span>
          )}
        </div>
        <p className={blocked ? 'update-blocked-reason' : undefined}>
          {entry.blocked ?? (entry.description || t('library.noDescription'))}
        </p>
        <div className="skill-tags">
          {groups.slice(0, 2).map((group) => (
            <span className="tag group-tag" key={group.id}>
              <span style={{ backgroundColor: group.color }} />
              {group.name}
            </span>
          ))}
          {groups.length > 2 && <span className="tag">+{groups.length - 2}</span>}
          {!blocked && descriptionChanged && <span className="tag update-tag">{t('library.descriptionChanged')}</span>}
        </div>
      </div>
      <div className="skill-meta">
        <span>
          {distributions.length ? (
            <>
              <span className="tiny-status" />
              {t('library.appliedDestinationCount', { count: distributions.length })}
            </>
          ) : (
            t('library.libraryOnly')
          )}
        </span>
        {!blocked && entry.localModified && selected && (
          <span className="update-note warn">{t('library.localChangesWillMoveToTrash')}</span>
        )}
        {!blocked && copies > 0 && <span className="update-note">{t('library.copyCount', { count: copies })}</span>}
      </div>
    </article>
  );
}

export function UpdateDock({ updates }: { updates: Updates }) {
  const t = useT();
  const count = updates.selectedIds.length;
  const replacing = updates.replacingModified.length;
  return (
    <div className="selection-dock update-dock">
      <div className="dock-count">
        <div className="dock-icon update">
          <CircleArrowUp size={16} />
        </div>
        <div>
          <strong>{t('library.selectedUpdateCount', { count })}</strong>
          <span className={replacing ? 'warn' : undefined}>
            {replacing
              ? t('library.localChangesInItemsWillMoveToTrash', { replacing: replacing })
              : t('library.updatesAvailableSelectLocallyModifiedSkillsManually', { count: updates.count })}
          </span>
        </div>
      </div>
      <div className="dock-actions">
        <button className="button subtle" onClick={updates.leave}>
          <ArrowLeft size={14} />
          {t('library.backToLibrary')}
        </button>
        <button data-testid="apply-updates" className="button primary" disabled={!count} onClick={updates.openConfirm}>
          <ArrowUpFromLine size={15} />
          {t('library.update')}
          <span className="button-count">{count}</span>
        </button>
      </div>
    </div>
  );
}
