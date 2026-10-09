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
  if (expandableCount <= 0 && (!selectableCount || !onToggleSelection)) return null;
  return (
    <div className={`list-actions ${className}`.trim()}>
      {expandableCount > 0 && (
        <button type="button" className="list-action-button" onClick={onToggleExpanded} aria-label={allExpanded ? '全部折叠' : '全部展开'}>
          {allExpanded ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}
          {allExpanded ? '全部折叠' : '全部展开'}
        </button>
      )}
      {!!selectableCount && onToggleSelection && (
        <button
          type="button"
          className="list-action-button"
          onClick={onToggleSelection}
          aria-label={allSelected ? '取消全选' : `全选 ${selectableCount} 项`}
        >
          {allSelected ? '取消全选' : `全选 ${selectableCount} 项`}
        </button>
      )}
    </div>
  );
}
