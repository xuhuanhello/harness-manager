import {
  ArrowRight,
  Check,
  CircleHelp,
  FolderOpen,
  HardDrive,
  Link2,
  LoaderCircle,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import type { BatchResult, ExternalMigrationPreview, ManagedLinkRepairPreview } from '../../shared/types';
import type { ManagedRepairOutcome } from '../view-types';

/** External-skill migration: issues, managed-link repair, preview and results. */
export function migrationFailureSummary(error: string) {
  if (/[\u3400-\u9fff]/.test(error)) return error;
  const value = error.toLocaleLowerCase();
  if (/修复未|修复没有完成|repair failed|repair did not complete/.test(value))
    return '受管链接修复没有完成。请检查该目标的路径和目录权限，再重新检测。';
  if (/eacces|eperm|permission|access denied|not permitted/.test(value)) return '无法访问技能目录，可能是文件权限或外接磁盘授权不足。';
  if (/enoent|not found|does not exist|no longer available/.test(value)) return '找不到技能来源路径，目录可能已移动或 Harness 配置已变化。';
  if (/symlink|symbolic link|managed link|link target/.test(value)) return '检测到受管链接状态异常；可查看下方是否有可预览的链接修复。';
  if (/unsupported|not supported|cross-device/.test(value)) return '当前目录或文件系统不支持所需的链接操作。';
  return '无法安全确认技能来源路径或全部已知引用。请核对 Harness 路径与目录访问权限。';
}

export function MigrationScanState() {
  return (
    <div className="migration-preview-state">
      <span className="migration-warning-icon">
        <LoaderCircle size={17} className="spin" />
      </span>
      <div>
        <strong>正在检测真实源路径和引用…</strong>
        <p>正在检查当前已配置 Harness 与已登记工作区。完成预览前不会开始迁移。</p>
      </div>
    </div>
  );
}

export function MigrationRepairOutcomes({ outcomes }: { outcomes: ManagedRepairOutcome[] }) {
  if (!outcomes.length) return null;
  return (
    <div className="migration-repair-outcomes">
      {outcomes.map(({ repair, result, error }) => {
        const succeeded = !error && !!result && result.items.length > 0 && result.items.every((item) => item.status !== 'error');
        return (
          <div className={`migration-repair-outcome ${succeeded ? 'success' : 'error'}`} key={repair.repairId}>
            <span>{succeeded ? <Check size={13} /> : <CircleHelp size={13} />}</span>
            <div>
              <strong>
                {repair.skillName} · {error ? '修复失败' : succeeded ? '受管链接已修复' : '修复未完成'}
              </strong>
              {error && (
                <>
                  <small>{migrationFailureSummary(error)}</small>
                  <details>
                    <summary>查看错误详情</summary>
                    <code>{error}</code>
                  </details>
                </>
              )}
              {result?.items.map((item) => (
                <small key={item.id}>
                  {item.label}：{item.message || (item.status === 'success' ? '已完成' : item.status === 'skipped' ? '已跳过' : '未完成')}
                </small>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ManagedLinkRepairCard({
  repair,
  expanded,
  busy,
  onToggle,
  onConfirm,
}: {
  repair: ManagedLinkRepairPreview;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onConfirm: () => void;
}) {
  return (
    <article className="managed-repair-card">
      <div className="managed-repair-heading">
        <span className="migration-reference-mark">
          <Link2 size={13} />
        </span>
        <div>
          <strong>{repair.skillName}</strong>
          <code title={repair.entryPath}>{repair.entryPath}</code>
        </div>
        <button className="button subtle compact" disabled={busy} aria-expanded={expanded} onClick={onToggle}>
          {expanded ? '收起预览' : '预览修复'}
        </button>
      </div>
      {expanded && (
        <div className="managed-repair-details">
          <div className="managed-repair-paths">
            <div>
              <span>当前路径</span>
              <code title={repair.entryPath}>{repair.entryPath}</code>
            </div>
            <div>
              <span>当前错误指向</span>
              <code title={repair.currentTarget}>{repair.currentTarget}</code>
            </div>
            <div>
              <span>正确中央路径</span>
              <code title={repair.centralPath}>{repair.centralPath}</code>
            </div>
          </div>
          <p>确认后只替换这个受管链接，不删除旧真源；技能内容使用中央记录的版本。</p>
          <button className="button primary compact" disabled={busy} onClick={onConfirm}>
            {busy ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}确认修复
          </button>
        </div>
      )}
    </article>
  );
}

export function MigrationIssuePanel({
  error,
  repairs,
  repairsChecked,
  repairsLoading,
  repairsError,
  outcomes,
  expandedRepairId,
  busy,
  loadingPreview,
  onToggleRepair,
  onRepair,
  onRecheck,
  onOpenSettings,
  onCancel,
}: {
  error: string;
  repairs: ManagedLinkRepairPreview[];
  repairsChecked: boolean;
  repairsLoading: boolean;
  repairsError: string;
  outcomes: ManagedRepairOutcome[];
  expandedRepairId: string;
  busy: boolean;
  loadingPreview: boolean;
  onToggleRepair: (repairId: string) => void;
  onRepair: (repair: ManagedLinkRepairPreview) => void;
  onRecheck: () => void;
  onOpenSettings: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <div className="migration-issue-panel">
        <div className="migration-issue-header">
          <span>
            <CircleHelp size={16} />
          </span>
          <div>
            <strong>迁移预检未完成</strong>
            <p>{migrationFailureSummary(error)}</p>
          </div>
        </div>
        <div className="migration-issue-actions">
          <button className="button primary" disabled={busy} onClick={onRecheck}>
            {loadingPreview ? <LoaderCircle size={14} className="spin" /> : <Search size={14} />}重新检测
          </button>
          <div>
            <button className="button subtle" disabled={busy} onClick={onOpenSettings}>
              <Settings2 size={14} />
              检查 Harness 设置
            </button>
            <small>只查看目录配置，不会修改文件。</small>
          </div>
        </div>
        <details className="migration-error-details">
          <summary>查看检测错误详情</summary>
          <code>{error}</code>
        </details>
      </div>
      <MigrationRepairOutcomes outcomes={outcomes} />
      {repairsLoading && (
        <div className="repair-list-status">
          <LoaderCircle size={14} className="spin" />
          正在检查可修复的受管链接…
        </div>
      )}
      {repairsError && (
        <div className="repair-list-status warning">
          <CircleHelp size={14} />
          <span>
            无法读取受管链接修复建议。检查 Harness 路径与目录访问权限后重新检测。
            <details>
              <summary>查看错误详情</summary>
              <code>{repairsError}</code>
            </details>
          </span>
        </div>
      )}
      {!repairsLoading && !repairsError && repairs.length > 0 && (
        <section className="managed-repairs">
          <div className="managed-repairs-heading">
            <strong>可预览的受管链接修复</strong>
            <span>{repairs.length} 项；每项单独确认</span>
          </div>
          {repairs.map((repair) => (
            <ManagedLinkRepairCard
              key={repair.repairId}
              repair={repair}
              expanded={expandedRepairId === repair.repairId}
              busy={busy}
              onToggle={() => onToggleRepair(repair.repairId)}
              onConfirm={() => onRepair(repair)}
            />
          ))}
        </section>
      )}
      {repairsChecked && !repairsLoading && !repairsError && repairs.length === 0 && (
        <div className="no-managed-repairs">
          <ShieldCheck size={14} />
          <span>
            没有检测到可自动修复的受管链接。请检查 Harness 路径；若目录权限不足或文件系统不支持链接操作，完成系统授权后再重新检测。
          </span>
        </div>
      )}
      <div className="dialog-footer">
        <button className="button subtle" disabled={busy} onClick={onCancel}>
          返回 Harness
        </button>
      </div>
    </>
  );
}

export function MigrationPreviewPanel({
  preview,
  repairOutcomes,
  busy,
  onCancel,
  onConfirm,
}: {
  preview: ExternalMigrationPreview;
  repairOutcomes: ManagedRepairOutcome[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <>
      <MigrationRepairOutcomes outcomes={repairOutcomes} />
      <div className="migration-source-card">
        <span className="migration-warning-icon">
          <FolderOpen size={17} />
        </span>
        <div>
          <strong>真实源路径</strong>
          <code title={preview.sourcePath}>{preview.sourcePath}</code>
        </div>
      </div>
      <div className="migration-source-card migration-central-path">
        <span className="migration-warning-icon">
          <HardDrive size={17} />
        </span>
        <div>
          <strong>迁移后的中央目录</strong>
          <code title={preview.centralPath}>{preview.centralPath}</code>
        </div>
      </div>
      <div className="migration-reference-heading">
        <div>
          <strong>检测到的 Harness 引用</strong>
          <span>{preview.references.length} 条引用</span>
        </div>
        <span>已配置 Harness + 已登记工作区</span>
      </div>
      {preview.references.length ? (
        <div className="migration-reference-list">
          {preview.references.map((reference, index) => (
            <div
              className="migration-reference-row"
              key={`${reference.path}:${reference.harnessId}:${reference.workspaceId || 'user'}:${index}`}
            >
              <span className="migration-reference-mark">
                <Link2 size={13} />
              </span>
              <div>
                <strong>{reference.harnessName}</strong>
                <span>
                  {reference.scope === 'user'
                    ? '用户级'
                    : `工作区级 · ${reference.workspaceName || reference.workspaceId || '已登记工作区'}`}
                </span>
                <code title={reference.path}>{reference.path}</code>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="migration-no-references">
          <ShieldCheck size={15} />
          <span>未检测到已知 Harness 引用。预览范围为当前已配置 Harness 与已登记工作区。</span>
        </div>
      )}
      <div className="migration-final-warning">
        <ShieldCheck size={14} />
        <span>迁移会保留以上 Harness 入口名称和路径，并将其重指到中央目录。技能内容由中央库接管，旧真源内容会移除且不会保留副本。</span>
      </div>
      <div className="dialog-footer spread">
        <button className="button subtle" disabled={busy} onClick={onCancel}>
          取消
        </button>
        <button className="button danger" disabled={busy} onClick={onConfirm}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={14} />}确认迁移并移除旧源
        </button>
      </div>
    </>
  );
}

export function MigrationResults({ result, onDone, onRepreview }: { result: BatchResult; onDone: () => void; onRepreview?: () => void }) {
  const succeeded = result.items.filter((item) => item.status === 'success').length;
  const needsAttention = result.items.length - succeeded;
  return (
    <>
      <div className="result-summary">
        <span className={`result-icon ${needsAttention ? 'partial' : ''}`}>
          {needsAttention ? <CircleHelp size={16} /> : <Check size={17} />}
        </span>
        <div>
          <strong>迁移处理完成</strong>
          <span>
            {succeeded} 项成功 · {needsAttention} 项需留意
          </span>
        </div>
      </div>
      <div className="result-list">
        {result.items.map((item) => (
          <div className="result-row" key={item.id}>
            <span className={`result-state ${item.status}`}>
              {item.status === 'success' ? <Check size={13} /> : item.status === 'skipped' ? <ArrowRight size={13} /> : <X size={13} />}
            </span>
            <div>
              <strong>{item.label}</strong>
              <span>
                {item.message || (item.status === 'success' ? '迁移已完成。' : item.status === 'skipped' ? '已跳过' : '迁移失败')}
              </span>
            </div>
          </div>
        ))}
      </div>
      <div className="dialog-footer spread">
        {onRepreview && (
          <button className="button subtle" onClick={onRepreview}>
            <Search size={14} />
            重新检测引用
          </button>
        )}
        <button className="button primary" onClick={onDone}>
          返回 Harness <ArrowRight size={15} />
        </button>
      </div>
    </>
  );
}
