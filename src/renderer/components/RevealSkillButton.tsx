import { FolderOpen } from 'lucide-react';
import { fileManagerLabels } from '../file-manager';
import { useAppInfo } from '../hooks/useAppInfo';

export function RevealSkillButton({
  name,
  onReveal,
  disabled,
  className = 'button subtle compact',
}: {
  name: string;
  onReveal: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const labels = fileManagerLabels(useAppInfo()?.platform);
  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
      aria-label={labels.skillLabel(name)}
      onClick={(event) => {
        event.stopPropagation();
        onReveal();
      }}
    >
      <FolderOpen size={12} />
      {labels.open}
    </button>
  );
}
