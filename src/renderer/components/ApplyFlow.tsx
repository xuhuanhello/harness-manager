import { useT } from '../i18n';
import { ArrowDownToLine, ArrowRight, Check, CircleHelp, LoaderCircle, X } from 'lucide-react';
import type { ApplyPlan, BatchResult, PlanItem } from '../../shared/types';

/** Apply preview and results. */
export function ApplyPreview({ plan, onContinue, busy }: { plan: ApplyPlan; onContinue: () => void; busy: boolean }) {
  const t = useT();
  const counts = plan.items.reduce(
    (acc, item) => {
      acc[item.status] += 1;
      return acc;
    },
    { new: 0, existing: 0, sync: 0, conflict: 0 },
  );
  const conflicts = counts.conflict > 0;
  return (
    <div className="apply-preview">
      <div className="preview-title-row">
        <div>
          <p className="eyebrow">{t('library.reviewBeforeApplying')}</p>
          <strong>
            {t('library.applyPreviewCount', {
              skills: new Set(plan.items.map((item) => item.skillId)).size,
              destinations: plan.items.length,
            })}
          </strong>
        </div>
        <button className="text-button" onClick={onContinue} disabled={busy}>
          {busy ? <LoaderCircle size={14} className="spin" /> : <ArrowDownToLine size={14} />}
          {conflicts ? t('library.continueWithoutConflicts') : t('library.apply')}
        </button>
      </div>
      <div className="preview-counts">
        <span className="new">{t('library.newCount', { count: counts.new })}</span>
        <span className="existing">{t('library.existingCount', { count: counts.existing })}</span>
        <span className="sync">{t('library.syncCount', { count: counts.sync })}</span>
        {conflicts && <span className="conflict">{t('library.conflictCount', { count: counts.conflict })}</span>}
      </div>
      {conflicts && (
        <div className="conflict-note">
          <CircleHelp size={14} />
          <span>{t('library.conflictingItemsWillBeKeptTheAppWillSkipEach')}</span>
        </div>
      )}
      <div className="preview-list">
        {plan.items.map((item, index) => (
          <PreviewRow item={item} key={`${item.skillId}:${item.targetPath}:${index}`} />
        ))}
      </div>
      <p className="preview-strategy">
        {t('library.strategySummary', {
          strategy: plan.request.strategy === 'symlink' ? t('library.symlink') : t('library.copyForCompatibility'),
        })}
      </p>
    </div>
  );
}

export function PreviewRow({ item }: { item: PlanItem }) {
  const t = useT();
  const label =
    item.status === 'new'
      ? t('library.newStatus')
      : item.status === 'existing'
        ? t('library.alreadyExists')
        : item.status === 'sync'
          ? t('library.outOfSyncStatus')
          : t('library.conflict');
  return (
    <div className={`preview-row ${item.status}`}>
      <span className="preview-status-icon">
        {item.status === 'conflict' ? <X size={12} /> : item.status === 'existing' ? <Check size={12} /> : <ArrowDownToLine size={12} />}
      </span>
      <div>
        <strong>
          {item.skillName}
          <span>{label}</span>
        </strong>
        <code title={item.targetPath}>{item.targetPath}</code>
        {item.message && <small>{item.message}</small>}
      </div>
    </div>
  );
}

export function ApplyResults({ result, onDone }: { result: BatchResult; onDone: () => void }) {
  const t = useT();
  const succeeded = result.items.filter((item) => item.status === 'success').length;
  const skipped = result.items.filter((item) => item.status === 'skipped').length;
  const failed = result.items.filter((item) => item.status === 'error').length;
  return (
    <>
      <div className="result-summary">
        <span className={`result-icon ${failed ? 'partial' : ''}`}>
          <Check size={17} />
        </span>
        <div>
          <strong>{failed ? t('library.someOperationsWereNotCompleted') : t('library.operationCompleted')}</strong>
          <span>{t('common.resultSummary', { succeeded, skipped, failed })}</span>
        </div>
      </div>
      <div className="result-list">
        {result.items.map((item, index) => (
          <div className="result-row" key={`${item.id}:${index}`}>
            <span className={`result-state ${item.status}`}>
              {item.status === 'success' ? <Check size={13} /> : item.status === 'skipped' ? <ArrowRight size={13} /> : <X size={13} />}
            </span>
            <div>
              <strong>{item.label}</strong>
              <span>
                {item.message ||
                  (item.status === 'success'
                    ? t('library.completed')
                    : item.status === 'skipped'
                      ? t('library.skippedStatus')
                      : t('library.operationFailed'))}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="dialog-footer">
        <button className="button primary" onClick={onDone}>
          {t('library.done')}
        </button>
      </div>
    </>
  );
}
