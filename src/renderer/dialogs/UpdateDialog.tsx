import { ArrowRight, ArrowUpFromLine, Check, Folder, Github, Info, LoaderCircle, RefreshCw, TriangleAlert, X } from 'lucide-react';
import type { Snapshot } from '../../shared/types';
import ModalShell from '../components/ModalShell';
import type { Shell } from '../hooks/useShell';
import type { Updates } from '../hooks/useUpdates';
import { FormError } from './LibraryDialogs';

/** Confirms the selected updates, then reports each skill's result. */
export function UpdateDialog({ shell, snapshot, updates }: { shell: Shell; snapshot: Snapshot; updates: Updates }) {
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
      <ModalShell title="更新结果" subtitle="按项显示本次更新状态。" onClose={updates.closeDialog}>
        <div className="result-summary">
          <span className={`result-icon ${succeeded === result.items.length ? '' : 'partial'}`}>
            <Check size={17} />
          </span>
          <div>
            <strong>{succeeded === result.items.length ? '更新已完成' : '更新处理完成'}</strong>
            <span>
              {succeeded} 项成功 · {result.items.length - succeeded} 项需留意
            </span>
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
                <span>{item.message || (item.status === 'success' ? '已更新' : item.status === 'skipped' ? '已跳过' : '更新失败')}</span>
              </div>
            </div>
          ))}
        </div>
        {staleCopies > 0 && (
          <p className="field-help info-help update-dialog-help">
            <Info size={13} />
            {staleCopies} 处副本安装不会自动刷新；在技能库中重新应用这些技能即可同步。
          </p>
        )}
        <div className="dialog-footer">
          <button className="button primary" onClick={updates.closeDialog}>
            完成 <ArrowRight size={15} />
          </button>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell
      locked={running}
      title="更新技能"
      subtitle={`用上游版本替换中央库中的 ${selected.size} 个技能。`}
      onClose={updates.closeDialog}
    >
      <div className="update-confirm-stats">
        <div>
          <strong>{selected.size}</strong>
          <span>个技能</span>
        </div>
        <div>
          <strong>{groups.length}</strong>
          <span>个来源</span>
        </div>
        <div>
          <strong>{distributions.length}</strong>
          <span>处已应用的安装</span>
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
          ? `软链接安装会立即使用新版本；${copies} 处副本安装需在更新后重新应用以同步。`
          : '软链接安装会立即使用新版本，无需重新应用。'}
      </p>
      {updates.replacingModified.length > 0 && (
        <div className="update-confirm-warning">
          <TriangleAlert size={14} />
          <span>
            {updates.replacingModified.map((entry) => entry.name).join('、')}{' '}
            在中央库中有本地修改。更新后，修改前的版本会移到废纸篓，可从那里找回。
          </span>
        </div>
      )}
      <FormError error={error} onDismiss={() => setError('')} />
      <div className="dialog-footer spread">
        {error ? (
          <button className="button subtle" onClick={updates.recheck} disabled={running}>
            <RefreshCw size={14} />
            重新检查更新
          </button>
        ) : (
          <button className="button subtle" onClick={updates.closeDialog} disabled={running}>
            取消
          </button>
        )}
        <button className="button primary" disabled={!selected.size || running} onClick={() => void updates.apply()}>
          {running ? <LoaderCircle size={15} className="spin" /> : <ArrowUpFromLine size={15} />}
          {running ? '正在更新…' : `确认更新 ${selected.size} 项`}
        </button>
      </div>
    </ModalShell>
  );
}
