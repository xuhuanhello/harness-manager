import { ArrowDownToLine, CheckCheck } from 'lucide-react';
import { formatCount } from '../format';
import type { LibraryView } from '../hooks/useLibraryView';

export function SelectionDock({ view, onReview, onApply }: { view: LibraryView; onReview: () => void; onApply: () => void }) {
  const { selectedCount, selectedOutsideView } = view;
  return (
    <div className="selection-dock">
      <div className="dock-count">
        <div className="dock-icon">
          <CheckCheck size={16} />
        </div>
        <div>
          <strong>{formatCount(selectedCount, '个技能')}</strong>
          <span>{selectedOutsideView ? `${selectedOutsideView} 项不在当前视图` : '按 skill_id 去重计数'}</span>
        </div>
      </div>
      <div className="dock-actions">
        <button className="button subtle" disabled={!selectedCount} onClick={onReview}>
          查看已选
        </button>
        <button className="button subtle" disabled={!selectedCount} onClick={() => view.setSelected(new Set())}>
          清空
        </button>
        <button data-testid="apply-selection" className="button primary" disabled={!selectedCount} onClick={onApply}>
          <ArrowDownToLine size={15} />
          应用 <span className="button-count">{selectedCount}</span>
        </button>
      </div>
    </div>
  );
}
