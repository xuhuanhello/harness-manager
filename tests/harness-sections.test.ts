import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../src/shared/types';
import { buildHarnessSections, resolveHarnessGroupBy } from '../src/renderer/harness-sections';

function fixture(): Snapshot {
  return {
    libraryRoot: '/library',
    sources: ['local', 'github'].map((id) => ({ id, label: id, type: id === 'local' ? 'local' : 'github', uri: id, ref: '', commit: '' })),
    skills: [
      ['ten', 'tool10', 'local'],
      ['two', 'Tool2', 'github'],
      ['one', 'tool1', 'local'],
      ['outside', 'outside', 'github'],
    ].map(([id, name, sourceId]) => ({
      id,
      name,
      sourceId,
      description: '',
      sourcePath: '',
      directory: '',
      baseHash: '',
      currentHash: '',
      installedAt: '',
    })),
    groups: [
      { id: 'b', name: 'Beta', color: 'blue', skillIds: ['ten', 'two', 'outside'] },
      { id: 'a', name: 'Alpha', color: 'red', skillIds: ['two'] },
      { id: 'empty', name: 'Empty', color: 'green', skillIds: [] },
    ],
    harnesses: [],
    marketplaces: [],
    workspaces: [],
    targets: [],
    distributions: [],
    externalSkills: [],
    bindings: [
      { id: 'user', harnessId: 'agent', scope: 'user', targetId: 'target' },
      { id: 'workspace', harnessId: 'agent', scope: 'workspace', targetId: 'workspace' },
      { id: 'other', harnessId: 'other', scope: 'user', targetId: 'other' },
    ],
    intents: [
      ...['ten', 'two', 'one'].map((skillId) => ({ id: skillId, skillId, bindingId: 'user' })),
      { id: 'workspace', skillId: 'outside', bindingId: 'workspace' },
      { id: 'other', skillId: 'outside', bindingId: 'other' },
      { id: 'duplicate', skillId: 'two', bindingId: 'user' },
    ],
    settings: { locale: 'system', viewMode: 'harness', activeTabs: {} },
  };
}

describe('Harness sections', () => {
  it('defaults to business groups in snapshot order with numeric name sorting and repeated multi-group members', () => {
    const sections = buildHarnessSections(fixture(), 'agent');
    expect(sections.map((section) => [section.id, section.kind, section.skills.map((skill) => skill.name), section.meta])).toEqual([
      ['harness:agent:group:b', 'group', ['Tool2', 'tool10'], '2 项'],
      ['harness:agent:group:a', 'group', ['Tool2'], '1 项'],
      ['harness:agent:group:ungrouped', 'group', ['tool1'], '1 项'],
    ]);
    expect(sections.at(-1)).toMatchObject({ label: '未分组', icon: 'neutral' });
  });

  it('omits empty groups and omits ungrouped when every Harness skill is grouped', () => {
    const snapshot = fixture();
    snapshot.groups[0].skillIds.push('one');
    expect(buildHarnessSections(snapshot, 'agent').map((section) => section.label)).toEqual(['Beta', 'Alpha']);
  });

  it('falls back to sources when no groups exist', () => {
    const snapshot = fixture();
    snapshot.groups = [];
    expect(buildHarnessSections(snapshot, 'agent')).toEqual(buildHarnessSections(snapshot, 'agent', 'source'));
  });

  it('exposes the effective grouping without changing the preferred grouping', () => {
    expect(resolveHarnessGroupBy('group', 0)).toBe('source');
    expect(resolveHarnessGroupBy('group', 1)).toBe('group');
    expect(resolveHarnessGroupBy('source', 0)).toBe('source');
    expect(resolveHarnessGroupBy('flat', 0)).toBe('flat');
  });

  it('preserves source order, icons and sorts each source independently', () => {
    expect(
      buildHarnessSections(fixture(), 'agent', 'source').map((section) => [
        section.id,
        section.icon,
        section.skills.map((skill) => skill.name),
      ]),
    ).toEqual([
      ['harness:agent:source:local', 'local', ['tool1', 'tool10']],
      ['harness:agent:source:github', 'github', ['Tool2']],
    ]);
  });

  it('filters searches, omits empty matches and counts the full Harness section membership', () => {
    const sections = buildHarnessSections(fixture(), 'agent', 'group', (skill) => skill.id === 'two');
    expect(sections.map((section) => [section.label, section.meta])).toEqual([
      ['Beta', '匹配 1 / 2 项'],
      ['Alpha', '匹配 1 / 1 项'],
    ]);
    expect(buildHarnessSections(fixture(), 'agent', 'source', () => false)).toEqual([]);
  });

  it('uses flat sections without headers and isolates IDs by Harness and grouping', () => {
    const snapshot = fixture();
    expect(buildHarnessSections(snapshot, 'agent', 'flat')).toMatchObject([
      { id: 'harness:agent:flat', kind: 'flat', meta: '3 项', skills: [{ name: 'tool1' }, { name: 'Tool2' }, { name: 'tool10' }] },
    ]);
    expect(buildHarnessSections(snapshot, 'other', 'group')[0].id).toBe('harness:other:group:b');
    expect(buildHarnessSections(snapshot, 'missing')).toEqual([]);
    expect(buildHarnessSections(snapshot, 'agent', 'flat', (skill) => skill.id === 'one')[0].meta).toBe('匹配 1 / 3 项');
  });
});
