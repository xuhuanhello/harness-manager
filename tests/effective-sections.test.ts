import { describe, expect, it } from 'vitest';
import type { ExternalSkill, Group } from '../src/shared/types';
import type { ManagedHarnessEntry } from '../src/renderer/view-types';
import { buildEffectiveSections, effectiveCounts, effectiveSectionKey, effectiveSummary } from '../src/renderer/effective-sections';

const managed: ManagedHarnessEntry[] = [
  ['ten', 'tool10'],
  ['two', 'Tool2'],
  ['one', 'tool1'],
].map(([id, name]) => ({
  bindingId: id,
  path: `/agent/${name}`,
  skill: { id, name, description: '', sourceId: '', sourcePath: '', directory: '', baseHash: '', currentHash: '', installedAt: '' },
}));
const groups: Group[] = [
  { id: 'b', name: 'Beta', color: 'blue', skillIds: ['ten', 'two', 'outside'] },
  { id: 'a', name: 'Alpha', color: 'red', skillIds: ['two'] },
  { id: 'empty', name: 'Empty', color: 'green', skillIds: [] },
];
const external: ExternalSkill[] = ['external10', 'external2'].map((name) => ({
  id: name,
  name,
  path: `/agent/${name}`,
  description: '',
  harnessId: 'agent',
  scope: 'user',
}));

describe('effective Harness sections', () => {
  it('keeps group order and multi-group members, sorts names numerically and puts external skills last', () => {
    const sections = buildEffectiveSections({ groups }, managed, external);
    expect(sections.map(({ id, names, count }) => [id, names, count])).toEqual([
      ['group:b', ['Tool2', 'tool10'], 2],
      ['group:a', ['Tool2'], 1],
      ['managed:ungrouped', ['tool1'], 1],
      ['external', ['external2', 'external10'], 2],
    ]);
    expect(sections[0]).toMatchObject({ label: 'Beta', color: 'blue', kind: 'managed' });
    expect(sections[2].label).toBe('未分组');
    expect(sections[3]).toMatchObject({ label: '外部技能', kind: 'external' });
    expect(managed.map((item) => item.skill.name)).toEqual(['tool10', 'Tool2', 'tool1']);
    expect(external.map((item) => item.name)).toEqual(['external10', 'external2']);
  });

  it('uses the managed title only when no business groups exist', () => {
    expect(buildEffectiveSections({ groups: [] }, managed, [])[0]).toMatchObject({
      label: '中央库托管',
      names: ['tool1', 'Tool2', 'tool10'],
    });
    expect(buildEffectiveSections({ groups: [groups[2]] }, managed, [])[0].label).toBe('未分组');
  });

  it('omits every empty subsection, including ungrouped and external', () => {
    const allGrouped = [{ ...groups[0], skillIds: ['one', 'two', 'ten'] }, groups[2]];
    expect(buildEffectiveSections({ groups: allGrouped }, managed, []).map((section) => section.label)).toEqual(['Beta']);
    expect(buildEffectiveSections({ groups }, [], external).map((section) => section.label)).toEqual(['外部技能']);
    expect(buildEffectiveSections({ groups }, [], [])).toEqual([]);
  });

  it('counts unique managed skills across groups and installation entries without losing paths', () => {
    const entries = [...managed, { ...managed[1], bindingId: 'second-install', path: '/other/Tool2' }];
    const sections = buildEffectiveSections({ groups }, entries, external);
    expect(sections[0].entries).toHaveLength(3);
    expect(sections[0].names).toEqual(['Tool2', 'tool10']);
    expect(sections[0].count).toBe(2);
    const counts = effectiveCounts(entries, external);
    expect(counts).toEqual({ managed: 3, external: 2, total: 5 });
    expect(effectiveSummary('Test Agent', counts)).toBe('5 个技能在 Test Agent 中生效：3 个由中央技能库托管，2 个为外部技能。');
    expect(effectiveSummary('Test Agent', effectiveCounts(entries, []))).toBe('3 个技能在 Test Agent 中生效：3 个由中央技能库托管。');
    expect(effectiveSummary('Test Agent', effectiveCounts([], external))).toBe('2 个技能在 Test Agent 中生效：2 个为外部技能。');
  });

  it('isolates collapse state by Harness, scope, workspace and subsection without delimiter collisions', () => {
    const keys = [
      effectiveSectionKey('a', 'user', 'w', 'group:b'),
      effectiveSectionKey('b', 'user', 'w', 'group:b'),
      effectiveSectionKey('a', 'workspace', 'w', 'group:b'),
      effectiveSectionKey('a', 'user', 'other', 'group:b'),
      effectiveSectionKey('a', 'user', 'w', 'group:c'),
      effectiveSectionKey('a', 'user', 'w:group', 'b'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});
