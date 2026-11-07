import { useT } from '../i18n';
import { ArrowDownToLine, CheckCheck, Unlink } from 'lucide-react';
import { formatCount } from '../format';
import type { LibraryView } from '../hooks/useLibraryView';

export function SelectionDock({
  view,
  onReview,
  onApply,
  unapply,
}: {
  view: LibraryView;
  onReview: () => void;
  onApply: () => void;
  unapply?: { harnessName: string; count: number; outsideCount: number; onClick: () => void };
}) {
  const t = useT();
  const { selectedCount, selectedOutsideView } = view;
  const detail = unapply
    ? !selectedCount
      ? t('library.selectSkillsOrAWholeSectionToApplyOrUnapply')
      : !unapply.count
        ? t('library.noneOfTheSelectedSkillsAreAppliedTo', { harnessName: unapply.harnessName })
        : t('library.itemsAppliedTo', {
            count: unapply.count,
            harnessName: unapply.harnessName,
            value: unapply.outsideCount ? t('library.itemsOutsideThisHarness', { outsideCount: unapply.outsideCount }) : '',
          })
    : selectedOutsideView
      ? t('library.itemsOutsideTheCurrentView', { selectedOutsideView: selectedOutsideView })
      : t('library.skillsAppearingInMultipleSectionsAreCountedOnce');
  return (
    <div className={`selection-dock${unapply ? ' with-unapply' : ''}`}>
      <div className="dock-count">
        <div className="dock-icon">
          <CheckCheck size={16} />
        </div>
        <div>
          <strong>{formatCount(selectedCount, 'skill')}</strong>
          <span>{detail}</span>
        </div>
      </div>
      <div className="dock-actions">
        <button className="button subtle review-selection" disabled={!selectedCount} onClick={onReview}>
          {t('library.viewSelection')}
        </button>
        <button className="button subtle" disabled={!selectedCount} onClick={() => view.setSelected(new Set())}>
          {t('library.clear')}
        </button>
        {unapply && (
          <button
            data-testid="unapply-selection"
            className="button subtle danger-quiet"
            disabled={!unapply.count}
            title={
              !unapply.count
                ? selectedCount
                  ? t('library.noneOfTheSelectedSkillsAreAppliedTo', { harnessName: unapply.harnessName })
                  : t('library.selectSkillsOrSectionsToUnapplyThem')
                : undefined
            }
            onClick={unapply.onClick}
          >
            <Unlink size={15} />
            {t('library.unapply')}
            <span className="button-count">{unapply.count}</span>
          </button>
        )}
        <button data-testid="apply-selection" className="button primary" disabled={!selectedCount} onClick={onApply}>
          <ArrowDownToLine size={15} />
          {t('library.applySelectedAction')}
          <span className="button-count">{selectedCount}</span>
        </button>
      </div>
    </div>
  );
}
