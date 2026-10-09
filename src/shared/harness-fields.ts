import type { Harness } from './types';

/**
 * Every configurable Harness field belongs to exactly one group. Adding a field to `Harness`
 * means adding it here, which updates built-in locking, custom saves and detection caching.
 */

/** Skill directories and compatibility rules. Fixed by the registry for built-ins. */
export const HARNESS_RULE_FIELDS = [
  'name',
  'icon',
  'userSkillsPath',
  'workspaceSkillsRelativePath',
  'kind',
  'readsUserAgents',
  'readsWorkspaceAgents',
  'command',
  'versionArgs',
  'extraUserSkillsPaths',
  'extraWorkspaceSkillsRelativePaths',
  'documentationUrl',
] as const satisfies ReadonlyArray<keyof Harness>;

/** Product identity used by installation detection. Fixed by the registry for built-ins. */
export const HARNESS_IDENTITY_FIELDS = ['extensionIds', 'appBundleIds'] as const satisfies ReadonlyArray<keyof Harness>;

/** Local discovery candidates that users may add to, including for built-ins. */
export const HARNESS_DETECTION_FIELDS = ['executablePaths', 'appPaths', 'extensionRoots'] as const satisfies ReadonlyArray<keyof Harness>;

/** Fields a built-in record never accepts changes to. */
export const BUILTIN_LOCKED_FIELDS = [...HARNESS_RULE_FIELDS, ...HARNESS_IDENTITY_FIELDS] as const;

/** Everything that defines a Harness, including state. Used to detect stale cached detection results. */
export const HARNESS_DEFINITION_FIELDS = [
  'id',
  'origin',
  'enabled',
  ...HARNESS_RULE_FIELDS,
  ...HARNESS_IDENTITY_FIELDS,
  ...HARNESS_DETECTION_FIELDS,
] as const satisfies ReadonlyArray<keyof Harness>;

type AssertNever<T extends never> = T;
/** Compile-time check that no Harness field is left out of the groups above. */
export type HarnessFieldsCovered = AssertNever<Exclude<keyof Harness, (typeof HARNESS_DEFINITION_FIELDS)[number]>>;
