import { LoaderCircle, Trash2 } from 'lucide-react';
import { ApplyResults } from '../components/ApplyFlow';
import { MigrationIssuePanel, MigrationPreviewPanel, MigrationResults, MigrationScanState } from '../components/MigrationPanels';
import ModalShell from '../components/ModalShell';
import { formatCount } from '../format';
import type { MigrationFlow } from '../hooks/useMigrationFlow';
import type { Shell } from '../hooks/useShell';
import type { WorkspaceFlow } from '../hooks/useWorkspaceFlow';
import { FormError } from './LibraryDialogs';

export function RemoveDialog({ shell, workspace }: { shell: Shell; workspace: WorkspaceFlow }) {
  const { removeDraft: draft, removeResult: result } = workspace;
  if (!draft) return null;
  const { busy, error, setError } = shell;
  return (
    <ModalShell
      locked={!!busy}
      title={result ? '移除结果' : '移除受管安装'}
      subtitle={result ? '中央技能库中的源文件仍然保留。' : '只撤销所选 Harness 目标的安装关系。'}
      onClose={workspace.closeRemove}
    >
      {result ? (
        <ApplyResults result={result} onDone={workspace.finishRemove} />
      ) : (
        <>
          <div className="remove-warning">
            <div className="warning-icon">
              <Trash2 size={17} />
            </div>
            <div>
              <strong>
                从 {draft.harnessName} 移除 {formatCount(draft.skillIds.length, '个安装')}
              </strong>
              <p>{draft.skillNames.join('、')}</p>
              <span>如果共享目录仍被其他绑定使用，文件会继续保留。</span>
            </div>
          </div>
          <div className="dialog-footer spread">
            <button className="button subtle" onClick={workspace.closeRemove}>
              取消
            </button>
            <button className="button danger" onClick={() => void workspace.confirmRemove()}>
              {busy === 'remove' ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />}确认移除
            </button>
          </div>
          <FormError error={error} onDismiss={() => setError('')} />
        </>
      )}
    </ModalShell>
  );
}

export function MigrationDialog({ shell, migration }: { shell: Shell; migration: MigrationFlow }) {
  const { target, preview, result, error } = migration;
  if (!target) return null;
  const { busy } = shell;
  return (
    <ModalShell
      locked={!!busy}
      title={result ? '迁移结果' : preview ? '确认迁移范围' : error ? '处理迁移问题' : '检测迁移范围'}
      subtitle={
        result
          ? '以下结果按项列出。'
          : preview
            ? '核对真实源路径及所有检测到的引用。'
            : error
              ? '可修复受管链接、检查 Harness 设置或重新检测。'
              : '确认前会先读取真实源路径和已知引用。'
      }
      onClose={() => {
        if (busy) return;
        migration.close();
      }}
      size="wide"
    >
      {result ? (
        <MigrationResults
          result={result}
          onRepreview={result.items.some((item) => item.status === 'error') ? migration.repreview : undefined}
          onDone={migration.done}
        />
      ) : preview ? (
        <MigrationPreviewPanel
          preview={preview}
          repairOutcomes={migration.repairOutcomes}
          busy={busy === 'migration'}
          onCancel={migration.close}
          onConfirm={() => void migration.confirm()}
        />
      ) : busy === 'migration-preview' && !error ? (
        <MigrationScanState />
      ) : (
        <MigrationIssuePanel
          error={error}
          repairs={migration.repairs}
          repairsChecked={migration.repairsChecked}
          repairsLoading={busy === 'migration-repairs'}
          repairsError={migration.repairsError}
          outcomes={migration.repairOutcomes}
          expandedRepairId={migration.expandedRepairId}
          busy={!!busy}
          loadingPreview={busy === 'migration-preview'}
          onToggleRepair={migration.toggleRepair}
          onRepair={(repair) => void migration.repair(repair)}
          onRecheck={() => void migration.loadPreview(target.id)}
          onOpenSettings={() => {
            shell.setDialog(null);
            shell.setPage('settings');
          }}
          onCancel={migration.close}
        />
      )}
    </ModalShell>
  );
}
