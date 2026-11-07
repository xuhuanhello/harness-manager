import type { Action } from '../shared/ipc-actions';
import type { ActionOutput, ActionPayload } from '../shared/ipc-contract';
import type { Distribution, Harness } from '../shared/types';
import type { Controller } from './controller';
import { appError } from './messages';
import { marketplaceSkillPageUrl } from './marketplace-catalog';

export interface Route<K extends Action> {
  /** `state` routes run one at a time, so no request observes half-committed state. */
  queue: 'state' | 'none';
  /** Whether the renderer is told to refresh after the route settles (also after a failure). */
  mutates: boolean;
  handle(app: Controller, input: ActionPayload<K>): Promise<ActionOutput<K>> | ActionOutput<K>;
}

const read = { queue: 'state', mutates: false } as const;
const write = { queue: 'state', mutates: true } as const;
/** Network, process or dialog work that does not read or write SQLite state. */
const unqueued = { queue: 'none', mutates: false } as const;

export const routes: { [K in Action]: Route<K> } = {
  appUpdateState: { ...unqueued, handle: (app) => app.appUpdater.getState() },
  checkAppUpdate: { ...unqueued, handle: (app) => app.appUpdater.check() },
  downloadAppUpdate: { ...unqueued, handle: (app) => app.appUpdater.download() },
  cancelAppUpdate: { ...unqueued, handle: (app) => app.appUpdater.cancel() },
  installAppUpdate: { ...unqueued, handle: (app) => app.appUpdater.install() },
  openAppUpdatePage: { ...unqueued, handle: (app, input) => app.appUpdater.openPage(input?.url) },
  openAppUpdateSettings: { ...unqueued, handle: (app) => app.appUpdater.openManagement() },
  detectHarnessInstallations: { ...unqueued, handle: (app, input) => app.installation.detect(app.store.list<Harness>('harnesses'), input) },
  previewHarnessCleanup: { ...read, handle: (app, input) => app.installation.previewCleanup(input) },
  cleanupHarness: { ...write, handle: (app, input) => app.installation.cleanup(input) },
  revealHarnessDirectory: {
    ...read,
    handle: async (app, input) => app.ports.showItemInFolder(await app.installation.resolveRevealPath(input)),
  },
  openSkillSource: { ...read, handle: (app, input) => app.ports.openExternal(app.locations.sourceUrl(input.skillId)) },
  revealSkill: { ...read, handle: async (app, input) => app.ports.showItemInFolder(await app.locations.directory(input.skillId)) },
  revealExternalSkill: {
    ...read,
    handle: async (app, input) => {
      const skill = (await app.external.externalSkills()).find((item) => item.id === input.externalSkillId);
      if (!skill) throw appError('LOCATION_EXTERNAL_NOT_FOUND');
      app.ports.showItemInFolder(skill.path);
    },
  },
  revealDistribution: {
    ...read,
    handle: (app, input) => {
      const distribution = app.store.get<Distribution>('distributions', input.distributionId);
      if (!distribution) throw appError('LOCATION_DISTRIBUTION_NOT_FOUND');
      app.ports.showItemInFolder(distribution.entryPath);
    },
  },
  appInfo: { ...unqueued, handle: (app) => app.appInfo },
  snapshot: { ...read, handle: (app) => app.snapshot() },
  migrationRepairs: { ...read, handle: (app, input) => app.repair.preview(input) },
  repairManagedLink: { ...write, handle: (app, input) => app.repair.repair(input) },
  previewMigrateExternal: { ...read, handle: (app, input) => app.migration.preview(input) },
  migrateExternal: { ...write, handle: (app, input) => app.migration.migrate(input) },
  openMarketplace: { ...read, handle: (app, input) => app.ports.openExternal(app.marketplaces.resolveUrl(input?.marketplaceId)) },
  openMarketplaceSkill: {
    ...read,
    handle: (app, input) => app.ports.openExternal(marketplaceSkillPageUrl(input.marketplaceId, input.url)),
  },
  saveMarketplace: { ...write, handle: (app, input) => app.marketplaces.save(input) },
  deleteMarketplace: { ...write, handle: (app, input) => app.marketplaces.delete(input) },
  marketplaceCatalog: { ...unqueued, handle: (app, input) => app.catalog.get(input) },
  scan: { ...read, handle: (app, input) => app.library.scan(input) },
  install: { ...write, handle: (app, input) => app.library.install(input) },
  checkUpdates: { ...unqueued, handle: (app) => app.updates.check() },
  applyUpdates: {
    ...write,
    handle: async (app, input) => {
      const result = await app.updates.apply(input);
      // Copies of an updated skill become stale at once; show that without waiting for the watcher.
      if (result.skillIds?.length) await app.health.checkHealth(result.skillIds);
      return result;
    },
  },
  saveGroup: { ...write, handle: (app, input) => app.library.saveGroup(input) },
  deleteGroup: { ...write, handle: (app, input) => app.library.deleteGroup(input) },
  saveHarness: { ...write, handle: (app, input) => app.harnesses.saveHarness(input) },
  setHarnessEnabled: { ...write, handle: (app, input) => app.harnesses.setHarnessEnabled(input) },
  previewApply: { ...read, handle: (app, input) => app.distribution.previewApply(input) },
  apply: { ...write, handle: (app, input) => app.distribution.apply(input) },
  remove: { ...write, handle: (app, input) => app.distribution.remove(input) },
  checkHealth: { ...write, handle: (app) => app.health.checkHealth() },
  saveSettings: {
    ...write,
    handle: (app, input) => {
      app.library.saveSettings(input);
      if (input.appUpdates) app.appUpdater.setAutoCheck(input.appUpdates.autoCheck);
    },
  },
  chooseDirectory: { ...unqueued, handle: (app) => app.ports.chooseDirectory() },
};
