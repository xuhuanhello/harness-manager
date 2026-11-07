import { useT } from '../i18n';
import { Check, ExternalLink, LoaderCircle, Store, Trash2 } from 'lucide-react';
import type { Snapshot } from '../../shared/types';
import HarnessForm from '../components/HarnessForm';
import ModalShell from '../components/ModalShell';
import type { HarnessEditor } from '../hooks/useHarnessEditor';
import type { MarketplaceSettings } from '../hooks/useMarketplaceSettings';
import type { Shell } from '../hooks/useShell';
import { FormError } from './LibraryDialogs';

export function HarnessFormDialog({ shell, allSnapshot, editor }: { shell: Shell; allSnapshot: Snapshot; editor: HarnessEditor }) {
  const t = useT();
  const { input } = editor;
  return (
    <ModalShell
      locked={!!shell.busy}
      title={input.id ? t('dialogs.editHarness') : t('dialogs.addCustomHarness')}
      subtitle={t('dialogs.enterDirectorySettingsEitherScopeCanBeLeftEmpty')}
      onClose={editor.close}
    >
      <HarnessForm
        builtin={allSnapshot.harnesses.some((item) => item.id === input.id && item.origin === 'builtin')}
        value={input}
        onChange={editor.setInput}
        onCancel={editor.close}
        saving={shell.busy === 'harness'}
        error={shell.error}
        onSave={() => void editor.save()}
      />
    </ModalShell>
  );
}

export function MarketplaceFormDialog({ shell, market }: { shell: Shell; market: MarketplaceSettings }) {
  const t = useT();
  const { draft, setDraft } = market;
  const saving = shell.busy === 'marketplace-save';
  return (
    <ModalShell
      locked={saving}
      title={draft.id ? t('dialogs.editMarketplaceSource') : t('dialogs.addMarketplaceSource')}
      subtitle={t('dialogs.theSourceWillAppearUnderMarketplaceInTheSidebar')}
      onClose={market.closeForm}
    >
      <label className="field-label" htmlFor="marketplace-name">
        {t('dialogs.marketplaceName')}
        <input
          id="marketplace-name"
          autoFocus
          className="form-input"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          placeholder={t('dialogs.eGTeamSkillMarketplace')}
        />
      </label>
      <label className="field-label" htmlFor="marketplace-url">
        {t('dialogs.websiteUrl')}
        <input
          id="marketplace-url"
          type="url"
          className="form-input"
          value={draft.url}
          onChange={(event) => setDraft({ ...draft, url: event.target.value })}
          placeholder="https://example.com"
        />
      </label>
      <p className="marketplace-form-note">
        <ExternalLink size={13} />
        {t('dialogs.thisUrlOpensInYourBrowserImportScanningSupportsGithub')}
      </p>
      <FormError error={market.formError} onDismiss={() => market.setFormError('')} />
      <div className="dialog-footer spread">
        <button className="button subtle" onClick={market.closeForm}>
          {t('dialogs.cancel')}
        </button>
        <button className="button primary" data-testid="save-marketplace" disabled={saving} onClick={() => void market.save()}>
          {saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}
          {t('dialogs.saveMarketplace')}
        </button>
      </div>
    </ModalShell>
  );
}

export function MarketplaceRemoveDialog({ shell, market }: { shell: Shell; market: MarketplaceSettings }) {
  const t = useT();
  const marketplace = market.toRemove;
  if (!marketplace) return null;
  const deleting = shell.busy === 'marketplace-delete';
  return (
    <ModalShell
      locked={deleting}
      title={t('dialogs.deleteMarketplaceSource')}
      subtitle={t('dialogs.thisRemovesTheCustomMarketplaceEntryFromTheSidebar')}
      onClose={market.closeRemove}
    >
      <div className="marketplace-remove-card">
        <div className="marketplace-settings-icon">
          <Store size={15} />
        </div>
        <div>
          <strong>{marketplace.name}</strong>
          <code>{marketplace.url}</code>
        </div>
      </div>
      <FormError error={market.formError} onDismiss={() => market.setFormError('')} />
      <div className="dialog-footer spread">
        <button className="button subtle" onClick={market.closeRemove}>
          {t('dialogs.cancel')}
        </button>
        <button
          className="button danger"
          data-testid="confirm-delete-marketplace"
          disabled={deleting}
          onClick={() => void market.confirmRemove()}
        >
          {deleting ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}
          {t('dialogs.delete')}
        </button>
      </div>
    </ModalShell>
  );
}
