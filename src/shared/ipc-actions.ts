/** Every IPC action name. Kept free of runtime dependencies so the preload bundle stays small. */
export const ACTIONS = [
  'detectHarnessInstallations',
  'previewHarnessCleanup',
  'cleanupHarness',
  'revealHarnessDirectory',
  'openSkillSource',
  'revealSkill',
  'revealExternalSkill',
  'revealDistribution',
  'appInfo',
  'appUpdateState',
  'checkAppUpdate',
  'downloadAppUpdate',
  'cancelAppUpdate',
  'installAppUpdate',
  'openAppUpdatePage',
  'openAppUpdateSettings',
  'snapshot',
  'migrationRepairs',
  'repairManagedLink',
  'previewMigrateExternal',
  'migrateExternal',
  'openMarketplace',
  'openMarketplaceSkill',
  'saveMarketplace',
  'deleteMarketplace',
  'marketplaceCatalog',
  'scan',
  'install',
  'checkUpdates',
  'applyUpdates',
  'saveGroup',
  'deleteGroup',
  'saveHarness',
  'setHarnessEnabled',
  'previewApply',
  'apply',
  'remove',
  'checkHealth',
  'saveSettings',
  'chooseDirectory',
] as const;

export type Action = (typeof ACTIONS)[number];

export function isAction(value: unknown): value is Action {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

export const CHANGED_CHANNEL = 'harness:changed';
export const APP_UPDATE_CHANNEL = 'harness:app-update';
export const INVOKE_CHANNEL = 'harness:invoke';
