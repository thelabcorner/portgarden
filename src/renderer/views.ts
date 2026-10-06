/**
 * The three views, and the row builders behind them.
 *
 * The governing rule is that a row is created once and then only ever has its
 * *text* updated. Rows are not rebuilt, action buttons are not recreated, and the
 * table element is never replaced.
 *
 * That is not tidiness, it is the difference between a table that works and one
 * that does not:
 *
 *   - Replacing the scroll container on every scan resets `scrollTop`, so a user
 *     reading row 80 is thrown back to the top every few seconds. That was a real
 *     bug in the first version.
 *   - Rebuilding the action cluster per row per paint allocated roughly 500 DOM
 *     nodes a second, which is what made the window feel heavy. The handlers now
 *     resolve the row from the current scan at click time, so a button is created
 *     once and stays correct as its row's data changes.
 *   - The one-second tick that keeps relative ages honest only rewrites the age
 *     cell. It does not repaint the table.
 */

import { append, el, icon, on, reconcile, setAttr, setHidden, setText } from './dom.js';
import { button, card, describeBindings, emptyState, facts, formatAge, formatAgeLong, formatBytes, iconButton, roleLabel, stat } from './ui.js';
import { createScrollView } from './scroll-view.js';
import { api } from './bridge.js';
import { inReservedRange } from '../main/parse.js';
import { DEFAULT_PROTECT, REFRESH_CHOICES } from '../main/settings.js';
import type { AppState, ConfirmTarget, KillMethod, PortRow, ProcessInfo, ScanResult, ThemePreference } from '../shared/types.js';

export interface Ctx {
  run(work: () => Promise<unknown>): void;
  toast(message: string, kind?: 'info' | 'error'): void;
  navigate(id: string): void;
  state(): AppState;
}

export interface View {
  node: HTMLElement;
  update(state: AppState): void;
  /** Cheap per-second work: relative times only. Never rebuilds structure. */
  tick?(state: AppState): void;
}

type SortKey = 'port' | 'process' | 'memory' | 'age';

const COLUMN_COUNT = 9;

/* ------------------------------------------------------------------ helpers */

/** Everything a user might plausibly type, so one search box covers every case. */
function haystack(row: PortRow): string {
  if (row.search === undefined) return '';
  return row.search;
}

/** Resolves a bare number typed into the search box as a port. */
function asPortQuery(needle: string): number | null {
  const trimmed = needle.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value > 0 && value <= 65535 ? value : null;
}

function toConfirmTargets(row: PortRow): ConfirmTarget[] {
  return row.processes.map((process) => ({
    pid: process.pid,
    port: row.port,
    name: process.name,
    owner: process.owner,
    commandLine: process.commandLine,
    descendants: process.descendants,
    projectName: process.project.name,
    protected: process.protected
  }));
}

/* --------------------------------------------------------------- ports view */

