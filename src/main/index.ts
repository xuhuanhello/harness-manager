import { app, BrowserWindow, dialog, ipcMain, powerMonitor, shell } from 'electron';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { AppError, errorMessage, type IpcResult } from '../shared/errors';
import { CHANGED_CHANNEL, INVOKE_CHANNEL, isAction } from '../shared/ipc-actions';
import { Controller } from './controller';
import { appError } from './messages';
let controller: Controller | undefined;
let window: BrowserWindow | null = null;
let quitting = false;
// Keep the library location stable between electron . and the named packaged app.
app.setPath('userData', path.join(app.getPath('appData'), 'harness-manager'));
if (process.env.HARNESS_PROFILE_ROOT) {
  const profile = path.resolve(process.env.HARNESS_PROFILE_ROOT);
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
}
const devUrl = process.env.HARNESS_DEV_URL;
if (devUrl && !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(devUrl)) throw appError('INTERNAL_DEV_ORIGIN');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      const root = process.env.HARNESS_LIBRARY_ROOT || path.join(app.getPath('userData'), 'library');
      controller = new Controller(root, () => window?.webContents.send(CHANGED_CHANNEL), {
        ports: {
          chooseDirectory: async () => {
            if (!window) return null;
            const selected = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] });
            return selected.canceled ? null : selected.filePaths[0];
          },
          openExternal: (url) => shell.openExternal(url),
          showItemInFolder: (target) => shell.showItemInFolder(target),
          trashItem: (target) => shell.trashItem(target),
        },
      });
      await controller.initialize();
      const rendererPath = path.join(__dirname, '../renderer/index.html');
      const trustedUrl = devUrl ?? pathToFileURL(rendererPath).href;
      ipcMain.handle(INVOKE_CHANNEL, async (event, action: unknown, payload: unknown): Promise<IpcResult<unknown>> => {
        const frame = event.senderFrame;
        if (
          !window ||
          event.sender !== window.webContents ||
          frame !== window.webContents.mainFrame ||
          frame.url.split('#')[0] !== trustedUrl
        )
          throw appError('IPC_UNAUTHORIZED');
        if (!isAction(action)) throw appError('IPC_UNKNOWN_ACTION');
        try {
          return { ok: true, value: await controller!.invoke(action, payload) };
        } catch (error) {
          return { ok: false, error: { code: error instanceof AppError ? error.code : 'UNEXPECTED', message: errorMessage(error) } };
        }
      });
      const createWindow = () => {
        window = new BrowserWindow({
          width: 1320,
          height: 880,
          minWidth: 940,
          minHeight: 660,
          title: 'Harness Manager',
          backgroundColor: '#f6f7f9',
          webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
        });
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', (event) => event.preventDefault());
        window.on('closed', () => {
          window = null;
        });
        if (devUrl) void window.loadURL(devUrl);
        else void window.loadFile(rendererPath);
      };
      createWindow();
      let lastCheck = Date.now();
      const refresh = () => {
        if (Date.now() - lastCheck < 30000) return;
        lastCheck = Date.now();
        void controller!.refreshHealth().catch(console.error);
      };
      app.on('browser-window-focus', refresh);
      powerMonitor.on('resume', refresh);
      app.on('activate', () => {
        if (!window) createWindow();
      });
    })
    .catch((error) => {
      dialog.showErrorBox('Harness Manager 启动失败', String(error));
      app.quit();
    });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', (event) => {
    if (!controller || quitting) return;
    event.preventDefault();
    quitting = true;
    void controller.close().finally(() => app.quit());
  });
}
