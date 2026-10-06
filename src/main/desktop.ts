/**
 * The two optional services a desktop utility can have: a tray icon and a
 * login item.
 *
 * Both are genuinely optional. A missing tray must not stop the app starting,
 * and a login item the OS refuses must be reported as refused rather than
 * silently downgraded - the reference app's rule, and the one that keeps a
 * preference from lying about what the machine is doing.
 */

import { Menu, Tray, app, nativeImage } from 'electron';
import { createTrayBitmap } from './tray-icon.js';
import { logInfo, logWarn } from './logger.js';

let tray: Tray | null = null;

export interface TrayActions {
  onShow: () => void;
  onRefresh: () => void;
  onRelaunchElevated: () => void;
  isElevated: () => boolean;
}

export function createTray(actions: TrayActions): Tray | null {
  if (tray) return tray;
  try {
    const instance = new Tray(createTrayBitmap(16));
    tray = instance;
    // Right-click is the conventional place for a status-icon menu; the left
    // click reveals the window, which is what a utility icon is expected to do.
    instance.on('click', () => actions.onShow());
    refreshTrayMenu(actions);
    logInfo('Tray created.');
  } catch (error) {
    // A missing tray degrades the UI. It must not block startup, and the app
    // must never end up with no way to reach it.
    tray = null;
    logWarn(`Tray unavailable: ${(error as Error).message}`);
  }
  return tray;
}

export function refreshTrayMenu(actions: TrayActions): void {
  if (!tray) return;
  try {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Port Garden', click: () => actions.onShow() },
        { type: 'separator' },
        { label: 'Rescan now', click: () => actions.onRefresh() },
        {
          label: 'Relaunch as administrator',
          enabled: !actions.isElevated(),
          click: () => actions.onRelaunchElevated()
        },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() }
      ])
    );
    tray.setToolTip('Port Garden');
  } catch (error) {
    logWarn(`Tray menu could not be updated: ${(error as Error).message}`);
  }
}

export function destroyTray(): void {
  if (!tray) return;
  try {
    tray.destroy();
  } catch {
    // Already gone.
  }
  tray = null;
}

export function hasTray(): boolean {
  return tray !== null && !tray.isDestroyed();
}

/**
 * A login item is only ever registered from a packaged build. Registering one
 * from `electron-vite dev` would point the user's machine at a source directory
 * that may be deleted next week.
 */
export function autostartSupported(): boolean {
  return app.isPackaged;
}

export function applyLaunchAtLogin(value: boolean): { applied: boolean; detail: string | null } {
  if (!autostartSupported()) {
    return { applied: false, detail: 'Login item is only available in a packaged build.' };
  }
  try {
    app.setLoginItemSettings({ openAtLogin: value, openAsHidden: true });
    return { applied: value, detail: null };
  } catch (error) {
    logWarn(`Login item was refused: ${(error as Error).message}`);
    return { applied: false, detail: `The OS refused the change: ${(error as Error).message}` };
  }
}

export function readLaunchAtLogin(): boolean {
  if (!autostartSupported()) return false;
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

/** Kept so an unbuilt dev run still has a valid image for the window icon. */
export const windowIcon = (): Electron.NativeImage => nativeImage.createFromBitmap(createTrayBitmap(32).toBitmap(), { width: 32, height: 32 });