export function portsView(ctx: Ctx): View {
  let expanded = -1;
  let sort: SortKey = 'port';
  let descending = false;
  const selected = new Set<number>();

  /** The scan the table currently reflects, so a repaint can be skipped outright. */
  let paintedAt = -1;
  let paintedKey = '';
  let mode: 'loading' | 'table' | 'empty' = 'loading';

  /** Per-row age cells, so the one-second tick never touches the table structure. */
  const ageCells = new Map<number, { cell: HTMLElement; createdAt: string | null }>();

  /**
   * Captured screenshots, held here rather than in the shared state. A 1280x800
   * PNG is a few hundred kilobytes; broadcasting one on every push would undo
   * the work of keeping the state payload small.
   */
  const thumbnails = new Map<number, string>();

  /** The current rows by port, so action handlers always act on live data. */
  let rowByPort = new Map<number, PortRow>();

  /* ------------------------------------------------------------- filter/sort */

  const searchInput = el('input', {
    class: 'input search',
    type: 'search',
    placeholder: 'Filter by port, pid, project, process or command…',
    'aria-label': 'Filter ports'
  });
  on(searchInput, 'input', () => paint(true));

  const toolbar = el(
    'div',
    { class: 'toolbar' },
    el('div', { class: 'search-wrap' }, icon('search', 13), searchInput),
    el('div', { class: 'spacer' }),
    sortControl()
  );

  const tbody = el('tbody');
  const table = el('table', { class: 'ptable' }, colgroup(), header(), tbody);
  const scroll = createScrollView({ axis: 'both' });
  scroll.viewport.appendChild(table);
  scroll.node.classList.add('table-scroll');

  const body = el('div', { class: 'card-body flush table-host' }, scroll.node);

  const holder = card({
    title: 'Listening ports',
    copy: 'TCP sockets in the LISTEN state, one row per port.',
    flush: true
  });
  holder.node.classList.add('port-panel');
  holder.node.appendChild(toolbar);
  holder.node.appendChild(body);

  const bulkbar = el('div', { class: 'bulkbar' });
  bulkbar.hidden = true;

  const statListening = stat('Listening');
  const statProcesses = stat('Processes');
  const statReserved = stat('Reserved ranges');
  const statScan = stat('Last scan');
  const stats = card({ title: 'At a glance', flush: true });
  stats.body.appendChild(
    el('div', { class: 'stats' }, statListening.node, statProcesses.node, statReserved.node, statScan.node)
  );

  const node = el('div', { class: 'view ports-view' }, stats.node, holder.node, bulkbar);

  /* ------------------------------------------------------------- selection */

  function refreshBulkbar(): void {
    const ports = [...selected];
    bulkbar.hidden = ports.length === 0;
    if (ports.length === 0) return;
    bulkbar.replaceChildren(
      el('span', { class: 'badge solid', text: String(ports.length) }),
      el('div', { text: `${ports.length === 1 ? 'port' : 'ports'} selected` }),
      el('div', { class: 'spacer' }),
      button('Close', { small: true, iconName: 'power', onClick: () => void actOnSelection('close') }),
      button('Terminate', {
        small: true,
        variant: 'danger',
        iconName: 'trash',
        onClick: () => void actOnSelection('terminate')
      }),
      iconButton('x', 'Clear selection', () => {
        selected.clear();
        paint(true);
      })
    );
  }

  async function actOnSelection(method: KillMethod): Promise<void> {
    const rows = (ctx.state().scan?.rows ?? []).filter((row) => selected.has(row.port));
    if (rows.length === 0) return;
    await confirmAndKill(rows.flatMap(toConfirmTargets), method);
    selected.clear();
    paint(true);
  }

  /* --------------------------------------------------------------- columns */

  function colgroup(): HTMLElement {
    /*
     * Widths live here so the header and every body row share one definition.
     * The first version laid the row out as a CSS grid instead, which a `tr`
     * silently ignores - the header and body drifted apart and the action
     * buttons fell off the right edge.
     *
     * The actions column fits three 28px icon buttons plus cell padding, which
     * is what stopped the last button being clipped.
     */
    return el(
      'colgroup',
      {},
      el('col', { style: 'width:34px' }),
      el('col', { style: 'width:112px' }),
      el('col', { style: 'width:auto' }),
      el('col', { style: 'width:auto' }),
      el('col', { style: 'width:74px' }),
      el('col', { style: 'width:74px' }),
      el('col', { style: 'width:52px' }),
      el('col', { style: 'width:50px' }),
      el('col', { style: 'width:106px' })
    );
  }

  function header(): HTMLElement {
    const columns: Array<[string, SortKey | null]> = [
      ['', null],
      ['Port', 'port'],
      ['Process', 'process'],
      ['Project', null],
      ['PID', null],
      ['Mem', 'memory'],
      ['CPU', null],
      ['Age', 'age'],
      ['', null]
    ];
    return el(
      'thead',
      {},
      el(
        'tr',
        {},
        ...columns.map(([label, key]) => {
          const th = el('th', { class: key === null ? '' : 'sortable' });
          th.appendChild(document.createTextNode(label));
          if (key !== null) {
            th.appendChild(el('span', { class: 'sort-caret' }));
            on(th, 'click', () => {
              if (sort === key) descending = !descending;
              else {
                sort = key;
                descending = false;
              }
              paint(true);
            });
          }
          return th;
        })
      )
    );
  }

  function sortControl(): HTMLElement {
    const group = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Sort order' });
    const keys: SortKey[] = ['port', 'process', 'memory', 'age'];
    const labels = ['Port', 'Process', 'Memory', 'Age'];
    keys.forEach((key, index) => {
      const node = el('button', { type: 'button', text: labels[index]! });
      on(node, 'click', () => {
        if (sort === key) descending = !descending;
        else {
          sort = key;
          descending = false;
        }
        paint(true);
      });
      group.appendChild(node);
    });
    return group;
  }

  function paintSortState(): void {
    const group = toolbar.querySelector('.segmented');
    if (!group) return;
    const keys: SortKey[] = ['port', 'process', 'memory', 'age'];
    Array.from(group.children).forEach((child, index) => {
      setAttr(child as HTMLElement, 'aria-pressed', keys[index] === sort ? 'true' : 'false');
    });
    const carets = table.querySelectorAll('th.sortable .sort-caret');
    const order: SortKey[] = ['port', 'process', 'memory', 'age'];
    carets.forEach((caret, index) => {
      caret.textContent = order[index] === sort ? (descending ? '▼' : '▲') : '';
    });
  }

  /* ------------------------------------------------------------------ rows */

  function ownerPrimary(row: PortRow): ProcessInfo | null {
    return row.processes[0] ?? null;
  }

  /**
   * Builds a row's cells once.
   *
   * Every handler reads `rowByPort` at click time rather than closing over the
   * row it was created with. That is what lets a row be created exactly once even
   * though its data changes on every scan - the alternative rebuilt four buttons
   * per row per paint, which is where the jank was coming from.
   */
  function rowNode(row: PortRow): HTMLElement {
    const cell = (className: string, ...content: Array<Node | string | null>): HTMLTableCellElement =>
      el('td', { class: className }, ...content);

    const check = el('input', { class: 'checkbox', type: 'checkbox', 'aria-label': `Select port ${row.port}` });
    on(check, 'change', () => {
      if (check.checked) selected.add(row.port);
      else selected.delete(row.port);
      refreshBulkbar();
    });

    const portCell = cell(
      'cell-port',
      el('div', { class: 'cell-main' }, el('span', { class: 'cell-port-num' })),
      el('div', { class: 'cell-sub' })
    );
    const procCell = cell('cell-proc', el('div', { class: 'cell-main' }), el('div', { class: 'cell-sub' }));
    const projectCell = cell('cell-project', el('div', { class: 'cell-main' }), el('div', { class: 'cell-sub' }));
    const pidCell = cell('cell-pid', el('div', { class: 'cell-num' }));
    const memCell = cell('cell-mem', el('div', { class: 'cell-num' }));
    const cpuCell = cell('cell-cpu', el('div', { class: 'cell-num' }));
    const ageCell = cell('cell-age', el('div', { class: 'cell-num' }));

    const pinButton = iconButton('star', 'Pin this port to the top', () => {
      ctx.run(() => api.togglePin(row.port));
    });
    const closeButton = iconButton('power', 'Close: ask the process to shut down through its window.', () => {
      const current = rowByPort.get(row.port);
      if (current) void confirmAndKill(toConfirmTargets(current), 'close');
    });
    const terminateButton = el(
      'button',
      { class: 'btn danger icon', type: 'button', title: 'Terminate: force-end this process and its children.', 'aria-label': 'Terminate' },
      icon('trash', 15)
    );
    on(terminateButton, 'click', () => {
      const current = rowByPort.get(row.port);
      if (current) void confirmAndKill(toConfirmTargets(current), 'terminate');
    });

    const actions = cell('cell-actions', el('div', { class: 'row-actions' }, closeButton, terminateButton, pinButton));

    const tr = el('tr', { 'data-port': String(row.port) }, cell('cell-check', check), portCell, procCell, projectCell, pidCell, memCell, cpuCell, ageCell, actions);

    on(tr, 'click', (event) => {
      if ((event.target as HTMLElement).closest('button, input')) return;
      expanded = expanded === row.port ? -1 : row.port;
      paint(true);
    });

    return tr;
  }

  function updateRow(tr: HTMLElement, row: PortRow, now: number): void {
    const cells = tr.children;
    const check = cells[0]!.firstElementChild as HTMLInputElement;
    const port = cells[1]!;
    const process = cells[2]!;
    const project = cells[3]!;
    const pid = cells[4]!;
    const mem = cells[5]!;
    const cpu = cells[6]!;
    const age = cells[7]!;

    const owner = ownerPrimary(row);
    const extraOwners = row.processes.length - 1;

    setAttr(tr, 'data-selected', selected.has(row.port) ? 'true' : 'false');
    if (check.checked !== selected.has(row.port)) check.checked = selected.has(row.port);

    setText(port.querySelector('.cell-port-num') as HTMLElement, String(row.port));
    setText(port.children[1] as HTMLElement, describeBindings(row.bindings));
    setAttr(port, 'title', row.bindings.map((binding) => `${binding.rawAddress} (${binding.family})`).join('\n'));

    /*
     * A small marker when the port is serving HTML, so "which of these is a web
     * server" is answerable by scanning the table rather than by expanding rows
     * one at a time. The tooltip carries the title, which is what actually
     * identifies the thing.
     *
     * It sits inline with the port number rather than under it: appended to the
     * cell it became a third line, so exactly the rows that had been identified
     * were taller than the rest and the table lost its rhythm.
     */
    const identity = ctx.state().identities[row.port] ?? null;
    const portMain = port.children[0] as HTMLElement;
    const existingFlag = portMain.querySelector('.cell-flag');
    if (identity?.html) {
      const label = identity.title ?? identity.server ?? identity.url ?? `port ${row.port}`;
      if (existingFlag) setAttr(existingFlag, 'title', label);
      else portMain.appendChild(el('span', { class: 'cell-flag', title: label }, icon('globe', 12)));
    } else if (existingFlag) {
      existingFlag.remove();
    }

    const procMain = process.children[0] as HTMLElement;
    if (!owner) {
      setText(procMain, row.unresolvedPids.length > 0 ? 'unreadable process' : 'no owner');
      procMain.classList.add('muted-inline');
      setText(process.children[1] as HTMLElement, row.unresolvedPids.length > 0 ? `pid ${row.unresolvedPids.join(', ')}` : '');
    } else {
      procMain.classList.remove('muted-inline');
      setText(procMain, `${owner.name}.exe`);
      setText(
        process.children[1] as HTMLElement,
        `${roleLabel(owner.role)}${owner.owner ? ` · ${owner.owner}` : ''}${extraOwners > 0 ? ` · +${extraOwners} more` : ''}`
      );
    }
    setAttr(process, 'title', owner?.image ?? '');

    setText(project.children[0] as HTMLElement, owner?.project.name ?? 'unknown');
    setText(project.children[1] as HTMLElement, owner ? projectSubtitle(owner) : '');
    setAttr(project, 'title', owner?.project.root ?? '');

    setText(pid.firstElementChild as HTMLElement, row.processes.map((entry) => entry.pid).join(', ') || '—');
    setText(mem.firstElementChild as HTMLElement, owner ? formatBytes(owner.workingSetBytes) : '—');
    setText(cpu.firstElementChild as HTMLElement, owner && owner.cpuPercent !== null ? `${owner.cpuPercent}%` : '—');
    setText(age.firstElementChild as HTMLElement, owner ? formatAge(owner.createdAt, now) : '—');

    ageCells.set(row.port, { cell: age.firstElementChild as HTMLElement, createdAt: owner?.createdAt ?? null });

    /*
     * The pin icon is swapped only when its state actually changed.
     *
     * Replacing it unconditionally rebuilt an SVG element for all ~140 rows on
     * every paint - roughly 140 element allocations and 140 DOM replacements
     * every three seconds - to render the same star it had rendered last time.
     * Comparing a cached flag instead makes the common case free.
     */
    const pin = (tr.children[8] as HTMLElement).querySelector('.row-actions .btn:last-child') as HTMLElement | null;
    if (pin && tr.dataset['pinned'] !== String(row.pinned)) {
      tr.dataset['pinned'] = String(row.pinned);
      const wanted = row.pinned ? 'Unpin this port' : 'Pin this port to the top';
      setAttr(pin, 'title', wanted);
      setAttr(pin, 'aria-label', wanted);
      const existing = pin.querySelector('svg');
      if (existing) existing.replaceWith(icon(row.pinned ? 'pin' : 'star', 15));
    }
  }

  /**
   * The project column's second line. It names the *evidence* rather than the
   * bare word "inferred", because "inferred" alone tells the user nothing about
   * what it was inferred from.
   */
  function projectSubtitle(owner: ProcessInfo): string {
    if (owner.project.root === null) return owner.project.basis;
    return owner.project.basis === 'inferred from the command line' ? 'from command line' : 'from executable path';
  }

  /* ----------------------------------------------------------------- detail */

  function detailRow(): HTMLElement {
    const notes = el('div', { class: 'pdetail-note' }, icon('info', 14), el('div', {}));
    const grid = el('div', { class: 'pdetail-grid' });
    const actions = el('div', { class: 'pdetail-actions' });
    return el('tr', { class: 'pdetail-row' }, el('td', { colSpan: COLUMN_COUNT }, el('div', { class: 'pdetail' }, notes, grid, actions)));
  }

  function updateDetail(tr: HTMLElement, row: PortRow): void {
    const host = tr.firstElementChild as HTMLElement;
    const notes = host.querySelector('.pdetail-note') as HTMLElement;
    const grid = host.querySelector('.pdetail-grid') as HTMLElement;
    const actions = host.querySelector('.pdetail-actions') as HTMLElement;

    const owner = ownerPrimary(row);
    const messages: string[] = [];

    if (row.declaredPortMismatch && owner?.declaredPort) {
      messages.push(
        `This process asked for port ${owner.declaredPort} but is bound to ${row.port}. If it should be on ${owner.declaredPort}, something else already holds that port.`
      );
    }
    if (owner && owner.project.confidence === 'unknown') {
      messages.push(
        owner.commandLine === null
          ? 'The command line could not be read. Windows withholds it from processes you do not own, and from protected system processes even for an administrator.'
          : 'No project marker was found above this process. Windows exposes no working directory for another process, so a project is inferred from the command line or the executable path - and left unknown when neither points at one.'
      );
    }
    if (row.unresolvedPids.length > 0) {
      messages.push(`Windows reported ${row.unresolvedPids.join(', ')} as the owner, but no process entry could be read.`);
    }
    if (row.processes.length > 1) {
      messages.push(`${row.processes.length} processes hold this port, which Windows allows across IPv4 and IPv6. Each is listed.`);
    }

    setHidden(notes, messages.length === 0);
    if (messages.length > 0) setText(notes.lastElementChild as HTMLElement, messages.join(' '));

    const sections: Array<{ title: string; node: HTMLElement }> = [];
    if (owner) {
      const service = serviceSection(row, owner);
      if (service) sections.push(service);

      const perProcess = row.processes.map((process) => {
        const rows: Array<[string, string]> = [
          ['PID', String(process.pid)],
          ['Parent', process.ppid === null ? 'unknown' : String(process.ppid)],
          ['Owner', process.owner ?? 'unavailable'],
          ['Session', process.sessionId === null ? 'unknown' : String(process.sessionId)],
          ['Image', process.image ?? 'withheld by Windows'],
          ['Started', `${formatAgeLong(process.createdAt)} · ${formatAge(process.createdAt)} ago`],
          ['Working set', formatBytes(process.workingSetBytes)],
          ['CPU', process.cpuPercent === null ? 'not yet sampled' : `${process.cpuPercent}% of all cores`],
          ['Ports held', process.ports.join(', ')],
          ['Children', process.descendants.length === 0 ? 'none' : process.descendants.join(', ')],
          ['Ancestry', process.ancestry.length === 0 ? 'none recorded' : process.ancestry.join(' ← ')]
        ];
        return el(
          'div',
          { class: 'pdetail-section' },
          el('div', { class: 'pdetail-heading', text: `${process.name}.exe · pid ${process.pid}` }),
          facts(rows)
        );
      });
      sections.push({
        title: 'identity',
        node: perProcess.length === 1 ? perProcess[0]! : el('div', { class: 'grid-2' }, ...perProcess)
      });

      sections.push({
        title: 'project',
        node: el(
          'div',
          { class: 'pdetail-section' },
          el('div', { class: 'pdetail-heading', text: 'Project' }),
          facts([
            ['Name', owner.project.name ?? 'unknown'],
            ['Root', owner.project.root ?? 'not resolved'],
            ['Evidence', owner.project.confidence === 'inferred' ? owner.project.basis : owner.project.basis],
            ['Role', roleLabel(owner.role)],
            ['Declared port', owner.declaredPort === null ? 'not declared on the command line' : String(owner.declaredPort)]
          ])
        )
      });

      if (owner.commandLine !== null) {
        sections.push({
          title: 'command',
          node: el(
            'div',
            { class: 'pdetail-section' },
            el('div', { class: 'pdetail-heading', text: 'Command line' }),
            el('pre', { class: 'pdetail-cmd', text: owner.commandLine })
          )
        });
      }
    }

    // Sections are few and each one is a rich block, so they are placed rather
    // than reconciled. The grid element itself is never replaced, which keeps the
    // panel's own scroll position.
    grid.replaceChildren(...sections.map((section) => section.node));

    if (!owner) {
      actions.replaceChildren();
      return;
    }
    actions.replaceChildren(
      button('Copy command line', {
        small: true,
        iconName: 'copy',
        disabled: owner.commandLine === null,
        onClick: () => void api.copy(owner.commandLine ?? '').then(() => ctx.toast('Command line copied.'))
      }),
      button('Copy PID', {
        small: true,
        iconName: 'copy',
        onClick: () => void api.copy(String(owner.pid)).then(() => ctx.toast('PID copied.'))
      }),
      button('Reveal executable', {
        small: true,
        iconName: 'folder',
        disabled: owner.image === null,
        onClick: () =>
          void api.reveal(owner.image ?? '').then((ok) => {
            if (!ok) ctx.toast('That path no longer exists.', 'error');
          })
      }),
      button('Reveal project', {
        small: true,
        iconName: 'folder',
        disabled: owner.project.root === null,
        onClick: () => void api.reveal(owner.project.root ?? '')
      }),
      button(owner.protected ? 'Remove protection' : 'Protect', {
        small: true,
        iconName: 'shield',
        title: owner.protected
          ? 'Remove this process from the protect list so it can be terminated.'
          : 'Add this process to the protect list so it can never be terminated by accident.',
        onClick: () => ctx.run(() => api.toggleProtect(owner.name))
      })
    );
  }

  /**
   * What the port is actually serving.
   *
   * Only rendered for a process that could plausibly be an HTTP server, or when
   * an identification already exists. Probing a database's socket with an HTTP
   * request would be noise, and the row already says what it is.
   */
  function serviceSection(row: PortRow, owner: ProcessInfo): { title: string; node: HTMLElement } | null {
    const identity = ctx.state().identities[row.port] ?? null;
    const plausible = owner.role === 'dev-server' || identity !== null;
    if (!plausible) return null;

    const body = el('div', { class: 'pdetail-section' });
    const status = el('div', { class: 'service-status' });
    const factsList = el('div');
    const preview = el('div', { class: 'service-preview' });
    const actions = el('div', { class: 'pdetail-actions' });

    const thumbnail = thumbnails.get(row.port);
    if (thumbnail) {
      const image = el('img', { class: 'service-shot', src: thumbnail, alt: `Screenshot of port ${row.port}` });
      on(image, 'click', () => void api.capture(identity?.url ?? '').then(() => undefined));
      preview.replaceChildren(image);
    } else if (identity?.html) {
      preview.replaceChildren(
        button('Capture screenshot', { small: true, iconName: 'eye', onClick: () => void captureInto(row.port, identity.url ?? '') })
      );
    } else {
      preview.replaceChildren();
    }

    if (identity === null || identity.state === 'checking') {
      status.replaceChildren(el('span', { class: 'badge', text: 'not yet identified' }));
      append(factsList, [
        el('div', { class: 'field-hint', text: 'Port Garden identifies a port by making one HTTP request to it and reading the status, content type and title.' })
      ]);
    } else if (identity.state === 'none') {
      // A port that answers nothing on http or https is not necessarily idle; it
      // is a socket speaking something that is not HTTP, which is worth saying.
      status.replaceChildren(el('span', { class: 'badge', text: 'not HTTP' }));
      append(factsList, [
        el('div', {
          class: 'field-hint',
          text: `Nothing answered an HTTP or HTTPS request on this port (${identity.error ?? 'no response'}). It is likely a database, a language server, or another non-HTTP protocol.`
        })
      ]);
    } else {
      status.replaceChildren(
        el('span', { class: identity.html ? 'badge success' : 'badge', text: identity.html ? 'HTML' : 'responds' }),
        el('span', { class: 'badge', text: `HTTP ${identity.status ?? '?'}` })
      );
      append(factsList, [
        facts([
          ['Address', identity.url ?? 'unknown'],
          ['Content type', identity.contentType ?? 'not reported'],
          ['Served by', identity.server ?? 'not reported'],
          ['Page title', identity.title ?? 'no <title>']
        ])
      ]);
    }

    append(body, [status, factsList, preview, actions]);

    actions.replaceChildren(
      button('Identify', {
        small: true,
        iconName: 'refresh',
        title: 'Re-request this port and read its status, content type and title.',
        onClick: () =>
          ctx.run(() =>
            api.identify({
              port: row.port,
              address: row.bindings[0]?.address ?? 'any',
              ownerKey: `${owner.pid}:${owner.createdAt ?? ''}`,
              force: true
            })
          )
      })
    );

    if (identity?.url) {
      actions.appendChild(
        button('Open in browser', {
          small: true,
          iconName: 'external',
          title: `Open ${identity.url} in your default browser.`,
          onClick: () =>
            void api.openUrl(identity.url!).then((ok) => {
              if (!ok) ctx.toast('That address is not a loopback URL, so it was not opened.', 'error');
            })
        })
      );
      if (identity.html) {
        actions.appendChild(
          button(thumbnail ? 'Recapture' : 'Capture screenshot', {
            small: true,
            iconName: 'eye',
            title: 'Render this address in a sandboxed hidden window and keep a picture of it.',
            onClick: () => void captureInto(row.port, identity.url!)
          })
        );
      }
    }

    return { title: `p${row.port}-service`, node: body };
  }

  async function captureInto(port: number, url: string): Promise<void> {
    ctx.toast('Capturing…');
    const image = await api.capture(url);
    if (!image) {
      ctx.toast('The screenshot could not be captured.', 'error');
      return;
    }
    thumbnails.set(port, image);
    paint(true);
  }

  /* ------------------------------------------------------------------ paint */

  function sortRows(rows: PortRow[]): PortRow[] {
    const direction = descending ? -1 : 1;
    const value = (row: PortRow): number | string => {
      const owner = ownerPrimary(row);
      switch (sort) {
        case 'process':
          return owner?.name ?? '';
        case 'memory':
          return owner?.workingSetBytes ?? 0;
        case 'age':
          return owner?.createdAt ? Date.parse(owner.createdAt) : 0;
        default:
          return row.port;
      }
    };
    return [...rows].sort((a, b) => {
      const left = value(a);
      const right = value(b);
      if (left === right) return a.port - b.port;
      return (left < right ? -1 : 1) * direction;
    });
  }

  function visibleRows(scan: ScanResult): PortRow[] {
    const needle = searchInput.value.trim().toLowerCase();
    const filtered = needle === '' ? scan.rows : scan.rows.filter((row) => haystack(row).includes(needle));
    return sortRows(filtered);
  }

  /**
   * @param force repaint even when nothing observable changed (filter, sort,
   *              expansion and selection all change the key, so this is only for
   *              the cases the key cannot see).
   */
  function paint(force = false): void {
    const state = ctx.state();
    const scan = state.scan;

    if (!scan) {
      if (mode !== 'loading') {
        mode = 'loading';
        body.replaceChildren(el('div', { class: 'empty' }, el('div', { class: 'empty-title', text: 'Reading the system…' })));
      }
      return;
    }

    const needle = searchInput.value.trim();
    const rows = visibleRows(scan);
    rowByPort = new Map(rows.map((row) => [row.port, row]));

    // The paint key covers everything that changes the table's structure. When it
    // is unchanged - which is most ticks - the table is left completely alone.
    const key = `${scan.at}|${needle}|${sort}|${descending}|${expanded}|${selected.size}`;
    if (!force && mode === 'table' && key === paintedKey && scan.at === paintedAt) return;
    paintedKey = key;
    paintedAt = scan.at;

    paintSortState();

    if (rows.length === 0) {
      const nextMode = 'empty';
      if (mode !== nextMode || force) {
        body.replaceChildren(explainNoRows(scan, needle));
      }
      mode = nextMode;
      ageCells.clear();
      refreshBulkbar();
      return;
    }

    if (mode !== 'table') {
      // Only swap containers when the mode actually changes. Replacing this on
      // every scan is what used to reset the scroll position every few seconds.
      body.replaceChildren(scroll.node);
      mode = 'table';
    }

    const now = Date.now();
    reconcile(
      tbody,
      rows,
      (row) => row.key,
      (row) => rowNode(row),
      (tr, row) => updateRow(tr, row, now)
    );

    // The expanded detail block lives directly after its own row so it reads as
    // part of it, and it is managed outside the row list: folding it into
    // `reconcile` would remount both it and its row on every scan.
    for (const child of Array.from(tbody.querySelectorAll('tr.pdetail-row'))) child.remove();
    const openRow = rows.find((row) => row.port === expanded);
    if (openRow) {
      const anchor = tbody.querySelector(`tr[data-port="${openRow.port}"]`);
      const detail = detailRow();
      updateDetail(detail, openRow);
      if (anchor) anchor.after(detail);
    }

    scroll.refresh();
    refreshBulkbar();
  }

  /**
   * The empty table has two distinct causes and they deserve different text.
   *
   * A port reserved by Windows is not free - it is *unavailable for a reason the
   * user cannot see from the port list*, and saying so is the most useful thing
   * this app can tell them about an empty search.
   */
  function explainNoRows(scan: ScanResult, raw: string): HTMLElement {
    const needle = raw.trim();
    if (needle === '') {
      return emptyState({
        title: 'Nothing is listening',
        copy: 'No process on this machine is holding a TCP listening port. If you expected something, check whether it is running in another session or on another machine.'
      });
    }

    const portQuery = asPortQuery(needle);
    if (portQuery !== null && inReservedRange(portQuery, scan.reserved)) {
      const range = scan.reserved.find((entry) => portQuery >= entry.start && portQuery <= entry.end)!;
      return el(
        'div',
        { class: 'reserved-note' },
        icon('alert', 15),
        el(
          'div',
          {},
          el('div', {}, el('strong', { text: `Port ${portQuery} has no listener, and it is not free either.` })),
          el(
            'div',
            { class: 'item-meta' },
            `Windows reserved ${range.start}–${range.end}${range.administered ? ' as an administered exclusion' : ''}, typically for Hyper-V, WSL or a container runtime. Binding it will fail until that reservation is removed.`
          )
        )
      );
    }

    return emptyState({
      title: 'No port matches that filter',
      copy: `Nothing matched “${needle}”. Ports, pids, project names, process names and full command lines are all searchable.`
    });
  }

  /* ------------------------------------------------------------------- kill */

  async function confirmAndKill(targets: ConfirmTarget[], method: KillMethod): Promise<void> {
    if (targets.length === 0) return;
    const choice = await api.confirmKill({ targets, method });
    if (!choice) return;
    const resolvedMethod: KillMethod = choice === 'close' ? 'close' : 'terminate';
    const allowProtected = choice === 'unprotect-and-terminate';

    for (const target of targets) {
      const process = rowByPort.get(target.port)?.processes.find((entry) => entry.pid === target.pid);
      const outcome = await api.kill({
        pid: target.pid,
        identity: process?.identity ?? { pid: target.pid, createdAt: null, image: null },
        method: resolvedMethod,
        allowProtected
      });
      if (outcome.ok) {
        ctx.toast(
          resolvedMethod === 'close'
            ? `Closed ${target.name} (pid ${target.pid}).`
            : `Terminated ${target.name} (pid ${target.pid})${process && process.descendants.length > 0 ? ' with its child processes' : ''}.`
        );
      } else {
        // The operating system's own words. Anything else would be inventing an
        // explanation the user can check for themselves.
        ctx.toast(outcome.message ?? `Could not end pid ${target.pid}.`, 'error');
      }
    }
  }

  /* ----------------------------------------------------------------- update */

  return {
    node,
    update(state) {
      const scan = state.scan;
      if (!scan) {
        statListening.set('—');
        statProcesses.set('—');
        statReserved.set('—');
        statScan.set('scanning…');
        paint();
        return;
      }
      statListening.set(String(scan.stats.listeners));
      statProcesses.set(String(scan.stats.processes));
      statReserved.set(String(scan.reserved.length));
      statScan.set(`${scan.stats.durationMs} ms`);
      holder.setFoot(describeScan(scan));
      paint();
    },
    /**
     * The one-second tick. It rewrites the age cells and nothing else - no
     * reconcile, no allocation, no scroll disturbance.
     */
    tick() {
      const now = Date.now();
      for (const { cell, createdAt } of ageCells.values()) {
        setText(cell, createdAt === null ? '—' : formatAge(createdAt, now));
      }
    }
  };
}

