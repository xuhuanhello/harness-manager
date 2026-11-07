import { formatDateTime, formatNumber, useT } from '../i18n';
import type { AppUpdateController } from '../hooks/useAppUpdate';
import { useAppInfo } from '../hooks/useAppInfo';
import ModalShell from './ModalShell';

function percent(received: number, total: number) {
  return total ? Math.min(100, Math.floor((received / total) * 100)) : 0;
}
function size(bytes: number) {
  const divisor = bytes >= 1_000_000 ? 1_000_000 : bytes >= 1000 ? 1000 : 1;
  return formatNumber(bytes / divisor, {
    maximumFractionDigits: 1,
    style: 'unit',
    unit: divisor === 1_000_000 ? 'megabyte' : divisor === 1000 ? 'kilobyte' : 'byte',
    unitDisplay: divisor === 1 ? 'long' : 'short',
  });
}

export function AppUpdateFooter({ update }: { update: AppUpdateController }) {
  const t = useT();
  const state = update.state;
  if (state.status === 'available')
    return (
      <button className="app-update-action" onClick={update.review}>
        {t('appUpdate.available', { version: state.version })}
      </button>
    );
  if (state.status === 'unsupported' && state.version)
    return (
      <button className="app-update-action" onClick={update.review}>
        {t('appUpdate.newVersion', { version: state.version })}
      </button>
    );
  if (state.status === 'downloaded')
    return (
      <button className="app-update-action" onClick={update.review}>
        {t('appUpdate.restart')}
      </button>
    );
  if (state.status === 'downloading')
    return (
      <button className="app-update-action app-update-progress" onClick={update.review}>
        <progress
          value={state.received}
          max={state.total || 1}
          aria-label={t('appUpdate.downloading', { percent: percent(state.received, state.total) })}
        />
        {t('appUpdate.downloading', { percent: percent(state.received, state.total) })}
      </button>
    );
  if (state.status === 'error')
    return (
      <button className="app-update-action app-update-error" onClick={state.permissionRequired ? update.review : update.check}>
        {t('appUpdate.retry')}
      </button>
    );
  if (state.status === 'installing') return <span>{t('appUpdate.installing')}</span>;
  return null;
}

export function AppUpdateSettings({
  update,
  autoCheck,
  onAutoCheck,
}: {
  update: AppUpdateController;
  autoCheck: boolean;
  onAutoCheck: (value: boolean) => void;
}) {
  const t = useT();
  const info = useAppInfo();
  const state = update.state;
  const status =
    state.status === 'checking'
      ? t('appUpdate.checking')
      : state.status === 'upToDate'
        ? t('appUpdate.upToDate')
        : state.status === 'available' || (state.status === 'unsupported' && state.version)
          ? t('appUpdate.found')
          : '';
  return (
    <section className="settings-section" data-testid="app-update-settings">
      <div className="settings-section-heading">
        <div>
          <h2>{t('appUpdate.title')}</h2>
          <p>{t('appUpdate.currentVersion', { version: info?.version ?? '…' })}</p>
        </div>
        <button
          className="button subtle"
          onClick={update.check}
          disabled={['checking', 'downloading', 'installing'].includes(state.status)}
        >
          {t('appUpdate.check')}
        </button>
      </div>
      <p role="status">{status}</p>
      <p className="settings-footnote">
        {t('appUpdate.lastChecked', {
          time: state.lastCheckedAt
            ? formatDateTime(new Date(state.lastCheckedAt), { dateStyle: 'medium', timeStyle: 'short' })
            : t('appUpdate.neverChecked'),
        })}
      </p>
      {state.status === 'error' && <p role="alert">{state.message}</p>}
      {state.status === 'error' && state.permissionRequired && (
        <button className="button subtle" onClick={update.openManagement}>
          {t('appUpdate.openManagement')}
        </button>
      )}
      {state.status === 'unsupported' && <p>{state.reason}</p>}
      <div className="app-update-settings-actions">
        <label>
          <input
            type="checkbox"
            role="switch"
            aria-checked={autoCheck}
            checked={autoCheck}
            onChange={(event) => onAutoCheck(event.target.checked)}
          />{' '}
          {t('appUpdate.autoCheck')}
        </label>
        <button className="button subtle" onClick={() => update.openPage()}>
          {t('appUpdate.allReleases')}
        </button>
      </div>
    </section>
  );
}

export function AppUpdateDialog({ update }: { update: AppUpdateController }) {
  const t = useT();
  const info = useAppInfo();
  const { state, release } = update;
  if (!update.dialog) return null;
  const downloading = state.status === 'downloading';
  const restart = state.status === 'downloaded' || state.status === 'installing' || update.dialog === 'restart';
  return (
    <ModalShell
      title={restart ? t('appUpdate.restart') : t('appUpdate.title')}
      onClose={update.close}
      locked={state.status === 'installing'}
    >
      <div className="app-update-dialog">
        {release && (
          <>
            <h3>{t('appUpdate.versionChange', { current: info?.version ?? '…', next: release.version })}</h3>
            <p>
              {t('appUpdate.published', {
                time: release.publishedAt
                  ? formatDateTime(new Date(release.publishedAt), { dateStyle: 'medium', timeStyle: 'short' })
                  : t('appUpdate.unknown'),
              })}
            </p>
            <p>{t('appUpdate.size', { size: release.size ? size(release.size) : t('appUpdate.unknown') })}</p>
          </>
        )}
        {restart ? (
          <p>{t(state.status === 'installing' ? 'appUpdate.installing' : 'appUpdate.restartConfirm')}</p>
        ) : (
          release && (
            <>
              <h4>{t('appUpdate.notes')}</h4>
              <pre className="app-release-notes">{release.notes || t('appUpdate.noNotes')}</pre>
            </>
          )
        )}
        {state.status === 'unsupported' && <p role="status">{state.reason}</p>}
        {state.status === 'error' && <p role="alert">{state.message}</p>}
        {downloading && (
          <div>
            <progress
              value={state.received}
              max={state.total || 1}
              aria-label={t('appUpdate.downloading', { percent: percent(state.received, state.total) })}
            />
            <p>{t('appUpdate.downloadProgress', { received: size(state.received), total: size(state.total) })}</p>
          </div>
        )}
        <div className="dialog-footer">
          <button className="button subtle" onClick={update.close}>
            {t('appUpdate.later')}
          </button>
          {state.status === 'error' && state.permissionRequired ? (
            <button className="button primary" onClick={update.openManagement}>
              {t('appUpdate.openManagement')}
            </button>
          ) : state.status === 'unsupported' ? (
            <button className="button primary" onClick={() => update.openPage(state.releaseUrl)}>
              {t('appUpdate.openRelease')}
            </button>
          ) : downloading ? (
            <button className="button primary" onClick={update.cancel}>
              {t('appUpdate.cancel')}
            </button>
          ) : restart ? (
            <button className="button primary" onClick={update.install}>
              {t('appUpdate.restart')}
            </button>
          ) : state.status === 'available' ? (
            <button className="button primary" onClick={update.download}>
              {t('appUpdate.download')}
            </button>
          ) : (
            state.status === 'error' && (
              <button className="button primary" onClick={update.check}>
                {t('appUpdate.retry')}
              </button>
            )
          )}
        </div>
      </div>
    </ModalShell>
  );
}
