export type ViewMode = 'source' | 'harness' | 'group' | 'flat';
export type Strategy = 'symlink' | 'copy';
export type Scope = 'user' | 'workspace';
export interface Source {
  id: string;
  uri: string;
  type: 'github' | 'local';
  ref: string;
  commit: string;
  label: string;
  subpath?: string;
}
export interface Skill {
  id: string;
  name: string;
  description: string;
  sourceId: string;
  sourcePath: string;
  directory: string;
  baseHash: string;
  currentHash: string;
  installedAt: string;
  resolvedCommit?: string;
  upstreamSignal?: { algo: string; value: string };
}
export interface Group {
  id: string;
  name: string;
  skillIds: string[];
  color: string;
}
export interface HarnessCapabilities {
  enabled?: boolean;
  kind?: 'cli' | 'desktop' | 'universal';
  readsUserAgents?: boolean;
  readsWorkspaceAgents?: boolean;
  command?: string;
  versionArgs?: string[];
  executablePaths?: string[];
  appPaths?: string[];
  appBundleIds?: string[];
  extensionIds?: string[];
  extensionRoots?: string[];
  documentationUrl?: string;
  extraUserSkillsPaths?: string[];
  extraWorkspaceSkillsRelativePaths?: string[];
}
export interface Harness extends HarnessCapabilities {
  id: string;
  name: string;
  icon: string;
  userSkillsPath: string;
  workspaceSkillsRelativePath: string;
  origin: 'builtin' | 'custom';
}
export interface Marketplace {
  id: string;
  name: string;
  url: string;
  origin: 'builtin' | 'custom';
}
export interface MarketplaceSkill {
  id: string;
  source: string;
  skillId: string;
  name: string;
  installs?: number;
  stars?: number;
  description?: string;
  /** The skill's page on the marketplace website, when the marketplace has one. */
  url?: string;
}
export interface MarketplaceCatalogRequest {
  marketplaceId?: 'skills-sh' | 'skillsmp';
  query?: string;
  board?: 'all-time' | 'trending' | 'hot';
  page?: number;
  refresh?: boolean;
}
export interface MarketplaceCatalog {
  skills: MarketplaceSkill[];
  fetchedAt: string;
  cached: boolean;
  page: number;
  pageSize: number;
  hasMore: boolean;
  total?: number;
}
export interface Workspace {
  id: string;
  path: string;
  name: string;
}
export interface Target {
  id: string;
  path: string;
}
export interface Binding {
  id: string;
  targetId: string;
  harnessId: string;
  scope: Scope;
  workspaceId?: string;
}
export interface Intent {
  id: string;
  bindingId: string;
  skillId: string;
}
export interface Distribution {
  id: string;
  skillId: string;
  targetId: string;
  entryPath: string;
  strategy: Strategy;
  lastWrittenHash: string;
  health: 'healthy' | 'missing' | 'broken' | 'stale' | 'conflict';
  verification: 'untested' | 'passed' | 'failed';
}
export interface ExternalSkill {
  inheritedFrom?: string;
  id: string;
  name: string;
  description: string;
  path: string;
  harnessId: string;
  scope: Scope;
  workspaceId?: string;
}
export interface Settings {
  viewMode: ViewMode;
  activeTabs: Record<string, string>;
}
export interface VisibleManagedSkill {
  harnessId: string;
  scope: Scope;
  workspaceId?: string;
  distributionId: string;
  inheritedFrom?: string;
}
export interface Snapshot {
  visibleManagedSkills?: VisibleManagedSkill[];
  visibleExternalSkills?: ExternalSkill[];
  libraryRoot: string;
  sources: Source[];
  skills: Skill[];
  groups: Group[];
  harnesses: Harness[];
  marketplaces: Marketplace[];
  workspaces: Workspace[];
  targets: Target[];
  bindings: Binding[];
  intents: Intent[];
  distributions: Distribution[];
  externalSkills: ExternalSkill[];
  settings: Settings;
  issues?: { id: string; message: string }[];
}
export interface ScanRequest {
  uri: string;
  ref?: string;
  subpath?: string;
}
export interface Candidate {
  id: string;
  name: string;
  description: string;
  path: string;
  issues: string[];
  installed: boolean;
}
export interface ScanResult {
  id: string;
  source: Source;
  candidates: Candidate[];
}
export interface InstallRequest {
  scanId: string;
  candidateIds: string[];
  createDetectedGroups?: boolean;
  customGroupName?: string;
  mergeExistingGroups?: boolean;
}
export interface ItemResult {
  id: string;
  label: string;
  status: 'success' | 'skipped' | 'error';
  message?: string;
}
export interface BatchResult {
  items: ItemResult[];
  skillIds?: string[];
}
export interface ApplyRequest {
  skillIds: string[];
  harnessIds: string[];
  scope: Scope;
  workspacePath?: string;
  strategy: Strategy;
}
export interface PlanItem {
  skillId: string;
  skillName: string;
  targetPath: string;
  harnessIds: string[];
  status: 'new' | 'existing' | 'sync' | 'conflict';
  message?: string;
}
export interface ApplyPlan {
  request: ApplyRequest;
  items: PlanItem[];
}
/** An installed skill whose upstream content differs from what was last installed or updated. */
export interface SkillUpdate {
  skillId: string;
  name: string;
  /** The upstream description, which may differ from the installed one. */
  description: string;
  /** The central copy was edited after it was installed; updating moves those edits to the trash. */
  localModified: boolean;
  /** Why this update cannot be applied in the app. */
  blocked?: string;
}
export interface SourceUpdates {
  sourceId: string;
  /** The upstream commit that was compared, for GitHub sources. */
  commit?: string;
  updates: SkillUpdate[];
  /** Installed skills whose directory no longer exists upstream. Their central copies are kept. */
  missing: string[];
  error?: string;
}
export interface UpdateCheck {
  id: string;
  checkedAt: string;
  sources: SourceUpdates[];
}
export interface UpdateRequest {
  checkId: string;
  skillIds: string[];
  /** Selected skills whose local edits the user agreed to replace. */
  replaceModified?: string[];
}
export interface HarnessInput extends HarnessCapabilities {
  id?: string;
  name: string;
  icon?: string;
  userSkillsPath: string;
  workspaceSkillsRelativePath: string;
}
export interface MarketplaceInput {
  id?: string;
  name: string;
  url: string;
}
export interface GroupInput {
  name?: string;
  groupId?: string;
  skillIds: string[];
}
export interface RemoveRequest {
  bindingId: string;
  skillIds: string[];
}
export interface ExternalMigrationReference {
  path: string;
  harnessId: string;
  harnessName: string;
  scope: Scope;
  workspaceId?: string;
  workspaceName?: string;
}
export interface ExternalMigrationPreview {
  previewId: string;
  externalSkillId: string;
  skillName: string;
  sourcePath: string;
  centralPath: string;
  references: ExternalMigrationReference[];
}
export interface ManagedLinkRepairPreview {
  repairId: string;
  distributionId: string;
  skillName: string;
  entryPath: string;
  currentTarget: string;
  centralPath: string;
}