function describeScan(scan: ScanResult): string | null {
  const parts: string[] = [];
  if (scan.stats.vanished > 0) parts.push(`${scan.stats.vanished} process(es) disappeared during the scan and were recorded in History.`);
  if (scan.stats.hidden > 0) parts.push(`${scan.stats.hidden} running process(es) hold no listening port and are not listed.`);
  if (scan.stats.degraded) parts.push(`Last scan was degraded: ${scan.stats.errors.join('; ')}`);
  if (parts.length === 0) return null;
  return parts.join(' ');
}

/* ------------------------------------------------------------- history view */

export function historyView(ctx: Ctx): View {
  const list = el('div', { class: 'hist' });
  const holder = card({
    title: 'What ran, and when it ended',
    copy: 'Ports that lost their owner, plus everything ended from this window. Capped at the most recent 200 entries.',
    flush: true,
    actions: [button('Clear', { small: true, iconName: 'eraser', onClick: () => ctx.run(() => api.clearHistory()) })]
  });
  holder.body.appendChild(list);

  const node = el('div', { class: 'view' }, holder.node);

  return {
    node,
    update(state) {
      if (state.history.length === 0) {
        list.replaceChildren(
          emptyState({
            title: 'Nothing has ended yet',
            copy: 'When a port loses its process - because you terminated it, or because the process quit on its own - it is recorded here.'
          })
        );
        return;
      }
      const rows = [...state.history].reverse();
      reconcile(
        list,
        rows,
        (entry) => `${entry.at}-${entry.port}-${entry.pid}`,
        () =>
          el(
            'div',
            { class: 'hist-row' },
            el('div', { class: 'hist-port' }),
            el('div', { class: 'hist-when' }),
            el('div', { class: 'hist-pid' }),
            el('div', { class: 'hist-name' }),
            el('div', { class: 'hist-reason' })
          ),
        (node2, entry) => {
          const cells = node2.children;
          setText(cells[0] as HTMLElement, String(entry.port));
          setText(cells[1] as HTMLElement, new Date(entry.at).toLocaleTimeString());
          setText(cells[2] as HTMLElement, String(entry.pid));
          setText(cells[3] as HTMLElement, `${entry.name}${entry.projectName ? ` · ${entry.projectName}` : ''}`);
          setText(cells[4] as HTMLElement, entry.reason);
        }
      );
    }
  };
}

