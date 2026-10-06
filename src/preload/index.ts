/**
 * The only bridge between the renderer and the main process.
 *
 * Every method is a fixed channel with no caller-supplied channel name, and the
 * push subscription hands the renderer the payload only - never the Electron
 * event object, which carries a live `sender` the renderer has no business
 * holding.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { demoState } from '../shared/demo-data.js';
import type {
  AppState,
  ConfirmChoice,
  ConfirmKillRequest,
  GardenApi,
  HistoryEntry,
  HttpIdentity,
  KillOutcome,
  KillRequest,
  Settings,
  ThemePreference
} from '../shared/types.js';

/**
 * Demo mode for the documentation screenshot.
 *
 * The main process passes `--portgarden-demo` when `PORTGARDEN_DEMO=1` is set in
 * an unpackaged run. The decision lives here rather than in the page because
 * `exposeInMainWorld` defines a read-only property: a document cannot replace the
 * bridge, and it should not be able to. A page that could swap its own bridge is
 * a page that could pretend to be the app.
 */
const DEMO_MODE = process.argv.includes('--portgarden-demo');

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

function demoBridge(): GardenApi {
  const current = (): AppState => demoState(window.location.search.includes('theme=light') ? 'light' : 'dark');
  return {
    getState: async () => current(),
    rescan: async () => current(),
    setSettings: async () => current(),
    setTheme: async () => current(),
    togglePin: async () => current().settings,
    toggleProtect: async () => current().settings,
    confirmKill: async () => null,
    kill: async () => ({ ok: false, pid: 0, method: 'terminate', tree: false, code: 'cancelled', message: 'Sample data.' }),
    copy: async () => undefined,
    reveal: async () => false,
    identify: async () => null,
    capture: async () => null,
    openUrl: async () => false,
    relaunchElevated: async () => ({ ok: false, message: 'Sample data.' }),
    clearHistory: async () => [],
    // The demo is a still picture, so nothing is ever pushed.
    onState: () => () => undefined
  };
}

const liveBridge: GardenApi = {
  getState: (): Promise<AppState> => ipcRenderer.invoke('portgarden:get-state'),
  rescan: (): Promise<AppState> => ipcRenderer.invoke('portgarden:rescan'),
  setSettings: (patch: Partial<Settings>): Promise<AppState> => ipcRenderer.invoke('portgarden:set-settings', patch),
  setTheme: (theme: ThemePreference): Promise<AppState> => ipcRenderer.invoke('portgarden:set-settings', { theme }),
  togglePin: (port: number): Promise<Settings> => ipcRenderer.invoke('portgarden:toggle-pin', port),
  toggleProtect: (name: string): Promise<Settings> => ipcRenderer.invoke('portgarden:toggle-protect', name),
  confirmKill: (request: ConfirmKillRequest): Promise<ConfirmChoice> => ipcRenderer.invoke('portgarden:confirm-kill', request),
  kill: (request: KillRequest): Promise<KillOutcome> => ipcRenderer.invoke('portgarden:kill', request),
  copy: (text: string): Promise<void> => ipcRenderer.invoke('portgarden:copy', text),
  reveal: (path: string): Promise<boolean> => ipcRenderer.invoke('portgarden:reveal', path),
  identify: (request: { port: number; address: string; ownerKey: string; force?: boolean }): Promise<HttpIdentity | null> =>
    ipcRenderer.invoke('portgarden:identify', request),
  capture: (url: string): Promise<string | null> => ipcRenderer.invoke('portgarden:capture', { url }),
  openUrl: (url: string): Promise<boolean> => ipcRenderer.invoke('portgarden:open-url', { url }),
  relaunchElevated: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('portgarden:relaunch-elevated'),
  clearHistory: (): Promise<HistoryEntry[]> => ipcRenderer.invoke('portgarden:clear-history'),
  onState: (listener: (payload: AppState) => void) => subscribe('portgarden:state', listener)
};

contextBridge.exposeInMainWorld('portGarden', DEMO_MODE ? demoBridge() : liveBridge);