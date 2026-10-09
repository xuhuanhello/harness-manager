import { isHarnessEnabled } from '../shared/harness-enabled';
import type { Binding, Distribution, Harness, Skill } from '../shared/types';
import { hashDirectory } from './content';
import { verifyDistributionEntry } from './entries';
import { inspectEntry } from './fs-utils';
import type { Store } from './store';

/** Refreshes central skill hashes and the health of every managed entry. */
export class HealthService {
  constructor(private readonly store: Store) {}

  /**
   * `rehashSkills: false` trusts the stored central hashes; use it only while the library watcher is
   * live, since the watcher is what keeps those hashes current.
   */
  async checkHealth(skillIds?: string[], options: { rehashSkills?: boolean } = {}): Promise<void> {
    const skills = this.store.list<Skill>('skills');
    const requestedSkills = skillIds ? new Set(skillIds) : undefined;
    const sourceHashes = new Map<string, string>();
    for (const skill of skills) {
      if (requestedSkills && !requestedSkills.has(skill.id)) continue;
      if (options.rehashSkills === false) {
        sourceHashes.set(skill.id, skill.currentHash);
        continue;
      }
      try {
        const currentHash = await hashDirectory(skill.directory);
        sourceHashes.set(skill.id, currentHash);
        if (skill.currentHash !== currentHash) {
          const updatedSkill: Skill = { ...skill, currentHash };
          this.store.put('skills', updatedSkill);
        }
      } catch {
        // A missing or unreadable source is reported on its distributions below.
      }
    }
    const enabledHarnessIds = new Set(
      this.store
        .list<Harness>('harnesses')
        .filter(isHarnessEnabled)
        .map((harness) => harness.id),
    );
    const activeTargetIds = new Set(
      this.store
        .list<Binding>('bindings')
        .filter((binding) => enabledHarnessIds.has(binding.harnessId))
        .map((binding) => binding.targetId),
    );
    const changed: Distribution[] = [];
    for (const distribution of this.store.list<Distribution>('distributions')) {
      if (!activeTargetIds.has(distribution.targetId)) continue;
      if (requestedSkills && !requestedSkills.has(distribution.skillId)) continue;
      const skill = this.store.get<Skill>('skills', distribution.skillId);
      let health: Distribution['health'] = 'missing';
      let newHash = distribution.lastWrittenHash;
      try {
        if (!skill) {
          health = 'broken';
        } else {
          const entry = await inspectEntry(distribution.entryPath);
          if (!entry.exists) {
            health = 'missing';
          } else {
            const result = await verifyDistributionEntry(
              this.store,
              distribution,
              skill,
              distribution.entryPath,
              sourceHashes.get(skill.id),
            );
            health = result.health;
            if (distribution.strategy === 'symlink' && result.ok && result.actualHash) newHash = result.actualHash;
          }
        }
      } catch {
        health = 'conflict';
      }
      if (health !== distribution.health || newHash !== distribution.lastWrittenHash) {
        changed.push({ ...distribution, health, lastWrittenHash: newHash });
      }
    }
    if (changed.length) {
      this.store.transaction(() => {
        for (const distribution of changed) this.store.put('distributions', distribution);
      });
    }
  }
}
