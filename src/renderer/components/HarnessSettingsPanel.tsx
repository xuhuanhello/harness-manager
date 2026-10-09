import { useEffect, useRef, useState } from 'react';
import ModalShell from './ModalShell';
import { HardDrive, Folder, Plus, RefreshCw, LoaderCircle, ShieldCheck } from 'lucide-react';
import type { Harness } from '../../shared/types';
import type { HarnessInstallationResult, HarnessCleanupPreview } from '../../shared/harness-installation';
import { isHarnessEnabled } from '../../shared/harness-enabled';
import { harnessReadPaths } from '../../shared/harness-paths';
const statusLabel = { installed: '已安装', 'not-found': '未检测到安装', unknown: '无法确认安装' };
export default function HarnessSettingsPanel({
  harnesses,
  onCreate,
  onEdit,
}: {
  harnesses: Harness[];
  onCreate: () => void;
  onEdit: (value: Harness) => void;
}) {
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
          <h2>Harness 管理</h2>
          <p>仅启用的 Harness 参与统一管理。关闭不会卸载工具或删除已有技能及链接。</p>
        </div>
        <div className="harness-settings-actions">
          <button className="button subtle" disabled={checking || working} onClick={() => void detect(true)}>
            {checking ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}检测工具安装
          </button>
          <button className="button subtle" onClick={onCreate}>
            <Plus size={15} />
            自定义 Harness
          </button>
        </div>
      </div>
      {error && !preview && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {preview && (
        <ModalShell returnFocus={cleanupTrigger.current} title="清理残留预览" locked={working} onClose={() => setPreview(null)}>
          <div className="cleanup-preview">
            <strong>确认将这个残留技能目录移入废纸篓？</strong>
            <code>{preview.path}</code>
            <p>
              仅处理预览的空目录或仅含软链的目录。不会删除软链指向的原始技能，也不会删除工具的其他配置、登录信息或缓存。执行前会重新核对安装状态和目录内容；可从系统废纸篓恢复。
            </p>
          </div>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <div className="harness-settings-actions">
            <button className="button subtle" disabled={working} onClick={() => setPreview(null)}>
              取消
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
              确认移入废纸篓
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
                    {harness.kind === 'universal' ? '通用目录' : harness.kind === 'desktop' ? '桌面' : 'CLI'}
                  </span>
                  <span className="custom-pill">{harness.origin === 'builtin' ? '内置规范' : '自定义'}</span>
                  {!enabled && <span className="custom-pill">未启用管理</span>}
                  {enabled && harness.kind !== 'universal' && (
                    <span className={`installation-status ${result?.status ?? ''}`}>
                      {result ? statusLabel[result.status] : checking ? '正在检测…' : '尚未检测'}
                    </span>
                  )}
                </strong>
                <div className="harness-paths">
                  <span>
                    <HardDrive size={12} />
                    用户级：
                    {harnessReadPaths(harness, 'user')
                      .map((item) => item.path)
                      .join('、') || '未配置'}
                  </span>
                  <span>
                    <Folder size={12} />
                    工作区：
                    {harnessReadPaths(harness, 'workspace')
                      .map((item) => item.path)
                      .join('、') || '未配置'}
                  </span>
                </div>
                <div className="harness-read-rules">
                  通用 .agents/skills：用户级{harness.readsUserAgents || harness.kind === 'universal' ? '支持' : '未声明支持'} · 工作区
                  {harness.readsWorkspaceAgents || harness.kind === 'universal' ? '支持' : '未声明支持'}
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
                          未检测到工具，但存在配置或技能目录：<code>{item.path}</code>
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
                            在访达中检查
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
                              预览清理
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
                  aria-label={`启用管理 ${harness.name}`}
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
                  <span>{toggling === harness.id ? '保存中…' : enabled ? '已启用' : '未启用'}</span>
                </button>
                <button className="button subtle compact" aria-label={`编辑 ${harness.name}`} onClick={() => onEdit(harness)}>
                  编辑
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <p className="settings-footnote">
        <ShieldCheck size={14} />
        内置兼容规范不可修改；可补充本机程序路径。仅检测未找到程序时才提示残留目录，不自动清理。
      </p>
    </section>
  );
}
