import { z } from 'zod';
import type { HarnessCleanupPreview, HarnessCleanupResult, HarnessInstallationResult } from './harness-installation';
import type { Action } from './ipc-actions';
import { CONTROL_CHARACTERS, ID_PATTERNS, LIMITS } from './limits';
import type {
  ApplyPlan,
  BatchResult,
  ExternalMigrationPreview,
  Group,
  Harness,
  ManagedLinkRepairPreview,
  Marketplace,
  MarketplaceCatalog,
  ScanResult,
  Snapshot,
  UpdateCheck,
} from './types';

/**
 * The IPC contract: one input schema and one output type per action. The renderer API type,
 * the preload bridge and the main-process routes are all derived from or checked against it.
 * Imported at runtime only by the main process; the renderer uses its types.
 */

z.config(z.locales.zhCN());

const visible = (value: string) => !CONTROL_CHARACTERS.test(value);
const id = z.string().trim().min(1).max(LIMITS.idLength);
const ids = z.array(id).min(1).max(LIMITS.selection);
const patterned = (pattern: RegExp) => z.string().regex(pattern);
const harnessId = patterned(ID_PATTERNS.harness);
const path = z.string().min(1).max(LIMITS.pathLength);
const pathList = z.array(z.string().max(LIMITS.pathLength)).max(LIMITS.pathListEntries);
const identityList = z.array(z.string().max(LIMITS.identityLength)).max(LIMITS.identityEntries);
const name = z.string().trim().min(1).max(LIMITS.nameLength).refine(visible);

const applyInput = z
  .object({
    skillIds: ids,
    harnessIds: z.array(harnessId).min(1).max(LIMITS.selection),
    scope: z.enum(['user', 'workspace']),
    workspacePath: z.string().trim().min(1).max(LIMITS.pathLength).optional(),
    strategy: z.enum(['symlink', 'copy']),
  })
  .strict();

interface ActionDef<I extends z.ZodType = z.ZodType, O = unknown> {
  input: I;
  /** Type-level only. */
  output?: O;
}
const action =
  <O>() =>
  <I extends z.ZodType>(input: I): ActionDef<I, O> => ({ input });

