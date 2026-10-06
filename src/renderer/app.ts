/**
 * The window shell: title bar, navigation, theme badge and the command menu.
 *
 * State arrives by push only. `onState` delivers a full snapshot whenever a scan
 * finishes, a setting changes or a process is ended; nothing here polls. The one
 * interval re-renders the active view so relative ages ("2m") stay honest, and it
 * reads the snapshot already in hand without touching IPC.
 */

import { el, icon, on, setAttr, setClass, setText } from './dom.js';
import { api } from './bridge.js';
import { button, iconButton } from './ui.js';
import { historyView, portsView, settingsView, type Ctx, type View } from './views.js';
import type { AppState, Settings } from '../shared/types.js';

type ViewId = 'ports' | 'history' | 'settings';

interface NavEntry {
  id: ViewId;
  label: string;
  iconName: string;
  shortcut: string;
  count?: (state: AppState) => number;
}

const NAV: NavEntry[] = [
  { id: 'ports', label: 'Ports', iconName: 'network', shortcut: '1', count: (state) => state.scan?.rows.length ?? 0 },
  { id: 'history', label: 'History', iconName: 'clock', shortcut: '2', count: (state) => state.history.length },
  { id: 'settings', label: 'Settings', iconName: 'settings', shortcut: '3' }
];

