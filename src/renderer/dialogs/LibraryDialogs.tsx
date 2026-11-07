import { useT } from '../i18n';
import { ArrowRight, Check, CircleHelp, LoaderCircle, Plus, X } from 'lucide-react';
import type { Group, Skill, Snapshot } from '../../shared/types';
import ModalShell from '../components/ModalShell';
import { InstallResults, SourceWizard } from '../components/SourceWizard';
import { initial, sourceName } from '../format';
import type { GroupDraft } from '../hooks/useGroupDraft';
import type { LibraryView } from '../hooks/useLibraryView';
import type { Shell } from '../hooks/useShell';
import type { SourceWizardState } from '../hooks/useSourceWizard';

export function FormError({ error, onDismiss }: { error: string; onDismiss: () => void }) {
  const t = useT();
  if (!error) return null;
  return (
    <div className="form-error">
      <CircleHelp size={14} />
      {error}
      <button onClick={onDismiss}>{t('dialogs.close')}</button>
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
  const t = useT();
  return (
    <>
      {groups.length > 0 && (
        <label className="field-label">
          {selectLabel}
          <select className="form-input" value={draft.groupId} onChange={(event) => draft.chooseGroup(event.target.value)}>
            <option value="">{t('dialogs.chooseAGroup')}</option>
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
  const t = useT();
  const { busy, error, setError, setDialog } = shell;
  return (
    <ModalShell
      locked={!!busy}
      title={wizard.batchResult ? t('dialogs.importResults') : t('dialogs.addSkillSource')}
      subtitle={wizard.batchResult ? t('dialogs.importStatusForEachItem') : t('dialogs.scanAGithubRepositoryOrImportALocalSkillDirectory')}
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
  const t = useT();
  const { busy, error, setError } = shell;
  return (
    <ModalShell
      locked={!!busy}
      title={t('dialogs.groupYourSkills')}
      subtitle={t('dialogs.groupsAreOptionalYouCanOrganizeYourSkillsLater')}
      onClose={draft.closeOnboarding}
    >
      <div className="onboarding-count">
        <div className="success-mark">
          <Check size={18} />
        </div>
        <div>
          <strong>{t('dialogs.importedCount', { count: draft.onboardingIds.length })}</strong>
          <span>{t('dialogs.addToAnExistingGroupCreateANewGroupOr')}</span>
        </div>
      </div>
      <GroupPicker
        groups={groups}
        draft={draft}
        selectLabel={t('dialogs.addToExistingGroup')}
        separator={t('dialogs.createGroupAlternative')}
        nameLabel={t('dialogs.groupName')}
        placeholder={t('dialogs.eGProductResearch')}
        autoFocus
      />
      <div className="dialog-footer spread">
        <button className="button subtle" onClick={draft.closeOnboarding}>
          {t('dialogs.skip')}
        </button>
        <button className="button primary" disabled={!draft.groupId && !draft.name.trim()} onClick={() => void draft.saveOnboarding()}>
          {busy === 'group' ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}
          {t('dialogs.submitGroupMembership')}
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
  const t = useT();
  const { selected } = view;
  return (
    <ModalShell
      locked={!!shell.busy}
      title={t('dialogs.selectedSkills')}
      subtitle={t('dialogs.uniqueSkillsYourSelectionIsKeptAcrossViews', { size: selected.size })}
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
              <button
                className="icon-button small"
                aria-label={t('dialogs.remove', { name: skill.name })}
                onClick={() => view.toggleOne(skill.id)}
              >
                <X size={14} />
              </button>
            </div>
          ))}
      </div>
      <div className="dialog-footer spread">
        <button className="button subtle" onClick={() => shell.setDialog(null)}>
          {t('dialogs.continueSelecting')}
        </button>
        <button className="button primary" disabled={!selected.size} onClick={onApply}>
          {t('dialogs.applySelected')}
          <ArrowRight size={15} />
        </button>
      </div>
    </ModalShell>
  );
}
