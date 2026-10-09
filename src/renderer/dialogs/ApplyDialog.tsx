import { ArrowDownToLine, ArrowRight, Check, CirclePlus, FolderOpen, HardDrive, LoaderCircle, Tag } from 'lucide-react';
import type { Snapshot } from '../../shared/types';
import { ApplyPreview, ApplyResults } from '../components/ApplyFlow';
import ModalShell from '../components/ModalShell';
import { harnessGlyph } from '../format';
import type { ApplyFlow } from '../hooks/useApplyFlow';
import type { GroupDraft } from '../hooks/useGroupDraft';
import type { LibraryView } from '../hooks/useLibraryView';
import type { Shell } from '../hooks/useShell';
import { FormError, GroupPicker } from './LibraryDialogs';

export function ApplyDialog({
  shell,
  snapshot,
  view,
  apply,
  draft: groupDraft,
  onAddHarness,
}: {
  shell: Shell;
  snapshot: Snapshot;
  view: LibraryView;
  apply: ApplyFlow;
  draft: GroupDraft;
  onAddHarness: () => void;
}) {
  const { busy, error, setError } = shell;
  const { draft, plan, results, update } = apply;
  const { selected } = view;
  const duplicateGroupName = (name: string) =>
    snapshot.groups.some((group) => group.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase() && !groupDraft.groupId);
  return (
    <ModalShell
      locked={!!busy}
      title={results ? '应用结果' : '应用所选技能'}
      subtitle={results ? '每个技能和目标的执行结果。' : `已选择 ${selected.size} 个不同技能。先选择分组或安装目标。`}
      onClose={() => shell.setDialog(null)}
      size="wide"
    >
      {results ? (
        <ApplyResults result={results} onDone={apply.finish} />
      ) : (
        <>
          <div className="apply-mode-tabs" role="tablist" aria-label="应用操作类型">
            <button
              role="tab"
              aria-selected={draft.mode === 'harness'}
              className={draft.mode === 'harness' ? 'active' : ''}
              onClick={() => update({ mode: 'harness' })}
            >
              <ArrowDownToLine size={15} />
              应用到 Harness
            </button>
            <button
              role="tab"
              aria-selected={draft.mode === 'group'}
              className={draft.mode === 'group' ? 'active' : ''}
              onClick={() => update({ mode: 'group' })}
            >
              <Tag size={15} />
              加入业务分组
            </button>
          </div>
          {draft.mode === 'group' ? (
            <div className="apply-panel">
              <div className="field-help">分组只保存这次选择的成员关系，不会改变来源或安装位置。</div>
              <GroupPicker
                groups={snapshot.groups}
                draft={groupDraft}
                selectLabel="选择已有分组"
                separator="或创建分组"
                nameLabel="新分组名称"
                placeholder="例如：客户支持"
              />
              {snapshot.groups.map((group) =>
                group.name.toLocaleLowerCase() === groupDraft.name.trim().toLocaleLowerCase() && groupDraft.name.trim() ? (
                  <div className="form-warning" key={group.id}>
                    已有同名分组“{group.name}”，请选择它以避免重复。
                  </div>
                ) : null,
              )}
              <div className="dialog-footer">
                <button
                  className="button primary"
                  disabled={(!groupDraft.groupId && !groupDraft.name.trim()) || duplicateGroupName(groupDraft.name)}
                  onClick={() => void apply.saveToGroup()}
                >
                  {busy === 'group' ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}确认加入 {selected.size} 项
                </button>
              </div>
            </div>
          ) : (
            <div className="apply-panel">
              <div className="scope-switch" role="radiogroup" aria-label="安装作用域">
                <button
                  role="radio"
                  aria-checked={draft.scope === 'user'}
                  className={draft.scope === 'user' ? 'active' : ''}
                  onClick={() => update({ scope: 'user', harnessIds: [] })}
                >
                  <HardDrive size={16} />
                  <span>
                    <strong>用户级</strong>
                    <small>对当前用户可用</small>
                  </span>
                </button>
                <button
                  role="radio"
                  aria-checked={draft.scope === 'workspace'}
                  className={draft.scope === 'workspace' ? 'active' : ''}
                  onClick={() => update({ scope: 'workspace', harnessIds: [] })}
                >
                  <FolderOpen size={16} />
                  <span>
                    <strong>工作区级</strong>
                    <small>仅配置指定工作目录</small>
                  </span>
                </button>
              </div>
              {draft.scope === 'workspace' && (
                <div className="workspace-path-field">
                  <label className="field-label" htmlFor="apply-workspace">
                    工作目录
                  </label>
                  <div className="path-picker">
                    <FolderOpen size={16} />
                    <input
                      id="apply-workspace"
                      value={draft.workspacePath}
                      onChange={(event) => update({ workspacePath: event.target.value })}
                      placeholder="选择本地工作目录"
                    />
                    <button className="button subtle" onClick={() => void apply.chooseWorkspace()}>
                      浏览…
                    </button>
                  </div>
                  <p className="field-help">工作区路径由你明确选择；应用不会自动切换到 Git 根目录。</p>
                </div>
              )}
              <div className="harness-picker-heading">
                <div>
                  <span className="field-label">目标 Harness</span>
                  <span className="field-help">可同时选择多个目标，实际共享目录会在预览中合并。</span>
                </div>
                <button className="text-button" onClick={onAddHarness}>
                  <CirclePlus size={14} />
                  添加自定义
                </button>
              </div>
              <div className="harness-picker-grid">
                {!snapshot.harnesses.length && (
                  <p className="field-help">尚未启用 Harness，请先在设置中开启需要管理的工具，或添加自定义 Harness。</p>
                )}
                {snapshot.harnesses
                  .filter((harness) => draft.scope === 'user' || harness.id !== 'universal')
                  .map((harness) => {
                    const path =
                      draft.scope === 'user'
                        ? harness.userSkillsPath || (harness.readsUserAgents ? '~/.agents/skills' : '')
                        : harness.workspaceSkillsRelativePath || (harness.readsWorkspaceAgents ? '.agents/skills' : '');
                    const unavailable = !path;
                    const checked = draft.harnessIds.includes(harness.id);
                    return (
                      <button
                        key={harness.id}
                        className={`harness-choice ${checked ? 'checked' : ''} ${unavailable ? 'unavailable' : ''}`}
                        disabled={unavailable}
                        onClick={() =>
                          update({
                            harnessIds: checked ? draft.harnessIds.filter((id) => id !== harness.id) : [...draft.harnessIds, harness.id],
                          })
                        }
                      >
                        <span className={`harness-icon ${harness.origin}`}>{harnessGlyph(harness.icon, harness.name)}</span>
                        <span className="harness-choice-copy">
                          <strong>{harness.name}</strong>
                          <small title={path || '此作用域不可用'}>{path || '未配置此作用域'}</small>
                        </span>
                        <span className="choice-check">{checked && <Check size={12} />}</span>
                      </button>
                    );
                  })}
              </div>
              <div className="advanced-row">
                <div>
                  <strong>安装策略</strong>
                  <span>链接保持中央库与 Harness 同步；复制可显式用于兼容。</span>
                </div>
                <div className="strategy-toggle">
                  <button className={draft.strategy === 'symlink' ? 'active' : ''} onClick={() => update({ strategy: 'symlink' })}>
                    软链
                  </button>
                  <button className={draft.strategy === 'copy' ? 'active' : ''} onClick={() => update({ strategy: 'copy' })}>
                    复制
                  </button>
                </div>
              </div>
              {plan && <ApplyPreview plan={plan} onContinue={() => void apply.confirm()} busy={busy === 'apply'} />}
              {!plan && (
                <div className="dialog-footer">
                  <button
                    className="button primary"
                    disabled={
                      !selected.size || !draft.harnessIds.length || (draft.scope === 'workspace' && !draft.workspacePath.trim()) || !!busy
                    }
                    onClick={() => void apply.preview()}
                  >
                    {busy === 'preview' ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}预览安装目标
                  </button>
                </div>
              )}
            </div>
          )}
          <FormError error={error} onDismiss={() => setError('')} />
        </>
      )}
    </ModalShell>
  );
}
