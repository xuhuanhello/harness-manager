import { formatList } from '../i18n';
import { useT } from '../i18n';
import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export function SectionHeading({
  label,
  kind,
  icon,
  count,
  names,
  subtitle = '',
  collapsed,
  onToggle,
  children,
}: {
  label: string;
  kind: string;
  icon: ReactNode;
  count: string;
  names: string[];
  subtitle?: string;
  collapsed: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <div className="section-heading">
      {children}
      <button
        className="section-collapse"
        aria-label={collapsed ? t('library.expandSection', { name: label }) : t('library.collapseSection', { name: label })}
        aria-expanded={!collapsed}
        onClick={onToggle}
      >
        <ChevronDown size={15} className={collapsed ? 'collapsed' : ''} />
      </button>
      <span className={`section-kind-icon ${kind}`}>{icon}</span>
      <strong>{label}</strong>
      <span className="section-count">{count}</span>
      <span className="section-subtitle">
        {collapsed
          ? names.length > 3
            ? t('library.sectionNamesMore', { names: formatList(names.slice(0, 3)) })
            : formatList(names)
          : subtitle}
      </span>
    </div>
  );
}
