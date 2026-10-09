import { ArrowDownToLine, ArrowRight, Check, CircleHelp, LoaderCircle, X } from 'lucide-react';
import type { ApplyPlan, BatchResult, PlanItem } from '../../shared/types';

/** Apply preview and results. */
export function ApplyPreview({ plan, onContinue, busy }: { plan: ApplyPlan; onContinue: () => void; busy: boolean }) {
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
          <p className="eyebrow">确认前预览</p>
          <strong>
            {new Set(plan.items.map((item) => item.skillId)).size} 个技能 · {plan.items.length} 个目标位置
          </strong>
        </div>
        <button className="text-button" onClick={onContinue} disabled={busy}>
          {busy ? <LoaderCircle size={14} className="spin" /> : <ArrowDownToLine size={14} />}
          {conflicts ? '继续无冲突项' : '确认应用'}
        </button>
      </div>
      <div className="preview-counts">
        <span className="new">{counts.new} 新增</span>
        <span className="existing">{counts.existing} 已存在</span>
        <span className="sync">{counts.sync} 待同步</span>
        {conflicts && <span className="conflict">{counts.conflict} 冲突</span>}
      </div>
      {conflicts && (
        <div className="conflict-note">
          <CircleHelp size={14} />
          <span>冲突项不会被覆盖。确认后主进程会逐项跳过冲突目标，并继续处理其他项。</span>
        </div>
      )}
      <div className="preview-list">
        {plan.items.map((item, index) => (
          <PreviewRow item={item} key={`${item.skillId}:${item.targetPath}:${index}`} />
        ))}
      </div>
      <p className="preview-strategy">
        策略：{plan.request.strategy === 'symlink' ? '软链' : '兼容复制'} · 工作区共享目录可能被同一工作区内的其他兼容 Agent 识别。
      </p>
    </div>
  );
}

export function PreviewRow({ item }: { item: PlanItem }) {
  const label = item.status === 'new' ? '新增' : item.status === 'existing' ? '已存在' : item.status === 'sync' ? '待同步' : '冲突';
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
          <strong>{failed ? '部分操作未完成' : '操作已完成'}</strong>
          <span>
            {succeeded} 成功 · {skipped} 跳过 · {failed} 失败
          </span>
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
              <span>{item.message || (item.status === 'success' ? '已完成' : item.status === 'skipped' ? '已跳过' : '操作失败')}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="dialog-footer">
        <button className="button primary" onClick={onDone}>
          完成
        </button>
      </div>
    </>
  );
}
