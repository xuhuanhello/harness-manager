import { t } from './i18n';
/** An error whose message is ready to show to the user, with a stable code for programmatic checks. */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** What the main process returns over IPC, so rejections reach the renderer without Electron's wrapper text. */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };

/** User-facing text for any thrown value. */
export function errorMessage(error: unknown, fallback = t('errors.operationFailed')): string {
  if (error instanceof Error) return error.message;
  return error ? String(error) : fallback;
}

export function errorCodeOf(error: unknown): string {
  return error instanceof AppError ? error.code : 'UNEXPECTED';
}
