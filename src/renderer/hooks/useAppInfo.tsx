import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AppInfo } from '../../shared/types';

const AppInfoContext = createContext<AppInfo | null>(null);
let request: Promise<AppInfo> | undefined;

/** Cache the startup request, including React StrictMode's repeated effect setup. */
export function AppInfoProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    if (!window.harness) return;
    let active = true;
    request ??= window.harness.appInfo();
    void request.then((value) => active && setInfo(value)).catch(console.error);
    return () => {
      active = false;
    };
  }, []);
  return <AppInfoContext.Provider value={info}>{children}</AppInfoContext.Provider>;
}

export const useAppInfo = () => useContext(AppInfoContext);
