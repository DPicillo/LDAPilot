import { useState } from 'react'
import { Check, AlertCircle, AlertTriangle, ShieldX, ChevronDown, ChevronRight } from 'lucide-react'
import type { CertificateInfo, ConnectionTestResult } from '../../types/auth'
import type { ConnectionProfile } from '../../types/ldap'
import { normalizeDN } from '../../lib/dn'
import { Button } from '../ui/Button'
import { certProblemTitle, describeTestSuccess, spnSuggestion, stageLabel } from '../../lib/connectionAuth'
import { CertificateChainView } from './CertificateChainView'

interface ConnectionTestResultViewProps {
  result: ConnectionTestResult;
  pinned: string[];
  /** Pins the fingerprint in the form (saved with the profile). */
  onTrust: (fingerprint: string) => void;
  /** Puts a CA certificate into the form's CA PEM field. */
  onUseAsCA: (pem: string, cert: CertificateInfo) => void;
  /** Sets the form's base DN (naming contexts of the server). */
  onUseBaseDN?: (dn: string) => void;
  /** The form's current base DN (its "Use as base DN" button is shown as chosen). */
  baseDN?: string;
  /** Host and SPN of the form: a failed Kerberos bind suggests ldap/<the server's dnsHostName> (DEF-05). */
  spnProfile?: Pick<ConnectionProfile, 'host' | 'krbSPN'>;
  onUseSPN?: (spn: string) => void;
}

const SERVER_TYPE_LABELS: Record<string, string> = {
  ad: 'Active Directory',
  openldap: 'OpenLDAP',
  '389ds': '389 Directory Server',
  other: 'LDAP server',
};

