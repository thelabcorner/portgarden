/**
 * Window lifetime, and the three places a theme change has to land.
 *
 * The reference app documents this problem and then ships dark-only: its CSS
 * comment notes that a light theme means coordinating the renderer, the window
 * background and the Windows caption overlay. This app ships both themes, so all
 * three are wired here:
 *
 *   1. `nativeTheme.themeSource` decides whether the renderer is light or dark.
 *   2. `setBackgroundColor` repaints the window before the renderer exists, so
 *      there is no white flash when a light theme opens on a dark desktop.
 *   3. `setTitleBarOverlay` recolours the caption buttons, which otherwise stay
 *      zinc-400 and become unreadable on a white title bar.
 *
 * No vibrancy, no transparency, no blur. The brief is a macOS-*styled* Windows
 * app, and the native feel here comes from behaviour - real caption buttons,
 * real menus, real dialogs - not from glass.
 */

import { app, BrowserWindow, nativeTheme, shell } from 'electron';
import path from 'node:path';
import type { ThemePreference } from '../shared/types.js';
import { logError, logInfo, logWarn } from './logger.js';
import { createTrayBitmap } from './tray-icon.js';

const TITLE_BAR_HEIGHT = 34;

/** The shadcn zinc endpoints the chrome has to match, as hex. */
const DARK_BACKGROUND = '#09090b';
const LIGHT_BACKGROUND = '#ffffff';
const DARK_SYMBOLS = '#a1a1aa';
const LIGHT_SYMBOLS = '#52525b';

export type ResolvedTheme = 'light' | 'dark';

let window: BrowserWindow | null = null;
let quitting = false;
let closeToTray = false;
let canHideOnClose = false;
let onThemeChange: ((theme: ResolvedTheme) => void) | null = null;

export function setCloseToTray(value: boolean): void {
  closeToTray = value;
}

/** The tray is optional; hiding on close is only ever allowed when one exists. */
export function setCanHideOnClose(value: boolean): void {
  canHideOnClose = value;
}

export function releaseForQuit(): void {
  quitting = true;
}

export function setThemeListener(listener: (theme: ResolvedTheme) => void): void {
  onThemeChange = listener;
}

