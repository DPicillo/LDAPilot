import { useLayoutEffect, useState, type RefObject } from 'react'

export interface MenuPlacement {
  left: number;
  top: number;
  /** Cap for the menu height; a longer menu scrolls. */
  maxHeight: number;
}

/**
 * Position of a context menu opened at (x, y), all values in the coordinate
 * space of the zoom wrapper: flipped left/up when it would overflow the
 * viewport, and moved into it when it fits on neither side, so no item ends
 * up above the top or left edge. A menu taller than the viewport starts at
 * the top margin and scrolls.
 */
export function placeMenu(
  x: number, y: number, width: number, height: number, viewportW: number, viewportH: number, margin = 4,
): MenuPlacement {
  const maxHeight = Math.max(0, viewportH - 2 * margin);
  const h = Math.min(height, maxHeight);
  // Below/right of the click if it fits, else above/left of it if that
  // fits, else pushed against the far edge.
  const place = (p: number, size: number, viewport: number) => {
    if (p + size <= viewport - margin) return p;
    if (p - size >= margin) return p - size;
    return viewport - size - margin;
  };
  return {
    left: Math.max(margin, place(x, width, viewportW)),
    top: Math.max(margin, place(y, h, viewportH)),
    maxHeight,
  };
}

/**
 * placeMenu for a fixed-position menu rendered inside the zoom wrapper
 * (transform: scale): x/y are clientX/clientY, divided by zoomLevel here.
 * The menu's real size is measured before paint (layout sizes are not
 * affected by the transform); `estimate` is only used for the first layout.
 */
export function useMenuPosition(
  ref: RefObject<HTMLElement | null>, x: number, y: number, zoomLevel: number,
  estimate: { width: number; height: number },
): MenuPlacement {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const width = el.offsetWidth;
    // natural height incl. borders, also when capped by maxHeight
    const height = el.scrollHeight + (el.offsetHeight - el.clientHeight);
    setSize((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
  });
  const s = size ?? estimate;
  return placeMenu(x / zoomLevel, y / zoomLevel, s.width, s.height, window.innerWidth / zoomLevel, window.innerHeight / zoomLevel);
}
