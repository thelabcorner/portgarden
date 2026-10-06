/**
 * The renderer's element toolkit.
 *
 * Elements are created once and mutated in place. That is not a stylistic
 * preference: this table re-renders on every scan, two seconds apart, and a
 * `innerHTML` rebuild would collapse a search field's caret mid-keystroke and
 * throw away scroll position while the user was reading a command line. It also
 * means there is no HTML-escaping question to get wrong - `textContent` is not a
 * parser.
 */

/** Attribute/property bag understood by `el`. */
interface Props {
  class?: string;
  text?: string;
  title?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  hidden?: boolean;
  disabled?: boolean;
  checked?: boolean;
  role?: string;
  style?: string;
  tabIndex?: number;
  colSpan?: number | string;
  src?: string;
  alt?: string;
  [key: `data-${string}`]: string | undefined;
  [key: `aria-${string}`]: string | undefined;
}

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'tabIndex' || key === 'colSpan') {
      // Properties, not attributes: an input's attribute is only its initial
      // value, and writing it would not move a control already interacted with.
      (node as unknown as Record<string, unknown>)[key] = value;
    } else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Sets `textContent` only when it differs, so a live selection is not collapsed. */
export function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function setClass(node: Element, className: string): void {
  if (node.className !== className) node.className = className;
}

export function setAttr(node: Element, name: string, value: string | null): void {
  if (value === null) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
  } else if (node.getAttribute(name) !== value) {
    node.setAttribute(name, value);
  }
}

export function setHidden(node: HTMLElement, hidden: boolean): void {
  if (node.hidden !== hidden) node.hidden = hidden;
}

/** Writes an input's value unless the user is editing it, which would fight their caret. */
export function setValueIfIdle(input: HTMLInputElement, value: string): void {
  if (document.activeElement === input) return;
  if (input.value !== value) input.value = value;
}

export function on<K extends keyof HTMLElementEventMap>(
  node: HTMLElement,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void
): void {
  node.addEventListener(type, handler);
}

/**
 * Keyed list reconciliation.
 *
 * Rows are created once per key and updated in place; only genuinely new keys
 * allocate a node. That is what lets a checkbox inside one row keep focus while
 * its siblings change, and it is the difference between a table that feels live
 * and one that flickers.
 */
export function reconcile<T>(
  container: HTMLElement,
  items: readonly T[],
  key: (item: T) => string,
  create: (item: T) => HTMLElement,
  update?: (node: HTMLElement, item: T) => void
): void {
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(container.children)) {
    const id = (child as HTMLElement).dataset['key'];
    if (id === undefined) child.remove();
    else existing.set(id, child as HTMLElement);
  }

  let cursor: ChildNode | null = container.firstChild;
  for (const item of items) {
    const id = key(item);
    let node = existing.get(id);
    if (node) {
      existing.delete(id);
    } else {
      node = create(item);
      node.dataset['key'] = id;
    }
    // Called for a freshly created node as well as an existing one. The first
    // version updated only existing nodes, so a row that `create` left empty for
    // `update` to fill rendered blank - which is every row in the ports table.
    update?.(node, item);
    if (cursor === node) cursor = node.nextSibling;
    else container.insertBefore(node, cursor);
  }
  for (const orphan of existing.values()) orphan.remove();
}

/* --------------------------------------------------------------------- icons */

/**
 * Inline 16px icons in the lucide house style - the icon set shadcn ships with -
 * drawn here so the renderer keeps its zero-runtime-dependency footprint.
 */
const PATHS: Record<string, string> = {
  activity: 'M3 12h4l3 8 4-16 3 8h4',
  gauge: 'M12 20a8 8 0 1 1 8-8M12 12l4.5-3.5',
  settings:
    'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  refresh: 'M20 11a8 8 0 1 0-.7 4.5M20 5v6h-6',
  trash: 'M4 7h16M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7',
  copy: 'M9 9V5.5A1.5 1.5 0 0 1 10.5 4h8A1.5 1.5 0 0 1 20 5.5v8a1.5 1.5 0 0 1-1.5 1.5H15M5.5 9h8A1.5 1.5 0 0 1 15 10.5v8a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 4 18.5v-8A1.5 1.5 0 0 1 5.5 9z',
  folder: 'M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.82 1.2a2 2 0 0 0 1.68.9H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  shield: 'M12 3l7 3v5.5c0 4.2-2.9 8.1-7 9.5-4.1-1.4-7-5.3-7-9.5V6z',
  star: 'M12 3.6l2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z',
  x: 'M6 6l12 12M18 6L6 18',
  pin: 'M9 4h6M12 4v6.5l3.5 4V17h-7v-2.5L12 10.5M12 17v3',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  stop: 'M7 7h10v10H7z',
  external: 'M14 4h6v6M20 4l-8.5 8.5M18 13.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V7.5A1.5 1.5 0 0 1 5 6h5.5',
  check: 'M5 12.5l4.5 4.5L19 7',
  alert: 'M12 8.5v5m0 3.2v.1M10.3 4.3 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 7.8v.1',
  chevron: 'M6 9l6 6 6-6',
  clock: 'M12 7v5l3.5 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  cpu: 'M8 8h8v8H8zM6.5 4v2M10 4v2M14 4v2M17.5 4v2M6.5 18v2M10 18v2M14 18v2M17.5 18v2M4 6.5h2M4 10h2M4 14h2M4 17.5h2M18 6.5h2M18 10h2M18 14h2M18 17.5h2',
  network: 'M12 3v4M12 17v4M4.5 7.5h15M6.5 11.5h11M6.5 16.5h11M2 7.5h4v4H2zM9.5 16.5h5v4h-5zM18 7.5h4v4h-4z',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3.5 9h17M3.5 15h17M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z',
  plus: 'M12 5v14M5 12h14',
  eraser: 'M4 19h16M6.5 16.5l-2-2a1.5 1.5 0 0 1 0-2.1l7-7a1.5 1.5 0 0 1 2.1 0l4.5 4.5a1.5 1.5 0 0 1 0 2.1L14 16.5z',
  power: 'M12 4v8M7.5 6.8a8 8 0 1 0 9 0',
  play: 'M7 5l11 7-11 7z'
};

export function icon(name: keyof typeof PATHS | string, size = 14): SVGElement {  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', PATHS[name] ?? PATHS['info']!);
  svg.appendChild(path);
  return svg;
}