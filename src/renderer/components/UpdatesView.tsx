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
  if (minutes < 1) return '刚刚检查';
  if (minutes < 60) return `${minutes} 分钟前检查`;
  return `${date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 检查`;
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
      <section className="update-summary" aria-label="可更新技能概览">
        <div className="update-summary-icon">
          <CircleArrowUp size={18} />
        </div>
        <div className="update-summary-copy">
          <strong>{updates.count ? `${formatCount(updates.count, '个技能')}有上游更新` : `${blockedCount} 项上游变化需要手动处理`}</strong>
          <span>
            来自 {sourceCount} 个来源 · {checkedAtLabel(updates.lastCheckedAt)}
            {updates.count > 0 && blockedCount > 0 && ` · ${blockedCount} 项需要手动处理`}
          </span>
        </div>
        <div className="update-summary-note">
          <Info size={13} />
          <span>更新会替换中央库中的内容；软链接安装立即使用新版本，副本安装需重新应用以同步。</span>
        </div>
      </section>

      {updates.failures.length > 0 && (
        <div className="update-notice" role="status">
          <TriangleAlert size={14} />
          <div>
            <strong>{updates.failures.length} 个来源无法检查更新</strong>
            {updates.failures.map((item) => (
              <span key={item.source.id}>
                {item.source.label}：{item.error}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="content-meta">
        <span>按来源查看可更新的技能；默认选中没有本地修改的更新。</span>
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
              '项',
            )}
            {search ? ' · 搜索结果' : ''}
          </span>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="empty-search">
          <Search size={20} />
          <strong>没有匹配的更新</strong>
          <span>试试其他关键词，或清除搜索条件。</span>
          <button className="button subtle" onClick={onClearSearch}>
            清除搜索
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
  const { source, entries, missing, commit } = item;
  const ids = applicableIds(entries);
  const selectedCount = ids.filter((id) => updates.selected.has(id)).length;
  const categories = [...new Set(entries.map((entry) => entry.category))].sort((left, right) =>
    !left ? 1 : !right ? -1 : left.localeCompare(right),
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
          label={`选择${source.label}中的 ${ids.length} 个更新`}
          onToggle={() => updates.toggleMany(ids)}
        />
        <button
          className="section-collapse"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? '展开' : '折叠'}${source.label}`}
          onClick={onToggleCollapsed}
        >
          <ChevronDown size={15} className={collapsed ? 'collapsed' : ''} />
        </button>
        <span className="section-kind-icon source">{source.type === 'github' ? <Github size={15} /> : <Folder size={15} />}</span>
        <strong>{source.label}</strong>
        <span className="section-count">
          {ids.length} 项可更新{entries.length > ids.length && ` · ${entries.length - ids.length} 项需手动处理`}
        </span>
        {commit && (
          <span className="update-commit" title={`上游提交 ${commit}`}>
            <GitCommitHorizontal size={11} />
            {commit.slice(0, 7)}
          </span>
        )}
        <span className="update-section-selected">
          已选 {selectedCount}/{ids.length}
        </span>
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
                        label={`选择分组 ${category || '根目录'}`}
                        onToggle={() => updates.toggleMany(memberIds)}
                      />
                      <FolderTree size={13} />
                      <strong>{category || '根目录'}</strong>
                      <span>
                        {members.length} 项 · 已选 {memberIds.filter((id) => updates.selected.has(id)).length}
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
              <span>
                {missing.length} 个技能在上游已不存在，中央库中的内容会保留：{missing.map((skill) => skill.name).join('、')}
              </span>
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
        aria-label={`选择更新 ${entry.name}`}
      />
      <div className="skill-avatar">{initial(entry.name)}</div>
      <div className="skill-main">
        <div className="skill-name-line">
          <h3>{entry.name}</h3>
          {blocked ? (
            <span className="update-pill blocked">需要手动处理</span>
          ) : entry.localModified ? (
            <span className="update-pill modified" title="中央库中的内容在安装后被修改过；勾选后会用上游版本替换，修改移到废纸篓。">
              本地已修改
            </span>
          ) : (
            <span className="update-pill">可更新</span>
          )}
        </div>
        <p className={blocked ? 'update-blocked-reason' : undefined}>{entry.blocked ?? (entry.description || '暂无描述。')}</p>
        <div className="skill-tags">
          {groups.slice(0, 2).map((group) => (
            <span className="tag group-tag" key={group.id}>
              <span style={{ backgroundColor: group.color }} />
              {group.name}
            </span>
          ))}
          {groups.length > 2 && <span className="tag">+{groups.length - 2}</span>}
          {!blocked && descriptionChanged && <span className="tag update-tag">描述有变化</span>}
        </div>
      </div>
      <div className="skill-meta">
        <span>
          {distributions.length ? (
            <>
              <span className="tiny-status" />
              已应用到 {distributions.length} 个目标
            </>
          ) : (
            '仅在中央库'
          )}
        </span>
        {!blocked && entry.localModified && selected && <span className="update-note warn">本地修改将移到废纸篓</span>}
        {!blocked && copies > 0 && <span className="update-note">{copies} 个副本需重新应用</span>}
      </div>
    </article>
  );
}

export function UpdateDock({ updates }: { updates: Updates }) {
  const count = updates.selectedIds.length;
  const replacing = updates.replacingModified.length;
  return (
    <div className="selection-dock update-dock">
      <div className="dock-count">
        <div className="dock-icon update">
          <CircleArrowUp size={16} />
        </div>
        <div>
          <strong>已选 {formatCount(count, '个更新')}</strong>
          <span className={replacing ? 'warn' : undefined}>
            {replacing ? `其中 ${replacing} 项的本地修改将移到废纸篓` : `共 ${updates.count} 个可更新；本地修改过的技能需手动勾选`}
          </span>
        </div>
      </div>
      <div className="dock-actions">
        <button className="button subtle" onClick={updates.leave}>
          <ArrowLeft size={14} />
          返回技能库
        </button>
        <button data-testid="apply-updates" className="button primary" disabled={!count} onClick={updates.openConfirm}>
          <ArrowUpFromLine size={15} />
          更新 <span className="button-count">{count}</span>
        </button>
      </div>
    </div>
  );
}
