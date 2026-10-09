import { contextBridge, ipcRenderer } from 'electron';
import type { IpcResult } from '../shared/errors';
import { ACTIONS, CHANGED_CHANNEL, INVOKE_CHANNEL } from '../shared/ipc-actions';
import type { HarnessAPI } from '../shared/ipc-contract';

async function invoke(action: string, payload?: unknown): Promise<unknown> {
  const result = (await ipcRenderer.invoke(INVOKE_CHANNEL, action, payload)) as IpcResult<unknown>;
  if (result.ok) return result.value;
  // Rethrow with only the user-facing message; a rejected invoke would prefix Electron's wrapper text.
  throw new Error(result.error.message);
}

// Payloads are validated and typed in the main process; the bridge itself only forwards them.
const actions = Object.fromEntries(ACTIONS.map((action) => [action, (payload?: unknown) => invoke(action, payload)])) as unknown as Omit<
  HarnessAPI,
  'onChanged'
>;

const api: HarnessAPI = {
  ...actions,
  onChanged: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on(CHANGED_CHANNEL, handler);
    return () => ipcRenderer.removeListener(CHANGED_CHANNEL, handler);
  },
};

contextBridge.exposeInMainWorld('harness', api);
