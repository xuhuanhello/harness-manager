import type { Action } from '../shared/ipc-actions';
import { type ActionOutput, type ActionPayload, contract } from '../shared/ipc-contract';
import type { Settings, Snapshot } from '../shared/types';
import { appError } from './messages';
import { LibraryObserver } from './observer';
import { type Route, routes } from './routes';
import { createServices, type Services } from './services';
import { Store } from './store';

/** Operating-system effects, injected so the controller stays testable outside Electron. */
export interface PlatformPorts {
  chooseDirectory(): Promise<string | null>;
  openExternal(url: string): Promise<void>;
  showItemInFolder(path: string): void;
  trashItem?(path: string): Promise<void>;
}

const unavailable = (): never => {
  throw appError('PLATFORM_UNAVAILABLE');
};
const defaultPorts: PlatformPorts = {
  chooseDirectory: async () => null,
  openExternal: async () => unavailable(),
  showItemInFolder: () => unavailable(),
};

export class Controller {
  readonly store: Services['store'];
  readonly journal: Services['journal'];
  readonly harnesses: Services['harnesses'];
  readonly external: Services['external'];
  readonly library: Services['library'];
  readonly updates: Services['updates'];
  readonly distribution: Services['distribution'];
  readonly health: Services['health'];
  readonly migrationExecutor: Services['migrationExecutor'];
  readonly migration: Services['migration'];
  readonly repair: Services['repair'];
  readonly marketplaces: Services['marketplaces'];
  readonly installation: Services['installation'];
  readonly catalog: Services['catalog'];
  readonly locations: Services['locations'];
  readonly ports: PlatformPorts;
  private queue: Promise<unknown> = Promise.resolve();
  private observer?: LibraryObserver;
  constructor(
    root: string,
    private changed: () => void = () => {},
    private options: { watch?: boolean; ports?: Partial<PlatformPorts> } = {},
  ) {
    this.ports = { ...defaultPorts, ...options.ports };
    const services = createServices(new Store(root), { trashItem: this.ports.trashItem });
    this.store = services.store;
    this.journal = services.journal;
    this.harnesses = services.harnesses;
    this.external = services.external;
    this.library = services.library;
    this.updates = services.updates;
    this.distribution = services.distribution;
    this.health = services.health;
    this.migrationExecutor = services.migrationExecutor;
    this.migration = services.migration;
    this.repair = services.repair;
    this.marketplaces = services.marketplaces;
    this.installation = services.installation;
    this.catalog = services.catalog;
    this.locations = services.locations;
  }
  async initialize() {
    await this.library.recover();
    await this.updates.recover();
    await this.repair.recover();
    await this.distribution.recover();
    await this.migrationExecutor.recover();
    this.journal.prune();
    await this.health.checkHealth();
    if (this.options.watch === false) return;
    this.observer = new LibraryObserver(this.store.root, (ids) =>
      this.enqueue(async () => {
        await this.health.checkHealth(ids.length ? ids : undefined);
        this.changed();
      }),
    );
    await this.observer.start();
  }
  async snapshot(): Promise<Snapshot> {
    const settings = this.store.get<Settings & { id: string }>('settings', 'ui');
    const issues = this.journal.issues();
    const externalSkills = await this.external.externalSkills();
    const visibility = await this.external.visibleSkills(externalSkills);
    return {
      ...visibility,
      libraryRoot: this.store.root,
      sources: this.store.list('sources'),
      skills: this.store.list('skills'),
      groups: this.store.list('groups'),
      harnesses: this.store.list('harnesses'),
      marketplaces: this.marketplaces.list(),
      workspaces: this.store.list('workspaces'),
      targets: this.store.list('targets'),
      bindings: this.store.list('bindings'),
      intents: this.store.list('intents'),
      distributions: this.store.list('distributions'),
      externalSkills,
      settings: { viewMode: settings?.viewMode ?? 'source', activeTabs: settings?.activeTabs ?? {} },
      issues,
    };
  }
  /** Validates the payload against the contract, then runs the action's route. */
  async invoke<K extends Action>(action: K, payload: unknown): Promise<ActionOutput<K>> {
    const route = routes[action] as Route<K>;
    const parsed = contract[action].input.safeParse(payload);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      const field = issue.path.join('.');
      throw appError('INVALID_REQUEST', { field, reason: issue.message });
    }
    const input = parsed.data as ActionPayload<K>;
    if (route.queue === 'none') return route.handle(this, input);
    try {
      return await this.enqueue(() => route.handle(this, input));
    } finally {
      if (route.mutates) this.changed();
    }
  }
  /** Background check on window focus or wake. Re-hashes the library only when the watcher is not live. */
  async refreshHealth(): Promise<void> {
    const rehashSkills = !this.observer?.watching;
    try {
      await this.enqueue(() => this.health.checkHealth(undefined, { rehashSkills }));
    } finally {
      this.changed();
    }
  }
  async close() {
    this.observer?.close();
    await this.queue;
    this.store.close();
  }
  private enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
