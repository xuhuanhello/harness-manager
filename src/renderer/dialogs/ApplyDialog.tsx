import { useT } from '../i18n';
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
  const t = useT();
  const { busy, error, setError } = shell;
  const { draft, plan, results, update } = apply;
  const { selected } = view;
  const duplicateGroupName = (name: string) =>
    snapshot.groups.some((group) => group.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase() && !groupDraft.groupId);
  return (
    <ModalShell
      locked={!!busy}
      title={results ? t('dialogs.applyResults') : t('dialogs.applySelectedSkills')}
      subtitle={
        results
          ? t('dialogs.resultsForEachSkillAndDestination')
          : t('dialogs.distinctSkillsSelectedChooseAGroupOrInstallationDestination', { size: selected.size })
      }
      onClose={() => shell.setDialog(null)}
      size="wide"
    >
      {results ? (
        <ApplyResults result={results} onDone={apply.finish} />
      ) : (
        <>
          <div className="apply-mode-tabs" role="tablist" aria-label={t('dialogs.applyAction')}>
            <button
              role="tab"
              aria-selected={draft.mode === 'harness'}
              className={draft.mode === 'harness' ? 'active' : ''}
              onClick={() => update({ mode: 'harness' })}
            >
              <ArrowDownToLine size={15} />
              {t('dialogs.applyToHarness')}
            </button>
            <button
              role="tab"
              aria-selected={draft.mode === 'group'}
              className={draft.mode === 'group' ? 'active' : ''}
              onClick={() => update({ mode: 'group' })}
            >
              <Tag size={15} />
              {t('dialogs.addToGroup')}
            </button>
          </div>
          {draft.mode === 'group' ? (
            <div className="apply-panel">
              <div className="field-help">{t('dialogs.groupsStoreMembershipOnlySourceAndInstallationLocationsStayThe')}</div>
              <GroupPicker
                groups={snapshot.groups}
                draft={groupDraft}
                selectLabel={t('dialogs.chooseAnExistingGroup')}
                separator={t('dialogs.orCreateAGroup')}
                nameLabel={t('dialogs.newGroupName')}
                placeholder={t('dialogs.eGCustomerSupport')}
              />
              {snapshot.groups.map((group) =>
                group.name.toLocaleLowerCase() === groupDraft.name.trim().toLocaleLowerCase() && groupDraft.name.trim() ? (
                  <div className="form-warning" key={group.id}>
                    {t('dialogs.duplicateGroup', { name: group.name })}
                  </div>
                ) : null,
              )}
              <div className="dialog-footer">
                <button
                  className="button primary"
                  disabled={(!groupDraft.groupId && !groupDraft.name.trim()) || duplicateGroupName(groupDraft.name)}
                  onClick={() => void apply.saveToGroup()}
                >
                  {busy === 'group' ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}
                  {t('dialogs.groupSelection', { count: selected.size })}
                </button>
              </div>
            </div>
          ) : (
            <div className="apply-panel">
              <div className="scope-switch" role="radiogroup" aria-label={t('dialogs.installationScope')}>
                <button
                  role="radio"
                  aria-checked={draft.scope === 'user'}
                  className={draft.scope === 'user' ? 'active' : ''}
                  onClick={() => update({ scope: 'user', harnessIds: [] })}
                >
                  <HardDrive size={16} />
                  <span>
                    <strong>{t('dialogs.user')}</strong>
                    <small>{t('dialogs.availableToTheCurrentUser')}</small>
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
                    <strong>{t('dialogs.workspace')}</strong>
                    <small>{t('dialogs.onlyInTheChosenWorkingDirectory')}</small>
                  </span>
                </button>
              </div>
              {draft.scope === 'workspace' && (
                <div className="workspace-path-field">
                  <label className="field-label" htmlFor="apply-workspace">
                    {t('dialogs.workingDirectory')}
                  </label>
                  <div className="path-picker">
                    <FolderOpen size={16} />
                    <input
                      id="apply-workspace"
                      value={draft.workspacePath}
                      onChange={(event) => update({ workspacePath: event.target.value })}
                      placeholder={t('dialogs.chooseALocalWorkingDirectory')}
                    />
                    <button className="button subtle" onClick={() => void apply.chooseWorkspace()}>
                      {t('dialogs.browse')}
                    </button>
                  </div>
                  <p className="field-help">{t('dialogs.theWorkspacePathIsYourExplicitChoiceTheAppDoes')}</p>
                </div>
              )}
              <div className="harness-picker-heading">
                <div>
                  <span className="field-label">{t('dialogs.targetHarnesses')}</span>
                  <span className="field-help">{t('dialogs.chooseMultipleDestinationsSharedDirectoriesAreCombinedInThePreview')}</span>
                </div>
                <button className="text-button" onClick={onAddHarness}>
                  <CirclePlus size={14} />
                  {t('dialogs.addCustom')}
                </button>
              </div>
              <div className="harness-picker-grid">
                {!snapshot.harnesses.length && <p className="field-help">{t('dialogs.noHarnessesEnabledEnableToolsInSettingsOrAddA')}</p>}
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
                          <small title={path || t('dialogs.unavailableInThisScope')}>{path || t('dialogs.scopeNotConfigured')}</small>
                        </span>
                        <span className="choice-check">{checked && <Check size={12} />}</span>
                      </button>
                    );
                  })}
              </div>
              <div className="advanced-row">
                <div>
                  <strong>{t('dialogs.installationStrategy')}</strong>
                  <span>{t('dialogs.linksKeepHarnessesInSyncWithTheLibraryChooseA')}</span>
                </div>
                <div className="strategy-toggle">
                  <button className={draft.strategy === 'symlink' ? 'active' : ''} onClick={() => update({ strategy: 'symlink' })}>
                    {t('dialogs.symlink')}
                  </button>
                  <button className={draft.strategy === 'copy' ? 'active' : ''} onClick={() => update({ strategy: 'copy' })}>
                    {t('dialogs.copy')}
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
                    {busy === 'preview' ? <LoaderCircle size={15} className="spin" /> : <ArrowRight size={15} />}
                    {t('dialogs.previewDestinations')}
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