export function mount(root: HTMLElement): void {
  let state: AppState | null = null;
  let active: ViewId = 'ports';

  /* ------------------------------------------------------------- feedback */

  const toasts = el('div', { class: 'toasts' });

  function toast(message: string, kind: 'info' | 'error' = 'info'): void {
    const node = el(
      'div',
      { class: kind === 'error' ? 'toast error' : 'toast', role: 'status' },
      icon(kind === 'error' ? 'alert' : 'check', 14),
      el('div', { class: 'toast-text', text: message })
    );
    toasts.appendChild(node);
    setTimeout(() => node.remove(), kind === 'error' ? 9000 : 4500);
  }

  function run(work: () => Promise<unknown>): void {
    void work().then(
      (result) => {
        // Handlers reply with a fresh snapshot. Applying it here makes the click
        // feel immediate rather than waiting for the push already in flight.
        if (result !== null && typeof result === 'object' && 'scan' in result && 'settings' in result) {
          applyState(result as AppState);
        }
      },
      (error: unknown) => toast(error instanceof Error ? error.message : String(error), 'error')
    );
  }

  const ctx: Ctx = { run, toast, navigate: (id) => navigate(id as ViewId), state: () => state ?? fallbackState() };

  /* ---------------------------------------------------------------- views */

  const views: Record<ViewId, View> = {
    ports: portsView(ctx),
    history: historyView(ctx),
    settings: settingsView(ctx)
  };

  const main = el('main', { class: 'main' });
  for (const view of Object.values(views)) {
    view.node.style.display = 'none';
    main.appendChild(view.node);
  }

  /* --------------------------------------------------------------- chrome */

  const navButtons = new Map<ViewId, { node: HTMLButtonElement; count: HTMLElement }>();
  const nav = el('nav', { class: 'nav', 'aria-label': 'Sections' });
  for (const entry of NAV) {
    const count = el('span', { class: 'count' });
    count.hidden = true;
    const node = el(
      'button',
      { class: 'nav-item', type: 'button' },
      icon(entry.iconName, 14),
      el('span', { class: 'label', text: entry.label }),
      count,
      el('span', { class: 'kbd', text: entry.shortcut })
    );
    on(node, 'click', () => navigate(entry.id));
    navButtons.set(entry.id, { node, count });
    nav.appendChild(node);
  }

  const rescanButton = iconButton('refresh', 'Rescan now', () => run(() => api.rescan()));
  const themeButton = iconButton('activity', 'Switch theme', () => void cycleTheme());
  const commandButton = button('Command menu', { variant: 'ghost', iconName: 'search', onClick: () => openCommands() });

  const sidebar = el(
    'aside',
    { class: 'sidebar' },
    el('div', { class: 'nav-label', text: 'Garden' }),
    nav,
    el(
      'div',
      { class: 'sidebar-foot' },
      commandButton,
      button('Rescan now', { variant: 'ghost', iconName: 'refresh', onClick: () => run(() => api.rescan()) })
      // The "Administrator" button is owned by applySidebar, not built here: it
      // has to appear and disappear as elevation changes, and a second copy
      // built inline meant a non-elevated run rendered two of them.
    )
  );

  const statusDot = el('span', { class: 'dot' });
  const statusLabel = el('span', { class: 'label', text: 'Starting…' });
  const statusPill = el('div', { class: 'status-pill', role: 'status' }, statusDot, statusLabel);
  const elevBadge = el('span', { class: 'badge admin' }, icon('shield', 11), el('span', { text: 'Admin' }));
  elevBadge.hidden = true;
  const brandTitle = el('div', { class: 'title', text: 'Port Garden' });
  const titlebar = el(
    'header',
    { class: 'titlebar' },
    el('div', { class: 'brand' }, el('div', { class: 'mark', text: 'PG' }), brandTitle),
    elevBadge,
    el('div', { class: 'drag-filler' }),
    themeButton,
    rescanButton,
    statusPill
  );

  root.replaceChildren(el('div', { class: 'app' }, titlebar, el('div', { class: 'body' }, sidebar, main)), toasts);

  reserveCaptionArea(titlebar);

  /* ----------------------------------------------------------- navigation */

  function navigate(id: ViewId): void {
    active = id;
    for (const [viewId, view] of Object.entries(views) as Array<[ViewId, View]>) {
      view.node.style.display = viewId === id ? '' : 'none';
    }
    for (const [viewId, entry] of navButtons) setAttr(entry.node, 'aria-current', viewId === id ? 'page' : null);
    if (state) views[id].update(state);
  }

  /* ----------------------------------------------------------------- theme */

  async function cycleTheme(): Promise<void> {
    if (!state) return;
    const order: Settings['theme'][] = ['system', 'light', 'dark'];
    const next = order[(order.indexOf(state.settings.theme) + 1) % order.length]!;
    await api.setTheme(next);
    toast(`Theme: ${next}.`);
  }

  /**
   * Applies the resolved theme to the document.
   *
   * `system` maps to whatever the OS reports, which the main process resolves -
   * it owns `nativeTheme` and is therefore the only place that knows. The
   * renderer never guesses at `prefers-color-scheme`.
   */
  function applyTheme(state: AppState): void {
    const dark = state.theme === 'dark';
    document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
    setAttr(themeButton, 'title', `Theme: ${state.settings.theme}. Click to change.`);
  }

  /* ----------------------------------------------------------------- state */

  function applyState(next: AppState): void {
    const previous = state;
    state = next;
    views[active].update(next);
    applyTheme(next);

    if (previous === null || previous.elevated !== next.elevated || previous.scan?.stats.degraded !== next.scan?.stats.degraded) {
      // The elevation badge and the Administrator shortcut are built in the
      // sidebar footer, so they follow state rather than being rebuilt per scan.
      applySidebar(next);
    }

    const degraded = next.scan?.stats.degraded === true;
    setClass(statusDot, `dot ${next.scanning || next.enriching ? 'busy' : degraded ? 'error' : 'ok'}`);
    setText(
      statusLabel,
      next.scan === null
        ? 'Reading the system…'
        : next.enriching
          ? `${next.scan.rows.length} ports · resolving command lines…`
          : `${next.scan.rows.length} port${next.scan.rows.length === 1 ? '' : 's'} · ${next.scan.stats.durationMs} ms`
    );
    setAttr(statusPill, 'title', next.scan === null ? 'First scan in progress' : `${next.source} — updated ${new Date(next.scan.at).toLocaleTimeString()}`);

    elevBadge.hidden = !next.elevated;

    for (const entry of NAV) {
      const target = navButtons.get(entry.id);
      if (!target || !entry.count) continue;
      const value = entry.count(next);
      target.count.hidden = value === 0;
      setText(target.count, String(value));
    }
  }

  function applySidebar(next: AppState): void {
    const foot = sidebar.querySelector('.sidebar-foot') as HTMLElement;
    const existing = foot.querySelector('[data-admin]') as HTMLElement | null;
    if (next.elevated) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const node = button('Administrator', {
      variant: 'ghost',
      iconName: 'shield',
      title: 'Restart with administrator rights to see and act on processes you do not own.',
      onClick: () => void api.relaunchElevated().then((result) => toast(result.message, result.ok ? 'info' : 'error'))
    });
    node.dataset['admin'] = '1';
    foot.appendChild(node);
  }

  /* --------------------------------------------------------------- command */

  let commandOverlay: HTMLElement | null = null;

  function commands(): Array<{ label: string; hint?: string; run: () => void }> {
    const current = state;
    return [
      ...NAV.map((entry) => ({ label: `Go to ${entry.label}`, hint: 'View', run: () => navigate(entry.id) })),
      { label: 'Rescan now', hint: 'Ports', run: () => run(() => api.rescan()) },
      {
        label: 'Toggle theme',
        hint: 'Appearance',
        run: () => void cycleTheme()
      },
      current === null || current.elevated
        ? { label: 'Already running as administrator', hint: 'Ports', run: () => undefined }
        : {
            label: 'Relaunch as administrator',
            hint: 'Ports',
            run: () => void api.relaunchElevated().then((result) => toast(result.message, result.ok ? 'info' : 'error'))
          },
      { label: 'Clear history', hint: 'History', run: () => run(() => api.clearHistory()) }
    ];
  }

  function openCommands(): void {
    if (commandOverlay) return;
    const all = commands();
    let matches = all;
    let index = 0;

    const input = el('input', { class: 'command-input', placeholder: 'Type a command…', 'aria-label': 'Command menu' });
    const list = el('div', { class: 'command-list scroll', role: 'listbox' });

    const paint = (): void => {
      list.replaceChildren(
        ...matches.map((command, position) =>
          el(
            'button',
            { class: 'command-item', type: 'button', role: 'option', 'data-active': position === index ? 'true' : 'false' },
            icon('play', 11),
            el('span', { text: command.label }),
            command.hint ? el('span', { class: 'hint', text: command.hint }) : null
          )
        )
      );
      if (matches.length === 0) list.replaceChildren(el('div', { class: 'log-empty', text: 'No matching command.' }));
      const items = Array.from(list.querySelectorAll<HTMLElement>('.command-item'));
      items.forEach((item, position) => {
        on(item, 'click', () => {
          close();
          matches[position]?.run();
        });
        on(item, 'mousemove', () => {
          if (index === position) return;
          index = position;
          paint();
        });
      });
    };

    const close = (): void => {
      commandOverlay?.remove();
      commandOverlay = null;
    };

    on(input, 'input', () => {
      const needle = input.value.trim().toLowerCase();
      matches = needle === '' ? all : all.filter((command) => command.label.toLowerCase().includes(needle));
      index = 0;
      paint();
    });
    on(input, 'keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        index = Math.min(matches.length - 1, index + 1);
        paint();
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        index = Math.max(0, index - 1);
        paint();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const chosen = matches[index];
        if (!chosen) return;
        close();
        chosen.run();
      }
    });

    const panel = el('div', { class: 'command', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command menu' }, input, list);
    commandOverlay = el('div', { class: 'overlay' }, panel);
    on(commandOverlay, 'pointerdown', (event) => {
      if (event.target === commandOverlay) close();
    });
    document.body.appendChild(commandOverlay);
    paint();
    input.focus();
  }

  /* ------------------------------------------------------------ shortcuts */

  on(document.body, 'keydown', (event) => {
    const accel = event.ctrlKey;
    if (accel && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openCommands();
      return;
    }
    if (commandOverlay) return;
    if (accel && event.key.toLowerCase() === 'r') {
      event.preventDefault();
      run(() => api.rescan());
      return;
    }
    if (accel && /^[1-3]$/.test(event.key)) {
      const entry = NAV[Number(event.key) - 1];
      if (entry) {
        event.preventDefault();
        navigate(entry.id);
      }
    }
  });

  /* ------------------------------------------------------------ bootstrap */

  navigate('ports');

  // Subscribe before the first read. A state push between the two would otherwise
  // be lost, and applying the newer snapshot afterwards is idempotent.
  api.onState((next) => applyState(next));

  void api
    .getState()
    .then(applyState)
    .catch((error: unknown) => toast(`Could not read the current state: ${String(error)}`, 'error'));

  // Relative times age between pushes. This calls the view's cheap `tick` - which
  // rewrites the age cells and nothing else - rather than a full update. Running
  // `update` here rebuilt every row once a second, which is what made the table
  // feel heavy and reset the scroll position for anyone reading further down.
  setInterval(() => {
    if (state) views[active].tick?.(state);
  }, 1000);
}

