import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Clock3,
  FolderOpen,
  FolderPlus,
  LoaderCircle,
  Package,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { Snapshot } from '../../shared/types';
import type { RemovalDraft } from '../view-types';
import { initial, harnessGlyph, formatCount } from '../format';

export function WorkspacePage({
  snapshot,
  selectedPath,
  onChoose,
  onBack,
  onOpen,
  onHealth,
  busy,
  onAddSkills,
  onRemove,
}: {
  snapshot: Snapshot;
  selectedPath: string;
  onChoose: () => void;
  onBack: () => void;
  onOpen: (workspace: Snapshot['workspaces'][number]) => void;
  onHealth: () => void;
  busy: string;
  onAddSkills: (path: string) => void;
  onRemove: (draft: RemovalDraft) => void;
}) {
  const [removalSelections, setRemovalSelections] = useState<Record<string, string[]>>({});
  useEffect(() => setRemovalSelections({}), [selectedPath]);
  const selectedWorkspace = snapshot.workspaces.find((workspace) => workspace.path === selectedPath);
  const installations = useMemo(() => {
    if (!selectedWorkspace) return [];
    const bindings = snapshot.bindings.filter((binding) => binding.scope === 'workspace' && binding.workspaceId === selectedWorkspace.id);
    return bindings.map((binding) => {
      const harness = snapshot.harnesses.find((item) => item.id === binding.harnessId);
      // Show the recorded directory: an older install can live in a root the Harness now only reads.
      const targetPath = snapshot.targets.find((target) => target.id === binding.targetId)?.path;
      const workspacePrefix = `${selectedWorkspace.path.replace(/\\/g, '/').replace(/\/$/, '')}/`;
      const portableTarget = targetPath?.replace(/\\/g, '/');
      const directory = portableTarget?.startsWith(workspacePrefix)
        ? portableTarget.slice(workspacePrefix.length)
        : targetPath || harness?.workspaceSkillsRelativePath;
      const intents = snapshot.intents.filter((intent) => intent.bindingId === binding.id);
      const items = intents
        .map((intent) => ({
          skill: snapshot.skills.find((skill) => skill.id === intent.skillId),
          distribution: snapshot.distributions.find((dist) => dist.skillId === intent.skillId && dist.targetId === binding.targetId),
        }))
        .filter((item) => !!item.skill);
      return { binding, harness, directory, items };
    });
  }, [selectedWorkspace, snapshot]);
  const installedCount = installations.reduce((total, group) => total + group.items.length, 0);
  return (
    <div className="workspace-page">
      <div className="workspace-top-actions">
        <span className="workspace-updated-note">
          <Clock3 size={13} />
          最近选择
        </span>
        <button className="button primary" onClick={onChoose}>
          <FolderPlus size={15} />
          打开工作区
        </button>
      </div>
      {!selectedPath ? (
        <>
          <div className="workspace-section-head">
            <div>
              <h2>最近工作区</h2>
              <p>工作区配置保存在选定目录，不会自动扩展到其它项目。</p>
            </div>
            <span className="subtle-count">{snapshot.workspaces.length} 个</span>
          </div>
          {snapshot.workspaces.length ? (
            <div className="workspace-grid">
              {snapshot.workspaces.map((workspace) => {
                const bindingIds = new Set(
                  snapshot.bindings
                    .filter((binding) => binding.scope === 'workspace' && binding.workspaceId === workspace.id)
                    .map((binding) => binding.id),
                );
                const count = snapshot.intents.filter((intent) => bindingIds.has(intent.bindingId)).length;
                return (
                  <button className="workspace-card" key={workspace.id} onClick={() => onOpen(workspace)}>
                    <div className="workspace-card-icon">
                      <FolderOpen size={18} />
                    </div>
                    <div className="workspace-card-copy">
                      <strong>{workspace.name || workspace.path.split(/[\\/]/).at(-1)}</strong>
                      <span title={workspace.path}>{workspace.path}</span>
                    </div>
                    <span className="workspace-skill-count">{count} 项</span>
                    <ArrowRight size={15} className="workspace-card-arrow" />
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="empty-workspaces">
              <div className="empty-workspace-icon">
                <FolderOpen size={21} />
              </div>
              <h2>还没有打开过工作区</h2>
              <p>选择本地工作目录后，应用技能时可以选定要配置的 Harness。目录会按物理路径记录。</p>
              <button className="button primary" onClick={onChoose}>
                <FolderPlus size={15} />
                选择工作目录
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="workspace-detail-heading">
            <button className="back-button" onClick={onBack} aria-label="返回工作区列表">
              <ArrowLeft size={14} />
              工作区列表
            </button>
            <div className="workspace-title-line">
              <div className="workspace-detail-icon">
                <FolderOpen size={19} />
              </div>
              <div>
                <p className="eyebrow">{selectedWorkspace ? '已登记工作区' : '当前目录'}</p>
                <h2>{selectedWorkspace?.name || selectedPath.split(/[\\/]/).filter(Boolean).at(-1) || selectedPath}</h2>
                <span className="workspace-fullpath">{selectedPath}</span>
              </div>
            </div>
            <div className="workspace-detail-actions">
              <button className="button subtle" onClick={onHealth} disabled={busy === 'health'}>
                {busy === 'health' ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}检查路径
              </button>
              <button className="button primary" onClick={() => onAddSkills(selectedPath)}>
                <Plus size={15} />
                添加技能
              </button>
            </div>
          </div>
          <div className="workspace-note">
            <Sparkles size={14} />
            <span>同一工作区内，其他兼容的 Agent 也可能识别这些技能。</span>
          </div>
          <div className="workspace-section-head">
            <div>
              <h2>Harness 安装</h2>
              <p>每个 Harness 可能使用独立目录，也可能与其它工具共享同一路径。</p>
            </div>
            <span className="subtle-count">{formatCount(installedCount, '项')}</span>
          </div>
          {installations.length ? (
            <div className="workspace-installations">
              {installations.map(({ binding, harness, directory, items }) => {
                const ids = items.flatMap((item) => (item.skill ? [item.skill.id] : []));
                const chosen = removalSelections[binding.id] ?? [];
                const allChosen = ids.length > 0 && ids.every((id) => chosen.includes(id));
                const partial = chosen.length > 0 && !allChosen;
                const harnessName = harness?.id === 'universal' ? '用户级通用技能' : harness?.name || '未知 Harness';
                return (
                  <section className="workspace-install-group" key={binding.id}>
                    <div className="installation-heading">
                      <input
                        className="tri-checkbox"
                        type="checkbox"
                        aria-label={`选择 ${harnessName} 下全部安装`}
                        checked={allChosen}
                        ref={(node) => {
                          if (node) node.indeterminate = partial;
                        }}
                        onChange={() => setRemovalSelections((current) => ({ ...current, [binding.id]: allChosen ? [] : ids }))}
                      />
                      <span className={`harness-icon ${harness?.origin || 'builtin'}`}>
                        {harness ? harnessGlyph(harness.icon, harness.name) : '?'}
                      </span>
                      <div>
                        <strong>{harnessName}</strong>
                        <span>{directory || '工作区技能目录'}</span>
                      </div>
                      <button
                        className="button subtle danger-quiet"
                        disabled={!chosen.length}
                        onClick={() =>
                          onRemove({
                            bindingId: binding.id,
                            harnessName,
                            skillIds: chosen,
                            skillNames: items.flatMap((item) => (item.skill && chosen.includes(item.skill.id) ? [item.skill.name] : [])),
                          })
                        }
                      >
                        <Trash2 size={14} />
                        移除所选{chosen.length ? ` ${chosen.length}` : ''}
                      </button>
                    </div>
                    <div className="installation-list">
                      {items.map(
                        ({ skill, distribution }) =>
                          skill && (
                            <label className="installation-row" key={skill.id}>
                              <input
                                type="checkbox"
                                checked={chosen.includes(skill.id)}
                                onChange={() =>
                                  setRemovalSelections((current) => {
                                    const next = new Set(current[binding.id] ?? []);
                                    if (next.has(skill.id)) next.delete(skill.id);
                                    else next.add(skill.id);
                                    return { ...current, [binding.id]: [...next] };
                                  })
                                }
                                aria-label={`选择 ${skill.name} 安装`}
                              />
                              <div className="mini-skill-icon">{initial(skill.name)}</div>
                              <div>
                                <strong>{skill.name}</strong>
                                <span>
                                  {distribution?.health === 'healthy'
                                    ? distribution.verification === 'passed'
                                      ? '文件正常 · 验证通过'
                                      : distribution.verification === 'failed'
                                        ? '文件正常 · 验证失败'
                                        : '文件正常 · 识别未验证'
                                    : distribution?.health || '状态未知'}{' '}
                                  · {distribution?.strategy === 'copy' ? '兼容复制' : '软链'}
                                </span>
                              </div>
                              <span className={`health-mark ${distribution?.health || 'missing'}`} />
                            </label>
                          ),
                      )}
                      {!items.length && <div className="section-empty">此目标目前没有受管安装。</div>}
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="workspace-empty-state">
              <Package size={19} />
              <strong>此工作区暂无受管技能</strong>
              <span>从中央库选择技能并应用到一个或多个 Harness。</span>
              <button className="text-button" onClick={() => onAddSkills(selectedPath)}>
                选择中央库技能 <ArrowRight size={14} />
              </button>
            </div>
          )}
          <button className="text-button change-workspace" onClick={onChoose}>
            <FolderOpen size={14} />
            打开另一个工作区
          </button>
        </>
      )}
    </div>
  );
}
