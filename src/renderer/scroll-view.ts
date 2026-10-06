/**
 * An overlay scroll view.
 *
 * The design guide (§12) replaces native scrollbars with a floating thumb: a 5px
 * pill in a 12px hit area, foreground at 22%, widening and darkening on hover or
 * drag, fading in on scroll and out once it goes idle. Native scrollbars inside a
 * panel are explicitly an anti-pattern there, and on Windows they are also an
 * obvious tell.
 *
 * This is deliberately a small mechanism rather than a scroll library:
 *
 *   - the real scrolling is still native (`overflow: auto`), so wheel, trackpad,
 *     keyboard, focus and `scrollIntoView` all keep working;
 *   - the native indicator is hidden and redrawn as the floating thumb, which is
 *     the only part that changes.
 *
 * Nothing here scrolls by animating `scrollTop` on a timer, so there is no
 * hijacking of momentum and no fight with the compositor.
 */

export type ScrollAxis = 'y' | 'both';

export interface ScrollView {
  /** The scroll container's wrapper. Put this in the layout. */
  node: HTMLElement;
  /** The element that actually scrolls. Put content in here. */
  viewport: HTMLElement;
  /** Recomputes thumb geometry. Call after replacing content. */
  refresh(): void;
  scrollToTop(): void;
}

/** How long the thumb lingers after the last scroll before fading out. */
const IDLE_HIDE_MS = 1100;
const MIN_THUMB_PX = 28;

