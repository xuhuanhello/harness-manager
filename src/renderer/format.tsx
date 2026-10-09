import { Boxes, Code2, FolderTree, Layers3, Sparkles, Tag } from 'lucide-react';
import type { Snapshot, ViewMode } from '../shared/types';

/** Small display helpers shared across pages. */
export const modeItems: { id: ViewMode; label: string; icon: typeof Layers3 }[] = [
  { id: 'source', label: '按来源', icon: FolderTree },
  { id: 'harness', label: '按 Harness', icon: Boxes },
  { id: 'group', label: '按分组', icon: Tag },
  { id: 'flat', label: '平铺', icon: Layers3 },
];

export function sourceName(snapshot: Snapshot, id: string) {
  return snapshot.sources.find((source) => source.id === id)?.label || '未知来源';
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

export function formatCount(value: number, noun = '项') {
  return `${value} ${noun}`;
}

export function modeTitle(mode: ViewMode) {
  return modeItems.find((item) => item.id === mode)?.label ?? '按来源';
}
