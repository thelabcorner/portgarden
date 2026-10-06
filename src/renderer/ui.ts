/**
 * Composable pieces every view is built from, so the dense scale stays
 * consistent. Mirrors the reference app's primitive API rather than inventing a
 * second one.
 */

import { el, icon, on } from './dom.js';
import type { ProcessRole } from '../shared/types.js';

export interface Card {
  node: HTMLElement;
  body: HTMLElement;
  foot: HTMLElement;
  setFoot(text: string | null): void;
}

export function card(spec: { title: string; copy?: string; actions?: HTMLElement[]; flush?: boolean }): Card {
  const body = el('div', { class: spec.flush ? 'card-body flush' : 'card-body' });
  const foot = el('div', { class: 'card-foot' });
  foot.hidden = true;
  const node = el(
    'section',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        {},
        el('div', { class: 'card-title', text: spec.title }),
        spec.copy ? el('div', { class: 'card-copy', text: spec.copy }) : null
      ),
      spec.actions?.length ? el('div', { class: 'item-actions always' }, ...spec.actions) : null
    ),
    body,
    foot
  );
  return {
    node,
    body,
    foot,
    setFoot(text) {
      foot.hidden = text === null;
      if (text !== null && foot.textContent !== text) foot.textContent = text;
    }
  };
}

export function button(
  label: string,
  spec: {
    variant?: 'default' | 'primary' | 'ghost' | 'danger';
    iconName?: string;
    onClick?: () => void;
    title?: string;
    small?: boolean;
    disabled?: boolean;
  } = {}
): HTMLButtonElement {
  const node = el(
    'button',
    {
      class: `btn ${spec.variant ?? 'default'}${spec.small ? ' sm' : ''}`,
      type: 'button',
      ...(spec.title ? { title: spec.title } : {})
    },
    spec.iconName ? icon(spec.iconName, spec.small ? 12 : 14) : null,
    label ? el('span', { class: 'label', text: label }) : null
  );
  if (!label) node.classList.add('icon');
  if (spec.onClick) on(node, 'click', spec.onClick);
  return node;
}

export function iconButton(iconName: string, title: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', { class: 'btn ghost icon', type: 'button', title, 'aria-label': title }, icon(iconName, 14));
  on(node, 'click', onClick);
  return node;
}

export function field(spec: { label: string; control: HTMLElement; hint?: string }): HTMLElement {
  return el(
    'label',
    { class: 'field' },
    el('span', { class: 'field-label', text: spec.label }),
    spec.control,
    spec.hint ? el('span', { class: 'field-hint', text: spec.hint }) : null
  );
}

export interface ToggleRow {
  node: HTMLElement;
  input: HTMLInputElement;
  setState(spec: { checked: boolean; disabled?: boolean }): void;
  setNote(text: string): void;
}

export function toggleRow(spec: { title: string; copy: string; onChange: (checked: boolean) => void }): ToggleRow {
  const input = el('input', { class: 'switch', type: 'checkbox', 'aria-label': spec.title });
  const copy = el('div', { class: 'item-meta', text: spec.copy });
  on(input, 'change', () => spec.onChange(input.checked));
  const node = el(
    'label',
    { class: 'item' },
    el('div', { class: 'item-main' }, el('div', { class: 'item-title', text: spec.title }), copy),
    input
  );
  return {
    node,
    input,
    setState({ checked, disabled }) {
      // Never move a control the user is mid-interaction with.
      if (document.activeElement !== input && input.checked !== checked) input.checked = checked;
      input.disabled = disabled === true;
    },
    setNote(text) {
      if (copy.textContent !== text) copy.textContent = text;
    }
  };
}

export function emptyState(spec: { title: string; copy: string; action?: HTMLElement }): HTMLElement {
  return el(
    'div',
    { class: 'empty' },
    el('div', { class: 'empty-title', text: spec.title }),
    el('div', { text: spec.copy }),
    spec.action
      ? el('div', { class: 'row' }, el('div', { class: 'spacer' }), spec.action, el('div', { class: 'spacer' }))
      : null
  );
}

/** Key/value strip. Values that must be copyable opt in via the `mono` class. */
export function facts(pairs: Array<[string, HTMLElement | string]>): HTMLElement {
  const list = el('dl', { class: 'facts' });
  for (const [term, value] of pairs) {
    list.appendChild(el('dt', { text: term }));
    list.appendChild(typeof value === 'string' ? el('dd', { class: 'selectable', text: value }) : value);
  }
  return list;
}

export function stat(label: string): { node: HTMLElement; set(value: string): void } {
  const value = el('div', { class: 'stat-value', text: '—' });
  return {
    node: el('div', { class: 'stat' }, value, el('div', { class: 'stat-label', text: label })),
    set(next) {
      if (value.textContent !== next) value.textContent = next;
    }
  };
}

/* ---------------------------------------------------------------- formatting */

const ROLE_LABELS: Record<ProcessRole, string> = {
  'dev-server': 'Dev server',
  node: 'Node.js',
  python: 'Python',
  dotnet: '.NET',
  java: 'Java',
  'docker-forward': 'Docker forward',
  database: 'Database',
  browser: 'Browser',
  system: 'Windows system',
  service: 'Windows service',
  other: 'Other'
};

export function roleLabel(role: ProcessRole): string {
  return ROLE_LABELS[role];
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** "3m ago" style. Returns "unknown" rather than a wrong duration. */
export function formatAge(iso: string | null, now = Date.now()): string {
  if (!iso) return 'unknown';
  const started = Date.parse(iso);
  if (!Number.isFinite(started)) return 'unknown';
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export function formatAgeLong(iso: string | null): string {
  if (!iso) return 'unavailable';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return 'unavailable';
  return parsed.toLocaleString();
}

/**
 * The short bind label for the port column.
 *
 * The first version rendered `all/IPv4, all/IPv6`, which is accurate and
 * unreadable: the slash reads as a path separator and the family suffix doubles
 * the width of a cell that has to sit beside the process name. The row cell now
 * says `all` or `loopback` or the actual host, and the exact addresses and
 * families live in the cell's tooltip and in the detail panel.
 */
export function describeBindings(bindings: Array<{ address: string; wildcard: boolean }>): string {
  if (bindings.length === 0) return 'unknown';
  const labels = bindings.map((binding) => (binding.wildcard ? 'all' : binding.address));
  const unique = [...new Set(labels)];
  if (unique.length <= 2) return unique.join(', ');
  return `${unique[0]} +${unique.length - 1}`;
}
