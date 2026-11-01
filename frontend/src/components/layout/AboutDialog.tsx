/**
 * About LDAPilot (Help ▸ About; moved from the activity bar, SPEC 7.3/7.4).
 * Read-only, so the backdrop and Escape close it (dismissible="always").
 * Shows the build (version, commit, build date; UIService.GetAppInfo), the
 * Go / Wails / web view versions, OS and config directory, and copies them
 * as plain text ("Copy diagnostics") for bug reports.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, Copy, ExternalLink } from 'lucide-react'
import logoImg from '../../assets/logo.png'
import { Dialog, type HostedDialogProps } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import { toast } from '../ui/Toast'
import { openExternal } from './shellState'
import { REPO_URL, ISSUES_URL, diagnosticsText, versionLine, type DiagnosticsInput } from '../connection/chromeLogic'
import { collectDiagnostics } from '../connection/diagnostics'

export { REPO_URL, ISSUES_URL }
const AUTHOR_URL = 'https://www.picillo.de/'

// lucide-react 1.x no longer ships brand icons; GitHub mark from Octicons (MIT).
function GitHubMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.06-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

function InfoRow({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  if (!value) return null
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? 'font-mono break-all select-text' : 'break-words select-text'}>{value}</dd>
    </>
  )
}

export function AboutDialog({ onClose }: HostedDialogProps) {
  // Read-only dialog: focus the harmless Close, never the external author link (Enter would open a browser).
  const closeRef = useRef<HTMLButtonElement>(null)
  const [diag, setDiag] = useState<DiagnosticsInput | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let alive = true
    collectDiagnostics()
      .then((d) => alive && setDiag(d))
      .catch(() => alive && setDiag({ version: 'dev' }))
    return () => {
      alive = false
    }
  }, [])

  const copy = () => {
    if (!diag) return
    navigator.clipboard
      .writeText(diagnosticsText(diag))
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
      .catch((err) => toast.error('Could not copy the diagnostics', err instanceof Error ? err.message : String(err)))
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="About LDAPilot"
      size="sm"
      dismissible="always"
      initialFocus={closeRef}
      footer={
        <>
          <Button variant="secondary" leftIcon={copied ? Check : Copy} onClick={copy} disabled={!diag} className="mr-auto">
            {copied ? 'Copied' : 'Copy diagnostics'}
          </Button>
          <Button ref={closeRef} variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-3 mb-3">
        <img src={logoImg} alt="" className="size-10 rounded-lg shrink-0" />
        <div className="min-w-0">
          <p className="text-lg font-semibold text-foreground">LDAPilot</p>
          <p className="text-sm text-muted-foreground">LDAP and Active Directory management tool</p>
        </div>
      </div>
      {diag ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-sm mb-3" aria-label="Build and environment">
          <InfoRow label="Version" value={versionLine(diag)} mono />
          <InfoRow label="Go" value={diag.goVersion} mono />
          <InfoRow label="Wails" value={diag.wailsVersion} mono />
          <InfoRow label="Web view" value={[diag.webView, diag.userAgent].filter(Boolean).join(' · ')} mono />
          <InfoRow label="OS" value={[diag.os, diag.arch].filter(Boolean).join(' ')} />
          <InfoRow label="Config" value={diag.configDir} mono />
        </dl>
      ) : (
        <div className="mb-3">
          <Spinner size="sm" label="Reading the build information" />
        </div>
      )}
      <p className="text-sm text-foreground mb-3">
        Developed by{' '}
        <Button variant="link" className="text-sm" rightIcon={ExternalLink} onClick={() => openExternal(AUTHOR_URL)}>
          David Picillo
        </Button>
      </p>
      <Button variant="secondary" className="w-full justify-start" leftIcon={<GitHubMark size={14} />} onClick={() => openExternal(REPO_URL)}>
        Bugs and feature requests on GitHub
      </Button>
      <p className="text-xs text-muted-foreground mt-3">© {new Date().getFullYear()} David Picillo</p>
    </Dialog>
  )
}
