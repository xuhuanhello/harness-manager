import { useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ExternalLink, FolderOpen, FolderPlus, HardDrive, ShieldCheck, Sparkles } from 'lucide-react';
import type { Distribution, ExternalSkill, Scope, Snapshot } from '../../shared/types';
import type { ManagedHarnessEntry } from '../view-types';
import { initial, harnessGlyph } from '../format';
import { WorkspacePicker } from '../components/WorkspacePicker';

export function harnessInstallations(snapshot: Snapshot, harnessId: string, scope: Scope, workspaceId: string): ManagedHarnessEntry[] {
  if (snapshot.visibleManagedSkills)
    return snapshot.visibleManagedSkills
      .filter((item) => item.harnessId === harnessId && item.scope === scope && (scope === 'user' || item.workspaceId === workspaceId))
      .flatMap((item) => {
        const distribution = snapshot.distributions.find((dist) => dist.id === item.distributionId);
        const skill = snapshot.skills.find((skill) => skill.id === distribution?.skillId);
        return skill && distribution
          ? [{ bindingId: distribution.id, skill, distribution, path: distribution.entryPath, inheritedFrom: item.inheritedFrom }]
          : [];
      });
  const bindings = snapshot.bindings.filter(
    (binding) => binding.harnessId === harnessId && binding.scope === scope && (scope === 'user' || binding.workspaceId === workspaceId),
  );
  const entries: ManagedHarnessEntry[] = [];
  const seen = new Set<string>();
  for (const binding of bindings) {
    for (const intent of snapshot.intents.filter((item) => item.bindingId === binding.id)) {
      const skill = snapshot.skills.find((item) => item.id === intent.skillId);
      if (!skill) continue;
      const identity = `${binding.targetId}:${skill.id}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const distribution = snapshot.distributions.find((item) => item.skillId === skill.id && item.targetId === binding.targetId);
      const target = snapshot.targets.find((item) => item.id === binding.targetId);
      entries.push({ bindingId: binding.id, skill, distribution, path: distribution?.entryPath || target?.path || '' });
    }
  }
  return entries;
}

export function distributionStatus(distribution?: Distribution) {
  if (!distribution) return '状态待检查';
  if (distribution.health !== 'healthy')
    return ({ missing: '缺失', broken: '损坏', stale: '待同步', conflict: '存在冲突' } as const)[distribution.health];
  return distribution.verification === 'passed'
    ? '正常 · 验证通过'
    : distribution.verification === 'failed'
      ? '正常 · 验证失败'
      : '正常 · 未验证';
}

export function EmptyHarness({
  snapshot,
  harnessId,
  onApply,
  onOpenHarness,
}: {
  snapshot: Snapshot;
  harnessId: string;
  onApply: () => void;
  onOpenHarness: () => void;
}) {
  const name =
    harnessId === 'universal' ? '用户级通用技能' : snapshot.harnesses.find((harness) => harness.id === harnessId)?.name || 'Harness';
  return (
    <div className="empty-harness">
      <div className="empty-harness-icon">
        <HardDrive size={21} />
      </div>
      <div>
        <strong>{name} 暂无受管安装</strong>
        <p>从中央库选择技能后应用到此目标。目录中由其他工具安装的外部技能，可在 Agent Harness 页面查看和迁移。</p>
        <div className="empty-harness-actions">
          <button className="text-button" onClick={onApply}>
            立即选择技能 <ArrowRight size={14} />
          </button>
          <button className="text-button muted" onClick={onOpenHarness}>
            查看 Agent Harness <ArrowRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function AgentHarnessPage({
  snapshot,
  busy,
  onMigrate,
  onApply,
  onOpenWorkspaces,
}: {
  snapshot: Snapshot;
  busy: string;
  onMigrate: (skill: ExternalSkill) => void;
  onApply: () => void;
  onOpenWorkspaces: () => void;
}) {
  const harnesses = useMemo(() => {
    const list = [...snapshot.harnesses];
    return list.sort((a, b) => (a.id === 'universal' ? -1 : b.id === 'universal' ? 1 : a.name.localeCompare(b.name)));
  }, [snapshot.harnesses]);
  const [harnessId, setHarnessId] = useState('universal');
  const [scope, setScope] = useState<Scope>('user');
  const [workspaceId, setWorkspaceId] = useState(snapshot.workspaces[0]?.id || '');
  const harness = harnesses.find((item) => item.id === harnessId) ||
    harnesses[0] || {
      id: 'universal',
      name: '用户级通用',
      icon: 'globe',
      userSkillsPath: '~/.agents/skills',
      workspaceSkillsRelativePath: '',
      origin: 'builtin' as const,
    };
  const workspace = snapshot.workspaces.find((item) => item.id === workspaceId);

  useEffect(() => {
    if (!harnesses.some((item) => item.id === harnessId)) setHarnessId(harnesses[0]?.id || 'universal');
  }, [harnesses, harnessId]);
  useEffect(() => {
    if (workspaceId && !snapshot.workspaces.some((item) => item.id === workspaceId)) setWorkspaceId(snapshot.workspaces[0]?.id || '');
    if (!workspaceId && snapshot.workspaces[0]) setWorkspaceId(snapshot.workspaces[0].id);
  }, [snapshot.workspaces, workspaceId]);

  const managed = useMemo(() => harnessInstallations(snapshot, harnessId, scope, workspaceId), [snapshot, harnessId, scope, workspaceId]);
  const external = useMemo(
    () =>
      (snapshot.visibleExternalSkills ?? snapshot.externalSkills).filter(
        (skill) => skill.harnessId === harnessId && skill.scope === scope && (scope === 'user' || skill.workspaceId === workspaceId),
      ),
    [snapshot.visibleExternalSkills, snapshot.externalSkills, harnessId, scope, workspaceId],
  );
  const activePath = scope === 'user' ? harness.userSkillsPath : harness.workspaceSkillsRelativePath;
  const scopeUnavailable = scope === 'workspace' && !harness.workspaceSkillsRelativePath.trim() && !harness.readsWorkspaceAgents;
  const countForHarness = (id: string) =>
    harnessInstallations(snapshot, id, scope, workspaceId).length +
    (snapshot.visibleExternalSkills ?? snapshot.externalSkills).filter(
      (skill) => skill.harnessId === id && skill.scope === scope && (scope === 'user' || skill.workspaceId === workspaceId),
    ).length;

  if (!harnesses.length) return <div className="section-empty">尚未启用任何 Harness，请在设置中开启需要管理的工具。</div>;
  return (
    <div className="agent-harness-page">
      <div className="agent-harness-toolbar">
        <div className="agent-harness-tabs" role="tablist" aria-label="选择 Harness">
          {harnesses.map((item) => (
            <button
              key={item.id}
              role="tab"
              aria-selected={harnessId === item.id}
              className={harnessId === item.id ? 'active' : ''}
              onClick={() => setHarnessId(item.id)}
            >
              <span className={`harness-icon ${item.origin}`}>{harnessGlyph(item.icon, item.name)}</span>
              <span className="agent-tab-name">{item.name}</span>
              <span className="agent-tab-count">{countForHarness(item.id)}</span>
            </button>
          ))}
        </div>
        <div className="agent-harness-filters">
          <div className="agent-scope-tabs" role="tablist" aria-label="选择技能作用域">
            <button
              role="tab"
              aria-selected={scope === 'user'}
              className={scope === 'user' ? 'active' : ''}
              onClick={() => setScope('user')}
            >
              <HardDrive size={14} />
              用户级
            </button>
            <button
              role="tab"
              aria-selected={scope === 'workspace'}
              className={scope === 'workspace' ? 'active' : ''}
              onClick={() => setScope('workspace')}
            >
              <FolderOpen size={14} />
              工作区级
            </button>
          </div>
          {scope === 'workspace' && <WorkspacePicker workspaces={snapshot.workspaces} value={workspaceId} onChange={setWorkspaceId} />}
        </div>
      </div>

      <div className="agent-harness-context">
        <span className={`harness-icon ${harness.origin}`}>{harnessGlyph(harness.icon, harness.name)}</span>
        <div>
          <strong>{harness.name}</strong>
          <span>
            {scope === 'user'
              ? '按目录规范可用 · 尚未验证工具实际加载'
              : workspace
                ? `${workspace.name || '工作区'} · ${workspace.path}`
                : '从已知工作区中选择一个目录'}
          </span>
        </div>
        <code title={activePath}>{activePath || '此 Harness 未配置此作用域的技能目录'}</code>
      </div>

      {scope === 'workspace' && !snapshot.workspaces.length ? (
        <div className="agent-harness-empty">
          <div className="agent-empty-icon">
            <FolderOpen size={20} />
          </div>
          <strong>还没有已知工作区</strong>
          <p>已应用过技能的工作区会显示在这里。</p>
          <button className="button subtle" onClick={onOpenWorkspaces}>
            <FolderPlus size={14} />
            前往工作区
          </button>
        </div>
      ) : scope === 'workspace' && !workspace ? (
        <div className="agent-harness-empty">
          <div className="agent-empty-icon">
            <FolderOpen size={20} />
          </div>
          <strong>选择一个工作区</strong>
          <p>只显示已记录的本地工作区及其 Harness 配置。</p>
        </div>
      ) : scopeUnavailable ? (
        <div className="agent-harness-empty">
          <div className="agent-empty-icon">
            <HardDrive size={20} />
          </div>
          <strong>{harness.name} 未配置工作区目录</strong>
          <p>在设置中为此 Harness 声明工作区级技能后，就能在这里查看安装。</p>
        </div>
      ) : (
        <>
          {!!managed.length && (
            <section className="agent-skill-section">
              <div className="agent-section-heading">
                <div>
                  <h2>受管技能</h2>
                  <p>{managed.length} 个技能由中央技能库管理。</p>
                </div>
                <span className="agent-section-count">{managed.length}</span>
              </div>
              <div className="agent-skill-grid">
                {managed.map(({ bindingId, skill, distribution, path, inheritedFrom }) => (
                  <article className="agent-skill-card" key={`${bindingId}:${skill.id}`}>
                    <span className="agent-skill-avatar">{initial(skill.name)}</span>
                    <div className="agent-skill-copy">
                      <div className="agent-skill-title">
                        <strong>{skill.name}</strong>
                        {inheritedFrom && <span className="inheritance-tag">继承自 {inheritedFrom}</span>}
                        <span className="agent-managed-badge">
                          <ShieldCheck size={12} />
                          中央仓库托管
                        </span>
                      </div>
                      <p>{skill.description || '暂无描述。'}</p>
                      <div className="agent-skill-details">
                        <code title={path}>{path || '安装路径未知'}</code>
                        <span>
                          {distribution?.strategy === 'copy' ? '复制安装' : '软链'} · {distributionStatus(distribution)}
                        </span>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
          {!!external.length && (
            <section className="agent-skill-section external-agent-section">
              <div className="agent-section-heading">
                <div>
                  <h2>外部技能</h2>
                  <p>这些技能当前由 Harness 目录中的原有内容提供。</p>
                </div>
                <span className="agent-section-count">{external.length}</span>
              </div>
              <div className="agent-skill-grid">
                {external.map((skill) => (
                  <article className="agent-skill-card external-agent-card" key={skill.id}>
                    <span className="agent-skill-avatar external-avatar">
                      <ExternalLink size={16} />
                    </span>
                    <div className="agent-skill-copy">
                      <div className="agent-skill-title">
                        <strong>{skill.name}</strong>
                        {skill.inheritedFrom && <span className="inheritance-tag">继承自 {skill.inheritedFrom}</span>}
                        <span className="external-badge">外部管理</span>
                      </div>
                      <p>{skill.description || '暂无描述。'}</p>
                      <div className="agent-skill-details">
                        <code title={skill.path}>{skill.path}</code>
                        <button className="button subtle compact" disabled={!!busy} onClick={() => onMigrate(skill)}>
                          <ArrowRight size={13} />
                          迁移到中央仓库管理
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
          {!managed.length && !external.length && (
            <div className="agent-harness-empty">
              <div className="agent-empty-icon">
                <Sparkles size={20} />
              </div>
              <strong>此目标还没有技能</strong>
              <p>中央仓库托管的技能和外部管理的技能会在这里分别显示。</p>
              <button className="button primary" onClick={onApply}>
                <ArrowDownToLine size={14} />
                从中央技能库选择
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
