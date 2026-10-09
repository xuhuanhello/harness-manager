import { CircleHelp, ExternalLink, LoaderCircle, ShieldCheck, Store } from 'lucide-react';
import type { Marketplace } from '../../shared/types';

export function MarketplacePage({
  marketplace,
  error,
  opening,
  onOpen,
}: {
  marketplace: Marketplace;
  error: string;
  opening: boolean;
  onOpen: () => void;
}) {
  let host = marketplace.url;
  try {
    host = new URL(marketplace.url).hostname;
  } catch {
    /* The saved value is validated by the main process. */
  }
  return (
    <div className="marketplace-page">
      <section className="marketplace-card">
        <div className="marketplace-card-heading">
          <div className="marketplace-mark">
            <Store size={19} />
          </div>
          <div>
            <p className="eyebrow">自定义技能市场</p>
            <h2>{marketplace.name}</h2>
            <span>{host}</span>
          </div>
          <button className="button subtle" data-testid="open-marketplace" disabled={opening} onClick={onOpen}>
            {opening ? <LoaderCircle size={14} className="spin" /> : <ExternalLink size={14} />}打开网站
          </button>
        </div>
        <div className="marketplace-description">
          <ShieldCheck size={15} />
          <p>此市场目前提供网站浏览入口。要扫描 GitHub 仓库或本地技能目录，请前往中央技能库添加来源。</p>
        </div>
        {error && (
          <div className="form-error">
            <CircleHelp size={14} />
            {error}
          </div>
        )}
      </section>
    </div>
  );
}