/** Report of "Test connection": what worked, or why it failed. */
export function ConnectionTestResultView({ result, pinned, onTrust, onUseAsCA, onUseBaseDN, baseDN = '', spnProfile, onUseSPN }: ConnectionTestResultViewProps) {
  const [showCerts, setShowCerts] = useState(false);

  if (result.success) {
    const certs = result.serverCertificates ?? [];
    return (
      <div className="rounded border border-border text-xs" role="status">
        <div className="flex items-center gap-2 px-3 py-2 bg-success-subtle text-success rounded-t">
          <Check size={14} />
          <span className="font-medium">Connection successful</span>
        </div>
        <ul className="px-3 py-2 space-y-0.5 text-foreground">
          {result.serverType && (
            <li className="break-words">
              Server: {SERVER_TYPE_LABELS[result.serverType] ?? result.serverType}
              {result.vendorName && result.serverType !== 'ad' ? ` (${[result.vendorName, result.vendorVersion].filter(Boolean).join(' ')})` : ''}
            </li>
          )}
          {describeTestSuccess(result).map((line) => <li key={line} className="break-all">{line}</li>)}
        </ul>
        {(result.namingContexts ?? []).length > 0 && (
          <NamingContexts result={result} baseDN={baseDN} onUseBaseDN={onUseBaseDN} />
        )}
        {(result.warnings ?? []).length > 0 && (
          <div className="px-3 pb-2 space-y-1">
            {result.warnings!.map((w) => (
              <div key={w} className="flex items-start gap-1.5 text-warning">
                <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                <span>{w}</span>
              </div>
            ))}
          </div>
        )}
        {certs.length > 0 && (
          <div className="px-3 pb-2">
            <button type="button" onClick={() => setShowCerts(!showCerts)} aria-expanded={showCerts} className="flex items-center gap-1 rounded-xs text-muted-foreground hover:text-foreground outline-hidden focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-1">
              {showCerts ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
              Server certificate ({certs.length} in chain)
            </button>
            {showCerts && (
              <div className="mt-1.5">
                <CertificateChainView
                  chain={certs}
                  pinned={pinned}
                  onTrust={result.tlsVerification === 'skipped' ? onTrust : undefined}
                  trustLabel="Pin this certificate"
                  onUseAsCA={onUseAsCA}
                />
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  const problem = result.certProblem;
  // A refused Kerberos bind with the server's own name at hand: offer its SPN.
  const spn = result.authMethod === 'kerberos' && result.stage === 'bind' && spnProfile ? spnSuggestion(spnProfile, result.dnsHostName) : null;
  return (
    <div className="rounded border border-destructive text-xs" role="alert">
      <div className="flex items-start gap-2 px-3 py-2 bg-destructive-subtle text-destructive rounded-t">
        {problem ? <ShieldX size={14} className="shrink-0 mt-0.5" /> : <AlertCircle size={14} className="shrink-0 mt-0.5" />}
        <div className="min-w-0">
          <div className="font-medium">{problem ? certProblemTitle(problem.kind) : stageLabel(result.stage)}</div>
          <div className="break-words select-text">{result.error}</div>
        </div>
      </div>
      {spn && (
        <div className="px-3 py-2 flex items-center gap-2 flex-wrap text-foreground">
          <span className="min-w-0">
            The server calls itself <span className="font-mono">{result.dnsHostName}</span>; Kerberos needs its SPN.
          </span>
          {onUseSPN && (
            <Button size="sm" variant="secondary" onClick={() => onUseSPN(spn)} className="shrink-0">
              Use SPN {spn}
            </Button>
          )}
        </div>
      )}
      {problem && (
        <div className="px-3 py-2 space-y-2">
          {problem.pinnedChanged && (
            <p className="font-medium text-destructive">
              The server presented a different certificate than the one pinned in this profile
              {(problem.previousPins ?? []).length > 0 && <> (pinned: <span className="font-mono break-all">{problem.previousPins!.map((p) => p.fingerprint).join(', ')}</span>)</>}.
              Verify the new fingerprint with the server administrator before trusting it.
            </p>
          )}
          {(problem.issues ?? []).length > 0 && (
            <ul className="list-disc pl-4 space-y-0.5">
              {problem.issues!.map((issue) => <li key={issue}>{issue}</li>)}
            </ul>
          )}
          <p className="text-muted-foreground">
            Check the fingerprint with the server administrator before trusting it. Pinning trusts exactly this
            certificate, even if its issuer, host name or validity cannot be verified; when the server gets a new
            certificate you will be asked again. To trust a CA instead, use its certificate below or set it under
            TLS trust.
          </p>
          <CertificateChainView chain={problem.chain ?? []} pinned={pinned} onTrust={onTrust} onUseAsCA={onUseAsCA} />
        </div>
      )}
    </div>
  );
}

/** The server's naming contexts with "Use as base DN" (default naming context first). */
function NamingContexts({ result, baseDN, onUseBaseDN }: { result: ConnectionTestResult; baseDN: string; onUseBaseDN?: (dn: string) => void }) {
  const def = result.defaultNamingContext ?? ''
  const list = [...(result.namingContexts ?? [])].sort((a, b) => (a === def ? -1 : b === def ? 1 : 0))
  const current = normalizeDN(baseDN)
  return (
    <div className="px-3 pb-2">
      <p className="text-muted-foreground mb-1">
        Naming contexts{baseDN.trim() ? '' : ' (the empty base DN shows all of them)'}:
      </p>
      <ul className="space-y-0.5" aria-label="Naming contexts of the server">
        {list.map((dn) => {
          const chosen = normalizeDN(dn) === current
          return (
            <li key={dn} className="flex items-center gap-2 min-w-0">
              <span className="font-mono break-all select-text flex-1 min-w-0">
                {dn}
                {dn === def && <span className="ml-1.5 font-sans text-muted-foreground">(default)</span>}
              </span>
              {onUseBaseDN && (
                <Button size="sm" variant={chosen ? 'ghost' : 'secondary'} disabled={chosen} onClick={() => onUseBaseDN(dn)} className="shrink-0">
                  {chosen ? 'Base DN' : 'Use as base DN'}
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
