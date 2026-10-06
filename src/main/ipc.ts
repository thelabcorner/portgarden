/**
 * The renderer's entire channel surface.
 *
 * State is pushed, never polled. A scan finishing, a setting changing, a theme
 * changing and a process being killed all publish a full snapshot, and the
 * renderer simply applies whatever arrives. The one pull is the initial read at
 * startup; everything after that is an event.
 *
 * Two rules from the reference app are load-bearing here:
 *
 * - Nothing returns a secret, and nothing the renderer sends is trusted. Every
 *   destructive call re-derives its own authority in this process rather than
 *   believing the renderer's idea of who owns a pid.
 * - Every preference the OS or the user profile owns is reported as the OS
 *   reports it. A login item the OS refused is shown as refused.
 */

import { app, clipboard, dialog, ipcMain, shell } from 'electron';
import { existsSync } from 'node:fs';
import { performKill } from './control.js';
import { applyLaunchAtLogin, hasTray, readLaunchAtLogin } from './desktop.js';
import { isElevated, relaunchElevated } from './elevation.js';
import { logError, logInfo, logTail, logFilePath, logWarn } from './logger.js';
import { powerShellLabel, probeDir } from './probe.js';
import { applyPatch } from './settings.js';
import { clearHistory, detailIsInFlight, detailIsStale, getHistory, noteKill, refreshDetail, runFastScan } from './snapshot.js';
import { capturePort, identify, identitySnapshot, pruneIdentities } from './identify.js';
import { getSettings, saveSettings } from './store.js';
import {
  applyThemePreference,
  broadcast,
  closeWindowForQuit,
  isWindowVisible,
  releaseForQuit,
  resolvedTheme,
  setCanHideOnClose,
  setCloseToTray
} from './window.js';
import type {
  AppState,
  ConfirmChoice,
  ConfirmKillRequest,
  ConfirmTarget,
  KillMethod,
  KillRequest,
  Settings
} from '../shared/types.js';

export const STATE_CHANNEL = 'portgarden:state';

let lastScan: AppState['scan'] = null;
let scanning = false;
let refreshTimer: NodeJS.Timeout | null = null;
let pushQueued = false;

/** Long enough to batch a burst of changes, short enough to feel immediate. */
const PUSH_INTERVAL_MS = 80;

function stateSnapshot(): AppState {
  const settings = getSettings();
  return {
    scan: lastScan,
    settings,
    theme: resolvedTheme(),
    elevated: isElevated(),
    // Absence is stated rather than rendered as a column of blanks that look
    // like a bug: `-IncludeUserName` is unavailable in some session-0 contexts.
    ownersAvailable: lastScan?.stats.ownersAvailable ?? true,
    history: getHistory(),
    source: `Get-NetTCPConnection + Get-Process via ${powerShellLabel()}`,
    identities: identitySnapshot(),
    scanning,
    enriching: detailIsInFlight(),
    version: app.getVersion(),
    platform: process.platform,
    logPath: logFilePath(),
    logTail: logTail(),
    probeDir: probeDir()
  };
}

export function pushState(): void {
  if (pushQueued) return;
  pushQueued = true;
  setTimeout(() => {
    pushQueued = false;
    broadcast(STATE_CHANNEL, stateSnapshot());
  }, PUSH_INTERVAL_MS);
}

/**
 * Applies the parts of settings that are owned by the OS or the window shell.
 * Called on load and after every change, so there is exactly one code path for
 * "make the desktop match the preferences".
 */
export function applyDesktopPreferences(): void {
  const settings = getSettings();
  applyThemePreference(settings.theme);
  setCloseToTray(settings.closeToTray);
  setCanHideOnClose(hasTray());

  if (settings.launchAtLogin && !readLaunchAtLogin()) {
    const result = applyLaunchAtLogin(true);
    if (!result.applied) logError(`Login item could not be enabled: ${result.detail ?? 'the OS refused it.'}`);
  }
}

export async function runScan(forceDetail: boolean): Promise<AppState> {
  // A scan already in flight is not joined or duplicated; the next tick picks up
  // whatever changed, which keeps a slow probe from stacking up behind itself.
  if (scanning) return stateSnapshot();
  scanning = true;
  pushState();
  try {
    lastScan = await runFastScan(getSettings());
    if (lastScan.stats.errors.length > 0) logError(`Scan reported: ${lastScan.stats.errors.join('; ')}`);
    noteScanChange(lastScan);
  } catch (error) {
    logError(`Scan failed: ${(error as Error).message}`);
  } finally {
    scanning = false;
    pushState();
  }
  if (forceDetail || detailIsStale()) void kickDetail();
  return stateSnapshot();
}

