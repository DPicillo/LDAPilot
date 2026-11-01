import { useState } from 'react'
import { ChevronDown, ChevronRight, Copy, Check, ScrollText, Fingerprint, ShieldCheck } from 'lucide-react'
import type { CertificateInfo } from '../../types/auth'
import { certValidityState, commonNameOf, formatDate } from '../../lib/connectionAuth'
import { cn } from '../../lib/utils'
import { Button, IconButton } from '../ui/Button'
import { Badge } from '../ui/Badge'

interface CertificateChainViewProps {
  /** Chain as presented by the server, leaf first. */
  chain: CertificateInfo[];
  /** Fingerprints already pinned in the profile. */
  pinned?: string[];
  /** Offers "Trust this certificate" on the leaf when set. */
  onTrust?: (fingerprint: string) => void;
  trustLabel?: string;
  /** Offers "Use as CA certificate" on CA certificates when set (the certificate is passed for its expiry). */
  onUseAsCA?: (pem: string, cert: CertificateInfo) => void;
}

/** Shows a server certificate chain with fingerprints and trust actions. */
export function CertificateChainView({ chain, pinned = [], onTrust, trustLabel = 'Trust this certificate', onUseAsCA }: CertificateChainViewProps) {
  return (
    <div className="space-y-1.5">
      {chain.map((cert, i) => (
        <CertificateCard
          key={cert.sha256 + i}
          cert={cert}
          role={i === 0 ? 'Server certificate' : cert.selfSigned ? 'Root CA' : 'Intermediate CA'}
          defaultOpen={i === 0}
          pinned={pinned.includes(cert.sha256)}
          onTrust={i === 0 ? onTrust : undefined}
          trustLabel={trustLabel}
          onUseAsCA={cert.isCA ? onUseAsCA : undefined}
        />
      ))}
    </div>
  );
}

function CertificateCard({ cert, role, defaultOpen, pinned, onTrust, trustLabel, onUseAsCA }: {
  cert: CertificateInfo;
  role: string;
  defaultOpen: boolean;
  pinned: boolean;
  onTrust?: (fingerprint: string) => void;
  trustLabel: string;
  onUseAsCA?: (pem: string, cert: CertificateInfo) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState<'fp' | 'pem' | null>(null);
  const validity = certValidityState(cert);
  const sans = [...(cert.dnsNames ?? []), ...(cert.ipAddresses ?? [])];

  function copy(what: 'fp' | 'pem') {
    navigator.clipboard.writeText(what === 'fp' ? cert.sha256 : cert.pem);
    setCopied(what);
    setTimeout(() => setCopied(null), 1500);
  }

  return (
    <div className="border border-border rounded bg-background">
      <button type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left hover:bg-accent rounded outline-hidden focus-ring-inset"
      >
        {open ? <ChevronDown size={12} aria-hidden className="shrink-0" /> : <ChevronRight size={12} aria-hidden className="shrink-0" />}
        <ScrollText size={12} aria-hidden className="shrink-0 text-muted-foreground" />
        <span className="text-xs font-medium truncate flex-1">{commonNameOf(cert.subject)}</span>
        <span className="text-xs text-muted-foreground shrink-0">{role}</span>
        {pinned && (
          <Badge tone="primary" icon={Fingerprint} className="shrink-0">pinned</Badge>
        )}
        {validity !== 'valid' && (
          <Badge tone="danger" className="shrink-0">{validity === 'expired' ? 'expired' : 'not yet valid'}</Badge>
        )}
      </button>
      {open && (
        <div className="px-3 pb-2 pt-0.5 space-y-1 text-xs">
          <Row label="Subject" value={cert.subject} />
          <Row label="Issuer" value={cert.issuer} />
          {sans.length > 0 && <Row label="Names (SAN)" value={sans.join(', ')} />}
          <Row
            label="Valid"
            value={`${formatDate(cert.notBefore)} to ${formatDate(cert.notAfter)}`}
            className={validity !== 'valid' ? 'text-destructive' : undefined}
          />
          <Row label="Key" value={`${cert.keyAlgorithm}, ${cert.signatureAlgorithm}`} />
          <Row label="Serial" value={cert.serialNumber} mono />
          <div className="flex gap-2">
            <span className="w-20 shrink-0 text-muted-foreground">SHA-256</span>
            <span className="font-mono break-all select-text flex-1">{cert.sha256}</span>
            <IconButton label={copied === 'fp' ? 'Fingerprint copied' : 'Copy fingerprint'} icon={copied === 'fp' ? Check : Copy} size="sm" onClick={() => copy('fp')} />
          </div>
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            {onTrust && !pinned && (
              <Button variant="primary" size="sm" leftIcon={Fingerprint} onClick={() => onTrust(cert.sha256)}>
                {trustLabel}
              </Button>
            )}
            {onUseAsCA && (
              <Button
                variant="secondary"
                size="sm"
                leftIcon={ShieldCheck}
                onClick={() => onUseAsCA(cert.pem, cert)}
                title={validity === 'expired' ? 'This CA certificate has expired: certificates it issued no longer verify' : 'Trust every certificate this CA issues for the host name'}
              >
                Use as CA certificate
              </Button>
            )}
            <Button variant="secondary" size="sm" leftIcon={copied === 'pem' ? Check : Copy} onClick={() => copy('pem')}>
              {copied === 'pem' ? 'PEM copied' : 'Copy PEM'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, value, mono, className }: { label: string; value: string; mono?: boolean; className?: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className={cn('break-all select-text flex-1', mono && 'font-mono', className)}>{value}</span>
    </div>
  );
}
