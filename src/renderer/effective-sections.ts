import { compareNames } from './i18n';
import { t } from './i18n';
import type { ExternalSkill, Scope, Snapshot } from '../shared/types';
import type { ManagedHarnessEntry } from './view-types';

export const effectiveLabels = {
  get title() {
    return t('agentHarness.effectiveSkills');
  },
  get ungrouped() {
    return t('agentHarness.ungrouped');
  },
  get managed() {
    return t('agentHarness.libraryManaged');
  },
  get external() {
    return t('agentHarness.externalSkills');
  },
};

export type EffectiveSection =
  | { id: string; label: string; kind: 'managed'; color: string; entries: ManagedHarnessEntry[]; names: string[]; count: number }
  | { id: string; label: string; kind: 'external'; entries: ExternalSkill[]; names: string[]; count: number };

/** Keep installation entries for their paths, but count each managed skill only once. */
export function effectiveCounts(managed: ManagedHarnessEntry[], external: ExternalSkill[]) {
  const managedCount = new Set(managed.map((entry) => entry.skill.id)).size;
  return { managed: managedCount, external: external.length, total: managedCount + external.length };
}

export function effectiveSummary(harnessName: string, counts: ReturnType<typeof effectiveCounts>) {
  const parts = [
    counts.managed ? t('agentHarness.managedByTheLibrary', { managed: counts.managed }) : '',
    counts.external ? t('agentHarness.external', { external: counts.external }) : '',
  ].filter(Boolean);
  return t('agentHarness.skillsAvailableIn', {
    total: counts.total,
    harnessName: harnessName,
    value: parts.join(t('agentHarness.summarySeparator')),
  });
}

export function effectiveSectionKey(harnessId: string, scope: Scope, workspaceId: string, sectionId: string) {
  return JSON.stringify([harnessId, scope, workspaceId, sectionId]);
}

export function buildEffectiveSections(
  snapshot: Pick<Snapshot, 'groups'>,
  managed: ManagedHarnessEntry[],
  external: ExternalSkill[],
): EffectiveSection[] {
  const sorted = [...managed].sort((a, b) => compareNames(a.skill.name, b.skill.name));
  const section = (id: string, label: string, color: string, entries: ManagedHarnessEntry[]): EffectiveSection => ({
    id,
    label,
    kind: 'managed',
    color,
    entries,
    names: [...new Map(entries.map((entry) => [entry.skill.id, entry.skill.name])).values()],
    count: new Set(entries.map((entry) => entry.skill.id)).size,
  });
  const grouped = new Set(snapshot.groups.flatMap((group) => group.skillIds));
  const sections = snapshot.groups.map((group) =>
    section(
      `group:${group.id}`,
      group.name,
      group.color,
      sorted.filter((entry) => group.skillIds.includes(entry.skill.id)),
    ),
  );
  sections.push(
    section(
      'managed:ungrouped',
      snapshot.groups.length ? effectiveLabels.ungrouped : effectiveLabels.managed,
      'neutral',
      sorted.filter((entry) => !grouped.has(entry.skill.id)),
    ),
  );
  if (external.length) {
    const entries = [...external].sort((a, b) => compareNames(a.name, b.name));
    sections.push({
      id: 'external',
      label: effectiveLabels.external,
      kind: 'external',
      entries,
      names: entries.map((item) => item.name),
      count: entries.length,
    });
  }
  return sections.filter((item) => item.entries.length > 0);
}
