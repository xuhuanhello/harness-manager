import { t } from './i18n';
import { Boxes, Code2, FolderTree, Layers3, Sparkles, Tag } from 'lucide-react';
import type { Snapshot, ViewMode } from '../shared/types';

/** Small display helpers shared across pages. */
export const modeItems = (): { id: ViewMode; label: string; icon: typeof Layers3 }[] => [
  { id: 'source', label: t('library.bySource'), icon: FolderTree },
  { id: 'harness', label: t('library.byHarness'), icon: Boxes },
  { id: 'group', label: t('library.byGroup'), icon: Tag },
  { id: 'flat', label: t('library.allSkills'), icon: Layers3 },
];

export function sourceName(snapshot: Snapshot, id: string) {
  return snapshot.sources.find((source) => source.id === id)?.label || t('library.unknownSource');
}

export function initial(name: string) {
  return [...name.trim()][0]?.toUpperCase() || 'H';
}

export function normalizeGroupName(name: string) {
  return name.normalize('NFKC').toLocaleLowerCase('en-US');
}

export function harnessGlyph(icon: string, name: string): React.ReactNode {
  if (icon === 'claude') return 'C';
  if (icon === 'codex') return <Code2 size={14} />;
  if (icon === 'globe') return <Sparkles size={14} />;
  if (icon.length > 0 && icon.length <= 2) return icon;
  return initial(name);
}

export { formatCount } from './i18n';

export function modeTitle(mode: ViewMode) {
  return modeItems().find((item) => item.id === mode)?.label ?? t('library.bySource');
}
