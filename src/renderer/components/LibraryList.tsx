import { useT } from '../i18n';
import { RevealSkillButton } from './RevealSkillButton';
import { SectionHeading } from './SectionHeading';
import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  CircleArrowUp,
  ExternalLink,
  Folder,
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
  const t = useT();
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
      <span>{t('library.viewMode')}</span>
      <button
        ref={trigger}
        data-testid="view-mode-select"
        className="view-menu-trigger"
        aria-label={
          updates?.count && !updates.active ? t('library.viewModeSkillsHaveUpdates', { count: updates.count }) : t('library.viewMode')
        }
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {updates?.active ? t('library.updates') : modeTitle(value)}
        <ChevronDown size={14} />
        {!!updates?.count && !updates.active && (
          <span className="update-badge" aria-hidden="true">
            {updates.count > 99 ? '99+' : updates.count}
          </span>
        )}
      </button>
      {open && (
        <div className="view-menu-popover" role="menu" aria-label={t('library.viewMode')}>
          {modeItems().map((item) => (
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
                <span>{t('library.updates')}</span>
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
  const t = useT();
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
        <SectionHeading
          label={section.label}
          kind={section.kind}
          icon={icon}
          count={section.meta || t('library.itemCount', { count: uniqueIds.length })}
          names={section.skills.map((skill) => skill.name)}
          subtitle={section.kind === 'source' ? t('library.sourceRepositories') : section.kind === 'group' ? t('library.groups') : ''}
          collapsed={collapsed}
          onToggle={onToggle}
        >
          {selectMode && (
            <input
              className="tri-checkbox"
              type="checkbox"
              aria-label={t('library.selectSkillsIn', { label: section.label, count: uniqueIds.length })}
              checked={all}
              ref={(node) => {
                if (node) node.indeterminate = partial;
              }}
              onChange={() => onToggleMany(uniqueIds)}
            />
          )}
        </SectionHeading>
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
            <div className="section-empty">{t('library.allSkillsAlreadyBelongToAGroup')}</div>
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
  const t = useT();
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
          aria-label={t('library.select', { name: skill.name })}
        />
      )}
      <div className="skill-avatar">{initial(skill.name)}</div>
      <div className="skill-main">
        <div className="skill-name-line">
          <h3>{skill.name}</h3>
          {health && (
            <span className={`health-pill ${health}`}>
              {health === 'missing'
                ? t('library.missing')
                : health === 'broken'
                  ? t('library.brokenLink')
                  : health === 'stale'
                    ? t('library.outOfSyncStatus')
                    : t('library.conflict')}
            </span>
          )}
        </div>
        <p>{skill.description || t('library.noDescription')}</p>
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
              {t('library.appliedDestinationCount', { count: distributions.length })}
            </>
          ) : (
            t('library.libraryOnly')
          )}
        </span>
        <div className="skill-row-actions">
          {githubSource && (
            <button
              type="button"
              className="skill-row-action"
              aria-label={t('library.openOnTheWeb', { name: skill.name })}
              onClick={(event) => {
                event.stopPropagation();
                onOpenSkillSource();
              }}
            >
              <ExternalLink size={12} />
              {t('library.openSourceWebpage')}
            </button>
          )}
          {skill.directory && <RevealSkillButton name={skill.name} className="skill-row-action" onReveal={onRevealSkill} />}
        </div>
      </div>
    </article>
  );
}

export function EmptyLibrary({ onAdd }: { onAdd: () => void }) {
  const t = useT();
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
      <p className="eyebrow">{t('library.startWithOneSkill')}</p>
      <h2>{t('library.yourSkillLibraryIsEmpty')}</h2>
      <p>{t('library.addAGithubRepositoryOrLocalDirectoryThenImportThe')}</p>
      <button className="button primary" onClick={onAdd}>
        <Plus size={16} />
        {t('library.addYourFirstSource')}
      </button>
      <div className="empty-points">
        <span>
          <Check size={13} />
          {t('library.scanningNeverRunsRepositoryScripts')}
        </span>
        <span>
          <Check size={13} />
          {t('library.groupsAreOptional')}
        </span>
        <span>
          <Check size={13} />
          {t('library.applyToDestinationsAsNeeded')}
        </span>
      </div>
    </div>
  );
}
