import { formatList, countUnit } from '../i18n';
import { useT } from '../i18n';
import { ArrowRight, ArrowUpFromLine, Check, Folder, Github, Info, LoaderCircle, RefreshCw, TriangleAlert, X } from 'lucide-react';
import type { Snapshot } from '../../shared/types';
import ModalShell from '../components/ModalShell';
import type { Shell } from '../hooks/useShell';
import type { Updates } from '../hooks/useUpdates';
import { FormError } from './LibraryDialogs';

/** Confirms the selected updates, then reports each skill's result. */
export function UpdateDialog({ shell, snapshot, updates }: { shell: Shell; snapshot: Snapshot; updates: Updates }) {
  const t = useT();
  const { busy, error, setError } = shell;
  const running = busy === 'updates';
  const { result } = updates;
  const selected = new Set(updates.selectedIds);
  const groups = updates.sources
    .map((item) => ({ ...item, entries: item.entries.filter((entry) => selected.has(entry.skillId)) }))
    .filter((item) => item.entries.length);
  const distributions = snapshot.distributions.filter((item) => selected.has(item.skillId));
  const copies = distributions.filter((item) => item.strategy === 'copy').length;

  if (result) {
    const succeeded = result.items.filter((item) => item.status === 'success').length;
    const updated = new Set(result.skillIds ?? []);
    const staleCopies = snapshot.distributions.filter((item) => updated.has(item.skillId) && item.strategy === 'copy').length;
    return (
      <ModalShell title={t('dialogs.updateResults')} subtitle={t('dialogs.updateStatusForEachItem')} onClose={updates.closeDialog}>
        <div className="result-summary">
          <span className={`result-icon ${succeeded === result.items.length ? '' : 'partial'}`}>
            <Check size={17} />
          </span>
          <div>
            <strong>{succeeded === result.items.length ? t('dialogs.updatesCompleted') : t('dialogs.updateFinished')}</strong>
            <span>{t('common.completedSummary', { succeeded, attention: result.items.length - succeeded })}</span>
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
                      ? t('dialogs.updated')
                      : item.status === 'skipped'
                        ? t('dialogs.skipped')
                        : t('dialogs.updateFailed'))}
                </span>
              </div>
            </div>
          ))}
        </div>
        {staleCopies > 0 && (
          <p className="field-help info-help update-dialog-help">
            <Info size={13} />
            {t('dialogs.staleCopies', { count: staleCopies })}
          </p>
        )}
        <div className="dialog-footer">
          <button className="button primary" onClick={updates.closeDialog}>
            {t('dialogs.done')}
            <ArrowRight size={15} />
          </button>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell
      locked={running}
      title={t('dialogs.updateSkills')}
      subtitle={t('dialogs.replaceLibrarySkillsWithTheirUpstreamVersions', { size: selected.size })}
      onClose={updates.closeDialog}
    >
      <div className="update-confirm-stats">
        <div>
          <strong>{selected.size}</strong>
          <span>{countUnit(selected.size, 'skill')}</span>
        </div>
        <div>
          <strong>{groups.length}</strong>
          <span>{countUnit(groups.length, 'source')}</span>
        </div>
        <div>
          <strong>{distributions.length}</strong>
          <span>{countUnit(distributions.length, 'appliedInstallation')}</span>
        </div>
      </div>
      <div className="update-confirm-list">
        {groups.map((item) => (
          <div className="update-confirm-source" key={item.source.id}>
            <div className="update-confirm-source-name">
              {item.source.type === 'github' ? <Github size={13} /> : <Folder size={13} />}
              <strong>{item.source.label}</strong>
              {item.commit && <code>{item.commit.slice(0, 7)}</code>}
            </div>
            <div className="update-confirm-skills">
              {item.entries.map((entry) => (
                <span key={entry.skillId} className={entry.localModified ? 'modified' : undefined}>
                  {entry.name}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="field-help info-help update-dialog-help">
        <Info size={13} />
        {copies > 0
          ? t('dialogs.symlinkInstallationsUseTheNewVersionImmediatelyCopyInstallationsNeed', { copies: copies })
          : t('dialogs.symlinkInstallationsUseTheNewVersionImmediatelyNoReapplyingNeeded')}
      </p>
      {updates.replacingModified.length > 0 && (
        <div className="update-confirm-warning">
          <TriangleAlert size={14} />
          <span>{t('dialogs.modifiedSkillsWarning', { names: formatList(updates.replacingModified.map((entry) => entry.name)) })}</span>
        </div>
      )}
      <FormError error={error} onDismiss={() => setError('')} />
      <div className="dialog-footer spread">
        {error ? (
          <button className="button subtle" onClick={updates.recheck} disabled={running}>
            <RefreshCw size={14} />
            {t('dialogs.checkUpdatesAgain')}
          </button>
        ) : (
          <button className="button subtle" onClick={updates.closeDialog} disabled={running}>
            {t('dialogs.cancel')}
          </button>
        )}
        <button className="button primary" disabled={!selected.size || running} onClick={() => void updates.apply()}>
          {running ? <LoaderCircle size={15} className="spin" /> : <ArrowUpFromLine size={15} />}
          {running ? t('dialogs.updating') : t('dialogs.updateItems', { size: selected.size })}
        </button>
      </div>
    </ModalShell>
  );
}
