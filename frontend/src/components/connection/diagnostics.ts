/**
 * Diagnostics of the running app for About ▸ Copy diagnostics and Help ▸
 * Report Issue (CONN-14): build (UIService.GetAppInfo), web view engine
 * (user agent) and the active connection's server type. Never host names,
 * DNs or credentials.
 */
import { GetAppInfo } from '../../lib/wails-app'
import { useConnectionStore } from '../../stores/connectionStore'
import { ensureServerType } from '../ui/commands'
import { openExternal } from '../layout/shellState'
import { ISSUES_URL, newIssueURL, type DiagnosticsInput } from './chromeLogic'

/** Engine tokens of the user agent ("AppleWebKit/605.1.15", "Edg/131.0…"), not the whole string. */
export function webViewEngine(ua: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  return (ua.match(/\b(?:Edg|Chrome|Version|AppleWebKit|Firefox)\/[\d.]+/g) ?? []).join(' ')
}

export async function collectDiagnostics(): Promise<DiagnosticsInput> {
  const info = await GetAppInfo()
  const cs = useConnectionStore.getState()
  const id = cs.activeProfileId
  let serverType: string | null = null
  if (id && cs.connectionStatuses[id]) serverType = await ensureServerType(id).catch(() => null)
  return {
    version: info?.version ?? 'dev',
    commit: info?.commit,
    buildDate: info?.buildDate,
    modified: info?.modified,
    goVersion: info?.goVersion,
    wailsVersion: info?.wailsVersion,
    webView: info?.webView,
    userAgent: webViewEngine(),
    os: info?.os,
    arch: info?.arch,
    configDir: info?.configDir,
    serverType,
  }
}

/** Help ▸ Report Issue: GitHub's new-issue form with version, OS and server type prefilled. */
export async function reportIssue(): Promise<void> {
  let d: DiagnosticsInput
  try {
    d = await collectDiagnostics()
  } catch {
    d = { version: 'dev', userAgent: webViewEngine() }
  }
  openExternal(newIssueURL(ISSUES_URL, d))
}
