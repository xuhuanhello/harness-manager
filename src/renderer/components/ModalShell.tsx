import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export default function ModalShell({
  title,
  subtitle,
  onClose,
  size = 'default',
  children,
  locked = false,
  returnFocus,
}: {
  returnFocus?: HTMLElement | null;
  locked?: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  size?: 'default' | 'wide';
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    dialogRef.current
      ?.querySelector<HTMLElement>('input:not([disabled]),button:not([disabled]),select:not([disabled])')
      ?.focus({ preventScroll: true });
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!locked) onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const elements = [
      ...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex="0"]',
      ),
    ];
    if (!elements.length) return;
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (!locked && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`modal-dialog ${size === 'wide' ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
      >
        <div className="modal-heading">
          <div>
            <h2 id="dialog-title">{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button modal-close" aria-label="关闭" disabled={locked} onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <fieldset className="modal-body modal-fields" disabled={locked}>
          {children}
        </fieldset>
      </section>
    </div>,
    document.body,
  );
}
