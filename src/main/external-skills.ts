import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { isHarnessEnabled } from '../shared/harness-enabled';
import { harnessReadPaths } from '../shared/harness-paths';
import type { Distribution, ExternalSkill, Harness, Scope, VisibleManagedSkill, Workspace } from '../shared/types';
import { canonicalizeLexical } from './entries';
import { errorMessage } from '../shared/errors';
import { isMissingEntryError } from './fs-utils';
import { recordId } from './ids';
import { assertWorkspaceContainment, canonicalizePath, expandUserPath, validateWorkspaceRelativePath } from './paths';
import type { Store } from './store';
import type { TargetResolver } from './targets';
import { appError } from './messages';

/** Finds skills in configured Harness directories that the central library does not manage, and what each Harness can see. */
export class ExternalSkillScanner {
  constructor(
    private readonly store: Store,
    private readonly targets: TargetResolver,
  ) {}

  async externalSkills(options: { strict?: boolean; includeDisabled?: boolean } = {}): Promise<ExternalSkill[]> {
    const output: ExternalSkill[] = [];
    const workspaces = this.store.list<Workspace>('workspaces');
    const harnesses = this.store.list<Harness>('harnesses');
    const distributions = this.store.list<Distribution>('distributions');
    const known = new Set<string>();

    const inspectConfigured = async (harness: Harness, scope: Scope, configuredPath: string, workspace?: Workspace): Promise<void> => {
      if (!configuredPath) return;
      let targetPath = configuredPath;
      try {
        if (scope === 'user') targetPath = expandUserPath(configuredPath, this.targets.home);
        else {
          const relative = validateWorkspaceRelativePath(configuredPath);
          if (!relative || !workspace) return;
          targetPath = path.resolve(workspace.path, relative);
          await assertWorkspaceContainment(workspace.path, targetPath);
        }
        const canonical = await canonicalizePath(targetPath);
        const dirStat = await stat(canonical.path);
        if (!dirStat.isDirectory()) return;
        await this.targets.assertSafeTarget(canonical.path);
        const targetRecord = await this.targets.findTarget(canonical.path);
        const entries = await readdir(canonical.path, { withFileTypes: true });
        for (const child of entries) {
          if (child.name.startsWith('.harness-manager-') || child.name.includes('.hm-')) continue;
          const childPath = path.join(canonical.path, child.name);
          const childStat = await stat(childPath).catch((error) => {
            if (options.strict && !isMissingEntryError(error)) throw error;
            return undefined;
          });
          if (!childStat?.isDirectory()) continue;
          const tracked =
            targetRecord &&
            distributions.some((dist) => dist.targetId === targetRecord.id && path.resolve(dist.entryPath) === path.resolve(childPath));
          if (tracked) continue;
          const manifestPath = path.join(childPath, 'SKILL.md');
          const manifest = await readFile(manifestPath, 'utf8').catch((error) => {
            if (options.strict && !isMissingEntryError(error)) throw error;
            return undefined;
          });
          if (manifest === undefined) continue;
          const signature = `${harness.id}\0${scope}\0${workspace?.id ?? ''}\0${canonicalizeLexical(childPath)}`;
          if (known.has(signature)) continue;
          known.add(signature);
          output.push({
            id: recordId('external', signature),
            name: child.name,
            description: readShortDescription(manifest),
            path: childPath,
            harnessId: harness.id,
            scope,
            ...(workspace ? { workspaceId: workspace.id } : {}),
          });
        }
      } catch (error) {
        if (options.strict && !isMissingEntryError(error)) {
          throw appError('EXTERNAL_SCAN_FAILED', { path: targetPath, reason: errorMessage(error) });
        }
      }
    };

    for (const harness of harnesses) {
      if (!options.includeDisabled && !isHarnessEnabled(harness)) continue;
      for (const configured of harnessReadPaths(harness, 'user')) await inspectConfigured(harness, 'user', configured.path);
      for (const workspace of workspaces) {
        for (const configured of harnessReadPaths(harness, 'workspace'))
          await inspectConfigured(harness, 'workspace', configured.path, workspace);
      }
    }
    return output;
  }

  async visibleSkills(
    external: ExternalSkill[],
  ): Promise<{ visibleManagedSkills: VisibleManagedSkill[]; visibleExternalSkills: ExternalSkill[] }> {
    const managed: VisibleManagedSkill[] = [];
    const unmanaged: ExternalSkill[] = [];
    const workspaces = this.store.list<Workspace>('workspaces');
    const distributions = this.store.list<Distribution>('distributions');
    const parents = new Map<string, Promise<string>>();
    const keyFor = (value: string) => {
      let pending = parents.get(value);
      if (!pending) {
        pending = canonicalizePath(value)
          .then((item) => item.key)
          .catch(() => '');
        parents.set(value, pending);
      }
      return pending;
    };
    for (const harness of this.store.list<Harness>('harnesses')) {
      if (!isHarnessEnabled(harness)) continue;
      for (const context of [
        { scope: 'user' as const, workspace: undefined },
        ...workspaces.map((workspace) => ({ scope: 'workspace' as const, workspace })),
      ]) {
        const seenManaged = new Set<string>();
        const seenExternal = new Set<string>();
        for (const configured of harnessReadPaths(harness, context.scope)) {
          const directory =
            context.scope === 'user'
              ? expandUserPath(configured.path, this.targets.home)
              : path.resolve(context.workspace!.path, configured.path);
          const targetKey = await keyFor(directory);
          if (!targetKey) continue;
          for (const distribution of distributions) {
            if (seenManaged.has(distribution.id) || (await keyFor(path.dirname(distribution.entryPath))) !== targetKey) continue;
            seenManaged.add(distribution.id);
            managed.push({
              harnessId: harness.id,
              scope: context.scope,
              workspaceId: context.workspace?.id,
              distributionId: distribution.id,
              inheritedFrom: configured.inheritedFrom,
            });
          }
          for (const item of external) {
            if (seenExternal.has(item.path) || (await keyFor(path.dirname(item.path))) !== targetKey) continue;
            seenExternal.add(item.path);
            unmanaged.push({
              ...item,
              harnessId: harness.id,
              scope: context.scope,
              workspaceId: context.workspace?.id,
              inheritedFrom: configured.inheritedFrom,
            });
          }
        }
      }
    }
    return { visibleManagedSkills: managed, visibleExternalSkills: unmanaged };
  }
}

function readShortDescription(manifest: string): string {
  const lines = manifest.split(/\r?\n/);
  const start = lines[0]?.trim() === '---' ? lines.findIndex((line, index) => index > 0 && line.trim() === '---') + 1 : 0;
  const body = lines
    .slice(Math.max(0, start))
    .map((line) => line.trim())
    .filter(Boolean);
  return body[0]?.replace(/^#+\s*/, '').slice(0, 240) ?? '';
}
