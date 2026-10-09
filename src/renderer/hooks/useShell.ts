import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from '../../shared/errors';
import type { Dialog, Page } from '../view-types';

/** App-wide UI state: current page and dialog, the busy task, and the shared error and toast. */
export function useShell() {
  const [page, setPage] = useState<Page>('library');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  /** Marks `key` busy, clears the shared error, and shows a failure there. */
  const runTask = useCallback(async (key: string, task: () => Promise<void>) => {
    setBusy(key);
    setError('');
    try {
      await task();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy('');
    }
  }, []);

  return { page, setPage, dialog, setDialog, menuOpen, setMenuOpen, error, setError, toast, setToast, busy, setBusy, runTask };
}

export type Shell = ReturnType<typeof useShell>;
