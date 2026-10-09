import { ArrowRight, Check, CircleHelp, LoaderCircle, Plus, X } from 'lucide-react';
import type { Group, Skill, Snapshot } from '../../shared/types';
import ModalShell from '../components/ModalShell';
import { InstallResults, SourceWizard } from '../components/SourceWizard';
import { formatCount, initial, sourceName } from '../format';
import type { GroupDraft } from '../hooks/useGroupDraft';
import type { LibraryView } from '../hooks/useLibraryView';
import type { Shell } from '../hooks/useShell';
import type { SourceWizardState } from '../hooks/useSourceWizard';

export function FormError({ error, onDismiss }: { error: string; onDismiss: () => void }) {
  if (!error) return null;
  return (
    <div className="form-error">
      <CircleHelp size={14} />
      {error}
      <button onClick={onDismiss}>关闭</button>
    </div>
  );
}

/** Choose an existing group or type a new name; used after importing and when grouping a selection. */
export function GroupPicker({
  groups,
  draft,
  selectLabel,
  separator,
  nameLabel,
  placeholder,
  autoFocus,
}: {
  groups: Group[];
  draft: GroupDraft;
  selectLabel: string;
  separator: string;
  nameLabel: string;
  placeholder: string;
  autoFocus?: boolean;
}) {
  return (
    <>
      {groups.length > 0 && (
        <label className="field-label">
          {selectLabel}
          <select className="form-input" value={draft.groupId} onChange={(event) => draft.chooseGroup(event.target.value)}>
            <option value="">选择分组…</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="or-separator">
        <span>{separator}</span>
      </div>
      <label className="field-label">
        {nameLabel}
        <input
          autoFocus={autoFocus}
          className="form-input"
          placeholder={placeholder}
          value={draft.name}
          onChange={(event) => draft.typeName(event.target.value)}
        />
      </label>
    </>
  );
}

export function SourceDialog({ shell, wizard, groups }: { shell: Shell; wizard: SourceWizardState; groups: Group[] }) {
  const { busy, error, setError, setDialog } = shell;
  return (
    <ModalShell
      locked={!!busy}
      title={wizard.batchResult ? '安装结果' : '添加技能来源'}
      subtitle={wizard.batchResult ? '按项显示本次安装状态。' : '扫描 GitHub 仓库或导入本地技能目录。'}
      onClose={wizard.close}
      size="wide"
    >
      {wizard.batchResult ? (
        <InstallResults result={wizard.batchResult} onDone={wizard.finish} />
      ) : (
        <SourceWizard
          mode={wizard.scanMode}
          setMode={wizard.changeMode}
          input={wizard.sourceInput}
          setInput={wizard.setSourceInput}
          refValue={wizard.sourceRef}
          setRefValue={wizard.setSourceRef}
          subpath={wizard.sourceSubpath}
          setSubpath={wizard.setSourceSubpath}
          scan={wizard.scan}
          setScan={wizard.setScan}
          selected={wizard.candidateIds}
          setSelected={wizard.setCandidateIds}
          candidateSearch={wizard.candidateSearch}
          setCandidateSearch={wizard.setCandidateSearch}
          scanning={busy === 'scan'}
          installing={busy === 'install'}
          error={error}
          clearError={() => setError('')}
          onCancel={() => setDialog(null)}
          onBrowse={wizard.browse}
          onScan={wizard.runScan}
          onInstall={wizard.install}
          groups={groups}
        />
      )}
    </ModalShell>
  );
}

export function OnboardingDialog({ shell, draft, groups }: { shell: Shell; draft: GroupDraft; groups: Group[] }) {
  const { busy, error, setError } = shell;
  return (
    <ModalShell
      locked={!!busy}
      title="为技能创建分组"
      subtitle="分组是可选的业务组织方式，也可以稍后再整理。"
      onClose={draft.closeOnboarding}
    >
      <div className="onboarding-count">
        <div className="success-mark">
          <Check size={18} />
        </div>
        <div>
          <strong>{formatCount(draft.onboardingIds.length, '个技能')}已加入中央库</strong>
          <span>可以加入现有分组、创建新分组，或直接跳过。</span>
        </div>
      </div>
      <GroupPicker
        groups={groups}
        draft={draft}
        selectLabel="加入现有分组"
        separator="或新建分组"
        nameLabel="分组名称"
        placeholder="例如：产品研究"
        autoFocus
      />
      <div className="dialog-footer spread">
        <button className="button subtle" onClick={draft.closeOnboarding}>
          跳过
        </button>
        <button className="button primary" disabled={!draft.groupId && !draft.name.trim()} onClick={() => void draft.saveOnboarding()}>
          {busy === 'group' ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}加入分组
        </button>
      </div>
      <FormError error={error} onDismiss={() => setError('')} />
    </ModalShell>
  );
}

export function SelectedDialog({
  shell,
  snapshot,
  view,
  onApply,
}: {
  shell: Shell;
  snapshot: Snapshot;
  view: LibraryView;
  onApply: () => void;
}) {
  const { selected } = view;
  return (
    <ModalShell
      locked={!!shell.busy}
      title="当前已选技能"
      subtitle={`${selected.size} 个唯一技能；选择集合跨分类视图保留。`}
      onClose={() => shell.setDialog(null)}
    >
      <div className="selected-list">
        {[...selected]
          .map((id) => snapshot.skills.find((skill) => skill.id === id))
          .filter((skill): skill is Skill => !!skill)
          .map((skill) => (
            <div className="selected-item" key={skill.id}>
              <span className="skill-avatar">{initial(skill.name)}</span>
              <span>
                <strong>{skill.name}</strong>
                <small>{sourceName(snapshot, skill.sourceId)}</small>
              </span>
              <button className="icon-button small" aria-label={`移除 ${skill.name}`} onClick={() => view.toggleOne(skill.id)}>
                <X size={14} />
              </button>
            </div>
          ))}
      </div>
      <div className="dialog-footer spread">
        <button className="button subtle" onClick={() => shell.setDialog(null)}>
          继续选择
        </button>
        <button className="button primary" disabled={!selected.size} onClick={onApply}>
          应用所选 <ArrowRight size={15} />
        </button>
      </div>
    </ModalShell>
  );
}