let lastPortSignature = '';

/**
 * Logs when the set of listening ports changes, which is the only thing worth
 * writing on every tick.
 *
 * It doubles as the cheapest possible proof that the table is live: a log line
 * naming the ports that appeared is not something a failed probe could have
 * written.
 */
function noteScanChange(scan: AppState['scan']): void {
  if (!scan) return;
  const signature = scan.rows.map((row) => row.port).join(',');
  if (signature === lastPortSignature) return;
  const previous = lastPortSignature === '' ? 0 : lastPortSignature.split(',').length;
  lastPortSignature = signature;
  logInfo(
    `${scan.rows.length} listening port(s)${previous === 0 ? ' (first scan)' : `, was ${previous}`}; ` +
      `${scan.stats.processes} processes, ${scan.stats.durationMs} ms, ${scan.stats.listeners} sockets.`
  );
}

/**
 * Runs the slow tier out of band and publishes the enriched rows when they
 * land. Never awaited by the refresh loop: a caller that waits here is waiting
 * three seconds for a command line it does not need yet.
 */
function kickDetail(): void {
  void refreshDetail(getSettings())
    .then((scan) => {
      if (!scan) return;
      lastScan = scan;
      if (scan.stats.errors.length > 0) logError(`Detail tier reported: ${scan.stats.errors.join('; ')}`);
      pushState();
      kickIdentify(scan);
    })
    .catch((error: unknown) => logError(`Detail tier failed: ${(error as Error).message}`));
}

/**
 * Identifies what the obvious candidates are serving.
 *
 * Scoped to dev servers on purpose. Probing every listening port would mean a
 * hundred HTTP requests per scan against sockets that are mostly databases,
 * Windows services and language servers - which would be both slow and rude. A
 * dev server is the case where "what is this" is actually in question, and there
 * are usually a handful of them.
 *
 * Runs after the detail tier so the process identity is known, is cached per
 * process, and never blocks a scan.
 */
function kickIdentify(scan: NonNullable<AppState['scan']>): void {
  const candidates = scan.rows
    .map((row) => ({ row, owner: row.processes[0] }))
    .filter((entry) => entry.owner !== undefined && entry.owner.role === 'dev-server')
    .slice(0, IDENTIFY_LIMIT);
  if (candidates.length === 0) return;

  pruneIdentities(scan.rows.map((row) => row.port));

  for (const { row, owner } of candidates) {
    if (!owner) continue;
    const ownerKey = `${owner.pid}:${owner.createdAt ?? ''}`;
    const target = { port: row.port, address: row.bindings[0]?.address ?? 'any' };
    void identify(target, ownerKey)
      .then((identity) => {
        if (identity.state === 'checking') return;
        pushState();
      })
      .catch((error: unknown) => logWarn(`Identify of port ${row.port} failed: ${(error as Error).message}`));
  }
}

const IDENTIFY_LIMIT = 6;

/**
 * The refresh loop.
 *
 * Deliberately two-phase. Measured on the development machine, the fast tier is
 * ~2.5s and the detail tier ~3.2s, of which ~2.8s is an irreducible WMI
 * provider start-up. Awaiting both would put a five-and-a-half second stall in
 * front of a table that refreshes every few seconds. Instead each tick
 * publishes the ports and processes it does have, and the enrichment lands as a
 * second push whenever it finishes.
 */
export function startScanning(): void {
  stopScanning();
  void runScan(true);
}

export function stopScanning(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
}

export function restartScanning(): void {
  const settings = getSettings();
  stopScanning();
  if (!settings.autoRefresh) return;
  const tick = async (): Promise<void> => {
    await runScan(false);
    // The slow tier needs its own cadence. Waiting for it inside the tick would
    // double the interval and block the table behind a command line.
    if (settings.autoRefresh) void kickDetail();
    if (!getSettings().autoRefresh) return;
    refreshTimer = setTimeout(() => void tick(), getSettings().refreshMs);
  };
  refreshTimer = setTimeout(() => void tick(), settings.refreshMs);
}

