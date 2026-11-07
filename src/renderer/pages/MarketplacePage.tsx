import { useT } from '../i18n';
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
  const t = useT();
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
            <p className="eyebrow">{t('marketplace.customSkillMarketplace')}</p>
            <h2>{marketplace.name}</h2>
            <span>{host}</span>
          </div>
          <button className="button subtle" data-testid="open-marketplace" disabled={opening} onClick={onOpen}>
            {opening ? <LoaderCircle size={14} className="spin" /> : <ExternalLink size={14} />}
            {t('marketplace.openWebsite')}
          </button>
        </div>
        <div className="marketplace-description">
          <ShieldCheck size={15} />
          <p>{t('marketplace.thisMarketplaceProvidesAWebsiteLinkToScanAGithub')}</p>
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
