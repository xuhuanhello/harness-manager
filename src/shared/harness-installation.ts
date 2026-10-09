export type HarnessInstallationStatus = 'installed' | 'not-found' | 'unknown';
export type HarnessInstallationMethod = 'version-command' | 'app-bundle' | 'editor-extension';
export type ResidualDirectoryClassification =
  | 'empty'
  | 'symlink-only'
  | 'contains-data'
  | 'protected'
  | 'active'
  | 'central-library'
  | 'missing'
  | 'unknown';

export interface ResidualDirectory {
  harnessId: string;
  path: string;
  scope: 'user' | 'workspace';
  workspaceId?: string;
  classification: ResidualDirectoryClassification;
  canTrash: boolean;
  detail: string;
}

export interface HarnessInstallationResult {
  harnessId: string;
  status: HarnessInstallationStatus;
  checkedAt: string;
  method?: HarnessInstallationMethod;
  executable?: string;
  version?: string;
  reason?: string;
  residualDirectories: ResidualDirectory[];
}

export interface HarnessCleanupPreview {
  token?: string;
  harnessId: string;
  path: string;
  classification: ResidualDirectoryClassification;
  canTrash: boolean;
  reason: string;
  expiresAt?: string;
}

export interface HarnessCleanupResult {
  harnessId: string;
  path: string;
  status: 'trashed';
}
