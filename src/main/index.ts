/**
 * Startup and shutdown.
 *
 * The one unusual thing here is the single-instance lock. Elevation is obtained
 * by relaunching, and the relaunched process deliberately does *not* take the
 * lock: the unelevated instance has not finished releasing it when the elevated
 * one starts, and two windows racing for one lock is a worse failure than a
 * brief overlap. So a normal launch focuses the window that is already running,
 * and a relaunch starts alongside it for the second or two it takes the old one
 * to quit.
 */

import { app } from 'electron';
import { createTray, destroyTray, hasTray, refreshTrayMenu } from './desktop.js';
import { isElevated, isElevatedRelaunch, relaunchElevated } from './elevation.js';
import { initLog, logError, logInfo } from './logger.js';
import { writePidFile, removePidFile } from './pidfile.js';
import { disposeProbeHost, probeDir } from './probe.js';
import {
  applyDesktopPreferences,
  onWindowShown,
  pushState,
  quit,
  registerIpc,
  restartScanning,
  runScan,
  startScanning,
  stopScanning
} from './ipc.js';
import { getSettings } from './store.js';
import { applyThemePreference, createWindow, setThemeListener, showWindow, syncNativeTheme } from './window.js';
import path from 'node:path';

const elevatedRelaunch = isElevatedRelaunch();

if (!elevatedRelaunch && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // `app.whenReady()` is not optional decoration: creating a BrowserWindow before
  // it throws, and nothing else in this module is safe to touch either.
  void app
    .whenReady()
    .then(() => start())
    .catch((error: unknown) => {
      // The log may not exist yet if this failed very early, so this goes to the
      // console as well as the bounded log.
      logError(`Startup failed: ${(error as Error).message}`);
      console.error('Port Garden failed to start:', error);
      app.quit();
    });
}

app.on('second-instance', () => {
  showWindow();
});

async function start(): Promise<void> {
  // The log lives in the user profile even when elevated, so an elevated
  // instance writes where a normal one can read it.
  initLog(path.join(app.getPath('userData'), 'logs'));

  app.setAppUserModelId('dev.portgarden.app');

  applyDesktopPreferences();
  registerIpc();

  // Recorded so the instance can be found again. A tray-only window has no
  // window to match on, and Electron's executable path does not contain the app
  // name, so `MainWindowTitle` and command-line matching both miss it - which
  // leaves a running app that nothing can identify, including its own tooling.
  writePidFile();

  setThemeListener(() => {
    // This listener is *notified by* syncNativeTheme, so it must not call it:
    // that would notify itself and recurse. syncNativeTheme owns repainting the
    // native chrome; everything here is a side effect it triggers - telling the
    // renderer, and refreshing the tray menu whose "Relaunch as administrator"
    // item is enabled by the same state.
    pushState();
    refreshTrayMenu(trayActions);
  });

  const window = createWindow();
  window.on('show', () => onWindowShown());
  window.on('closed', () => {
    // Without a tray there would be no way to reach the app again, so there is
    // no point continuing to poll in the background.
    if (!hasTray()) stopScanning();
  });

  const trayActions = {
    onShow: () => showWindow(),
    onRefresh: () => void runScan(true),
    onRelaunchElevated: () => void relaunchElevated(),
    isElevated
  };
  createTray(trayActions);

  applyThemePreference(getSettings().theme);
  syncNativeTheme();

  startScanning();
  restartScanning();

  logInfo(`Port Garden ${app.getVersion()} started; probes in ${probeDir()}; elevated=${isElevated()}.`);
}

app.on('window-all-closed', () => {
  // With a tray the app keeps running and the window is simply gone; without one
  // there would be no way to reach it, so it quits.
  if (!hasTray()) app.quit();
});

app.on('before-quit', () => {
  quit();
});

app.on('will-quit', () => {
  stopScanning();
  destroyTray();
  removePidFile();
  // The probe host is a child process; leaving it behind would strand a pwsh.
  disposeProbeHost();
});

process.on('uncaughtException', (error) => {
  logError(`Uncaught exception: ${error.message}`);
});