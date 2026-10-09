import { Check, ExternalLink, LoaderCircle, Store, Trash2 } from 'lucide-react';
import type { Snapshot } from '../../shared/types';
import HarnessForm from '../components/HarnessForm';
import ModalShell from '../components/ModalShell';
import type { HarnessEditor } from '../hooks/useHarnessEditor';
import type { MarketplaceSettings } from '../hooks/useMarketplaceSettings';
import type { Shell } from '../hooks/useShell';
import { FormError } from './LibraryDialogs';

export function HarnessFormDialog({ shell, allSnapshot, editor }: { shell: Shell; allSnapshot: Snapshot; editor: HarnessEditor }) {
  const { input } = editor;
  return (
    <ModalShell
      locked={!!shell.busy}
      title={input.id ? '编辑 Harness' : '添加自定义 Harness'}
      subtitle="填写目录声明；两种作用域可分别留空。"
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
  const { draft, setDraft } = market;
  const saving = shell.busy === 'marketplace-save';
  return (
    <ModalShell
      locked={saving}
      title={draft.id ? '编辑市场来源' : '添加市场来源'}
      subtitle="保存后会在侧栏“市场”中显示。"
      onClose={market.closeForm}
    >
      <label className="field-label" htmlFor="marketplace-name">
        市场名称
        <input
          id="marketplace-name"
          autoFocus
          className="form-input"
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          placeholder="例如：团队技能市场"
        />
      </label>
      <label className="field-label" htmlFor="marketplace-url">
        网站地址
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
        此地址用于在浏览器中打开。导入扫描支持 GitHub 仓库和 skills.sh 技能详情链接。
      </p>
      <FormError error={market.formError} onDismiss={() => market.setFormError('')} />
      <div className="dialog-footer spread">
        <button className="button subtle" onClick={market.closeForm}>
          取消
        </button>
        <button className="button primary" data-testid="save-marketplace" disabled={saving} onClick={() => void market.save()}>
          {saving ? <LoaderCircle size={14} className="spin" /> : <Check size={14} />}保存市场
        </button>
      </div>
    </ModalShell>
  );
}

export function MarketplaceRemoveDialog({ shell, market }: { shell: Shell; market: MarketplaceSettings }) {
  const marketplace = market.toRemove;
  if (!marketplace) return null;
  const deleting = shell.busy === 'marketplace-delete';
  return (
    <ModalShell locked={deleting} title="删除市场来源" subtitle="此操作会从侧栏移除此自定义市场入口。" onClose={market.closeRemove}>
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
          取消
        </button>
        <button
          className="button danger"
          data-testid="confirm-delete-marketplace"
          disabled={deleting}
          onClick={() => void market.confirmRemove()}
        >
          {deleting ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}确认删除
        </button>
      </div>
    </ModalShell>
  );
}