export function onWindowShown(): void {
  // Coming back from the tray should show current data, not the state at the
  // moment it was hidden.
  if (isWindowVisible()) void runScan(false);
  pushState();
}

export function quit(): void {
  releaseForQuit();
  stopScanning();
  closeWindowForQuit();
}

/**
 * The native confirmation.
 *
 * A web dialog would be quicker to write, but this is a destructive action on
 * somebody's machine and it deserves a real Win32 message box - which is also
 * where a protected process's extra friction belongs. The dialog enumerates what
 * is about to be signalled rather than asking a bare yes/no, because "are you
 * sure" is not information.
 */
async function confirmKill(targets: ConfirmTarget[], method: KillMethod): Promise<ConfirmChoice> {
  if (targets.length === 0) return null;

  const hasProtected = targets.some((target) => target.protected);
  const first = targets[0]!;

  if (method === 'close') {
    const result = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Close', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Close process',
      message: targets.length === 1 ? `Close ${first.name} (pid ${first.pid})?` : `Close ${targets.length} processes?`,
      detail: describe(targets, 'Close', false)
    });
    return result.response === 0 ? 'close' : null;
  }

  if (hasProtected) {
    const result = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Unprotect and terminate', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Protected process',
      message: `${first.name} is on the protect list. Terminate anyway?`,
      detail: `${describe(targets, 'Terminate', true)}\n\nProtected processes include databases and container runtimes, where a forced termination can mean data loss.`
    });
    return result.response === 0 ? 'unprotect-and-terminate' : null;
  }

  const result = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['Terminate', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    title: 'Terminate process',
    message: targets.length === 1 ? `Force-terminate ${first.name} (pid ${first.pid})?` : `Force-terminate ${targets.length} processes?`,
    detail: describe(targets, 'Terminate', false)
  });
  return result.response === 0 ? 'terminate' : null;
}

function describe(targets: ConfirmTarget[], verb: string, includeCommandLine: boolean): string {
  const lines: string[] = [];
  for (const target of targets.slice(0, 6)) {
    const owner = target.owner ? ` · ${target.owner}` : '';
    const children = target.descendants.length > 0 ? ` · ${target.descendants.length} child process(es)` : '';
    lines.push(`${verb} ${target.name} on port ${target.port} (pid ${target.pid}${owner}${children})`);
  }
  if (targets.length > 6) lines.push(`…and ${targets.length - 6} more.`);
  if (verb === 'Terminate') {
    lines.push('', 'Force termination is immediate and cannot be caught by the process. Windows will also end its child processes at that moment, which may differ from the count above.');
  } else {
    lines.push('', 'Close asks the process to shut down through its window. A process without a window - a console or headless server - will refuse, and nothing will be terminated.');
  }
  if (includeCommandLine) {
    const command = targets[0]?.commandLine;
    if (command) lines.push('', `Command line: ${command}`);
  }
  return lines.join('\n');
}

