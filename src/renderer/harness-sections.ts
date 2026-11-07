import { compareNames } from './i18n';
import { t } from './i18n';
import type { Skill, Snapshot } from '../shared/types';
import type { Section } from './view-types';

export type HarnessGroupBy = 'group' | 'source' | 'flat';

export function resolveHarnessGroupBy(groupBy: HarnessGroupBy, groupCount: number): HarnessGroupBy {
  return groupBy === 'group' && groupCount === 0 ? 'source' : groupBy;
}

/** User-level intents define membership; grouping and search only change its presentation. */
export function buildHarnessSections(
  snapshot: Snapshot,
  harnessId: string,
  groupBy: HarnessGroupBy = 'group',
  matches?: (skill: Skill) => boolean,
): Section[] {
  const bindingIds = new Set(
    snapshot.bindings.filter((binding) => binding.scope === 'user' && binding.harnessId === harnessId).map((binding) => binding.id),
  );
  const skillIds = new Set(snapshot.intents.filter((intent) => bindingIds.has(intent.bindingId)).map((intent) => intent.skillId));
  const skills = snapshot.skills.filter((skill) => skillIds.has(skill.id)).sort((a, b) => compareNames(a.name, b.name));
  const prefix = `harness:${harnessId}`;
  const grouping = resolveHarnessGroupBy(groupBy, snapshot.groups.length);
  let sections: Section[];
  if (grouping === 'flat') {
    sections = [{ id: `${prefix}:flat`, label: t('library.flatViewTitle'), kind: 'flat', skills }];
  } else if (grouping === 'source') {
    sections = snapshot.sources.map((source) => ({
      id: `${prefix}:source:${source.id}`,
      label: source.label,
      kind: 'source',
      icon: source.type,
      skills: skills.filter((skill) => skill.sourceId === source.id),
    }));
  } else {
    const grouped = new Set(snapshot.groups.flatMap((group) => group.skillIds));
    sections = snapshot.groups.map((group) => ({
      id: `${prefix}:group:${group.id}`,
      label: group.name,
      kind: 'group',
      icon: group.color,
      skills: skills.filter((skill) => group.skillIds.includes(skill.id)),
    }));
    sections.push({
      id: `${prefix}:group:ungrouped`,
      label: t('library.ungrouped'),
      kind: 'group',
      icon: 'neutral',
      skills: skills.filter((skill) => !grouped.has(skill.id)),
    });
  }
  return sections.flatMap((section) => {
    const filtered = matches ? section.skills.filter(matches) : section.skills;
    return filtered.length
      ? [
          {
            ...section,
            skills: filtered,
            meta: matches
              ? t('library.ofItemsMatch', { count: filtered.length, count2: section.skills.length })
              : t('library.itemCount', { count: filtered.length }),
          },
        ]
      : [];
  });
}
