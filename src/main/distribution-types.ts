import type { Distribution, Harness, Scope, Target, Workspace } from '../shared/types';

/** Records shared by applying, removing and migrating skills, including their journal entries. */
type AnyRecord = { id: string; [key: string]: unknown };

export interface ResolvedTarget {
  path: string;
  key: string;
  caseSensitive: boolean;
  scope: Scope;
  workspace?: Workspace;
  harnesses: Harness[];
}

export interface BindingEffect {
  id: string;
  targetId: string;
  harnessId: string;
  scope: Scope;
  workspaceId?: string;
}

export interface MigrationEntryPlan {
  path: string;
  target: Target;
  originalEntryKind: 'directory' | 'symlink';
  originalLinkText?: string;
  stagePath: string;
  backupPath: string;
  phase: 'planned' | 'staged' | 'old_moved' | 'new_placed';
  bindings: BindingEffect[];
}

export interface MigrationPlan {
  references: MigrationEntryPlan[];
  targets: Target[];
  bindings: BindingEffect[];
  originalSourcePath: string;
  sourceBackupPath: string;
  sourceMoved: boolean;
}

export interface ApplyEffects {
  target: Target;
  workspace?: Workspace;
  bindings: BindingEffect[];
  skillId: string;
}

export interface JournalOperation extends AnyRecord {
  owner: 'distribution';
  kind: 'apply' | 'remove' | 'migration';
  phase: 'planned' | 'staged' | 'old_moved' | 'new_placed' | 'cleanup' | 'committed' | 'failed' | 'blocked';
  createdAt: string;
  updatedAt: string;
  error?: string;
  skillId: string;
  targetId?: string;
  entryPath: string;
  sourcePath?: string;
  strategy?: 'symlink' | 'copy';
  newHash?: string;
  originalHash?: string;
  originalEntryKind?: 'directory' | 'symlink';
  originalLinkText?: string;
  originalTargetPath?: string;
  stagePath?: string;
  backupPath?: string;
  previousDistribution?: Distribution;
  effects?: ApplyEffects;
  bindingId?: string;
  removedIntentId?: string;
  removeIntentOnCommit?: boolean;
  migration?: MigrationPlan;
}