export const contract = {
  detectHarnessInstallations: action<HarnessInstallationResult[]>()(z.object({ refresh: z.boolean().optional() }).strict().optional()),
  previewHarnessCleanup: action<HarnessCleanupPreview>()(z.object({ harnessId, path }).strict()),
  cleanupHarness: action<HarnessCleanupResult>()(z.object({ token: id }).strict()),
  revealHarnessDirectory: action<void>()(z.object({ harnessId, path }).strict()),
  openSkillSource: action<void>()(z.object({ skillId: id }).strict()),
  revealSkill: action<void>()(z.object({ skillId: id }).strict()),
  snapshot: action<Snapshot>()(z.undefined()),
  migrationRepairs: action<ManagedLinkRepairPreview[]>()(z.object({ externalSkillId: id }).strict()),
  repairManagedLink: action<BatchResult>()(z.object({ repairId: id }).strict()),
  previewMigrateExternal: action<ExternalMigrationPreview>()(z.object({ externalSkillId: patterned(ID_PATTERNS.external) }).strict()),
  migrateExternal: action<BatchResult>()(z.object({ externalSkillId: patterned(ID_PATTERNS.external), previewId: id }).strict()),
  openMarketplace: action<void>()(z.object({ marketplaceId: id }).strict().optional()),
  openMarketplaceSkill: action<void>()(
    z.object({ marketplaceId: z.enum(['skills-sh', 'skillsmp']), url: z.string().trim().min(1).max(LIMITS.urlLength) }).strict(),
  ),
  saveMarketplace: action<Marketplace>()(
    z.object({ id: id.optional(), name, url: z.string().trim().min(1).max(LIMITS.urlLength) }).strict(),
  ),
  deleteMarketplace: action<void>()(id),
  marketplaceCatalog: action<MarketplaceCatalog>()(
    z
      .object({
        marketplaceId: z.enum(['skills-sh', 'skillsmp']).optional(),
        query: z.string().max(LIMITS.searchQueryLength).optional(),
        board: z.enum(['all-time', 'trending', 'hot']).optional(),
        page: z.number().int().min(0).max(LIMITS.catalogMaxPage).optional(),
        refresh: z.boolean().optional(),
      })
      .strict(),
  ),
  scan: action<ScanResult>()(
    z
      .object({
        uri: z.string().trim().min(1).max(LIMITS.scanUriLength).refine(visible),
        ref: z.string().max(LIMITS.refLength).refine(visible).optional(),
        subpath: z.string().max(LIMITS.subpathLength).refine(visible).optional(),
      })
      .strict(),
  ),
  install: action<BatchResult>()(
    z
      .object({
        scanId: patterned(ID_PATTERNS.uuid),
        candidateIds: z.array(patterned(ID_PATTERNS.skill)).min(1).max(LIMITS.selection),
        createDetectedGroups: z.boolean().optional(),
        customGroupName: name.optional(),
        mergeExistingGroups: z.boolean().optional(),
      })
      .strict()
      .refine((value) => !(value.createDetectedGroups && value.customGroupName !== undefined), '识别分组与自定义分组不能同时指定。'),
  ),
  checkUpdates: action<UpdateCheck>()(z.undefined()),
  applyUpdates: action<BatchResult>()(
    z
      .object({
        checkId: patterned(ID_PATTERNS.uuid),
        skillIds: z.array(patterned(ID_PATTERNS.skill)).min(1).max(LIMITS.selection),
        replaceModified: z.array(patterned(ID_PATTERNS.skill)).max(LIMITS.selection).optional(),
      })
      .strict(),
  ),
  saveGroup: action<Group>()(
    z
      .object({
        name: name.optional(),
        groupId: patterned(ID_PATTERNS.group).optional(),
        skillIds: z.array(patterned(ID_PATTERNS.skill)).min(1).max(LIMITS.selection),
      })
      .strict()
      .refine((value) => value.name || value.groupId, '请选择或命名分组'),
  ),
  deleteGroup: action<void>()(patterned(ID_PATTERNS.group)),
  saveHarness: action<Harness>()(
    z
      .object({
        id: harnessId.optional(),
        name,
        icon: z.string().max(LIMITS.iconLength).optional(),
        enabled: z.boolean().optional(),
        userSkillsPath: z.string().max(LIMITS.pathLength),
        workspaceSkillsRelativePath: z.string().max(LIMITS.pathLength),
        kind: z.enum(['cli', 'desktop', 'universal']).optional(),
        readsUserAgents: z.boolean().optional(),
        readsWorkspaceAgents: z.boolean().optional(),
        command: z
          .string()
          .trim()
          .max(LIMITS.commandLength)
          .regex(/^[a-zA-Z0-9_.+-]*$/, '只填写命令名称，程序绝对路径请填可执行文件路径。')
          .optional(),
        versionArgs: z.array(z.string().max(LIMITS.versionArgLength)).max(LIMITS.versionArgs).optional(),
        executablePaths: pathList.optional(),
        appPaths: pathList.optional(),
        appBundleIds: identityList.optional(),
        extensionIds: identityList.optional(),
        extensionRoots: pathList.optional(),
        extraUserSkillsPaths: pathList.optional(),
        extraWorkspaceSkillsRelativePaths: pathList.optional(),
        documentationUrl: z
          .url({ protocol: /^https?$/ })
          .max(LIMITS.urlLength)
          .optional(),
      })
      .strict(),
  ),
  setHarnessEnabled: action<Harness>()(z.object({ harnessId, enabled: z.boolean() }).strict()),
  previewApply: action<ApplyPlan>()(applyInput),
  apply: action<BatchResult>()(applyInput),
  remove: action<BatchResult>()(z.object({ bindingId: id, skillIds: ids }).strict()),
  checkHealth: action<void>()(z.undefined()),
  saveSettings: action<void>()(
    z
      .object({
        viewMode: z.enum(['source', 'harness', 'group', 'flat']).optional(),
        activeTabs: z
          .record(
            z.string().min(1).max(LIMITS.settingsKeyLength).refine(visible),
            z.string().max(LIMITS.settingsValueLength).refine(visible),
          )
          .optional(),
      })
      .strict(),
  ),
  chooseDirectory: action<string | null>()(z.undefined()),
} satisfies Record<Action, ActionDef>;

type Contract = typeof contract;
/** What the renderer sends. */
export type ActionInput<K extends Action> = z.input<Contract[K]['input']>;
/** What a route receives after validation and normalization. */
export type ActionPayload<K extends Action> = z.output<Contract[K]['input']>;
export type ActionOutput<K extends Action> = Contract[K] extends ActionDef<z.ZodType, infer O> ? O : never;

export type HarnessAPI = {
  [K in Action]: undefined extends ActionInput<K>
    ? (input?: ActionInput<K>) => Promise<ActionOutput<K>>
    : (input: ActionInput<K>) => Promise<ActionOutput<K>>;
} & { onChanged(callback: () => void): () => void };

declare global {
  interface Window {
    harness: HarnessAPI;
  }
}
