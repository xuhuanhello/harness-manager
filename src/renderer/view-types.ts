import type { BatchResult, Distribution, ManagedLinkRepairPreview, Scope, Skill } from '../shared/types';

/** View-state types shared by the app shell and its pages. */
export type Page = 'library' | 'agent-harness' | 'marketplace' | 'workspaces' | 'settings';

export type Dialog =
  | 'add-source'
  | 'apply'
  | 'onboarding'
  | 'harness-form'
  | 'selected'
  | 'remove'
  | 'migrate-external'
  | 'marketplace-form'
  | 'marketplace-remove'
  | 'updates'
  | null;

export type Section = {
  id: string;
  label: string;
  kind: 'source' | 'group' | 'harness' | 'flat';
  skills: Skill[];
  icon?: string;
  meta?: string;
};

export type ApplyMode = 'group' | 'harness';

export type ApplyDraft = { mode: ApplyMode; scope: Scope; harnessIds: string[]; workspacePath: string; strategy: 'symlink' | 'copy' };

export type RemovalDraft = { bindingId: string; harnessName: string; skillIds: string[]; skillNames: string[] };

export type SourceInstallOptions = { createDetectedGroups?: boolean; customGroupName?: string; mergeExistingGroups?: boolean };

export type ManagedRepairOutcome = { repair: ManagedLinkRepairPreview; result?: BatchResult; error?: string };

export type ManagedHarnessEntry = { inheritedFrom?: string; bindingId: string; skill: Skill; distribution?: Distribution; path: string };