export function createScrollView(options: { axis?: ScrollAxis; className?: string } = {}): ScrollView {
  const axis = options.axis ?? 'y';
  const node = document.createElement('div');
  node.className = `scrollview${axis === 'both' ? ' scrollview-both' : ''}${options.className ? ` ${options.className}` : ''}`;
  const viewport = document.createElement('div');
  viewport.className = 'scrollview-viewport';
  node.appendChild(viewport);

  const trackY = document.createElement('div');
  trackY.className = 'scrollview-track scrollview-track-y';
  const thumbY = document.createElement('div');
  thumbY.className = 'scrollview-thumb';
  trackY.appendChild(thumbY);
  node.appendChild(trackY);

  const trackX = document.createElement('div');
  trackX.className = 'scrollview-track scrollview-track-x';
  const thumbX = document.createElement('div');
  thumbX.className = 'scrollview-thumb';
  trackX.appendChild(thumbX);
  if (axis === 'both') node.appendChild(trackX);

  let hideTimer: number | null = null;
  let dragging = false;

  function reveal(): void {
    node.classList.add('is-scrolling');
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      if (!dragging) node.classList.remove('is-scrolling');
    }, IDLE_HIDE_MS);
  }

  /** Height of the vertical track's usable area, which the thumb is sized against. */
  function trackExtent(): number {
    return Math.max(0, trackY.clientHeight - 4);
  }

  function layoutY(): void {
    const viewportExtent = viewport.clientHeight;
    const contentExtent = viewport.scrollHeight;
    const extent = trackExtent();

    if (contentExtent <= viewportExtent + 1 || extent <= 0) {
      // Nothing to scroll: an overlaid thumb would be a lie, so it is removed
      // rather than drawn full-height.
      node.classList.add('no-overflow-y');
      return;
    }
    node.classList.remove('no-overflow-y');

    const thumbHeight = Math.max(MIN_THUMB_PX, (viewportExtent / contentExtent) * extent);
    const maxScroll = contentExtent - viewportExtent;
    const maxThumbTravel = extent - thumbHeight;
    const progress = maxScroll <= 0 ? 0 : viewport.scrollTop / maxScroll;

    thumbY.style.height = `${Math.round(thumbHeight)}px`;
    thumbY.style.transform = `translateY(${Math.round(progress * maxThumbTravel)}px)`;
  }

  function layoutX(): void {
    if (axis !== 'both') return;
    const viewportExtent = viewport.clientWidth;
    const contentExtent = viewport.scrollWidth;
    const extent = Math.max(0, trackX.clientWidth - 4);

    if (contentExtent <= viewportExtent + 1 || extent <= 0) {
      node.classList.add('no-overflow-x');
      return;
    }
    node.classList.remove('no-overflow-x');

    const thumbWidth = Math.max(MIN_THUMB_PX, (viewportExtent / contentExtent) * extent);
    const maxScroll = contentExtent - viewportExtent;
    const maxThumbTravel = extent - thumbWidth;
    const progress = maxScroll <= 0 ? 0 : viewport.scrollLeft / maxScroll;

    thumbX.style.width = `${Math.round(thumbWidth)}px`;
    thumbX.style.transform = `translateX(${Math.round(progress * maxThumbTravel)}px)`;
  }

  function layout(): void {
    layoutY();
    layoutX();
  }

  viewport.addEventListener('scroll', () => {
    layout();
    reveal();
  }, { passive: true });

  node.addEventListener('pointerenter', reveal);
  node.addEventListener('pointerleave', () => {
    if (dragging) return;
    node.classList.remove('is-scrolling');
  });

  /** Shared drag behaviour: capture the pointer, translate travel into scroll. */
  function bindDrag(track: HTMLElement, thumb: HTMLElement, vertical: boolean): void {
    thumb.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      dragging = true;
      node.classList.add('is-scrolling', 'is-dragging');
      thumb.setPointerCapture(event.pointerId);

      const startPointer = vertical ? event.clientY : event.clientX;
      const startScroll = vertical ? viewport.scrollTop : viewport.scrollLeft;
      const extent = vertical ? trackExtent() : Math.max(0, track.clientWidth - 4);
      const thumbExtent = vertical ? thumb.offsetHeight : thumb.offsetWidth;
      const travel = Math.max(1, extent - thumbExtent);
      const maxScroll = vertical
        ? viewport.scrollHeight - viewport.clientHeight
        : viewport.scrollWidth - viewport.clientWidth;

      const move = (moveEvent: PointerEvent): void => {
        const delta = (vertical ? moveEvent.clientY : moveEvent.clientX) - startPointer;
        const next = startScroll + (delta / travel) * maxScroll;
        if (vertical) viewport.scrollTop = next;
        else viewport.scrollLeft = next;
      };
      const up = (): void => {
        dragging = false;
        node.classList.remove('is-dragging');
        thumb.releasePointerCapture(event.pointerId);
        thumb.removeEventListener('pointermove', move);
        thumb.removeEventListener('pointerup', up);
        thumb.removeEventListener('pointercancel', up);
        reveal();
      };
      thumb.addEventListener('pointermove', move);
      thumb.addEventListener('pointerup', up);
      thumb.addEventListener('pointercancel', up);
    });

    // Clicking the track pages toward the click, which is what a native
    // scrollbar does and what a 12px hit area implies.
    track.addEventListener('pointerdown', (event) => {
      if (event.target === thumb) return;
      const rect = track.getBoundingClientRect();
      const before = vertical ? event.clientY < rect.top + thumb.offsetTop : event.clientX < rect.left + thumb.offsetLeft;
      const page = (vertical ? viewport.clientHeight : viewport.clientWidth) * 0.9;
      if (vertical) viewport.scrollTop += before ? -page : page;
      else viewport.scrollLeft += before ? -page : page;
      layout();
      reveal();
    });
  }

  bindDrag(trackY, thumbY, true);
  if (axis === 'both') bindDrag(trackX, thumbX, false);

  // Content and viewport both change size for reasons no scroll event reports:
  // a scan adding rows, a window resize, a detail panel opening.
  const observer = new ResizeObserver(() => layout());
  observer.observe(viewport);
  const contentObserver = new ResizeObserver(() => layout());

  const originalAppend = viewport.appendChild.bind(viewport);
  const originalReplace = viewport.replaceChildren.bind(viewport);
  void originalAppend;
  void originalReplace;

  // Observing the first element child covers both "content replaced" and
  // "content grew", without needing the caller to remember to call refresh().
  const watchContent = (): void => {
    contentObserver.disconnect();
    const child = viewport.firstElementChild;
    if (child) contentObserver.observe(child);
    layout();
  };
  const mutation = new MutationObserver(() => watchContent());
  mutation.observe(viewport, { childList: true });
  watchContent();

  const onResize = (): void => layout();
  window.addEventListener('resize', onResize);
  node.addEventListener('scrollview:dispose', () => {
    observer.disconnect();
    contentObserver.disconnect();
    mutation.disconnect();
    window.removeEventListener('resize', onResize);
    if (hideTimer !== null) window.clearTimeout(hideTimer);
  });

  return {
    node,
    viewport,
    refresh: layout,
    scrollToTop(): void {
      viewport.scrollTop = 0;
      layout();
    }
  };
}