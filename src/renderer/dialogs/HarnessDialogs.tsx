import { useT } from '../i18n';
import { useState } from 'react';
import { LoaderCircle, Unlink } from 'lucide-react';
import { ApplyResults } from '../components/ApplyFlow';
import { MigrationIssuePanel, MigrationPreviewPanel, MigrationResults, MigrationScanState } from '../components/MigrationPanels';
import ModalShell from '../components/ModalShell';
import type { MigrationFlow } from '../hooks/useMigrationFlow';
import type { Shell } from '../hooks/useShell';
import type { WorkspaceFlow } from '../hooks/useWorkspaceFlow';
import { FormError } from './LibraryDialogs';

export function RemoveDialog({ shell, workspace }: { shell: Shell; workspace: WorkspaceFlow }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const { removeDraft: draft, removeResult: result } = workspace;
  if (!draft) return null;
  const { busy, error, setError } = shell;
  return (
    <ModalShell
      locked={!!busy}
      title={result ? t('dialogs.unapplyResults') : t('dialogs.unapply')}
      initialFocus="[data-remove-back]"
      subtitle={
        result
          ? t('dialogs.sourceFilesInTheSkillLibraryAreKept')
          : t('dialogs.onlyInstallationsInHarnessDirectoriesAreRemovedSourceFilesIn')
      }
      onClose={result ? workspace.finishRemove : workspace.closeRemove}
    >
      {result ? (
        <ApplyResults result={result} onDone={workspace.finishRemove} />
      ) : (
        <>
          <div className="remove-warning">
            <div className="warning-icon">
              <Unlink size={17} />
            </div>
            <div>
              <strong>{t('dialogs.unapplySummary', { harnessName: draft.harnessName, count: draft.skills.length })}</strong>
              <p>
                {draft.origin === 'library'
                  ? t('dialogs.scopeSelectedSkills', { scopeLabel: draft.scopeLabel })
                  : t('dialogs.workspaceScopeSummary', { scopeLabel: draft.scopeLabel })}
              </p>
              <div className={`remove-skill-tags ${expanded ? 'expanded' : ''}`}>
                {(expanded ? draft.skills : draft.skills.slice(0, 6)).map((skill) => (
                  <span className="tag" key={skill.id}>
                    {skill.name}
                  </span>
                ))}
              </div>
              {draft.skills.length > 6 && (
                <button className="text-button" onClick={() => setExpanded(!expanded)}>
                  {expanded ? t('dialogs.hide') : t('dialogs.itemsInTotalShowAll', { count: draft.skills.length })}
                </button>
              )}
              {draft.sharedNotes?.map((note) => (
                <p key={note}>{note}</p>
              ))}
              <p>{t('dialogs.youCanApplyTheseSkillsAgainFromTheLibraryAt')}</p>
            </div>
          </div>
          <div className="dialog-footer spread">
            <button data-remove-back className="button subtle" onClick={workspace.closeRemove}>
              {t('dialogs.back')}
            </button>
            <button className="button danger" onClick={() => void workspace.confirmRemove()}>
              {busy === 'remove' ? <LoaderCircle size={15} className="spin" /> : <Unlink size={15} />}
              {t('dialogs.unapplyCount', { count: draft.skills.length })}
            </button>
          </div>
          <FormError error={error} onDismiss={() => setError('')} />
        </>
      )}
    </ModalShell>
  );
}

export function MigrationDialog({ shell, migration }: { shell: Shell; migration: MigrationFlow }) {
  const t = useT();
  const { target, preview, result, error } = migration;
  if (!target) return null;
  const { busy } = shell;
  return (
    <ModalShell
      locked={!!busy}
      title={
        result
          ? t('dialogs.migrationResults')
          : preview
            ? t('dialogs.reviewMigrationScope')
            : error
              ? t('dialogs.resolveMigrationIssues')
              : t('dialogs.checkMigrationScope')
      }
      subtitle={
        result
          ? t('dialogs.resultsAreListedByItemBelow')
          : preview
            ? t('dialogs.verifyTheSourcePathAndAllDetectedReferences')
            : error
              ? t('dialogs.repairManagedLinksCheckHarnessSettingsOrDetectAgain')
              : t('dialogs.sourcePathsAndKnownReferencesWillBeCheckedBeforeConfirmation')
      }
      onClose={() => {
        if (busy) return;
        migration.close();
      }}
      size="wide"
    >
      {result ? (
        <MigrationResults
          result={result}
          onRepreview={result.items.some((item) => item.status === 'error') ? migration.repreview : undefined}
          onDone={migration.done}
        />
      ) : preview ? (
        <MigrationPreviewPanel
          preview={preview}
          repairOutcomes={migration.repairOutcomes}
          busy={busy === 'migration'}
          onCancel={migration.close}
          onConfirm={() => void migration.confirm()}
        />
      ) : busy === 'migration-preview' && !error ? (
        <MigrationScanState />
      ) : (
        <MigrationIssuePanel
          error={error}
          repairs={migration.repairs}
          repairsChecked={migration.repairsChecked}
          repairsLoading={busy === 'migration-repairs'}
          repairsError={migration.repairsError}
          outcomes={migration.repairOutcomes}
          expandedRepairId={migration.expandedRepairId}
          busy={!!busy}
          loadingPreview={busy === 'migration-preview'}
          onToggleRepair={migration.toggleRepair}
          onRepair={(repair) => void migration.repair(repair)}
          onRecheck={() => void migration.loadPreview(target.id)}
          onOpenSettings={() => {
            shell.setDialog(null);
            shell.setPage('settings');
          }}
          onCancel={migration.close}
        />
      )}
    </ModalShell>
  );
}