export function resolvedTheme(): ResolvedTheme {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

/**
 * Applies the user's preference to the OS-level theme source. `system` is the
 * default, so the app follows Windows light/dark until the user overrides it.
 */
export function applyThemePreference(theme: ThemePreference): void {
  nativeTheme.themeSource = theme;
}

export function themeColors(theme: ResolvedTheme): { background: string; symbols: string } {
  return theme === 'dark'
    ? { background: DARK_BACKGROUND, symbols: DARK_SYMBOLS }
    : { background: LIGHT_BACKGROUND, symbols: LIGHT_SYMBOLS };
}

/** Repaints the native chrome for the resolved theme. Called on every change. */
export function syncNativeTheme(): void {
  const colors = themeColors(resolvedTheme());
  const target = window && !window.isDestroyed() ? window : null;
  if (target) {
    try {
      target.setBackgroundColor(colors.background);
      target.setTitleBarOverlay({ color: colors.background, symbolColor: colors.symbols, height: TITLE_BAR_HEIGHT });
    } catch {
      // A window destroyed mid-change is an ordinary outcome, not an error.
    }
  }
  onThemeChange?.(resolvedTheme());
}

/**
 * Whether this run is the documentation demo.
 *
 * Guarded on `!app.isPackaged` as well as the variable, so a packaged build can
 * never be talked into rendering fabricated rows: a port tool that could show
 * invented data would have failed at the one thing it is for. The flag reaches
 * the renderer through `additionalArguments`, because the preload decides what
 * the bridge is and the preload runs before the page.
 */
export function isDemoMode(): boolean {
  return !app.isPackaged && process.env['PORTGARDEN_DEMO'] === '1';
}

export function createWindow(): BrowserWindow {
  if (window && !window.isDestroyed()) return window;

  const theme = resolvedTheme();
  const colors = themeColors(theme);

  const created = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'Port Garden',
    backgroundColor: colors.background,
    autoHideMenuBar: true,
    icon: createTrayBitmap(32),
    // Windows-only product, so the caption-overlay chrome is unconditional
    // rather than a per-platform branch.
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: colors.background, symbolColor: colors.symbols, height: TITLE_BAR_HEIGHT },
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Read by the preload, which chooses between the live bridge and the demo
      // stub. It cannot come from the page: `exposeInMainWorld` defines a
      // read-only property, so a document cannot replace its own bridge.
      ...(isDemoMode() ? { additionalArguments: ['--portgarden-demo'] } : {})
    }
  });

  window = created;

  created.once('ready-to-show', () => created.show());
  created.on('close', (event) => {
    if (quitting || !closeToTray || !canHideOnClose) return;
    // Never let the app reach a state with a tray but no reachable window.
    event.preventDefault();
    created.hide();
  });
  created.on('closed', () => {
    if (window === created) window = null;
  });
  created.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  created.webContents.on('will-navigate', (event, url) => {
    if (url !== created.webContents.getURL()) event.preventDefault();
  });

  /*
   * Showing the window.
   *
   * `ready-to-show` normally means "the first paint is done, so showing now will
   * not flash a blank frame". It is the right moment - but it is a *signal from
   * the renderer*, and if the renderer never gets there, nothing ever shows and
   * the app runs invisibly behind its tray icon. That is the worst outcome
   * available, so the timer is the real guarantee and the event is the
   * optimisation: whichever arrives first shows the window.
   *
   * A hidden window is also indistinguishable from a crash to the user, so the
   * fallback logs rather than passing silently.
   */
  let shown = false;
  const reveal = (reason: string): void => {
    if (shown || created.isDestroyed()) return;
    shown = true;
    created.show();
    logInfo(`Window shown (${reason}).`);
  };
  created.once('ready-to-show', () => reveal('first paint'));
  const revealTimer = setTimeout(() => {
    if (shown) return;
    logWarn('The renderer did not report a first paint within 6s; showing the window anyway.');
    reveal('timeout');
  }, 6000);
  created.on('closed', () => clearTimeout(revealTimer));

  // The failure modes that produce "the window never appeared", each named
  // rather than left to be inferred from silence.
  created.webContents.on('did-fail-load', (_event, code, description, url) => {
    logError(`Renderer failed to load ${url}: ${description} (${code})`);
    reveal('load failure');
  });
  created.webContents.on('render-process-gone', (_event, details) => {
    logError(`Renderer process gone: ${details.reason} (exit ${details.exitCode})`);
  });
  /*
   * Renderer warnings and errors are forwarded into the bounded log.
   *
   * This is the only way a renderer that throws during module evaluation becomes
   * visible at all: without it the window simply never paints and nothing
   * anywhere says why.
   *
   * Electron 43 declares two shapes - a legacy
   * `(event, level, message, line, sourceId)` and a newer details object - and
   * which one arrives at runtime is decided by the handler's arity, not by what
   * the type declarations resolve to. The previous version read `details.level`
   * while Electron was sending a bare number, so every message was silently
   * dropped and a blank window had no explanation anywhere. Both are handled.
   */
  const contents = created.webContents as unknown as {
    on(event: 'console-message', listener: (...args: unknown[]) => void): void;
  };
  contents.on('console-message', (...args: unknown[]) => {
    const second = args[1];
    let level = 0;
    let message = '';
    if (typeof second === 'number') {
      // Legacy shape: (event, level, message, line, sourceId)
      level = second;
      message = String(args[2] ?? '');
    } else if (second !== null && typeof second === 'object') {
      const details = second as { level?: unknown; message?: unknown };
      level = typeof details.level === 'number' ? details.level : 0;
      message = typeof details.message === 'string' ? details.message : '';
    }
    if (level >= 2 && message !== '') logWarn(`renderer ${level >= 3 ? 'error' : 'warning'}: ${message}`);
  });

  nativeTheme.on('updated', syncNativeTheme);

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    // The documentation demo, for capturing screenshots without publishing a
    // real machine's process list. Guarded on `!app.isPackaged` as well as the
    // variable, so a packaged build cannot be talked into rendering fabricated
    // rows: a port tool that could ever show invented data would have failed at
    // the one thing it is for.
    const demo = isDemoMode();
    const target = demo ? `${devUrl.replace(/\/$/, '')}/demo.html` : devUrl;
    logInfo(`Loading the renderer from ${target}${demo ? ' (demo mode, sample data)' : ''}.`);
    created.webContents.loadURL(target).catch((error: unknown) => {
      logError(`Could not load ${target}: ${(error as Error).message}`);
      reveal('load failure');
    });
  } else {
    const file = path.join(__dirname, '../renderer/index.html');
    created.webContents.loadFile(file).catch((error: unknown) => {
      logError(`Could not load ${file}: ${(error as Error).message}`);
      reveal('load failure');
    });
  }
  return created;
}

export function getWindow(): BrowserWindow | null {
  return window && !window.isDestroyed() ? window : null;
}

export function isWindowVisible(): boolean {
  const target = getWindow();
  return target !== null && target.isVisible();
}

export function showWindow(): void {
  const target = window && !window.isDestroyed() ? window : createWindow();
  if (!target.isMinimized()) target.restore();
  target.show();
  target.focus();
}

export function closeWindowForQuit(): void {
  releaseForQuit();
  if (window && !window.isDestroyed()) window.destroy();
  window = null;
}

/**
 * Fire-and-forget push. Sends are routinely attempted during teardown - log
 * lines are broadcast while the window is being destroyed - so a missing target
 * is expected here rather than exceptional.
 */
export function broadcast(channel: string, payload: unknown): void {
  const target = getWindow();
  if (!target) return;
  try {
    target.webContents.send(channel, payload);
  } catch {
    // The window went away between the check and the send.
  }
}