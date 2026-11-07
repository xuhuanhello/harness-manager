import { useT } from '../i18n';
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react';

type Props = {
  allExpanded: boolean;
  onToggleExpanded: () => void;
  expandableCount: number;
  selectableCount?: number;
  allSelected?: boolean;
  onToggleSelection?: () => void;
  className?: string;
};

export default function ListActions({
  allExpanded,
  onToggleExpanded,
  expandableCount,
  selectableCount = 0,
  allSelected = false,
  onToggleSelection,
  className = '',
}: Props) {
  const t = useT();
  if (expandableCount <= 0 && (!selectableCount || !onToggleSelection)) return null;
  return (
    <div className={`list-actions ${className}`.trim()}>
      {expandableCount > 0 && (
        <button
          type="button"
          className="list-action-button"
          onClick={onToggleExpanded}
          aria-label={allExpanded ? t('library.collapseAll') : t('library.expandAll')}
        >
          {allExpanded ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}
          {allExpanded ? t('library.collapseAll') : t('library.expandAll')}
        </button>
      )}
      {!!selectableCount && onToggleSelection && (
        <button
          type="button"
          className="list-action-button"
          onClick={onToggleSelection}
          aria-label={allSelected ? t('library.deselectAll') : t('library.selectAllItems', { selectableCount: selectableCount })}
        >
          {allSelected ? t('library.deselectAll') : t('library.selectAllItems', { selectableCount: selectableCount })}
        </button>
      )}
    </div>
  );
}