/** Only ever reached before the first snapshot arrives. */
function fallbackState(): AppState {
  return {
    scan: null,
    settings: {
      refreshMs: 2000,
      autoRefresh: true,
      theme: 'system',
      protect: [],
      pins: [],
      closeToTray: true,
      launchAtLogin: false
    },
    elevated: false,
    ownersAvailable: false,
    history: [],
    identities: {},
    source: 'starting',
    scanning: true,
    enriching: false,
    version: '',
    platform: 'win32',
    logPath: '',
    logTail: [],
    probeDir: '',
    theme: 'dark'
  };
}

/**
 * On Windows the caption buttons are drawn over the top-right of the renderer.
 * Reserve exactly the space the platform reports, and re-reserve it when the
 * window is maximised or the DPI changes, so the status pill never ends up under
 * the close button.
 */
function reserveCaptionArea(titlebar: HTMLElement): void {
  const overlay = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay }).windowControlsOverlay;
  if (!overlay) return;
  const apply = (): void => {
    if (!overlay.visible) {
      titlebar.style.paddingRight = '';
      return;
    }
    const rect = overlay.getTitlebarAreaRect();
    titlebar.style.paddingRight = `${Math.max(0, Math.round(window.innerWidth - rect.right) + 8)}px`;
  };
  overlay.addEventListener('geometrychange', apply);
  window.addEventListener('resize', apply);
  apply();
}

/** `navigator.windowControlsOverlay` is not in the DOM lib this project compiles against. */
interface WindowControlsOverlay {
  visible: boolean;
  getTitlebarAreaRect(): DOMRect;
  addEventListener(type: 'geometrychange', listener: () => void): void;
}