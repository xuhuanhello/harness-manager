import { formatList } from '../i18n';
import { t, useT } from '../i18n';
import { useAppInfo } from '../hooks/useAppInfo';
import { fileManagerLabels } from '../file-manager';
import { useEffect, useRef, useState } from 'react';
import ModalShell from './ModalShell';
import { HardDrive, Folder, Plus, RefreshCw, LoaderCircle, ShieldCheck } from 'lucide-react';
import type { Harness } from '../../shared/types';
import type { HarnessInstallationResult, HarnessCleanupPreview } from '../../shared/harness-installation';
import { isHarnessEnabled } from '../../shared/harness-enabled';
import { harnessReadPaths } from '../../shared/harness-paths';
const statusLabels = () => ({
  installed: t('harness.installed'),
  'not-found': t('harness.installationNotFound'),
  unknown: t('harness.installationUnknown'),
});
export default function HarnessSettingsPanel({
  harnesses,
  onCreate,
  onEdit,
}: {
  harnesses: Harness[];
  onCreate: () => void;
  onEdit: (value: Harness) => void;
}) {
  const t = useT();
  const fileManager = fileManagerLabels(useAppInfo()?.platform);
  const [results, setResults] = useState<HarnessInstallationResult[]>([]);
  const [toggling, setToggling] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<HarnessCleanupPreview | null>(null);
  const [working, setWorking] = useState(false);
  const cleanupTrigger = useRef<HTMLButtonElement | null>(null);
  const detect = async (refresh = false) => {
    setChecking(true);
    setError('');
    try {
      setResults(await window.harness.detectHarnessInstallations({ refresh }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    void detect();
  }, [JSON.stringify(harnesses)]);
  const showCleanup = async (harnessId: string, path: string) => {
    setWorking(true);
    setError('');
    try {
      const result = await window.harness.previewHarnessCleanup({ harnessId, path });
      if (!result.canTrash || !result.token) throw new Error(result.reason);
      setPreview(result);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setWorking(false);
    }
  };
  return (
    <section className="settings-section">
      <div className="settings-section-heading">
        <div>
          <h2>{t('harness.harnessManagement')}</h2>
          <p>{t('harness.onlyEnabledHarnessesAreManagedDisablingOneKeepsTheTool')}</p>
        </div>
        <div className="harness-settings-actions">
          <button className="button subtle" disabled={checking || working} onClick={() => void detect(true)}>
            {checking ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}
            {t('harness.detectInstallations')}
          </button>
          <button className="button subtle" onClick={onCreate}>
            <Plus size={15} />
            {t('harness.customHarness')}
          </button>
        </div>
      </div>
      {error && !preview && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {preview && (
        <ModalShell
          returnFocus={cleanupTrigger.current}
          title={t('harness.reviewLeftoverDirectory')}
          locked={working}
          onClose={() => setPreview(null)}
        >
          <div className="cleanup-preview">
            <strong>{t('harness.moveThisLeftoverSkillDirectoryToTrash')}</strong>
            <code>{preview.path}</code>
            <p>{t('harness.onlyThePreviewedEmptyOrSymlinkOnlyDirectoryWillBe')}</p>
          </div>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="harness-settings-actions">
            <button className="button subtle" disabled={working} onClick={() => setPreview(null)}>
              {t('harness.cancel')}
            </button>
            <button
              className="button primary"
              disabled={working || !preview.token}
              onClick={async () => {
                setWorking(true);
                setError('');
                try {
                  await window.harness.cleanupHarness({ token: preview.token! });
                  setPreview(null);
                  await detect(true);
                } catch (cause) {
                  setError(String(cause));
                } finally {
                  setWorking(false);
                }
              }}
            >
              {t('harness.moveToTrash')}
            </button>
          </div>
        </ModalShell>
      )}
      <div className="harness-settings-list">
        {harnesses.map((harness) => {
          const enabled = isHarnessEnabled(harness);
          const result = enabled ? results.find((item) => item.harnessId === harness.id) : undefined;
          return (
            <div className="harness-settings-row harness-detection-row" data-testid="harness-setting-row" key={harness.id}>
              <span className={`harness-icon ${harness.origin}`}>{harness.name.slice(0, 1)}</span>
              <div className="harness-settings-main">
                <strong>
                  {harness.name}
                  <span className="custom-pill">
                    {harness.kind === 'universal'
                      ? t('harness.sharedDirectory')
                      : harness.kind === 'desktop'
                        ? t('harness.desktop')
                        : 'CLI'}
                  </span>
                  <span className="custom-pill">{harness.origin === 'builtin' ? t('harness.builtInRules') : t('harness.custom')}</span>
                  {!enabled && <span className="custom-pill">{t('harness.managementDisabled')}</span>}
                  {enabled && harness.kind !== 'universal' && (
                    <span className={`installation-status ${result?.status ?? ''}`}>
                      {result ? statusLabels()[result.status] : checking ? t('harness.detecting') : t('harness.notCheckedYet')}
                    </span>
                  )}
                </strong>
                <div className="harness-paths">
                  <span>
                    <HardDrive size={12} />
                    {t('harness.userPaths', {
                      paths: formatList(harnessReadPaths(harness, 'user').map((item) => item.path)) || t('harness.notConfigured'),
                    })}
                  </span>
                  <span>
                    <Folder size={12} />
                    {t('harness.workspacePaths', {
                      paths: formatList(harnessReadPaths(harness, 'workspace').map((item) => item.path)) || t('harness.notConfigured'),
                    })}
                  </span>
                </div>
                <div className="harness-read-rules">
                  {t('harness.sharedCompatibility', {
                    user:
                      harness.readsUserAgents || harness.kind === 'universal'
                        ? t('harness.compatibilitySupported')
                        : t('harness.compatibilityNotDeclared'),
                    workspace:
                      harness.readsWorkspaceAgents || harness.kind === 'universal'
                        ? t('harness.compatibilitySupported')
                        : t('harness.compatibilityNotDeclared'),
                  })}
                </div>
                {result?.reason && <span className="installation-detail">{result.reason}</span>}
                {result?.executable && (
                  <code className="installation-detail">
                    {result.executable}
                    {result.version ? ` · ${result.version}` : ''}
                  </code>
                )}
                {result?.status === 'not-found' &&
                  result.residualDirectories
                    .filter((item) => item.classification !== 'missing')
                    .map((item) => (
                      <div className="residual-directory" key={item.path}>
                        <span>
                          {t('harness.toolNotFoundButConfigurationOrSkillDirectoriesExist')}
                          <code>{item.path}</code>
                        </span>
                        <span>{item.detail}</span>
                        <div>
                          <button
                            className="text-button"
                            onClick={() => {
                              void window.harness
                                .revealHarnessDirectory({ harnessId: harness.id, path: item.path })
                                .catch((cause) => setError(String(cause)));
                            }}
                          >
                            {fileManager.inspect}
                          </button>
                          {item.canTrash && (
                            <button
                              className="button subtle compact"
                              disabled={working}
                              onClick={(event) => {
                                cleanupTrigger.current = event.currentTarget;
                                void showCleanup(harness.id, item.path);
                              }}
                            >
                              {t('harness.reviewCleanup')}
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
              </div>
              <div className="harness-settings-row-actions">
                <button
                  type="button"
                  className="harness-enable-switch"
                  role="switch"
                  aria-checked={enabled}
                  aria-label={t('harness.enableManagementFor', { name: harness.name })}
                  disabled={!!toggling || working}
                  onClick={async () => {
                    setToggling(harness.id);
                    setError('');
                    try {
                      await window.harness.setHarnessEnabled({ harnessId: harness.id, enabled: !enabled });
                    } catch (cause) {
                      setError(String(cause));
                    } finally {
                      setToggling('');
                    }
                  }}
                >
                  <span className="harness-switch-track">
                    <span />
                  </span>
                  <span>{toggling === harness.id ? t('harness.saving') : enabled ? t('harness.enabled') : t('harness.disabled')}</span>
                </button>
                <button
                  className="button subtle compact"
                  aria-label={t('harness.edit', { name: harness.name })}
                  onClick={() => onEdit(harness)}
                >
                  {t('harness.editAction')}
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <p className="settings-footnote">
        <ShieldCheck size={14} />
        {t('harness.builtInCompatibilityRulesAreReadOnlyLocalProgramPaths')}
      </p>
    </section>
  );
}
