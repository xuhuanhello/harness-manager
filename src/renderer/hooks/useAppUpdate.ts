import { useCallback, useEffect, useState } from 'react';
import type { AppRelease, AppUpdateState } from '../../shared/app-update';
import type { HarnessAPI } from '../../shared/ipc-contract';

export function useAppUpdate(api: HarnessAPI | undefined) {
  const [state, setState] = useState<AppUpdateState>({ status: 'idle' });
  const [release, setRelease] = useState<AppRelease>();
  const [dialog, setDialog] = useState<'release' | 'restart' | null>(null);
  const accept = useCallback((next: AppUpdateState) => {
    setState(next);
    if (next.status === 'available') setRelease(next);
    if (next.status === 'unsupported' && next.release) setRelease(next.release);
    if (next.status === 'upToDate') setRelease(undefined);
  }, []);
  useEffect(() => {
    if (!api) return;
    let mounted = true;
    let eventReceived = false;
    const unsubscribe = api.onAppUpdate((next) => {
      eventReceived = true;
      if (mounted) accept(next);
    });
    void api.appUpdateState().then((next) => {
      if (mounted && !eventReceived) accept(next);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [api, accept]);
  const run = async (action: () => Promise<AppUpdateState> | Promise<void>) => {
    try {
      const next = await action();
      if (next) accept(next);
    } catch (error) {
      setState({ status: 'error', message: String(error instanceof Error ? error.message : error), retryable: true });
    }
  };
  return {
    state,
    release,
    dialog,
    close: () => setDialog(null),
    review: () => setDialog(state.status === 'downloaded' ? 'restart' : 'release'),
    check: () => void run(() => api!.checkAppUpdate()),
    download: () => void run(() => api!.downloadAppUpdate()),
    cancel: () => void run(() => api!.cancelAppUpdate()),
    install: () => void run(() => api!.installAppUpdate()),
    openPage: (url?: string) => void run(() => api!.openAppUpdatePage({ url })),
    openManagement: () => void run(() => api!.openAppUpdateSettings()),
  };
}

export type AppUpdateController = ReturnType<typeof useAppUpdate>;
