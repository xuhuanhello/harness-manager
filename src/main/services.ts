import { DistributionService } from './distribution';
import { ExternalSkillScanner } from './external-skills';
import { HarnessConfigService } from './harness-config';
import { HarnessInstallationService } from './harness-installation';
import { HealthService } from './health';
import { Journal } from './journal';
import { LibraryService } from './library';
import { MarketplaceCatalogService } from './marketplace-catalog';
import { MarketplaceService } from './marketplaces';
import { MigrationService } from './migration';
import { MigrationExecutor } from './migration-executor';
import { MIGRATIONS } from './migrations';
import { ManagedLinkRepairService } from './repair';
import { SkillLocationService } from './skill-locations';
import type { Store } from './store';
import { TargetResolver } from './targets';
import { UpdateService } from './updates';

export interface ServiceOptions {
  /** Home directory for `~` paths. A test seam; defaults to the current user's home. */
  home?: string;
  trashItem?: (path: string) => Promise<void>;
}

export type Services = ReturnType<typeof createServices>;

/** The composition root: migrates the store, syncs built-ins and wires every main-process service. */
export function createServices(store: Store, options: ServiceOptions = {}) {
  store.migrate(MIGRATIONS);
  const journal = new Journal(store);
  const harnesses = new HarnessConfigService(store, { home: options.home });
  harnesses.syncBuiltins();
  const targets = new TargetResolver(store, { home: options.home });
  const external = new ExternalSkillScanner(store, targets);
  const library = new LibraryService(store);
  const migrationExecutor = new MigrationExecutor(store, targets, external);
  return {
    store,
    journal,
    harnesses,
    targets,
    external,
    library,
    updates: new UpdateService(store, { trashItem: options.trashItem }),
    distribution: new DistributionService(store, targets),
    health: new HealthService(store),
    migrationExecutor,
    migration: new MigrationService(store, library, external, targets, migrationExecutor),
    repair: new ManagedLinkRepairService(store, external),
    marketplaces: new MarketplaceService(store),
    catalog: new MarketplaceCatalogService(),
    installation: new HarnessInstallationService(store, { home: options.home, trashItem: options.trashItem }),
    locations: new SkillLocationService(store),
  };
}
