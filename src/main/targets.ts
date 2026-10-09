import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isHarnessEnabled } from '../shared/harness-enabled';
import type { ApplyRequest, Binding, Harness, Target, Workspace } from '../shared/types';
import type { ApplyEffects, ResolvedTarget } from './distribution-types';
import { inspectEntry } from './fs-utils';
import { recordId } from './ids';
import {
  assertNoPathOverlap,
  assertWorkspaceContainment,
  canonicalizePath,
  expandUserPath,
  type ResolvePath,
  requireDirectory,
  validateWorkspaceRelativePath,
} from './paths';
import type { Store } from './store';
import { appError, message } from './messages';

/** Resolves Harness skill directories to canonical targets and guards which directories may be written. */
export class TargetResolver {
  /** Home directory used to expand `~` paths. A test seam; defaults to the current user's home. */
  readonly home: string;

  constructor(
    private readonly store: Store,
    options: { home?: string } = {},
  ) {
    this.home = path.resolve(options.home ?? os.homedir());
  }

  async resolveTargets(request: ApplyRequest): Promise<ResolvedTarget[]> {
    const harnesses = this.store.list<Harness>('harnesses');
    const selected: Harness[] = [];
    for (const id of request.harnessIds) {
      const harness = harnesses.find((item) => item.id === id);
      if (!harness) throw appError('HARNESS_NOT_CONFIGURED', { id });
      if (!isHarnessEnabled(harness)) throw appError('TARGET_HARNESS_DISABLED', { name: harness.name });
      selected.push(harness);
    }
    if (!selected.length) throw appError('TARGET_NO_HARNESS');

    let workspace: Workspace | undefined;
    let workspaceCanonical: string | undefined;
    if (request.scope === 'workspace') {
      if (!request.workspacePath) throw appError('TARGET_WORKSPACE_REQUIRED');
      const canonical = await requireDirectory(path.resolve(request.workspacePath), message('LABEL_WORKSPACE'));
      workspaceCanonical = canonical.path;
      workspace = (await this.findWorkspace(canonical.path)) ?? {
        id: recordId('workspace', canonical.key),
        path: canonical.path,
        name: path.basename(canonical.path) || canonical.path,
      };
    } else if (request.workspacePath) {
      throw appError('TARGET_WORKSPACE_UNEXPECTED');
    }

    const merged = new Map<string, ResolvedTarget>();
    for (const harness of selected) {
      let configured: string;
      if (request.scope === 'user') {
        if (!harness.userSkillsPath.trim() && !harness.readsUserAgents) throw appError('TARGET_NO_USER_PATH', { name: harness.name });
        configured = expandUserPath(harness.userSkillsPath || '~/.agents/skills', this.home);
      } else {
        const relative = validateWorkspaceRelativePath(
          harness.workspaceSkillsRelativePath || (harness.readsWorkspaceAgents ? '.agents/skills' : ''),
        );
        if (!relative) throw appError('TARGET_NO_WORKSPACE_PATH', { name: harness.name });
        configured = path.resolve(workspaceCanonical!, relative);
      }
      const canonical = await canonicalizePath(configured);
      if (request.scope === 'workspace') await assertWorkspaceContainment(workspaceCanonical!, canonical.path);
      const disabledReader = await this.disabledHarnessForTargetKey(canonical.key);
      if (disabledReader) throw appError('TARGET_SHARED_WITH_DISABLED', { name: disabledReader });
      await this.assertSafeTarget(canonical.path);
      const state = await inspectEntry(canonical.path);
      if (state.exists && !(await stat(canonical.path)).isDirectory()) {
        throw appError('TARGET_NOT_DIRECTORY', { path: canonical.path });
      }
      let target = merged.get(canonical.key);
      if (!target) {
        target = {
          path: canonical.path,
          key: canonical.key,
          caseSensitive: canonical.caseSensitive,
          scope: request.scope,
          ...(workspace ? { workspace } : {}),
          harnesses: [],
        };
        merged.set(canonical.key, target);
      }
      if (!target.harnesses.some((item) => item.id === harness.id)) target.harnesses.push(harness);
    }
    return [...merged.values()];
  }

