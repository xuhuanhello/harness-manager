import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, FolderOpen } from 'lucide-react';
import type { Snapshot } from '../../shared/types';

export function WorkspacePicker({
  workspaces,
  value,
  onChange,
}: {
  workspaces: Snapshot['workspaces'];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = workspaces.find((workspace) => workspace.id === value);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    root.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div
      className="agent-workspace-picker"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          setOpen(false);
          trigger.current?.focus();
        }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          if (!open) {
            setOpen(true);
            return;
          }
          const options = [...root.current!.querySelectorAll<HTMLButtonElement>('[role="option"]')];
          const current = options.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? options.length - 1
                : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
          options[next]?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        className="agent-workspace-trigger"
        type="button"
        aria-label="选择工作区"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <FolderOpen size={14} />
        <span>{selected ? `${selected.name || selected.path.split(/[\\/]/).at(-1)} · ${selected.path}` : '选择已知工作区…'}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="agent-workspace-options" role="listbox" aria-label="已知工作区">
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              role="option"
              aria-selected={workspace.id === value}
              type="button"
              onClick={() => {
                onChange(workspace.id);
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <span>{workspace.name || workspace.path.split(/[\\/]/).at(-1)}</span>
              <small title={workspace.path}>{workspace.path}</small>
              {workspace.id === value && <Check size={13} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
