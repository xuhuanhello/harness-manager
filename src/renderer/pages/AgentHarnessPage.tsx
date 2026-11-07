import { compareNames } from '../i18n';
import { t, useT } from '../i18n';
import { useEffect, useMemo, useState } from 'react';
import { ArrowDownToLine, ArrowRight, ExternalLink, FolderOpen, FolderPlus, HardDrive, ShieldCheck, Sparkles } from 'lucide-react';
import type { Distribution, ExternalSkill, Scope, Snapshot } from '../../shared/types';
import type { ManagedHarnessEntry } from '../view-types';
import { initial, harnessGlyph } from '../format';
import { WorkspacePicker } from '../components/WorkspacePicker';
import ListActions from '../components/ListActions';
import { RevealSkillButton } from '../components/RevealSkillButton';
import { SectionHeading } from '../components/SectionHeading';
import { buildEffectiveSections, effectiveCounts, effectiveLabels, effectiveSectionKey, effectiveSummary } from '../effective-sections';

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
  if (!distribution) return t('agentHarness.needsChecking');
  if (distribution.health !== 'healthy')
    return (
      {
        missing: t('agentHarness.missing'),
        broken: t('agentHarness.damaged'),
        stale: t('agentHarness.outOfSync'),
        conflict: t('agentHarness.conflictsFound'),
      } as const
    )[distribution.health];
  return distribution.verification === 'passed'
    ? t('agentHarness.healthyVerified')
    : distribution.verification === 'failed'
      ? t('agentHarness.healthyVerificationFailed')
      : t('agentHarness.healthyNotVerified');
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
  const t = useT();
  const name = snapshot.harnesses.find((harness) => harness.id === harnessId)?.name || 'Harness';
  return (
    <div className="empty-harness">
      <div className="empty-harness-icon">
        <HardDrive size={21} />
      </div>
      <div>
        <strong>{t('agentHarness.emptyManaged', { name })}</strong>
        <p>{t('agentHarness.selectSkillsFromTheLibraryAndApplyThemHereYou')}</p>
        <div className="empty-harness-actions">
          <button className="text-button" onClick={onApply}>
            {t('agentHarness.chooseSkills')}
            <ArrowRight size={14} />
          </button>
          <button className="text-button muted" onClick={onOpenHarness}>
            {t('agentHarness.viewAgentHarness')}
            <ArrowRight size={14} />
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
  onRevealExternal,
  onRevealDistribution,
  onApply,
  onOpenWorkspaces,
  onManageLibrary,
  onManageWorkspace,
}: {
  snapshot: Snapshot;
  busy: string;
  onMigrate: (skill: ExternalSkill) => void;
  onRevealExternal: (externalSkillId: string) => void;
  onRevealDistribution: (distributionId: string) => void;
  onApply: () => void;
  onOpenWorkspaces: () => void;
  onManageLibrary: (harnessId: string) => void;
  onManageWorkspace: (path: string) => void;
}) {
  const t = useT();
  const harnesses = useMemo(() => {
    const list = [...snapshot.harnesses];
    return list.sort((a, b) => (a.id === 'universal' ? -1 : b.id === 'universal' ? 1 : compareNames(a.name, b.name)));
  }, [snapshot.harnesses]);
  const [harnessId, setHarnessId] = useState('universal');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [scope, setScope] = useState<Scope>('user');
  const [workspaceId, setWorkspaceId] = useState(snapshot.workspaces[0]?.id || '');
  const harness = harnesses.find((item) => item.id === harnessId) ||
    harnesses[0] || {
      id: 'universal',
      name: t('agentHarness.sharedUserScope'),
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

  const managed = useMemo(
    () => harnessInstallations(snapshot, harnessId, scope, workspaceId).sort((a, b) => compareNames(a.skill.name, b.skill.name)),
    [snapshot, harnessId, scope, workspaceId],
  );
  const external = useMemo(
    () =>
      (snapshot.visibleExternalSkills ?? snapshot.externalSkills)
        .filter(
          (skill) => skill.harnessId === harnessId && skill.scope === scope && (scope === 'user' || skill.workspaceId === workspaceId),
        )
        .sort((a, b) => compareNames(a.name, b.name)),
    [snapshot.visibleExternalSkills, snapshot.externalSkills, harnessId, scope, workspaceId],
  );
  const sections = useMemo(() => buildEffectiveSections(snapshot, managed, external), [snapshot, managed, external]);
  const counts = effectiveCounts(managed, external);
  const sectionKey = (id: string) => effectiveSectionKey(harnessId, scope, workspaceId, id);
  const allExpanded = sections.every((section) => !collapsed.has(sectionKey(section.id)));
  const toggleSections = (ids: string[], collapse: boolean) => {
    setCollapsed((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (collapse) next.add(sectionKey(id));
        else next.delete(sectionKey(id));
      }
      return next;
    });
  };
  const activePath = scope === 'user' ? harness.userSkillsPath : harness.workspaceSkillsRelativePath;
  const scopeUnavailable = scope === 'workspace' && !harness.workspaceSkillsRelativePath.trim() && !harness.readsWorkspaceAgents;
  const countForHarness = (id: string) =>
    new Set(harnessInstallations(snapshot, id, scope, workspaceId).map((entry) => entry.skill.id)).size +
    (snapshot.visibleExternalSkills ?? snapshot.externalSkills).filter(
      (skill) => skill.harnessId === id && skill.scope === scope && (scope === 'user' || skill.workspaceId === workspaceId),
    ).length;

  if (!harnesses.length) return <div className="section-empty">{t('agentHarness.noHarnessesEnabledEnableTheToolsYouWantToManage')}</div>;
  return (
    <div className="agent-harness-page">
      <div className="agent-harness-toolbar">
        <div className="agent-harness-tabs" role="tablist" aria-label={t('agentHarness.chooseHarness')}>
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
          <div className="agent-scope-tabs" role="tablist" aria-label={t('agentHarness.chooseSkillScope')}>
            <button
              role="tab"
              aria-selected={scope === 'user'}
              className={scope === 'user' ? 'active' : ''}
              onClick={() => setScope('user')}
            >
              <HardDrive size={14} />
              {t('agentHarness.user')}
            </button>
            <button
              role="tab"
              aria-selected={scope === 'workspace'}
              className={scope === 'workspace' ? 'active' : ''}
              onClick={() => setScope('workspace')}
            >
              <FolderOpen size={14} />
              {t('agentHarness.workspace')}
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
              ? t('agentHarness.availableByDirectoryRulesToolLoadingNotYetVerified')
              : workspace
                ? `${workspace.name || t('agentHarness.workspaces')} · ${workspace.path}`
                : t('agentHarness.chooseAKnownWorkspaceDirectory')}
          </span>
        </div>
        <code title={activePath}>{activePath || t('agentHarness.thisHarnessHasNoSkillDirectoryConfiguredForThisScope')}</code>
      </div>

      {scope === 'workspace' && !snapshot.workspaces.length ? (
        <div className="agent-harness-empty">
          <div className="agent-empty-icon">
            <FolderOpen size={20} />
          </div>
          <strong>{t('agentHarness.noKnownWorkspacesYet')}</strong>
          <p>{t('agentHarness.workspacesWhereYouHaveAppliedSkillsWillAppearHere')}</p>
          <button className="button subtle" onClick={onOpenWorkspaces}>
            <FolderPlus size={14} />
            {t('agentHarness.goToWorkspaces')}
          </button>
        </div>
      ) : scope === 'workspace' && !workspace ? (
        <div className="agent-harness-empty">
          <div className="agent-empty-icon">
            <FolderOpen size={20} />
          </div>
          <strong>{t('agentHarness.chooseAWorkspace')}</strong>
          <p>{t('agentHarness.onlyRegisteredLocalWorkspacesAndTheirHarnessSettingsAreShown')}</p>
        </div>
      ) : scopeUnavailable ? (
        <div className="agent-harness-empty">
          <div className="agent-empty-icon">
            <HardDrive size={20} />
          </div>
          <strong>{t('agentHarness.workspaceNotConfigured', { name: harness.name })}</strong>
          <p>{t('agentHarness.configureWorkspaceSkillsForThisHarnessInSettingsToView')}</p>
        </div>
      ) : (
        <>
          {counts.total > 0 && (
            <section className="agent-skill-section">
              <div className="agent-section-heading">
                <div>
                  <h2>{effectiveLabels.title}</h2>
                  <p>{effectiveSummary(harness.name, counts)}</p>
                </div>
                <div className="agent-section-actions">
                  {counts.managed > 0 && (
                    <button
                      className="text-button"
                      onClick={() => (scope === 'user' ? onManageLibrary(harnessId) : workspace && onManageWorkspace(workspace.path))}
                    >
                      {scope === 'user' ? t('agentHarness.manageInLibrary') : t('agentHarness.manageInWorkspace')}
                    </button>
                  )}
                  <span className="agent-section-count">{counts.total}</span>
                  <ListActions
                    allExpanded={allExpanded}
                    expandableCount={sections.length}
                    onToggleExpanded={() =>
                      toggleSections(
                        sections.map((section) => section.id),
                        allExpanded,
                      )
                    }
                  />
                </div>
              </div>
              <div className="effective-sections">
                {sections.map((section) => {
                  const isCollapsed = collapsed.has(sectionKey(section.id));
                  return (
                    <section
                      className={`skill-section effective-section ${section.kind === 'external' ? 'external-agent-section' : ''}`}
                      key={section.id}
                    >
                      <SectionHeading
                        label={section.label}
                        kind={section.kind === 'external' ? 'external' : 'group'}
                        icon={
                          section.kind === 'external' ? (
                            <ExternalLink size={15} />
                          ) : (
                            <span
                              className="section-dot"
                              style={section.color !== 'neutral' ? { backgroundColor: section.color } : undefined}
                            />
                          )
                        }
                        count={t('agentHarness.items', { count: section.count })}
                        names={section.names}
                        subtitle={section.kind === 'external' ? t('agentHarness.externallyManaged') : t('agentHarness.groups')}
                        collapsed={isCollapsed}
                        onToggle={() => toggleSections([section.id], !isCollapsed)}
                      />
                      {!isCollapsed && (
                        <div className="agent-skill-grid">
                          {section.kind === 'managed'
                            ? section.entries.map(({ bindingId, skill, distribution, path, inheritedFrom }) => (
                                <article className="agent-skill-card" key={`${bindingId}:${skill.id}`}>
                                  <span className="agent-skill-avatar">{initial(skill.name)}</span>
                                  <div className="agent-skill-copy">
                                    <div className="agent-skill-title">
                                      <strong>{skill.name}</strong>
                                      {inheritedFrom && (
                                        <span className="inheritance-tag">
                                          {t('agentHarness.inheritedSource', { name: inheritedFrom })}
                                        </span>
                                      )}
                                      <span className="agent-managed-badge">
                                        <ShieldCheck size={12} />
                                        {t('agentHarness.libraryManaged2')}
                                      </span>
                                    </div>
                                    <p>{skill.description || t('agentHarness.noDescription')}</p>
                                    <div className="agent-skill-details">
                                      <code title={path}>{path || t('agentHarness.unknownInstallationPath')}</code>
                                      <span>
                                        {t('agentHarness.installationStatus', {
                                          strategy:
                                            distribution?.strategy === 'copy'
                                              ? t('agentHarness.copyInstallation')
                                              : t('agentHarness.symlink'),
                                          status: distributionStatus(distribution),
                                        })}
                                      </span>
                                      <RevealSkillButton
                                        name={skill.name}
                                        disabled={!!busy || !distribution}
                                        onReveal={() => distribution && onRevealDistribution(distribution.id)}
                                      />
                                    </div>
                                  </div>
                                </article>
                              ))
                            : section.entries.map((skill) => (
                                <article className="agent-skill-card external-agent-card" key={skill.id}>
                                  <span className="agent-skill-avatar external-avatar">
                                    <ExternalLink size={16} />
                                  </span>
                                  <div className="agent-skill-copy">
                                    <div className="agent-skill-title">
                                      <strong>{skill.name}</strong>
                                      {skill.inheritedFrom && (
                                        <span className="inheritance-tag">
                                          {t('agentHarness.inheritedSource', { name: skill.inheritedFrom })}
                                        </span>
                                      )}
                                      <span className="external-badge">{t('agentHarness.externallyManaged')}</span>
                                    </div>
                                    <p>{skill.description || t('agentHarness.noDescription')}</p>
                                    <div className="agent-skill-details">
                                      <code title={skill.path}>{skill.path}</code>
                                      <RevealSkillButton name={skill.name} disabled={!!busy} onReveal={() => onRevealExternal(skill.id)} />
                                      <button className="button subtle compact" disabled={!!busy} onClick={() => onMigrate(skill)}>
                                        <ArrowRight size={13} />
                                        {t('agentHarness.migrateToLibrary')}
                                      </button>
                                    </div>
                                  </div>
                                </article>
                              ))}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            </section>
          )}
          {!managed.length && !external.length && (
            <div className="agent-harness-empty">
              <div className="agent-empty-icon">
                <Sparkles size={20} />
              </div>
              <strong>{t('agentHarness.noSkillsInThisDestinationYet')}</strong>
              <p>{t('agentHarness.libraryManagedAndExternallyManagedSkillsWillAppearSeparatelyHere')}</p>
              <button className="button primary" onClick={onApply}>
                <ArrowDownToLine size={14} />
                {t('agentHarness.chooseFromLibrary')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