  async findTarget(targetPath: string, resolve: ResolvePath = canonicalizePath): Promise<Target | undefined> {
    const canonical = await resolve(targetPath);
    for (const target of this.store.list<Target>('targets')) {
      try {
        const recorded = await resolve(target.path);
        if (recorded.path === path.resolve(target.path) && recorded.key === canonical.key) return target;
      } catch {
        // Skip stale or invalid records. A later apply will create a canonical record.
      }
    }
    return undefined;
  }

  async findWorkspace(workspacePath: string, resolve: ResolvePath = canonicalizePath): Promise<Workspace | undefined> {
    const canonical = await resolve(workspacePath);
    for (const workspace of this.store.list<Workspace>('workspaces')) {
      try {
        const recorded = await resolve(workspace.path);
        if (recorded.path === path.resolve(workspace.path) && recorded.key === canonical.key) return workspace;
      } catch {
        // Ignore stale registrations.
      }
    }
    return undefined;
  }

  async buildEffects(target: ResolvedTarget, skillId: string, resolve: ResolvePath = canonicalizePath): Promise<ApplyEffects> {
    const existingTarget = await this.findTarget(target.path, resolve);
    const targetRecord: Target = existingTarget ?? {
      id: recordId('target', target.key),
      path: target.path,
    };
    let workspace: Workspace | undefined;
    let workspaceId: string | undefined;
    if (target.workspace) {
      const existingWorkspace = await this.findWorkspace(target.workspace.path, resolve);
      workspace = existingWorkspace ?? target.workspace;
      workspaceId = workspace.id;
    }
    const currentBindings = this.store.list<Binding>('bindings');
    const bindings = target.harnesses.map((harness) => {
      const previous = currentBindings.find(
        (binding) =>
          binding.targetId === targetRecord.id &&
          binding.harnessId === harness.id &&
          binding.scope === target.scope &&
          binding.workspaceId === workspaceId,
      );
      return {
        id: previous?.id ?? recordId('binding', `${target.scope}\0${workspaceId ?? ''}\0${targetRecord.id}\0${harness.id}`),
        targetId: targetRecord.id,
        harnessId: harness.id,
        scope: target.scope,
        ...(workspaceId ? { workspaceId } : {}),
      };
    });
    return { target: targetRecord, ...(workspace ? { workspace } : {}), bindings, skillId };
  }

  async assertSafeTarget(targetPath: string): Promise<void> {
    await assertNoPathOverlap(targetPath, [
      this.store.root,
      path.join(this.store.root, '.staging'),
      path.join(this.store.root, '.trash'),
      path.join(this.store.root, 'skills'),
    ]);
  }

  async assertBindingTarget(binding: Binding, targetPath: string): Promise<void> {
    if (binding.scope === 'user') return;
    if (binding.scope !== 'workspace' || !binding.workspaceId) {
      throw appError('TARGET_BINDING_INCOMPLETE');
    }
    const workspace = this.store.get<Workspace>('workspaces', binding.workspaceId);
    if (!workspace) throw appError('TARGET_BINDING_WORKSPACE_MISSING');
    const canonicalWorkspace = await requireDirectory(workspace.path, message('LABEL_RECORDED_WORKSPACE'));
    if (canonicalWorkspace.path !== path.resolve(workspace.path)) {
      throw appError('TARGET_WORKSPACE_REDIRECTED');
    }
    await assertWorkspaceContainment(canonicalWorkspace.path, targetPath);
  }

  async disabledHarnessForTargetKey(targetKey: string): Promise<string | undefined> {
    const targets = new Map(this.store.list<Target>('targets').map((target) => [target.id, target]));
    for (const binding of this.store.list<Binding>('bindings')) {
      const harness = this.store.get<Harness>('harnesses', binding.harnessId);
      if (isHarnessEnabled(harness)) continue;
      const target = targets.get(binding.targetId);
      if (!target?.path) continue;
      const canonical = await canonicalizePath(target.path).catch(() => undefined);
      if (canonical?.key === targetKey) return harness?.name ?? binding.harnessId;
    }
    return undefined;
  }

  async disabledHarnessForTargetPath(targetPath: string): Promise<string | undefined> {
    const canonical = await canonicalizePath(targetPath);
    return this.disabledHarnessForTargetKey(canonical.key);
  }
}
