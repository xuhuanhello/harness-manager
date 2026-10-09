import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { isHarnessEnabled } from '../shared/harness-enabled';
import { BUILTIN_LOCKED_FIELDS } from '../shared/harness-fields';
import { BUILTIN_HARNESSES, DEFAULT_ENABLED_HARNESS_IDS } from '../shared/harness-registry';
import type { Binding, Harness, HarnessInput, Intent } from '../shared/types';
import { expandUserPath, validateWorkspaceRelativePath } from './paths';
import type { Store } from './store';
import { appError } from './messages';

/** Every key required, optional values may still be undefined. */
type Complete<T> = { [K in keyof Required<T>]: T[K] };

/** Built-in and custom Harness records: saving, enabling and syncing built-ins with the registry. */
export class HarnessConfigService {
  private readonly home: string;

  constructor(
    private readonly store: Store,
    options: { home?: string } = {},
  ) {
    this.home = path.resolve(options.home ?? os.homedir());
  }

  saveHarness(input: HarnessInput): Harness {
    const name = input.name.trim();
    const icon = input.icon?.trim() ?? '';
    const userSkillsPath = normalizeConfiguredUserPath(input.userSkillsPath, this.home);
    const workspaceSkillsRelativePath = validateWorkspaceRelativePath(input.workspaceSkillsRelativePath);
    if (!userSkillsPath && !workspaceSkillsRelativePath && !input.readsUserAgents && !input.readsWorkspaceAgents) {
      throw appError('HARNESS_PATH_REQUIRED');
    }

    const harnesses = this.store.list<Harness>('harnesses');
    let existing: Harness | undefined;
    let id = input.id?.trim();
    if (id) {
      existing = harnesses.find((harness) => harness.id === id);
      if (!existing) throw appError('HARNESS_NOT_FOUND', { id });
      if (existing.origin === 'builtin') {
        for (const key of BUILTIN_LOCKED_FIELDS)
          if (input[key] !== undefined && JSON.stringify(input[key]) !== JSON.stringify(existing[key]))
            throw appError('HARNESS_BUILTIN_LOCKED');
        const updated = {
          ...existing,
          executablePaths: normalizeDetectionPaths(input.executablePaths ?? existing.executablePaths),
          appPaths: normalizeDetectionPaths(input.appPaths ?? existing.appPaths),
          extensionRoots: normalizeDetectionPaths(input.extensionRoots ?? existing.extensionRoots),
        };
        this.store.put('harnesses', updated);
        return updated;
      }
      const bindingIds = new Set(
        this.store
          .list<Binding>('bindings')
          .filter((binding) => binding.harnessId === id)
          .map((binding) => binding.id),
      );
      const hasActiveIntents = this.store.list<Intent>('intents').some((intent) => bindingIds.has(intent.bindingId));
      if (
        hasActiveIntents &&
        (normalizeConfiguredUserPath(existing.userSkillsPath, this.home) !== userSkillsPath ||
          validateWorkspaceRelativePath(existing.workspaceSkillsRelativePath) !== workspaceSkillsRelativePath ||
          JSON.stringify(existing.extraUserSkillsPaths ?? []) !== JSON.stringify(input.extraUserSkillsPaths ?? []) ||
          JSON.stringify(existing.extraWorkspaceSkillsRelativePaths ?? []) !==
            JSON.stringify(input.extraWorkspaceSkillsRelativePaths ?? []) ||
          !!existing.readsUserAgents !== !!input.readsUserAgents ||
          !!existing.readsWorkspaceAgents !== !!input.readsWorkspaceAgents)
      ) {
        throw appError('HARNESS_PATHS_IN_USE');
      }
    } else {
      id = `custom-${randomUUID()}`;
    }
    if (input.kind === 'universal') throw appError('HARNESS_CUSTOM_KIND');
    const duplicateName = harnesses.find((harness) => harness.id !== id && harness.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (duplicateName) throw appError('HARNESS_NAME_TAKEN', { name: duplicateName.name });

    // Listing every field (Complete) makes a new Harness field a compile error here instead of being silently dropped.
    const result: Complete<Harness> = {
      id,
      name,
      icon,
      userSkillsPath,
      workspaceSkillsRelativePath,
      origin: 'custom',
      enabled: existing ? isHarnessEnabled(existing) : true,
      kind: input.kind === 'desktop' ? 'desktop' : 'cli',
      readsUserAgents: !!input.readsUserAgents,
      readsWorkspaceAgents: !!input.readsWorkspaceAgents,
      command: input.command?.trim() || undefined,
      versionArgs: input.versionArgs?.length ? input.versionArgs : ['--version'],
      executablePaths: normalizeDetectionPaths(input.executablePaths),
      appPaths: normalizeDetectionPaths(input.appPaths),
      appBundleIds: normalizeIdentities(input.appBundleIds),
      extensionIds: normalizeIdentities(input.extensionIds),
      extensionRoots: normalizeDetectionPaths(input.extensionRoots),
      extraUserSkillsPaths: (input.extraUserSkillsPaths ?? [])
        .map((value) => normalizeConfiguredUserPath(value, this.home))
        .filter(Boolean),
      extraWorkspaceSkillsRelativePaths: (input.extraWorkspaceSkillsRelativePaths ?? []).map(validateWorkspaceRelativePath).filter(Boolean),
      documentationUrl: input.documentationUrl?.trim() || undefined,
    };
    this.store.put('harnesses', result);
    return result;
  }

  setHarnessEnabled(request: { harnessId: string; enabled: boolean }): Harness {
    const harness = this.store.get<Harness>('harnesses', request.harnessId);
    if (!harness) throw appError('HARNESS_NOT_CONFIGURED', { id: request.harnessId });
    const updated: Harness = { ...harness, enabled: request.enabled };
    this.store.put('harnesses', updated);
    return updated;
  }

  /** Applies the current registry to stored built-ins. Runs on every start: product rules follow the registry. */
  syncBuiltins(): void {
    this.store.transaction(() => {
      for (const harness of BUILTIN_HARNESSES) {
        const previous = this.store.get<Harness>('harnesses', harness.id);
        // Stored records always carry a boolean after store migration v2; new built-ins use the registry default.
        const enabled = typeof previous?.enabled === 'boolean' ? previous.enabled : DEFAULT_ENABLED_HARNESS_IDS.has(harness.id);
        // Product rules follow the registry. Saved discovery paths supplement the current built-in candidates
        // instead of hiding candidates added by a newer registry.
        this.store.put('harnesses', {
          ...harness,
          enabled,
          ...(previous
            ? {
                executablePaths: mergeDetectionPaths(previous.executablePaths, harness.executablePaths),
                appPaths: mergeDetectionPaths(previous.appPaths, harness.appPaths),
                extensionRoots: mergeDetectionPaths(previous.extensionRoots, harness.extensionRoots),
              }
            : {}),
        });
      }
    });
  }
}

function normalizeIdentities(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function normalizeConfiguredUserPath(value: string, home: string): string {
  if (typeof value !== 'string') throw appError('HARNESS_USER_PATH_TYPE');
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.includes('\0')) throw appError('HARNESS_USER_PATH_INVALID');
  const resolved = expandUserPath(trimmed, home);
  if (trimmed === '~' || trimmed.startsWith('~/')) {
    const relative = path.relative(home, resolved);
    return relative ? `~/${relative.split(path.sep).join('/')}` : '~';
  }
  return resolved;
}

function mergeDetectionPaths(saved: string[] | undefined, builtin: string[] | undefined): string[] | undefined {
  if (!saved?.length && !builtin?.length) return saved ?? builtin;
  return [...new Set([...(saved ?? []), ...(builtin ?? [])])];
}

function normalizeDetectionPaths(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))].map((value) => {
    if ((!path.isAbsolute(value) && !value.startsWith('~/')) || value.includes('\0')) throw appError('HARNESS_DETECTION_PATH_INVALID');
    return value;
  });
}
