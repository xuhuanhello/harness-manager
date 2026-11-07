import { useT } from '../i18n';
import { useMemo, type Dispatch, type SetStateAction } from 'react';
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
  Unlink,
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
  removalSelections,
  setRemovalSelections,
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
  removalSelections: Record<string, string[]>;
  setRemovalSelections: Dispatch<SetStateAction<Record<string, string[]>>>;
}) {
  const t = useT();
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
          {t('workspace.recentlySelected')}
        </span>
        <button className="button primary" onClick={onChoose}>
          <FolderPlus size={15} />
          {t('workspace.openWorkspace')}
        </button>
      </div>
      {!selectedPath ? (
        <>
          <div className="workspace-section-head">
            <div>
              <h2>{t('workspace.recentWorkspaces')}</h2>
              <p>{t('workspace.workspaceSettingsBelongToTheChosenDirectoryAndDoNot')}</p>
            </div>
            <span className="subtle-count">{formatCount(snapshot.workspaces.length)}</span>
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
                    <span className="workspace-skill-count">{formatCount(count)}</span>
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
              <h2>{t('workspace.noWorkspacesOpenedYet')}</h2>
              <p>{t('workspace.chooseALocalWorkingDirectoryThenSelectTheHarnessesTo')}</p>
              <button className="button primary" onClick={onChoose}>
                <FolderPlus size={15} />
                {t('workspace.chooseWorkingDirectory')}
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="workspace-detail-heading">
            <button className="back-button" onClick={onBack} aria-label={t('workspace.backToWorkspaceList')}>
              <ArrowLeft size={14} />
              {t('workspace.workspaceList')}
            </button>
            <div className="workspace-title-line">
              <div className="workspace-detail-icon">
                <FolderOpen size={19} />
              </div>
              <div>
                <p className="eyebrow">{selectedWorkspace ? t('workspace.registeredWorkspace') : t('workspace.currentDirectory')}</p>
                <h2>{selectedWorkspace?.name || selectedPath.split(/[\\/]/).filter(Boolean).at(-1) || selectedPath}</h2>
                <span className="workspace-fullpath">{selectedPath}</span>
              </div>
            </div>
            <div className="workspace-detail-actions">
              <button className="button subtle" onClick={onHealth} disabled={busy === 'health'}>
                {busy === 'health' ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}
                {t('workspace.inspectPath')}
              </button>
              <button className="button primary" onClick={() => onAddSkills(selectedPath)}>
                <Plus size={15} />
                {t('workspace.addSkills')}
              </button>
            </div>
          </div>
          <div className="workspace-note">
            <Sparkles size={14} />
            <span>{t('workspace.otherCompatibleAgentsInThisWorkspaceMayAlsoDiscoverThese')}</span>
          </div>
          <div className="workspace-section-head">
            <div>
              <h2>{t('workspace.harnessInstallations')}</h2>
              <p>{t('workspace.eachHarnessMayUseItsOwnDirectoryOrShareA')}</p>
            </div>
            <span className="subtle-count">{formatCount(installedCount, 'item')}</span>
          </div>
          {installations.length ? (
            <div className="workspace-installations">
              {installations.map(({ binding, harness, directory, items }) => {
                const ids = items.flatMap((item) => (item.skill ? [item.skill.id] : []));
                const chosen = removalSelections[binding.id] ?? [];
                const allChosen = ids.length > 0 && ids.every((id) => chosen.includes(id));
                const partial = chosen.length > 0 && !allChosen;
                const harnessName = harness?.name || t('workspace.unknownHarness');
                return (
                  <section className="workspace-install-group" key={binding.id}>
                    <div className="installation-heading">
                      <input
                        className="tri-checkbox"
                        type="checkbox"
                        aria-label={t('workspace.selectAllInstallationsUnder', { harnessName: harnessName })}
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
                        <span>{directory || t('workspace.workspaceSkillDirectory')}</span>
                      </div>
                      <button
                        className="button subtle danger-quiet"
                        disabled={!chosen.length}
                        onClick={() =>
                          onRemove({
                            parts: [{ bindingId: binding.id, skillIds: chosen }],
                            origin: 'workspace',
                            scopeLabel: selectedWorkspace?.name || selectedPath,
                            harnessName,
                            skills: items.flatMap((item) =>
                              item.skill && chosen.includes(item.skill.id) ? [{ id: item.skill.id, name: item.skill.name }] : [],
                            ),
                          })
                        }
                      >
                        <Unlink size={14} />
                        {chosen.length ? t('workspace.unapplyCount', { count: chosen.length }) : t('workspace.unapplySelected')}
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
                                aria-label={t('workspace.selectInstallationOf', { name: skill.name })}
                              />
                              <div className="mini-skill-icon">{initial(skill.name)}</div>
                              <div>
                                <strong>{skill.name}</strong>
                                <span>
                                  {distribution?.health === 'healthy'
                                    ? distribution.verification === 'passed'
                                      ? t('workspace.filesHealthyVerified')
                                      : distribution.verification === 'failed'
                                        ? t('workspace.filesHealthyVerificationFailed')
                                        : t('workspace.filesHealthyDiscoveryNotVerified')
                                    : distribution?.health || t('workspace.unknownStatus')}{' '}
                                  · {distribution?.strategy === 'copy' ? t('workspace.copyForCompatibility') : t('workspace.symlink')}
                                </span>
                              </div>
                              <span className={`health-mark ${distribution?.health || 'missing'}`} />
                            </label>
                          ),
                      )}
                      {!items.length && <div className="section-empty">{t('workspace.noManagedInstallationsInThisDestination')}</div>}
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="workspace-empty-state">
              <Package size={19} />
              <strong>{t('workspace.noManagedSkillsInThisWorkspaceYet')}</strong>
              <span>{t('workspace.selectLibrarySkillsAndApplyThemToOneOrMore')}</span>
              <button className="text-button" onClick={() => onAddSkills(selectedPath)}>
                {t('workspace.chooseLibrarySkills')}
                <ArrowRight size={14} />
              </button>
            </div>
          )}
          <button className="text-button change-workspace" onClick={onChoose}>
            <FolderOpen size={14} />
            {t('workspace.openAnotherWorkspace')}
          </button>
        </>
      )}
    </div>
  );
}
