/**
 * The window and taskbar icon, drawn in code.
 *
 * A binary icon asset would be one more thing to keep in sync with the palette,
 * and the mark is simple enough to rasterise: a rounded square with a socket
 * notch cut out of the middle, in the same zinc the chrome uses. Electron takes
 * raw bitmaps directly, so there is no PNG encoder and no file on disk.
 */

import { nativeImage } from 'electron';

/** Renders the mark at `size` pixels square as a BGRA bitmap. */
export function createTrayBitmap(size: number): Electron.NativeImage {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = Math.max(2, Math.round(size * 0.28));
  const inset = Math.max(1, Math.round(size * 0.1));
  const innerRadius = Math.max(1, Math.round(size * 0.17));
  const cx = size / 2;
  const cy = size / 2;

  // zinc-900 body, zinc-50 notch - matches the dark surface the app sits on and
  // still reads at 16px on a light taskbar because the body is dark.
  const body = [24, 24, 27, 255];
  const notch = [244, 244, 245, 255];

  const insideRounded = (x: number, y: number, left: number, top: number, box: number, r: number): boolean => {
    if (x < left || y < top || x >= left + box || y >= top + box) return false;
    const cxr = Math.min(Math.max(x + 0.5, left + r), left + box - r);
    const cyr = Math.min(Math.max(y + 0.5, top + r), top + box - r);
    const dx = x + 0.5 - cxr;
    const dy = y + 0.5 - cyr;
    return dx * dx + dy * dy <= r * r;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const box = size - inset * 2;
      if (!insideRounded(x, y, inset, inset, box, radius)) continue;
      const hole = insideRounded(x, y, Math.round(cx - innerRadius), Math.round(cy - innerRadius), innerRadius * 2, innerRadius);
      const colour = hole ? notch : body;
      const offset = (y * size + x) * 4;
      rgba[offset] = colour[0]!;
      rgba[offset + 1] = colour[1]!;
      rgba[offset + 2] = colour[2]!;
      rgba[offset + 3] = colour[3]!;
    }
  }

  return nativeImage.createFromBitmap(rgba, { width: size, height: size });
}