/* ------------------------------------------------------------- settings view */

export function settingsView(ctx: Ctx): View {
  const themeGroup = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Theme' });
  const themes: ThemePreference[] = ['system', 'light', 'dark'];
  for (const [index, label] of ['System', 'Light', 'Dark'].entries()) {
    const node = el('button', { type: 'button', text: label });
    on(node, 'click', () => ctx.run(() => api.setTheme(themes[index]!)));
    themeGroup.appendChild(node);
  }

  const refreshSelect = el('select', { class: 'select' });
  for (const choice of REFRESH_CHOICES) refreshSelect.appendChild(el('option', { value: String(choice), text: `${choice / 1000}s` }));
  on(refreshSelect, 'change', () => {
    const value = Number(refreshSelect.value);
    if (Number.isFinite(value)) ctx.run(() => api.setSettings({ refreshMs: value }));
  });

  const appearance = card({
    title: 'Appearance and refresh',
    copy: 'The theme follows Windows by default. The main process repaints the window background and the caption buttons in step, so there is no flash and no unreadable title bar.'
  });
  appearance.body.appendChild(
    el(
      'div',
      { class: 'grid-2' },
      el('div', { class: 'field' }, el('span', { class: 'field-label', text: 'Theme' }), themeGroup),
      el('div', { class: 'field' }, el('span', { class: 'field-label', text: 'Refresh interval' }), refreshSelect)
    )
  );

  const chipList = el('div', { class: 'chip-list' });
  const protectInput = el('input', { class: 'input', placeholder: 'image.exe', 'aria-label': 'Protect an image name' });
  const addProtect = button('Add', {
    small: true,
    iconName: 'plus',
    onClick: () => {
      const value = protectInput.value.trim().toLowerCase().replace(/\.exe$/, '');
      if (!value) return;
      protectInput.value = '';
      ctx.run(() => api.toggleProtect(value));
    }
  });

  const protection = card({
    title: 'Protected processes',
    copy: 'These cannot be terminated without an explicit override in the confirmation dialog. Windows termination cannot be caught by the target, so force-ending a database means a crash-recovery cycle at best.'
  });
  protection.body.appendChild(el('div', { class: 'row' }, protectInput, addProtect));
  protection.body.appendChild(
    el('div', { class: 'field-hint', text: `Pre-seeded with ${DEFAULT_PROTECT.length} database, container and virtualization runtimes.` })
  );
  protection.body.appendChild(chipList);

  const launchRow = toggleRow('Launch at login', 'Registers a Windows login item. Only available in a packaged build; a dev run never registers one.', (checked) =>
    ctx.run(() => api.setSettings({ launchAtLogin: checked }))
  );
  const trayRow = toggleRow('Close to tray', 'With a tray icon present, closing the window hides it instead of quitting.', (checked) =>
    ctx.run(() => api.setSettings({ closeToTray: checked }))
  );
  const startup = card({ title: 'Startup and window' });
  startup.body.appendChild(el('div', { class: 'list' }, launchRow.node, trayRow.node));

  const elevationValue = el('dd');
  const probeValue = el('dd');
  const sourceValue = el('dd');
  const logPathValue = el('dd', { class: 'selectable' });
  const logBox = el('pre', { class: 'diag-log' });

  const diagnostics = card({
    title: 'Diagnostics',
    copy: 'How the data was gathered, and the bounded activity log.',
    actions: [button('Relaunch as administrator', { small: true, iconName: 'shield', onClick: () => void elevate() })]
  });
  append(diagnostics.body, [
    facts([
      ['Elevation', elevationValue],
      ['Probe host', probeValue],
      ['Data source', sourceValue],
      ['Activity log', logPathValue]
    ]),
    logBox
  ]);

  const node = el('div', { class: 'view' }, appearance.node, el('div', { class: 'grid-2' }, protection.node, startup.node), diagnostics.node);

  async function elevate(): Promise<void> {
    const result = await api.relaunchElevated();
    ctx.toast(result.message, result.ok ? 'info' : 'error');
  }

  return {
    node,
    update(state) {
      Array.from(themeGroup.children).forEach((child, index) => {
        setAttr(child as HTMLElement, 'aria-pressed', themes[index] === state.settings.theme ? 'true' : 'false');
      });
      refreshSelect.value = String(state.settings.refreshMs);

      reconcile(
        chipList,
        state.settings.protect,
        (name) => name,
        (name) => {
          const remove = el('button', { type: 'button', title: `Remove ${name} from the protect list` }, icon('x', 12));
          on(remove, 'click', () => ctx.run(() => api.toggleProtect(name)));
          return el('span', { class: 'chip' }, el('span', { text: name }), remove);
        }
      );

      launchRow.setState({ checked: state.settings.launchAtLogin });
      trayRow.setState({ checked: state.settings.closeToTray });
      setText(
        elevationValue,
        state.elevated
          ? 'administrator · every process you can see can be acted on'
          : 'standard · you can act on your own processes only'
      );
      setText(probeValue, state.source);
      setText(
        sourceValue,
        state.scan === null
          ? 'no scan yet'
          : `${state.scan.stats.processes} processes · ${state.scan.stats.cores} logical cores · ${state.scan.stats.durationMs} ms`
      );
      setText(logPathValue, state.logPath || 'not yet created');
      setText(logBox, state.logTail.slice(-40).join('\n') || 'No log entries yet.');
    }
  };
}

/** §8.3 two-line row with a trailing switch. */
function toggleRow(title: string, copy: string, onChange: (checked: boolean) => void) {
  const input = el('input', { class: 'switch', type: 'checkbox', 'aria-label': title });
  on(input, 'change', () => onChange(input.checked));
  const node = el(
    'label',
    { class: 'item' },
    el('div', { class: 'item-main' }, el('div', { class: 'item-title', text: title }), el('div', { class: 'item-meta', text: copy })),
    input
  );
  return {
    node,
    setState({ checked }: { checked: boolean }) {
      if (document.activeElement !== input && input.checked !== checked) input.checked = checked;
    }
  };
}