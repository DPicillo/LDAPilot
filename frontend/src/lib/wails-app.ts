/**
 * Wails wrappers of the application-level UIService methods (Go
 * services/app_info.go, services/ui_service.go): build information and the
 * close guard (app:before-close).
 */
import { getBinding } from './wails';

/** Build and environment of the running app - mirrors Go services.AppInfo. */
export interface AppInfo {
  name: string;
  version: string;
  commit: string;
  /** RFC 3339 when known. */
  buildDate: string;
  /** Built from a working tree with uncommitted changes. */
  modified: boolean;
  goVersion: string;
  wailsVersion: string;
  /** Linux: the loaded libwebkit2gtk; '' elsewhere. */
  webView: string;
  os: string;
  arch: string;
  configDir: string;
}

/** Event the backend emits when the window is about to close (answer with AckClose, then QuitApp or CancelClose). */
export const APP_BEFORE_CLOSE_EVENT = 'app:before-close';

export async function GetAppInfo(): Promise<AppInfo | null> {
  try {
    const svc = getBinding('UIService');
    if (svc?.GetAppInfo) return (await svc.GetAppInfo()) ?? null;
  } catch {
    /* outside Wails */
  }
  return null;
}

/** Tells the backend the close request arrived (else it closes after 2 s). */
export async function AckClose(): Promise<void> {
  const svc = getBinding('UIService');
  if (svc?.AckClose) await svc.AckClose();
}

/** The user keeps the window open; the next close request asks again. */
export async function CancelClose(): Promise<void> {
  const svc = getBinding('UIService');
  if (svc?.CancelClose) await svc.CancelClose();
}

/**
 * Quits the application without asking again (UIService.Quit). Outside
 * Wails (or with an old backend) falls back to the runtime's Quit.
 */
export async function QuitApp(): Promise<void> {
  const svc = getBinding('UIService');
  if (svc?.Quit) {
    await svc.Quit();
    return;
  }
  try {
    (window as unknown as { runtime?: { Quit?: () => void } }).runtime?.Quit?.();
  } catch {
    /* not running under Wails */
  }
}
