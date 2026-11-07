import { formatList } from './i18n';
import { compareNames } from './i18n';
import { t } from './i18n';
import type { BatchResult, ItemResult, Snapshot } from '../shared/types';

/** Plan only this Harness's user bindings, regardless of search or duplicate group rows. */
export function planHarnessRemoval(snapshot: Snapshot, harnessId: string, selectedIds: Iterable<string>) {
  const selected = new Set(selectedIds);
  const bindings = snapshot.bindings.filter((binding) => binding.harnessId === harnessId && binding.scope === 'user');
  const parts = bindings.flatMap((binding) => {
    const skillIds = [
      ...new Set(
        snapshot.intents
          .filter((intent) => intent.bindingId === binding.id && selected.has(intent.skillId))
          .map((intent) => intent.skillId),
      ),
    ];
    return skillIds.length ? [{ bindingId: binding.id, skillIds }] : [];
  });
  const skillIds = [...new Set(parts.flatMap((part) => part.skillIds))];
  const skills = skillIds
    .map((id) => ({ id, name: snapshot.skills.find((skill) => skill.id === id)?.name || id }))
    .sort((a, b) => compareNames(a.name, b.name));
  const removingBindings = new Set(bindings.map((binding) => binding.id));
  const sharedIds = new Set<string>();
  const sharedNotes: string[] = [];
  const harnessName = snapshot.harnesses.find((harness) => harness.id === harnessId)?.name || 'Harness';
  for (const targetId of new Set(bindings.map((binding) => binding.targetId))) {
    const targetBindings = new Set(bindings.filter((binding) => binding.targetId === targetId).map((binding) => binding.id));
    const targetSkills = new Set(parts.filter((part) => targetBindings.has(part.bindingId)).flatMap((part) => part.skillIds));
    const others = snapshot.bindings.filter((binding) => binding.targetId === targetId && !removingBindings.has(binding.id));
    const shared = new Set<string>();
    const names = new Set<string>();
    for (const other of others) {
      const intents = snapshot.intents.filter((intent) => intent.bindingId === other.id && targetSkills.has(intent.skillId));
      if (!intents.length) continue;
      names.add(snapshot.harnesses.find((harness) => harness.id === other.harnessId)?.name || other.harnessId);
      for (const intent of intents) {
        shared.add(intent.skillId);
        sharedIds.add(intent.skillId);
      }
    }
    if (shared.size) {
      const path = snapshot.targets.find((target) => target.id === targetId)?.path || targetId;
      sharedNotes.push(
        t('dialogs.itemsInAreAlsoUsedByOnlyTheBindingWill', {
          size: shared.size,
          path: path,
          value: formatList(names),
          harnessName: harnessName,
        }),
      );
    }
  }
  return { parts, skillIds, skills, outsideCount: selected.size - skillIds.length, sharedCount: sharedIds.size, sharedNotes };
}

/** One skill may span bindings. Keep its worst outcome so incomplete removals stay selected. */
export function mergeBatchResults(results: BatchResult[]): BatchResult {
  const items = new Map<string, ItemResult>();
  const priority = { success: 0, skipped: 1, error: 2 };
  for (const result of results) {
    for (const item of result.items) {
      const previous = items.get(item.id);
      if (!previous || priority[item.status] > priority[previous.status]) items.set(item.id, item);
    }
  }
  return { items: [...items.values()] };
}

export function pruneSelection(selected: Set<string>, result: BatchResult): Set<string> {
  const next = new Set(selected);
  for (const item of mergeBatchResults([result]).items) {
    if (item.status === 'success') next.delete(item.id);
  }
  return next;
}
