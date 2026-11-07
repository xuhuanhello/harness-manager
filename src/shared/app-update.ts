export const APP_RELEASES_URL = 'https://github.com/xuhuanhello/harness-manager/releases';

export interface AppRelease {
  version: string;
  notes: string;
  publishedAt: string;
  size: number;
  releaseUrl: string;
}

export type AppUpdateState = { lastCheckedAt?: string } & (
  | { status: 'idle' | 'checking' | 'upToDate' | 'installing' }
  | ({ status: 'available' } & AppRelease)
  | { status: 'downloading'; version: string; received: number; total: number }
  | { status: 'downloaded'; version: string }
  | { status: 'error'; message: string; retryable: boolean; permissionRequired?: boolean }
  | { status: 'unsupported'; reason: string; releaseUrl: string; version?: string; release?: AppRelease }
);
