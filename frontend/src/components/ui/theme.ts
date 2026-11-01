// Appearance helpers (SPEC section 5). uiStore owns the state; this module only
// knows how to read/persist the preference, resolve 'system', and write the
// data-theme / data-density attributes on <html> that styles/globals.css keys on.
// Every storage and matchMedia access is guarded: private mode, blocked site data
// or an engine without matchMedia must still render (default 'system' -> dark).

export type ThemePref = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';
export type Density = 'compact' | 'comfortable';

/** One-line switch if the owner wants dark until light GA (SPEC 12.1). */
export const THEME_DEFAULT: ThemePref = 'system';
export const DENSITY_DEFAULT: Density = 'compact';

/**
 * Light was "(preview)" until sweep step S8: lint gates 0 and a light live
 * contrast scan with 0 failures on the main screens (post-integration sweep).
 */
export const LIGHT_THEME_PREVIEW = false;

export const THEME_STORAGE_KEY = 'ldapilot-theme';
export const DENSITY_STORAGE_KEY = 'ldapilot-density';

const LIGHT_QUERY = '(prefers-color-scheme: light)';

export const THEME_OPTIONS: ReadonlyArray<{ value: ThemePref; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: LIGHT_THEME_PREVIEW ? 'Light (preview)' : 'Light' },
];

export const DENSITY_OPTIONS: ReadonlyArray<{ value: Density; label: string }> = [
  { value: 'compact', label: 'Compact' },
  { value: 'comfortable', label: 'Comfortable' },
];

export function themeLabel(p: ThemePref): string {
  return THEME_OPTIONS.find((o) => o.value === p)?.label ?? p;
}

export function densityLabel(d: Density): string {
  return DENSITY_OPTIONS.find((o) => o.value === d)?.label ?? d;
}

export const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};

export const write = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode / blocked storage: the choice just is not remembered */
  }
};

export function isThemePref(v: unknown): v is ThemePref {
  return v === 'system' || v === 'dark' || v === 'light';
}

export function isDensity(v: unknown): v is Density {
  return v === 'compact' || v === 'comfortable';
}

export function loadThemePref(): ThemePref {
  const v = read(THEME_STORAGE_KEY);
  return isThemePref(v) ? v : THEME_DEFAULT;
}

export function loadDensity(): Density {
  return read(DENSITY_STORAGE_KEY) === 'comfortable' ? 'comfortable' : DENSITY_DEFAULT;
}

/** 'system' follows prefers-color-scheme; "no-preference" (WebKitGTK) resolves to dark = today's look. */
export function resolveTheme(p: ThemePref): ResolvedTheme {
  if (p !== 'system') return p;
  try {
    return window.matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function applyAppearance(t: ResolvedTheme, d: Density): void {
  try {
    const el = document.documentElement;
    el.dataset.theme = t;
    el.dataset.density = d;
  } catch {
    /* no DOM (tests / SSR) */
  }
}

/**
 * Calls `onChange` whenever the OS colour scheme flips. Returns the unsubscribe.
 * Falls back to the legacy addListener API (older WebKit) and to a no-op when
 * matchMedia is unavailable.
 */
export function watchSystemTheme(onChange: (t: ResolvedTheme) => void): () => void {
  let mql: MediaQueryList;
  try {
    mql = window.matchMedia(LIGHT_QUERY);
  } catch {
    return () => {};
  }
  const handler = (e: MediaQueryListEvent | MediaQueryList) => onChange(e.matches ? 'light' : 'dark');
  try {
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handler);
      return () => mql.removeEventListener('change', handler);
    }
    // Legacy MediaQueryList API (Safari < 14 / old WebKitGTK).
    const legacy = mql as unknown as {
      addListener?: (cb: typeof handler) => void;
      removeListener?: (cb: typeof handler) => void;
    };
    legacy.addListener?.(handler);
    return () => legacy.removeListener?.(handler);
  } catch {
    return () => {};
  }
}

/** "220 13% 10%" (an HSL channel token) -> 0-255 RGB. */
function hslTokenToRGB(token: string): [number, number, number] | null {
  const m = token.trim().match(/^(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/);
  if (!m) return null;
  const h = (((+m[1] % 360) + 360) % 360) / 360;
  const s = Math.min(1, +m[2] / 100);
  const l = Math.min(1, +m[3] / 100);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(ch(h + 1 / 3) * 255), Math.round(ch(h) * 255), Math.round(ch(h - 1 / 3) * 255)];
}

/**
 * The theme's page background (`--background`, what `body` paints) as 0-255
 * RGB, or null if it cannot be read. Used to paint the native window (Wails
 * WindowSetBackgroundColour) in the current theme so resizing never flashes
 * the other theme's colour.
 *
 * Reads the TOKEN of the current data-theme, not body's computed colour:
 * that one may still be mid-transition (reduced-motion and other stylesheets
 * transition background-color) when this runs right after a theme switch.
 */
export function readBodyBackgroundRGB(): [number, number, number] | null {
  try {
    const token = getComputedStyle(document.documentElement).getPropertyValue('--background');
    const rgb = token ? hslTokenToRGB(token) : null;
    if (rgb) return rgb;
  } catch {
    /* no DOM */
  }
  try {
    const bg = getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    if (m) return [Math.round(+m[1]), Math.round(+m[2]), Math.round(+m[3])];
    // color(srgb r g b) serialisation (0..1 channels)
    const c = bg.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i);
    if (c) return [Math.round(+c[1] * 255), Math.round(+c[2] * 255), Math.round(+c[3] * 255)];
  } catch {
    /* no DOM */
  }
  return null;
}