export function registerIpc(): void {
  ipcMain.handle('portgarden:get-state', () => stateSnapshot());

  // A manual rescan always forces the detail tier: the user pressed a button, and
  // making them wait for a scheduled refresh would read as a dead click.
  ipcMain.handle('portgarden:rescan', () => runScan(true));

  ipcMain.handle('portgarden:set-settings', (_event, patch: unknown) => {
    const next: Settings = saveSettings(applyPatch(getSettings(), patch));
    setCloseToTray(next.closeToTray);
    setCanHideOnClose(hasTray());
    if ('launchAtLogin' in (patch as Record<string, unknown>)) {
      const result = applyLaunchAtLogin(next.launchAtLogin);
      if (!result.applied && next.launchAtLogin) logError(result.detail ?? 'The OS refused the login item.');
    }
    if ('theme' in (patch as Record<string, unknown>)) applyThemePreference(next.theme);
    if ('refreshMs' in (patch as Record<string, unknown>) || 'autoRefresh' in (patch as Record<string, unknown>)) restartScanning();
    pushState();
    return stateSnapshot();
  });

  ipcMain.handle('portgarden:toggle-pin', (_event, port: unknown) => {
    const value = typeof port === 'number' ? port : 0;
    const current = getSettings();
    const pins = current.pins.includes(value) ? current.pins.filter((entry) => entry !== value) : [...current.pins, value];
    const next = saveSettings(applyPatch(current, { pins }));
    pushState();
    return next;
  });

  ipcMain.handle('portgarden:toggle-protect', (_event, name: unknown) => {
    const value = typeof name === 'string' ? name.trim().toLowerCase().replace(/\.exe$/, '') : '';
    if (!value) return getSettings();
    const current = getSettings();
    const protect = current.protect.includes(value)
      ? current.protect.filter((entry) => entry !== value)
      : [...current.protect, value];
    const next = saveSettings(applyPatch(current, { protect }));
    pushState();
    return next;
  });

  ipcMain.handle('portgarden:confirm-kill', (_event, payload: unknown) => {
    const body = (payload ?? {}) as Partial<ConfirmKillRequest>;
    const method: KillMethod = body.method === 'close' ? 'close' : 'terminate';
    return confirmKill(Array.isArray(body.targets) ? body.targets : [], method);
  });

  ipcMain.handle('portgarden:kill', async (_event, payload: unknown) => {
    const body = (payload ?? {}) as Partial<KillRequest> & { port?: number; projectName?: string | null };
    const request: KillRequest = {
      pid: typeof body.pid === 'number' ? body.pid : 0,
      identity: body.identity ?? { pid: 0, createdAt: null, image: null },
      method: body.method === 'close' ? 'close' : 'terminate',
      allowProtected: body.allowProtected === true
    };
    const outcome = await performKill(request);
    if (outcome.ok) {
      const ports = typeof body.port === 'number' ? [body.port] : [];
      for (const port of ports) {
        noteKill({
          at: Date.now(),
          port,
          pid: request.pid,
          name: request.identity.image ?? `pid ${request.pid}`,
          projectName: typeof body.projectName === 'string' ? body.projectName : null,
          reason: request.method === 'close' ? 'closed' : 'terminated'
        });
      }
      logInfo(`${request.method === 'close' ? 'Closed' : 'Terminated'} pid ${request.pid} at the user's request.`);
    }
    // The system will have changed either way, so the table is refreshed rather
    // than patched optimistically.
    void runScan(true);
    void kickDetail();
    pushState();
    return outcome;
  });

  /**
   * Identifies a port on demand, for the row the user is looking at whether or
   * not it looked like a dev server.
   */
  ipcMain.handle('portgarden:identify', async (_event, payload: unknown) => {
    const body = (payload ?? {}) as { port?: number; address?: string; ownerKey?: string; force?: boolean };
    const port = typeof body.port === 'number' ? body.port : 0;
    if (port <= 0) return null;
    const result = await identify(
      { port, address: typeof body.address === 'string' ? body.address : 'any' },
      typeof body.ownerKey === 'string' ? body.ownerKey : 'unknown',
      body.force === true
    );
    pushState();
    return result;
  });

  /**
   * Captures a picture of what the port is serving. Returns a data URL, and
   * deliberately does not publish it into the shared state - see the note on
   * `AppState.identities`.
   */
  ipcMain.handle('portgarden:capture', async (_event, payload: unknown) => {
    const body = (payload ?? {}) as { url?: string };
    const url = typeof body.url === 'string' ? body.url : '';
    if (url === '') return null;
    const image = await capturePort(url);
    pushState();
    return image;
  });

  /**
   * Opens an identified address in the user's own browser.
   *
   * Restricted to loopback over http(s): the renderer may only ask the shell to
   * open the address of a local service it identified, never an arbitrary URL it
   * happens to hold.
   */
  ipcMain.handle('portgarden:open-url', async (_event, payload: unknown) => {
    const body = (payload ?? {}) as { url?: string };
    const url = typeof body.url === 'string' ? body.url : '';
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(url)) {
      logWarn(`Refused to open a non-loopback address: ${url}`);
      return false;
    }
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle('portgarden:copy', (_event, text: unknown) => {
    if (typeof text === 'string') clipboard.writeText(text);
  });

  ipcMain.handle('portgarden:reveal', (_event, target: unknown) => {
    const value = typeof target === 'string' ? target : '';
    if (!value || !existsSync(value)) return false;
    shell.showItemInFolder(value);
    return true;
  });

  ipcMain.handle('portgarden:relaunch-elevated', async () => {
    const result = await relaunchElevated();
    pushState();
    return result;
  });

  ipcMain.handle('portgarden:clear-history', () => {
    clearHistory();
    pushState();
    return getHistory();
  });
}

