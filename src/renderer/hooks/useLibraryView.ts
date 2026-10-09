import { useEffect, useMemo, useRef, useState } from 'react';
import type { Skill, Snapshot } from '../../shared/types';
import { sourceName } from '../format';
import type { Section } from '../view-types';
import type { LibraryData } from './useLibraryData';
import type { Shell } from './useShell';

/** The central library view: category tab, search, collapsed sections and the multi-selection. */
export function useLibraryView(snapshot: Snapshot | null, data: LibraryData, shell: Shell) {
  const { setMenuOpen, setToast } = shell;
  const [search, setSearch] = useState('');
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [searchCollapsed, setSearchCollapsed] = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setMenuOpen]);

  const mode = snapshot?.settings.viewMode ?? 'source';
  const activeTab = snapshot?.settings.activeTabs[mode] ?? 'all';
  const selectedCount = selected.size;

  useEffect(() => {
    if (!snapshot) return;
    const tab = snapshot.settings.activeTabs[mode];
    if (!tab) return;
    const valid =
      mode === 'source'
        ? tab === 'all' || snapshot.sources.some((source) => source.id === tab)
        : mode === 'group'
          ? tab === 'all' || tab === 'ungrouped' || snapshot.groups.some((group) => group.id === tab)
          : mode === 'harness'
            ? tab === 'all' || snapshot.harnesses.some((harness) => harness.id === tab)
            : true;
    if (
      !valid ||
      (mode === 'harness' && tab === 'all' && snapshot.harnesses.length > 0 && !snapshot.harnesses.some((item) => item.id === 'universal'))
    )
      void data.setActiveTab(
        mode,
        mode === 'harness' ? snapshot.harnesses.find((item) => item.id === 'universal')?.id || snapshot.harnesses[0]?.id || 'all' : 'all',
      );
  }, [snapshot?.sources, snapshot?.groups, snapshot?.harnesses, snapshot?.settings.activeTabs, mode]);

  const visibleSections = useMemo<Section[]>(() => {
    if (!snapshot) return [];
    const query = search.trim().toLocaleLowerCase();
    const matches = (skill: Skill) =>
      !query ||
      `${skill.name} ${skill.description} ${skill.sourcePath} ${sourceName(snapshot, skill.sourceId)}`.toLocaleLowerCase().includes(query);
    const skills = snapshot.skills.filter(matches);
    if (mode === 'flat') return [{ id: 'flat', label: '全部技能', kind: 'flat', skills }];
    if (mode === 'source') {
      const sources = activeTab === 'all' ? snapshot.sources : snapshot.sources.filter((source) => source.id === activeTab);
      return sources.map((source) => ({
        id: `source:${source.id}`,
        label: source.label,
        kind: 'source',
        icon: source.type,
        meta: `${snapshot.skills.filter((skill) => skill.sourceId === source.id).length} 项`,
        skills: skills.filter((skill) => skill.sourceId === source.id),
      }));
    }
    if (mode === 'group') {
      const groups = activeTab === 'all' ? snapshot.groups : snapshot.groups.filter((group) => group.id === activeTab);
      const sections = groups.map((group) => ({
        id: `group:${group.id}`,
        label: group.name,
        kind: 'group' as const,
        icon: group.color,
        meta: `${group.skillIds.filter((id) => snapshot.skills.some((skill) => skill.id === id)).length} 项`,
        skills: skills.filter((skill) => group.skillIds.includes(skill.id)),
      }));
      if (activeTab === 'all' || activeTab === 'ungrouped') {
        const grouped = new Set(snapshot.groups.flatMap((group) => group.skillIds));
        sections.push({
          id: 'group:ungrouped',
          label: '未分组',
          kind: 'group',
          icon: 'neutral',
          meta: `${snapshot.skills.filter((skill) => !grouped.has(skill.id)).length} 项`,
          skills: skills.filter((skill) => !grouped.has(skill.id)),
        });
      }
      return sections;
    }
    const harnessId = activeTab === 'all' ? 'universal' : activeTab;
    const bindingIds = new Set(
      snapshot.bindings.filter((binding) => binding.scope === 'user' && binding.harnessId === harnessId).map((binding) => binding.id),
    );
    const skillIds = new Set(snapshot.intents.filter((intent) => bindingIds.has(intent.bindingId)).map((intent) => intent.skillId));
    const harness = snapshot.harnesses.find((item) => item.id === harnessId);
    const name = harness ? `${harness.name} · 用户级安装` : '用户级通用技能';
    return [
      {
        id: `harness:${harnessId}`,
        label: name,
        kind: 'harness',
        icon: harness?.icon || 'H',
        skills: skills.filter((skill) => skillIds.has(skill.id)),
      },
    ];
  }, [snapshot, mode, activeTab, search]);

  const skillOnCurrentView = useMemo(
    () => new Set(visibleSections.flatMap((section) => section.skills.map((skill) => skill.id))),
    [visibleSections],
  );
  const renderedSections = useMemo(
    () =>
      visibleSections.filter(
        (section) =>
          section.skills.length > 0 ||
          (section.kind === 'group' && section.id === 'group:ungrouped') ||
          (section.kind === 'source' && !search),
      ),
    [visibleSections, search],
  );
  const expandableSections = renderedSections.filter((section) => section.kind !== 'flat');
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const searchCollapseKey = (sectionId: string) => `${normalizedSearch}\u0000${sectionId}`;
  const isSectionCollapsed = (sectionId: string) =>
    normalizedSearch ? searchCollapsed.has(searchCollapseKey(sectionId)) : collapsed.has(sectionId);
  const setSectionCollapsed = (sectionId: string, nextCollapsed: boolean) => {
    if (normalizedSearch)
      setSearchCollapsed((previous) => {
        const next = new Set(previous);
        const key = searchCollapseKey(sectionId);
        if (nextCollapsed) next.add(key);
        else next.delete(key);
        return next;
      });
    else
      setCollapsed((previous) => {
        const next = new Set(previous);
        if (nextCollapsed) next.add(sectionId);
        else next.delete(sectionId);
        return next;
      });
  };
  const allSectionsExpanded = expandableSections.length > 0 && expandableSections.every((section) => !isSectionCollapsed(section.id));
  const setAllSectionsExpanded = () => {
    const shouldExpand = !allSectionsExpanded;
    if (normalizedSearch)
      setSearchCollapsed((previous) => {
        const next = new Set(previous);
        for (const section of expandableSections) {
          const key = searchCollapseKey(section.id);
          if (shouldExpand) next.delete(key);
          else next.add(key);
        }
        return next;
      });
    else
      setCollapsed((previous) => {
        const next = new Set(previous);
        for (const section of expandableSections) {
          if (shouldExpand) next.delete(section.id);
          else next.add(section.id);
        }
        return next;
      });
  };
  const selectedOutsideView = [...selected].filter((id) => !skillOnCurrentView.has(id)).length;

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleMany = (ids: string[]) =>
    setSelected((prev) => {
      const unique = [...new Set(ids)];
      const allSelected = unique.length > 0 && unique.every((id) => prev.has(id));
      const next = new Set(prev);
      for (const id of unique) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });

  const beginSelection = () => {
    setSelectMode(true);
    setMenuOpen(false);
    setToast('多选已开启；选择技能、来源或分组，再统一应用。');
  };

  return {
    search,
    setSearch,
    searchRef,
    selectMode,
    setSelectMode,
    selected,
    setSelected,
    selectedCount,
    mode,
    activeTab,
    skillOnCurrentView,
    renderedSections,
    expandableSections,
    isSectionCollapsed,
    setSectionCollapsed,
    allSectionsExpanded,
    setAllSectionsExpanded,
    selectedOutsideView,
    toggleOne,
    toggleMany,
    beginSelection,
  };
}

export type LibraryView = ReturnType<typeof useLibraryView>;
