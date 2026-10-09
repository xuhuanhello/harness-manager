import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  CircleArrowUp,
  ExternalLink,
  Folder,
  FolderOpen,
  Github,
  HardDrive,
  Layers3,
  ListFilter,
  Package,
  Plus,
  Sparkles,
} from 'lucide-react';
import type { Skill, Snapshot, ViewMode } from '../../shared/types';
import type { Section } from '../view-types';
import { modeItems, sourceName, initial, modeTitle } from '../format';

/** The central library list: view switcher, sections and rows. */

/**
 * The “可更新” entry of the view menu. `count` is what can be applied; `available` also covers
 * upstream changes that need manual handling.
 */
export type UpdatesMenuItem = { count: number; available: boolean; active: boolean; onOpen: () => void };

export function ViewMenu({
  value,
  onChange,
  updates,
}: {
  value: ViewMode;
  onChange: (value: ViewMode) => void;
  updates?: UpdatesMenuItem;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    root.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div
      className="view-select-wrap custom-view-menu"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          if (!open) {
            setOpen(true);
            return;
          }
          const options = [...root.current!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
          const current = options.indexOf(document.activeElement as HTMLButtonElement);
          options[
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? options.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length
          ]?.focus();
        }
      }}
    >
      <ListFilter size={15} />
      <span>分类方式</span>
      <button
        ref={trigger}
        data-testid="view-mode-select"
        className="view-menu-trigger"
        aria-label={updates?.count && !updates.active ? `分类方式，${updates.count} 个技能可更新` : '分类方式'}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {updates?.active ? '可更新' : modeTitle(value)}
        <ChevronDown size={14} />
        {!!updates?.count && !updates.active && (
          <span className="update-badge" aria-hidden="true">
            {updates.count > 99 ? '99+' : updates.count}
          </span>
        )}
      </button>
      {open && (
        <div className="view-menu-popover" role="menu" aria-label="分类方式">
          {modeItems.map((item) => (
            <button
              role="menuitemradio"
              aria-checked={item.id === value && !updates?.active}
              key={item.id}
              onClick={() => {
                onChange(item.id);
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <item.icon size={15} />
              <span>{item.label}</span>
              {item.id === value && !updates?.active && <Check size={14} />}
            </button>
          ))}
          {updates && (updates.available || updates.active) && (
            <>
              <hr className="view-menu-divider" />
              <button
                role="menuitemradio"
                className="view-menu-updates"
                aria-checked={updates.active}
                onClick={() => {
                  updates.onOpen();
                  setOpen(false);
                  trigger.current?.focus();
                }}
              >
                <CircleArrowUp size={15} />
                <span>可更新</span>
                {updates.count > 0 && <span className="update-count-pill">{updates.count}</span>}
                {updates.active && <Check size={14} />}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function SkillSection({
  section,
  snapshot,
  selected,
  selectMode,
  collapsed,
  onToggle,
  onToggleMany,
  onToggleOne,
  onOpenSkillSource,
  onRevealSkill,
}: {
  section: Section;
  snapshot: Snapshot;
  selected: Set<string>;
  selectMode: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onToggleMany: (ids: string[]) => void;
  onToggleOne: (id: string) => void;
  onOpenSkillSource: (skillId: string) => void;
  onRevealSkill: (skillId: string) => void;
}) {
  const uniqueIds = [...new Set(section.skills.map((skill) => skill.id))];
  const selectedMembers = uniqueIds.filter((id) => selected.has(id)).length;
  const all = uniqueIds.length > 0 && selectedMembers === uniqueIds.length;
  const partial = selectedMembers > 0 && !all;
  const icon =
    section.kind === 'source' ? (
      section.icon === 'github' ? (
        <Github size={15} />
      ) : (
        <Folder size={15} />
      )
    ) : section.kind === 'group' ? (
      <span className="section-dot" style={section.icon !== 'neutral' ? { backgroundColor: section.icon } : undefined} />
    ) : section.kind === 'harness' ? (
      <HardDrive size={15} />
    ) : (
      <Layers3 size={15} />
    );
  return (
    <section className={`skill-section ${section.kind === 'flat' ? 'flat-section' : ''}`}>
      {section.kind !== 'flat' && (
        <div className="section-heading">
          {selectMode && (
            <input
              className="tri-checkbox"
              type="checkbox"
              aria-label={`选择${section.label}中的 ${uniqueIds.length} 个技能`}
              checked={all}
              ref={(node) => {
                if (node) node.indeterminate = partial;
              }}
              onChange={() => onToggleMany(uniqueIds)}
            />
          )}
          <button className="section-collapse" aria-expanded={!collapsed} onClick={onToggle}>
            <ChevronDown size={15} className={collapsed ? 'collapsed' : ''} />
          </button>
          <span className={`section-kind-icon ${section.kind}`}>{icon}</span>
          <strong>{section.label}</strong>
          <span className="section-count">{section.meta || `${uniqueIds.length} 项`}</span>
          {section.kind === 'source' && <span className="section-subtitle">来源仓库</span>}
          {section.kind === 'group' && <span className="section-subtitle">业务分组</span>}
        </div>
      )}
      {!collapsed && (
        <div className={`skill-list ${section.kind === 'flat' ? 'flat-list' : ''}`}>
          {section.skills.map((skill) => (
            <SkillRow
              key={`${section.id}:${skill.id}`}
              skill={skill}
              snapshot={snapshot}
              selected={selected.has(skill.id)}
              selectable={selectMode}
              onToggle={() => onToggleOne(skill.id)}
              onOpenSkillSource={() => onOpenSkillSource(skill.id)}
              onRevealSkill={() => onRevealSkill(skill.id)}
            />
          ))}
          {!section.skills.length && section.kind === 'group' && section.id === 'group:ungrouped' && (
            <div className="section-empty">所有技能都已加入分组。</div>
          )}
        </div>
      )}
    </section>
  );
}

export function SkillRow({
  skill,
  snapshot,
  selected,
  selectable,
  onToggle,
  onOpenSkillSource,
  onRevealSkill,
}: {
  skill: Skill;
  snapshot: Snapshot;
  selected: boolean;
  selectable: boolean;
  onToggle: () => void;
  onOpenSkillSource: () => void;
  onRevealSkill: () => void;
}) {
  const groups = snapshot.groups.filter((group) => group.skillIds.includes(skill.id));
  const distributions = snapshot.distributions.filter((item) => item.skillId === skill.id);
  const health = distributions.find((item) => item.health !== 'healthy')?.health;
  const githubSource = snapshot.sources.find((source) => source.id === skill.sourceId)?.type === 'github';
  return (
    <article
      className={`skill-row ${selectable ? 'selectable' : ''} ${selected ? 'selected' : ''}`}
      onClick={selectable ? onToggle : undefined}
    >
      {selectable && (
        <input
          className="row-checkbox"
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          onClick={(event) => event.stopPropagation()}
          aria-label={`选择 ${skill.name}`}
        />
      )}
      <div className="skill-avatar">{initial(skill.name)}</div>
      <div className="skill-main">
        <div className="skill-name-line">
          <h3>{skill.name}</h3>
          {health && (
            <span className={`health-pill ${health}`}>
              {health === 'missing' ? '缺失' : health === 'broken' ? '断链' : health === 'stale' ? '待同步' : '冲突'}
            </span>
          )}
        </div>
        <p>{skill.description || '暂无描述。'}</p>
        <div className="skill-tags">
          {groups.slice(0, 2).map((group) => (
            <span className="tag group-tag" key={group.id}>
              <span style={{ backgroundColor: group.color }} />
              {group.name}
            </span>
          ))}
          {groups.length > 2 && <span className="tag">+{groups.length - 2}</span>}
          <span className="tag source-tag">
            {snapshot.sources.find((source) => source.id === skill.sourceId)?.type === 'github' ? (
              <Github size={11} />
            ) : (
              <Folder size={11} />
            )}
            {sourceName(snapshot, skill.sourceId)}
          </span>
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
        <div className="skill-row-actions">
          {githubSource && (
            <button
              type="button"
              className="skill-row-action"
              aria-label={`在网页中打开 ${skill.name}`}
              onClick={(event) => {
                event.stopPropagation();
                onOpenSkillSource();
              }}
            >
              <ExternalLink size={12} />
              在网页中打开
            </button>
          )}
          {skill.directory && (
            <button
              type="button"
              className="skill-row-action"
              aria-label={`在访达中显示 ${skill.name}`}
              onClick={(event) => {
                event.stopPropagation();
                onRevealSkill();
              }}
            >
              <FolderOpen size={12} />
              在访达中显示
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

export function EmptyLibrary({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="empty-library">
      <div className="empty-illustration">
        <div className="empty-stack stack-back">
          <Package size={23} />
        </div>
        <div className="empty-stack stack-front">
          <Sparkles size={22} />
        </div>
        <span className="empty-spark spark-one" />
        <span className="empty-spark spark-two" />
      </div>
      <p className="eyebrow">从一个技能开始</p>
      <h2>你的中央技能库还是空的</h2>
      <p>添加 GitHub 仓库或本地目录，扫描后只安装你选择的技能。安装到库中不会自动应用到任何 Harness。</p>
      <button className="button primary" onClick={onAdd}>
        <Plus size={16} />
        添加第一个来源
      </button>
      <div className="empty-points">
        <span>
          <Check size={13} />
          扫描不运行仓库脚本
        </span>
        <span>
          <Check size={13} />
          可跳过业务分组
        </span>
        <span>
          <Check size={13} />
          按需安装到目标
        </span>
      </div>
    </div>
  );
}
