import { getBinding } from './wails';

/**
 * Records the resolved theme for the next start (UIService.SetTheme): main.go
 * paints the native window in it before the page loads. Never throws; a
 * no-op outside Wails.
 */
export async function SaveWindowTheme(theme: 'dark' | 'light'): Promise<void> {
  try {
    const svc = getBinding('UIService');
    if (svc?.SetTheme) await svc.SetTheme(theme);
  } catch {
    /* not essential: the window just opens in the default colour */
  }
}
