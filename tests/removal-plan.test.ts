import { describe, expect, it } from 'vitest';
import type { BatchResult, Snapshot } from '../src/shared/types';
import { mergeBatchResults, planHarnessRemoval, pruneSelection } from '../src/renderer/removal-plan';

function fixture(): Snapshot {
  return {
    libraryRoot: '/library',
    sources: [],
    groups: [],
    marketplaces: [],
    workspaces: [],
    distributions: [],
    externalSkills: [],
    skills: [
      ['one', 'tool1'],
      ['two', 'Tool2'],
      ['ten', 'tool10'],
      ['outside', 'outside'],
    ].map(([id, name]) => ({
      id,
      name,
      sourceId: '',
      description: '',
      sourcePath: '',
      directory: '',
      baseHash: '',
      currentHash: '',
      installedAt: '',
    })),
    harnesses: ['agent', 'other'].map((id) => ({
      id,
      name: id === 'agent' ? 'Agent' : 'Other Agent',
      icon: '',
      userSkillsPath: '',
      workspaceSkillsRelativePath: '',
      origin: 'custom',
    })),
    targets: [
      { id: 'shared', path: '/shared/skills' },
      { id: 'legacy', path: '/legacy/skills' },
    ],
    bindings: [
      { id: 'a', harnessId: 'agent', scope: 'user', targetId: 'shared' },
      { id: 'b', harnessId: 'agent', scope: 'user', targetId: 'legacy' },
      { id: 'c', harnessId: 'other', scope: 'user', targetId: 'shared' },
      { id: 'd', harnessId: 'agent', scope: 'workspace', targetId: 'workspace' },
    ],
    intents: [
      { id: '1', bindingId: 'a', skillId: 'ten' },
      { id: '2', bindingId: 'a', skillId: 'two' },
      { id: '3', bindingId: 'b', skillId: 'one' },
      { id: '4', bindingId: 'b', skillId: 'two' },
      { id: '5', bindingId: 'c', skillId: 'two' },
      { id: '6', bindingId: 'c', skillId: 'outside' },
      { id: '7', bindingId: 'd', skillId: 'outside' },
    ],
    settings: { locale: 'system', viewMode: 'harness', activeTabs: {} },
  };
}

describe('Harness removal planning', () => {
  it('splits by user binding, deduplicates selected IDs and sorts names numerically', () => {
    const plan = planHarnessRemoval(fixture(), 'agent', ['two', 'ten', 'one', 'two']);
    expect(plan.parts).toEqual([
      { bindingId: 'a', skillIds: ['ten', 'two'] },
      { bindingId: 'b', skillIds: ['one', 'two'] },
    ]);
    expect(new Set(plan.skillIds)).toEqual(new Set(['one', 'two', 'ten']));
    expect(plan.skills).toEqual([
      { id: 'one', name: 'tool1' },
      { id: 'two', name: 'Tool2' },
      { id: 'ten', name: 'tool10' },
    ]);
    expect(plan.outsideCount).toBe(0);
  });

  it('retains distinct IDs for skills with the same name', () => {
    const snapshot = fixture();
    snapshot.skills.find((skill) => skill.id === 'two')!.name = 'tool1';
    expect(planHarnessRemoval(snapshot, 'agent', ['one', 'two']).skills).toEqual([
      { id: 'two', name: 'tool1' },
      { id: 'one', name: 'tool1' },
    ]);
  });

  it('counts selected skills outside this Harness including workspace-only and missing skills', () => {
    const plan = planHarnessRemoval(fixture(), 'agent', new Set(['one', 'outside', 'missing']));
    expect(plan.parts).toEqual([{ bindingId: 'b', skillIds: ['one'] }]);
    expect(plan.outsideCount).toBe(2);
    expect(planHarnessRemoval(fixture(), 'missing', ['one']).parts).toEqual([]);
    expect(planHarnessRemoval(fixture(), 'agent', []).outsideCount).toBe(0);
  });

  it('counts shared skills once and names the directory and other Harness', () => {
    const plan = planHarnessRemoval(fixture(), 'agent', ['two', 'ten']);
    expect(plan.sharedCount).toBe(1);
    expect(plan.sharedNotes).toEqual(['1 项所在目录 /shared/skills 同时被「Other Agent」使用：只解除 Agent 的绑定，文件会保留。']);
    expect(planHarnessRemoval(fixture(), 'agent', ['one']).sharedNotes).toEqual([]);
  });

  it('does not predict retained files when all bindings sharing a directory are being removed', () => {
    const snapshot = fixture();
    snapshot.bindings[1].targetId = 'shared';
    snapshot.intents = snapshot.intents.filter((intent) => intent.bindingId !== 'c');
    expect(planHarnessRemoval(snapshot, 'agent', ['two']).sharedCount).toBe(0);
  });
});

describe('removal results', () => {
  const success: BatchResult = { items: [{ id: 'a', label: 'A', status: 'success' }] };
  const failure: BatchResult = {
    items: [
      { id: 'b', label: 'B', status: 'error', message: 'Failed' },
      { id: 'c', label: 'C', status: 'skipped' },
    ],
  };

  it('merges results in order including empty batches', () => {
    expect(mergeBatchResults([success, failure])).toEqual({ items: [...success.items, ...failure.items] });
    expect(mergeBatchResults([])).toEqual({ items: [] });
  });

  it('keeps the worst outcome for skills appearing in multiple bindings', () => {
    const incomplete: BatchResult = { items: [{ id: 'a', label: 'A', status: 'skipped' }] };
    const failed: BatchResult = { items: [{ id: 'a', label: 'A', status: 'error', message: 'Failed' }] };
    expect(mergeBatchResults([success, incomplete]).items[0].status).toBe('skipped');
    expect(mergeBatchResults([failed, incomplete, success])).toEqual(failed);
  });

  it('prunes only successful skills without mutating selection or dropping outside skills', () => {
    const selected = new Set(['a', 'b', 'c', 'outside']);
    expect(pruneSelection(selected, mergeBatchResults([success, failure]))).toEqual(new Set(['b', 'c', 'outside']));
    expect(selected.size).toBe(4);
    expect(pruneSelection(selected, { items: [...success.items, { id: 'a', label: 'A', status: 'error' }] })).toEqual(selected);
  });
});
