import { t } from '../shared/i18n';
import { app, BrowserWindow, dialog, ipcMain, net, powerMonitor, shell } from 'electron';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { AppError, errorMessage, type IpcResult } from '../shared/errors';
import { APP_UPDATE_CHANNEL, CHANGED_CHANNEL, INVOKE_CHANNEL, isAction } from '../shared/ipc-actions';
import { Controller } from './controller';
import { resolveLocale, setLocaleResolver } from '../shared/i18n';
import type { Settings } from '../shared/types';
import { appError } from './messages';
import { AppUpdater } from './app-updater';
import { installMacUpdate, macLocationReason, spawnDetached } from './app-update-install';
import { writeFile } from 'node:fs/promises';
let controller: Controller | undefined;
let window: BrowserWindow | null = null;
let quitting = false;
const systemLocale = () =>
  resolveLocale(
    'system',
    process.env.HARNESS_SYSTEM_LOCALE
      ? [process.env.HARNESS_SYSTEM_LOCALE]
      : !app.isReady()
        ? [process.env.LANG ?? 'en']
        : app.getPreferredSystemLanguages().length
          ? app.getPreferredSystemLanguages()
          : [app.getLocale()],
  );
setLocaleResolver(() => resolveLocale(controller?.store.get<Settings>('settings', 'ui')?.locale, [systemLocale()]));
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
      const updater = new AppUpdater({
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        isPackaged: app.isPackaged,
        userData: app.getPath('userData'),
        env: process.env,
        fetch: (url, init) => net.fetch(url instanceof URL ? url.href : url, init),
        locationReason: () => macLocationReason(process.execPath),
        install: async (file, version) => {
          await writeFile(path.join(app.getPath('userData'), 'updates', 'pending-version'), version, { mode: 0o600 });
          if (process.platform === 'darwin') await installMacUpdate(file, version, process.execPath, updater.updatesRoot);
          else await spawnDetached(file, ['/S', '--updated', '--force-run']);
        },
        quit: () => app.quit(),
        openExternal: (url) => shell.openExternal(url),
        changed: (state) => {
          if (window && !window.webContents.isDestroyed()) window.webContents.send(APP_UPDATE_CHANNEL, state);
        },
      });
      controller = new Controller(root, () => window?.webContents.send(CHANGED_CHANNEL), {
        appUpdater: updater,
        appInfo: { version: app.getVersion(), platform: process.platform, systemLocale: systemLocale() },
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
      await updater.initialize();
      updater.setAutoCheck(controller.store.get<Settings>('settings', 'ui')?.appUpdates?.autoCheck ?? true);
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
      dialog.showErrorBox(t('library.harnessManagerCouldNotStart'), String(error));
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
