import { useT } from '../i18n';
import { Check, LoaderCircle, ShieldCheck } from 'lucide-react';
import type { HarnessInput } from '../../shared/types';
const lines = (value: string) =>
  value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
export default function HarnessForm({
  value,
  builtin,
  onChange,
  onCancel,
  onSave,
  saving,
  error,
}: {
  value: HarnessInput;
  builtin: boolean;
  onChange: (value: HarnessInput) => void;
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  error: string;
}) {
  const t = useT();
  const invalid =
    !value.name.trim() ||
    (!value.userSkillsPath.trim() &&
      !value.workspaceSkillsRelativePath.trim() &&
      !value.readsUserAgents &&
      !value.readsWorkspaceAgents &&
      value.kind !== 'universal');
  return (
    <>
      {builtin && (
        <div className="form-help-box">
          <ShieldCheck size={16} />
          <span>{t('harness.builtInDirectoriesAndCompatibilityRulesFollowOfficialDocumentationYou')}</span>
        </div>
      )}
      <fieldset className="modal-fields" disabled={builtin || saving}>
        <label className="field-label">
          {t('harness.name')}
          <input
            autoFocus={!builtin}
            className="form-input"
            value={value.name}
            onChange={(e) => onChange({ ...value, name: e.target.value })}
          />
        </label>
        <label className="field-label">
          {t('harness.iconCharacter')}
          <input
            className="form-input short-input"
            maxLength={3}
            value={value.icon || ''}
            onChange={(e) => onChange({ ...value, icon: e.target.value })}
          />
        </label>
        <div className="field-label">
          {t('harness.toolType')}
          <div className="scope-switch">
            {(['cli', 'desktop'] as const).map((kind) => (
              <button key={kind} type="button" className={value.kind === kind ? 'active' : ''} onClick={() => onChange({ ...value, kind })}>
                {kind === 'cli' ? t('harness.commandLineCli') : t('harness.desktopApp')}
              </button>
            ))}
          </div>
        </div>
        <label className="field-label">
          {t('harness.userSkillDirectory')}
          <input
            className="form-input"
            value={value.userSkillsPath}
            onChange={(e) => onChange({ ...value, userSkillsPath: e.target.value })}
            placeholder="~/.my-agent/skills"
          />
        </label>
        <label className="field-label">
          {t('harness.workspaceRelativeDirectory')}
          <input
            className="form-input"
            value={value.workspaceSkillsRelativePath}
            onChange={(e) => onChange({ ...value, workspaceSkillsRelativePath: e.target.value })}
            placeholder=".my-agent/skills"
          />
        </label>
        <div className="harness-compatibility-fields">
          <label>
            <input
              type="checkbox"
              checked={!!value.readsUserAgents}
              onChange={(e) => onChange({ ...value, readsUserAgents: e.target.checked })}
            />
            {t('harness.readUserAgentsSkills')}
          </label>
          <label>
            <input
              type="checkbox"
              checked={!!value.readsWorkspaceAgents}
              onChange={(e) => onChange({ ...value, readsWorkspaceAgents: e.target.checked })}
            />
            {t('harness.readWorkspaceAgentsSkills')}
          </label>
        </div>
        <label className="field-label">
          {t('harness.additionalUserSkillDirectories')}
          <textarea
            className="form-input"
            value={(value.extraUserSkillsPaths ?? []).join('\n')}
            onChange={(e) => onChange({ ...value, extraUserSkillsPaths: lines(e.target.value) })}
            placeholder={t('harness.oneAbsoluteDirectoryPerLineOptional')}
          />
        </label>
        <label className="field-label">
          {t('harness.additionalWorkspaceRelativeDirectories')}
          <textarea
            className="form-input"
            value={(value.extraWorkspaceSkillsRelativePaths ?? []).join('\n')}
            onChange={(e) => onChange({ ...value, extraWorkspaceSkillsRelativePaths: lines(e.target.value) })}
            placeholder={t('harness.oneRelativeDirectoryPerLineOptional')}
          />
        </label>
        <label className="field-label">
          {t('harness.detectionCommand')}
          <input
            className="form-input"
            value={value.command ?? ''}
            onChange={(e) => onChange({ ...value, command: e.target.value })}
            placeholder={t('harness.eGClaudeExecutableNameOnlyNotAFullCommand')}
          />
        </label>
        <label className="field-label">
          {t('harness.versionArguments')}
          <input
            className="form-input"
            value={(value.versionArgs ?? ['--version']).join(' ')}
            onChange={(e) => onChange({ ...value, versionArgs: e.target.value.split(/\s+/).filter(Boolean) })}
            placeholder="--version"
          />
        </label>
      </fieldset>
      {value.kind !== 'universal' && (
        <>
          {!!value.extensionIds?.length && (
            <label className="field-label">
              {t('harness.editorExtensionDirectories')}
              <textarea
                className="form-input"
                value={(value.extensionRoots ?? []).join('\n')}
                onChange={(e) => onChange({ ...value, extensionRoots: lines(e.target.value) })}
                placeholder={t('harness.oneDirectoryPerLineEGVscodeExtensions')}
              />
            </label>
          )}
          <label className="field-label">
            {t('harness.executablePaths')}
            <textarea
              className="form-input"
              value={(value.executablePaths ?? []).join('\n')}
              onChange={(e) => onChange({ ...value, executablePaths: lines(e.target.value) })}
              placeholder={t('harness.oneAbsolutePathPerLineEGLocalBinMy')}
            />
          </label>
          {value.kind === 'desktop' && (
            <label className="field-label">
              {t('harness.desktopAppPaths')}
              <textarea
                className="form-input"
                value={(value.appPaths ?? []).join('\n')}
                onChange={(e) => onChange({ ...value, appPaths: lines(e.target.value) })}
                placeholder="/Applications/My Agent.app"
              />
            </label>
          )}
          <p className="field-help">{t('harness.afterSavingDetectionChecksPathYourPathsAndCommonInstallation')}</p>
        </>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="dialog-footer spread">
        <button className="button subtle" onClick={onCancel}>
          {t('harness.cancel')}
        </button>
        <button className="button primary" disabled={(!builtin && invalid) || saving} onClick={onSave}>
          {saving ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}
          {t('harness.saveHarness')}
        </button>
      </div>
    </>
  );
}
