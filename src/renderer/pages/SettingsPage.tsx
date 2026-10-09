import { Activity, Check, CircleHelp, Clock3, HardDrive, LoaderCircle, Plus, ShieldCheck, Store } from 'lucide-react';
import HarnessSettingsPanel from '../components/HarnessSettingsPanel';
import type { Harness, Marketplace, Snapshot, ViewMode } from '../../shared/types';
import { modeItems } from '../format';

export function SettingsPage({
  snapshot,
  onCreate,
  onEdit,
  onMarketplaceCreate,
  onMarketplaceEdit,
  onMarketplaceRemove,
  onHealth,
  busy,
  onViewMode,
}: {
  snapshot: Snapshot;
  onCreate: () => void;
  onEdit: (harness: Harness) => void;
  onMarketplaceCreate: () => void;
  onMarketplaceEdit: (marketplace: Marketplace) => void;
  onMarketplaceRemove: (marketplace: Marketplace) => void;
  onHealth: () => void;
  busy: string;
  onViewMode: (mode: ViewMode) => void;
}) {
  return (
    <div className="settings-page">
      <section className="settings-section">
        <div className="settings-section-heading">
          <div>
            <h2>分类偏好</h2>
            <p>选择中央技能库打开时使用的分类视图。</p>
          </div>
          <div className="settings-badge">
            <Clock3 size={13} />
            已保存
          </div>
        </div>
        <div className="preference-options">
          {modeItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={`preference-option ${snapshot.settings.viewMode === item.id ? 'active' : ''}`}
                onClick={() => onViewMode(item.id)}
              >
                <span className="preference-icon">
                  <Icon size={16} />
                </span>
                <span>
                  <strong>{item.label}</strong>
                  <small>
                    {item.id === 'source'
                      ? '从哪个仓库导入'
                      : item.id === 'harness'
                        ? '每个 Harness 的用户级安装'
                        : item.id === 'group'
                          ? '业务主题与集合'
                          : '集中查看全部技能'}
                  </small>
                </span>
                {snapshot.settings.viewMode === item.id && (
                  <span className="preference-check">
                    <Check size={13} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-section-heading">
          <div>
            <h2>市场来源</h2>
            <p>管理侧栏“市场”中的网站入口。</p>
          </div>
          <button className="button subtle" data-testid="add-marketplace" onClick={onMarketplaceCreate}>
            <Plus size={15} />
            添加市场
          </button>
        </div>
        <div className="marketplace-settings-list">
          {snapshot.marketplaces.map((marketplace) => (
            <div className="marketplace-settings-row" data-testid="marketplace-source-row" key={marketplace.id}>
              <span className="marketplace-settings-icon">
                <Store size={15} />
              </span>
              <div className="marketplace-settings-main">
                <strong>
                  {marketplace.name}
                  <span className={`custom-pill ${marketplace.origin === 'builtin' ? 'builtin-pill' : ''}`}>
                    {marketplace.origin === 'builtin' ? '内置' : '自定义'}
                  </span>
                </strong>
                <code title={marketplace.url}>{marketplace.url}</code>
              </div>
              {marketplace.origin === 'custom' && (
                <div className="marketplace-settings-actions">
                  <button
                    className="button subtle compact"
                    aria-label={`编辑 ${marketplace.name}`}
                    onClick={() => onMarketplaceEdit(marketplace)}
                  >
                    编辑
                  </button>
                  <button
                    className="button subtle compact marketplace-delete-button"
                    aria-label={`删除 ${marketplace.name}`}
                    onClick={() => onMarketplaceRemove(marketplace)}
                  >
                    删除
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        <p className="settings-footnote">
          <ShieldCheck size={14} />
          内置市场固定提供。添加的网址用于打开浏览器；导入仍支持 GitHub 仓库和 skills.sh 技能详情链接。
        </p>
      </section>
      <HarnessSettingsPanel harnesses={snapshot.harnesses} onCreate={onCreate} onEdit={onEdit} />
      <section className="settings-section library-settings">
        <div className="settings-section-heading">
          <div>
            <h2>中央技能库</h2>
            <p>技能文件与管理数据保存在此目录。</p>
          </div>
          <button className="button subtle" onClick={onHealth} disabled={busy === 'health'}>
            {busy === 'health' ? <LoaderCircle size={14} className="spin" /> : <Activity size={14} />}检查安装
          </button>
        </div>
        <div className="library-path-card">
          <div className="library-path-icon">
            <HardDrive size={17} />
          </div>
          <div>
            <strong>{snapshot.libraryRoot}</strong>
            <span>本机库位置 · 含 SQLite 管理数据与技能文件</span>
          </div>
          <span className="path-state">
            <span className="tiny-status" />
            可用
          </span>
        </div>
        <div className="settings-footnote">
          <CircleHelp size={14} />
          移动库和备份导出将在后续版本提供。
        </div>
      </section>
      <footer className="settings-footer">
        <span>Harness Manager</span>
        <span>本机技能管理 · 版本 M1</span>
      </footer>
    </div>
  );
}
