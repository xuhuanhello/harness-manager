import { t, useT } from '../i18n';
import {
  ArrowRight,
  Check,
  CircleHelp,
  FolderOpen,
  HardDrive,
  Link2,
  LoaderCircle,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import type { BatchResult, ExternalMigrationPreview, ManagedLinkRepairPreview } from '../../shared/types';
import type { ManagedRepairOutcome } from '../view-types';

/** External-skill migration: issues, managed-link repair, preview and results. */
export function migrationFailureSummary(error: string) {
  if (/[\u3400-\u9fff]/.test(error)) return error;
  const value = error.toLocaleLowerCase();
  if (/修复未|修复没有完成|repair failed|repair did not complete/.test(value))
    return t('library.managedLinkRepairWasNotCompletedCheckTheDestinationPath');
  if (/eacces|eperm|permission|access denied|not permitted/.test(value))
    return t('library.cannotAccessTheSkillDirectoryCheckFilePermissionsOrExternal');
  if (/enoent|not found|does not exist|no longer available/.test(value))
    return t('library.skillSourcePathNotFoundTheDirectoryMayHaveMoved');
  if (/symlink|symbolic link|managed link|link target/.test(value)) return t('library.aManagedLinkHasAProblemCheckBelowForAvailable');
  if (/unsupported|not supported|cross-device/.test(value)) return t('library.thisDirectoryOrFileSystemDoesNotSupportTheRequired');
  return t('library.cannotSafelyVerifyTheSkillSourcePathOrAllKnown');
}

export function MigrationScanState() {
  const t = useT();
  return (
    <div className="migration-preview-state">
      <span className="migration-warning-icon">
        <LoaderCircle size={17} className="spin" />
      </span>
      <div>
        <strong>{t('library.checkingSourcePathsAndReferences')}</strong>
        <p>{t('library.checkingConfiguredHarnessesAndRegisteredWorkspacesMigrationWillNotStart')}</p>
      </div>
    </div>
  );
}

export function MigrationRepairOutcomes({ outcomes }: { outcomes: ManagedRepairOutcome[] }) {
  const t = useT();
  if (!outcomes.length) return null;
  return (
    <div className="migration-repair-outcomes">
      {outcomes.map(({ repair, result, error }) => {
        const succeeded = !error && !!result && result.items.length > 0 && result.items.every((item) => item.status !== 'error');
        return (
          <div className={`migration-repair-outcome ${succeeded ? 'success' : 'error'}`} key={repair.repairId}>
            <span>{succeeded ? <Check size={13} /> : <CircleHelp size={13} />}</span>
            <div>
              <strong>
                {t('library.repairStatus', {
                  name: repair.skillName,
                  status: error ? t('library.repairFailed') : succeeded ? t('library.managedLinkRepaired') : t('library.repairIncomplete'),
                })}
              </strong>
              {error && (
                <>
                  <small>{migrationFailureSummary(error)}</small>
                  <details>
                    <summary>{t('library.viewErrorDetails')}</summary>
                    <code>{error}</code>
                  </details>
                </>
              )}
              {result?.items.map((item) => (
                <small key={item.id}>
                  {t('common.namedDetail', {
                    name: item.label,
                    detail:
                      item.message ||
                      (item.status === 'success'
                        ? t('library.completed')
                        : item.status === 'skipped'
                          ? t('library.skippedStatus')
                          : t('library.incomplete')),
                  })}
                </small>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ManagedLinkRepairCard({
  repair,
  expanded,
  busy,
  onToggle,
  onConfirm,
}: {
  repair: ManagedLinkRepairPreview;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <article className="managed-repair-card">
      <div className="managed-repair-heading">
        <span className="migration-reference-mark">
          <Link2 size={13} />
        </span>
        <div>
          <strong>{repair.skillName}</strong>
          <code title={repair.entryPath}>{repair.entryPath}</code>
        </div>
        <button className="button subtle compact" disabled={busy} aria-expanded={expanded} onClick={onToggle}>
          {expanded ? t('library.hidePreview') : t('library.previewRepair')}
        </button>
      </div>
      {expanded && (
        <div className="managed-repair-details">
          <div className="managed-repair-paths">
            <div>
              <span>{t('library.currentPath')}</span>
              <code title={repair.entryPath}>{repair.entryPath}</code>
            </div>
            <div>
              <span>{t('library.currentIncorrectTarget')}</span>
              <code title={repair.currentTarget}>{repair.currentTarget}</code>
            </div>
            <div>
              <span>{t('library.correctLibraryPath')}</span>
              <code title={repair.centralPath}>{repair.centralPath}</code>
            </div>
          </div>
          <p>{t('library.onlyThisManagedLinkWillBeReplacedTheOldSource')}</p>
          <button className="button primary compact" disabled={busy} onClick={onConfirm}>
            {busy ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}
            {t('library.repairLink')}
          </button>
        </div>
      )}
    </article>
  );
}

export function MigrationIssuePanel({
  error,
  repairs,
  repairsChecked,
  repairsLoading,
  repairsError,
  outcomes,
  expandedRepairId,
  busy,
  loadingPreview,
  onToggleRepair,
  onRepair,
  onRecheck,
  onOpenSettings,
  onCancel,
}: {
  error: string;
  repairs: ManagedLinkRepairPreview[];
  repairsChecked: boolean;
  repairsLoading: boolean;
  repairsError: string;
  outcomes: ManagedRepairOutcome[];
  expandedRepairId: string;
  busy: boolean;
  loadingPreview: boolean;
  onToggleRepair: (repairId: string) => void;
  onRepair: (repair: ManagedLinkRepairPreview) => void;
  onRecheck: () => void;
  onOpenSettings: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <>
      <div className="migration-issue-panel">
        <div className="migration-issue-header">
          <span>
            <CircleHelp size={16} />
          </span>
          <div>
            <strong>{t('library.migrationCheckIncomplete')}</strong>
            <p>{migrationFailureSummary(error)}</p>
          </div>
        </div>
        <div className="migration-issue-actions">
          <button className="button primary" disabled={busy} onClick={onRecheck}>
            {loadingPreview ? <LoaderCircle size={14} className="spin" /> : <Search size={14} />}
            {t('library.detectAgain')}
          </button>
          <div>
            <button className="button subtle" disabled={busy} onClick={onOpenSettings}>
              <Settings2 size={14} />
              {t('library.checkHarnessSettings')}
            </button>
            <small>{t('library.viewDirectorySettingsWithoutChangingFiles')}</small>
          </div>
        </div>
        <details className="migration-error-details">
          <summary>{t('library.viewDetectionErrorDetails')}</summary>
          <code>{error}</code>
        </details>
      </div>
      <MigrationRepairOutcomes outcomes={outcomes} />
      {repairsLoading && (
        <div className="repair-list-status">
          <LoaderCircle size={14} className="spin" />
          {t('library.checkingForRepairableManagedLinks')}
        </div>
      )}
      {repairsError && (
        <div className="repair-list-status warning">
          <CircleHelp size={14} />
          <span>
            {t('library.couldNotReadManagedLinkRepairSuggestionsCheckHarnessPaths')}
            <details>
              <summary>{t('library.viewErrorDetails')}</summary>
              <code>{repairsError}</code>
            </details>
          </span>
        </div>
      )}
      {!repairsLoading && !repairsError && repairs.length > 0 && (
        <section className="managed-repairs">
          <div className="managed-repairs-heading">
            <strong>{t('library.managedLinksAvailableForRepair')}</strong>
            <span>{t('library.repairCount', { count: repairs.length })}</span>
          </div>
          {repairs.map((repair) => (
            <ManagedLinkRepairCard
              key={repair.repairId}
              repair={repair}
              expanded={expandedRepairId === repair.repairId}
              busy={busy}
              onToggle={() => onToggleRepair(repair.repairId)}
              onConfirm={() => onRepair(repair)}
            />
          ))}
        </section>
      )}
      {repairsChecked && !repairsLoading && !repairsError && repairs.length === 0 && (
        <div className="no-managed-repairs">
          <ShieldCheck size={14} />
          <span>{t('library.noAutomaticallyRepairableManagedLinksFoundCheckHarnessPathsIf')}</span>
        </div>
      )}
      <div className="dialog-footer">
        <button className="button subtle" disabled={busy} onClick={onCancel}>
          {t('library.backToHarness')}
        </button>
      </div>
    </>
  );
}

export function MigrationPreviewPanel({
  preview,
  repairOutcomes,
  busy,
  onCancel,
  onConfirm,
}: {
  preview: ExternalMigrationPreview;
  repairOutcomes: ManagedRepairOutcome[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <>
      <MigrationRepairOutcomes outcomes={repairOutcomes} />
      <div className="migration-source-card">
        <span className="migration-warning-icon">
          <FolderOpen size={17} />
        </span>
        <div>
          <strong>{t('library.sourcePath')}</strong>
          <code title={preview.sourcePath}>{preview.sourcePath}</code>
        </div>
      </div>
      <div className="migration-source-card migration-central-path">
        <span className="migration-warning-icon">
          <HardDrive size={17} />
        </span>
        <div>
          <strong>{t('library.libraryDirectoryAfterMigration')}</strong>
          <code title={preview.centralPath}>{preview.centralPath}</code>
        </div>
      </div>
      <div className="migration-reference-heading">
        <div>
          <strong>{t('library.detectedHarnessReferences')}</strong>
          <span>{t('library.referenceCount', { count: preview.references.length })}</span>
        </div>
        <span>{t('library.configuredHarnessesRegisteredWorkspaces')}</span>
      </div>
      {preview.references.length ? (
        <div className="migration-reference-list">
          {preview.references.map((reference, index) => (
            <div
              className="migration-reference-row"
              key={`${reference.path}:${reference.harnessId}:${reference.workspaceId || 'user'}:${index}`}
            >
              <span className="migration-reference-mark">
                <Link2 size={13} />
              </span>
              <div>
                <strong>{reference.harnessName}</strong>
                <span>
                  {reference.scope === 'user'
                    ? t('library.user')
                    : t('library.workspace', {
                        value: reference.workspaceName || reference.workspaceId || t('library.registeredWorkspace'),
                      })}
                </span>
                <code title={reference.path}>{reference.path}</code>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="migration-no-references">
          <ShieldCheck size={15} />
          <span>{t('library.noKnownHarnessReferencesFoundThePreviewCoversConfiguredHarnesses')}</span>
        </div>
      )}
      <div className="migration-final-warning">
        <ShieldCheck size={14} />
        <span>{t('library.migrationKeepsTheseHarnessEntryNamesAndPathsAndPoints')}</span>
      </div>
      <div className="dialog-footer spread">
        <button className="button subtle" disabled={busy} onClick={onCancel}>
          {t('library.cancel')}
        </button>
        <button className="button danger" disabled={busy} onClick={onConfirm}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={14} />}
          {t('library.migrateAndRemoveOldSource')}
        </button>
      </div>
    </>
  );
}

export function MigrationResults({ result, onDone, onRepreview }: { result: BatchResult; onDone: () => void; onRepreview?: () => void }) {
  const t = useT();
  const succeeded = result.items.filter((item) => item.status === 'success').length;
  const needsAttention = result.items.length - succeeded;
  return (
    <>
      <div className="result-summary">
        <span className={`result-icon ${needsAttention ? 'partial' : ''}`}>
          {needsAttention ? <CircleHelp size={16} /> : <Check size={17} />}
        </span>
        <div>
          <strong>{t('library.migrationFinished')}</strong>
          <span>{t('common.completedSummary', { succeeded, attention: needsAttention })}</span>
        </div>
      </div>
      <div className="result-list">
        {result.items.map((item) => (
          <div className="result-row" key={item.id}>
            <span className={`result-state ${item.status}`}>
              {item.status === 'success' ? <Check size={13} /> : item.status === 'skipped' ? <ArrowRight size={13} /> : <X size={13} />}
            </span>
            <div>
              <strong>{item.label}</strong>
              <span>
                {item.message ||
                  (item.status === 'success'
                    ? t('library.migrationCompleted')
                    : item.status === 'skipped'
                      ? t('library.skippedStatus')
                      : t('library.migrationFailed'))}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="dialog-footer spread">
        {onRepreview && (
          <button className="button subtle" onClick={onRepreview}>
            <Search size={14} />
            {t('library.checkReferencesAgain')}
          </button>
        )}
        <button className="button primary" onClick={onDone}>
          {t('library.returnToHarness')}
          <ArrowRight size={15} />
        </button>
      </div>
    </>
  );
}
