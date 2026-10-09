import { createHash, randomUUID } from 'node:crypto';
import { lstat, readlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import type {
  BatchResult,
  Distribution,
  ExternalMigrationPreview,
  ExternalMigrationReference,
  ExternalSkill,
  Harness,
  Skill,
  Workspace,
} from '../shared/types';
import { hashDirectory } from './content';
import { isHarnessEnabled } from '../shared/harness-enabled';
import type { ExternalSkillScanner } from './external-skills';
import { overlaps } from './fs-utils';
import type { LibraryService } from './library';
import type { MigrationExecutor } from './migration-executor';
import type { Store } from './store';
import type { TargetResolver } from './targets';
import { appError, message } from './messages';

interface PreviewRecord {
  preview: ExternalMigrationPreview;
  sourceHash: string;
  fingerprint: string;
  scanId: string;
  candidateId: string;
  expiresAt: number;
}

/** Preview tokens bind consent to the real content and the complete configured reference set. */
export class MigrationService {
  private readonly previews = new Map<string, PreviewRecord>();
  constructor(
    private readonly store: Store,
    private readonly library: LibraryService,
    private readonly external: ExternalSkillScanner,
    private readonly targets: TargetResolver,
    private readonly executor: MigrationExecutor,
  ) {}

  async preview(request: { externalSkillId: string }): Promise<ExternalMigrationPreview> {
    const state = await this.inspect(request.externalSkillId);
    const scan = await this.library.scan({ uri: state.sourcePath });
    const candidate = scan.candidates.find((item) => item.path === '.');
    if (!candidate || candidate.issues.length)
      throw appError('MIGRATION_SOURCE_INVALID', { reason: candidate?.issues.join(' ') || message('MIGRATION_SOURCE_NO_MANIFEST') });
    const checked = await this.inspect(request.externalSkillId);
    if (state.fingerprint !== checked.fingerprint) throw appError('MIGRATION_PREVIEW_CHANGED_DURING');
    const preview: ExternalMigrationPreview = {
      previewId: randomUUID(),
      externalSkillId: request.externalSkillId,
      skillName: candidate.name,
      sourcePath: state.sourcePath,
      centralPath: path.join(this.store.root, 'skills', candidate.id, candidate.name),
      references: state.references,
    };
    for (const [id, record] of this.previews) if (record.expiresAt < Date.now()) this.previews.delete(id);
    while (this.previews.size >= 32) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(preview.previewId, {
      preview,
      sourceHash: state.sourceHash,
      fingerprint: state.fingerprint,
      scanId: scan.id,
      candidateId: candidate.id,
      expiresAt: Date.now() + 15 * 60_000,
    });
    return structuredClone(preview);
  }

  async migrate(request: { externalSkillId: string; previewId: string }): Promise<BatchResult> {
    const record = this.previews.get(request.previewId);
    if (!record || record.expiresAt < Date.now() || record.preview.externalSkillId !== request.externalSkillId) {
      throw appError('MIGRATION_PREVIEW_EXPIRED');
    }
    this.previews.delete(request.previewId);
    const checked = await this.inspect(request.externalSkillId);
    if (checked.fingerprint !== record.fingerprint) throw appError('MIGRATION_CONSENT_STALE');
    const installed = await this.library.install({ scanId: record.scanId, candidateIds: [record.candidateId] });
    const installation = installed.items.find((item) => item.id === record.candidateId);
    if (!installation || installation.status === 'error')
      return {
        items: [
          {
            id: request.externalSkillId,
            label: record.preview.skillName,
            status: 'error',
            message: message('MIGRATION_IMPORT_FAILED', { reason: installation?.message || '' }),
          },
        ],
      };
    const skill = this.store.get<Skill>('skills', record.candidateId);
    if (!skill || (await hashDirectory(skill.directory)) !== record.sourceHash) throw appError('MIGRATION_CENTRAL_MISMATCH');
    // Copying may take time; recheck consent immediately before changing any original entry.
    const beforeWrite = await this.inspect(request.externalSkillId);
    if (beforeWrite.fingerprint !== record.fingerprint) throw appError('MIGRATION_CHANGED_DURING_COPY');
    const result = await this.executor.migrateExternalReferences({
      skill,
      sourcePath: record.preview.sourcePath,
      sourceHash: record.sourceHash,
      references: record.preview.references,
    });
    return { items: result.items, skillIds: result.complete ? [skill.id] : [] };
  }

  private async inspect(externalSkillId: string) {
    const external = await this.external.externalSkills({ strict: true });
    const selected = external.find((item) => item.id === externalSkillId);
    if (!selected) throw appError('MIGRATION_EXTERNAL_GONE');
    const sourcePath = await realpath(selected.path);
    const allExternal = await this.external.externalSkills({ strict: true, includeDisabled: true });
    const disabledReferences: ExternalSkill[] = [];
    for (const item of allExternal) {
      if (isHarnessEnabled(this.store.get<Harness>('harnesses', item.harnessId))) continue;
      if ((await realpath(item.path)) === sourcePath) disabledReferences.push(item);
    }
    const enabledEntryPaths = new Set<string>();
    for (const item of external) if ((await realpath(item.path)) === sourcePath) enabledEntryPaths.add(path.resolve(item.path));
    const independentDisabledReferences = disabledReferences.filter((item) => !enabledEntryPaths.has(path.resolve(item.path)));
    if (independentDisabledReferences.length) {
      const harnessNames = this.store.list<Harness>('harnesses');
      const names = [
        ...new Set(
          independentDisabledReferences.map(
            (item) => harnessNames.find((harness) => harness.id === item.harnessId)?.name || item.harnessId,
          ),
        ),
      ].join(', ');
      throw appError('MIGRATION_PREVIEW_DISABLED_REFERENCES', { names });
    }
    for (const item of external) {
      if ((await realpath(item.path)) !== sourcePath) continue;
      const disabledBinding = await this.targets.disabledHarnessForTargetPath(path.dirname(item.path));
      if (disabledBinding) throw appError('MIGRATION_PREVIEW_DISABLED_BINDING', { name: disabledBinding });
    }
    if (overlaps(sourcePath, this.store.root)) throw appError('MIGRATION_SOURCE_OVERLAPS_LIBRARY');
    const sourceStat = await lstat(sourcePath);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw appError('MIGRATION_SOURCE_NOT_DIRECTORY');
    for (const managed of this.store.list<Distribution>('distributions')) {
      const destination = await realpath(managed.entryPath).catch((error) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (destination === sourcePath) throw appError('MIGRATION_MANAGED_REFERENCE', { path: managed.entryPath });
    }
    const sourceHash = await hashDirectory(sourcePath);
    const matching: ExternalSkill[] = [];
    // strict externalSkills rejects unreadable configured directories before consent is issued.
    for (const item of external) if ((await realpath(item.path)) === sourcePath) matching.push(item);
    const harnesses = this.store.list<Harness>('harnesses');
    const workspaces = this.store.list<Workspace>('workspaces');
    const references: ExternalMigrationReference[] = matching
      .map((item) => ({
        path: item.path,
        harnessId: item.harnessId,
        harnessName: harnesses.find((harness) => harness.id === item.harnessId)?.name || item.harnessId,
        scope: item.scope,
        ...(item.workspaceId
          ? { workspaceId: item.workspaceId, workspaceName: workspaces.find((workspace) => workspace.id === item.workspaceId)?.name }
          : {}),
      }))
      .sort((a, b) =>
        `${a.path}\0${a.harnessId}\0${a.scope}\0${a.workspaceId || ''}`.localeCompare(
          `${b.path}\0${b.harnessId}\0${b.scope}\0${b.workspaceId || ''}`,
        ),
      );
    if (!references.length) throw appError('MIGRATION_NO_REFERENCES');
    const entries = [];
    for (const entryPath of [...new Set(references.map((ref) => ref.path))].sort()) {
      const info = await lstat(entryPath);
      if (!info.isDirectory() && !info.isSymbolicLink()) throw appError('MIGRATION_REFERENCE_TYPE_CHANGED');
      entries.push({
        path: entryPath,
        type: info.isSymbolicLink() ? 'symlink' : 'directory',
        link: info.isSymbolicLink() ? await readlink(entryPath) : null,
        destination: await realpath(entryPath),
        dev: info.dev,
        ino: info.ino,
      });
    }
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ sourcePath, sourceHash, sourceDev: sourceStat.dev, sourceIno: sourceStat.ino, references, entries }))
      .digest('hex');
    return { sourcePath, sourceHash, references, fingerprint };
  }
}
