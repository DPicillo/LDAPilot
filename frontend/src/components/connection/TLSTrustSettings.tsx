import { useEffect, useId, useRef, useState } from 'react'
import { AlertCircle, Fingerprint, Plus, RefreshCw, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react'
import type { ConnectionProfile } from '../../types/ldap'
import type { CertificateInfo } from '../../types/auth'
import {
  caCheckLines, certValidityState, commonNameOf, formatDate, hasTLSTrustError, normalizeFingerprint, pinDetailText, shortFingerprint, splitPEMCertificates,
} from '../../lib/connectionAuth'
import * as wailsAuth from '../../lib/wails-auth'
import { cn } from '../../lib/utils'
import { Input, Textarea } from '../ui/Input'
import { Button, IconButton } from '../ui/Button'
import { DisclosureButton } from '../ui/Disclosure'
import { Checkbox } from '../ui/Checkbox'
import { Badge } from '../ui/Badge'
import { InlineAlert } from '../ui/InlineAlert'
import { Spinner } from '../ui/Spinner'
import { Field, PathInput } from './FormField'

interface TLSTrustSettingsProps {
  form: ConnectionProfile;
  update: <K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]) => void;
  errors: Record<string, string>;
  /**
   * Incremented by the dialog on every Save/Test blocked by validation, so
   * the section opens again to show its errors even if it was collapsed.
   */
  revealErrors?: number;
  /** Open the section (the status bar's security chip opens Edit Connection here). */
  defaultOpen?: boolean;
  /** SHA-256 fingerprints of CA certificates added from the server ("Use as CA certificate"). */
  serverCAs?: string[];
  /** Reads the server's certificate and fills in the details of the pins (DEF-04). */
  onRefreshPins?: () => void;
  /** State of that refresh: running, or what it found. */
  pinRefresh?: { loading?: boolean; message?: string; tone?: 'info' | 'warning' };
}

/** Delay before a changed CA path / PEM text is checked (DEF-03). */
const CA_CHECK_DEBOUNCE_MS = 450;

interface PastedCA {
  pem: string;
  cert?: CertificateInfo;
  error?: string;
}

/**
 * TLS trust of a profile: custom CA certificate, client certificate for
 * mutual TLS, pinned server certificates and (discouraged) skipping
 * verification.
 */
export function TLSTrustSettings({ form, update, errors, revealErrors = 0, defaultOpen = false, serverCAs = [], onRefreshPins, pinRefresh }: TLSTrustSettingsProps) {
  const pins = form.tlsPinnedCerts ?? [];
  const hasCA = !!(form.tlsCACertFile?.trim() || form.tlsCACertPEM?.trim());
  const hasClientCert = !!(form.tlsClientCertFile?.trim() || form.tlsClientKeyFile?.trim());
  const [open, setOpen] = useState(defaultOpen || hasCA || hasClientCert || pins.length > 0 || form.tlsSkipVerify);
  const [showPEM, setShowPEM] = useState(false);
  // The pasted / server CA certificates, described one by one (Remove per certificate).
  const [pasted, setPasted] = useState<PastedCA[]>([]);
  // Pasted text without any PEM certificate block: what the parser says about it.
  const [pemError, setPEMError] = useState<string | null>(null);
  // Checked automatically, debounced while the text is typed or pasted (DEF-03).
  useEffect(() => {
    const text = form.tlsCACertPEM ?? '';
    const blocks = splitPEMCertificates(text);
    if (blocks.length === 0) setPasted([]);
    if (!text.trim()) {
      setPEMError(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      if (blocks.length === 0) {
        wailsAuth.DescribeCACertificates('', text)
          .then(() => alive && setPEMError(null))
          .catch((err: unknown) => alive && setPEMError(err instanceof Error ? err.message : String(err)));
        return;
      }
      setPEMError(null);
      Promise.all(blocks.map((pem) =>
        wailsAuth.DescribeCACertificates('', pem)
          .then((certs): PastedCA => ({ pem, cert: certs[0] }))
          .catch((err: unknown): PastedCA => ({ pem, error: err instanceof Error ? err.message : String(err) })),
      )).then((list) => alive && setPasted(list));
    }, blocks.length > 0 && pasted.length === 0 ? 0 : CA_CHECK_DEBOUNCE_MS);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `pasted` only picks the first delay
  }, [form.tlsCACertPEM]);
  const removePastedCA = (pem: string) => {
    const rest = splitPEMCertificates(form.tlsCACertPEM ?? '').filter((b) => b !== pem);
    update('tlsCACertPEM', rest.join('\n'));
  };
  // The CA file is checked automatically when its path changes (debounced) and on open (DEF-03).
  const [caInfo, setCAInfo] = useState<{ file: string; certs?: CertificateInfo[]; error?: string; loading?: boolean } | null>(null);
  const [caCheckSeq, setCACheckSeq] = useState(0);
  // "Check again" reads at once; typing the path waits for a pause.
  const checkNow = useRef(false);
  const caFile = form.tlsCACertFile?.trim() ?? '';
  useEffect(() => {
    if (!caFile) {
      setCAInfo(null);
      return;
    }
    let alive = true;
    setCAInfo((cur) => ({ file: caFile, loading: true, certs: cur?.file === caFile ? cur.certs : undefined }));
    const t = setTimeout(() => {
      wailsAuth.DescribeCACertificates(caFile, '')
        .then((certs) => alive && setCAInfo({ file: caFile, certs }))
        .catch((err: unknown) => alive && setCAInfo({ file: caFile, error: err instanceof Error ? err.message : String(err) }));
    }, checkNow.current ? 0 : CA_CHECK_DEBOUNCE_MS);
    checkNow.current = false;
    return () => { alive = false; clearTimeout(t); };
  }, [caFile, caCheckSeq]);
  const [newPin, setNewPin] = useState('');
  const [pinError, setPinError] = useState('');
  const hasError = hasTLSTrustError(errors);
  const regionId = `tls${useId().replace(/:/g, '')}`;

  // Open when one of the fields in here has an error (e.g. the client
  // certificate SASL EXTERNAL needs), otherwise Save/Test seem to do nothing.
  useEffect(() => {
    if (hasError) setOpen(true);
  }, [hasError, revealErrors]);

  const summary = form.tlsSkipVerify
    ? 'verification disabled'
    : [hasCA && 'custom CA', pins.length > 0 && `${pins.length} pinned`, hasClientCert && 'client certificate']
        .filter(Boolean).join(', ') || 'system trust store';

  const caLines = caInfo?.certs ? caCheckLines(caInfo.certs) : [];
  const pinsWithoutDetails = pins.filter((fp) => !form.tlsPinnedInfo?.[normalizeFingerprint(fp) ?? fp]?.subject).length;

  function addPin() {
    const fp = normalizeFingerprint(newPin);
    if (!fp) {
      setPinError('Enter a SHA-256 fingerprint (64 hex digits, colons optional)');
      return;
    }
    if (!pins.includes(fp)) update('tlsPinnedCerts', [...pins, fp]);
    setNewPin('');
    setPinError('');
  }

  return (
    <div className="border border-border rounded">
      {/* The shared disclosure trigger (same chevron as Advanced settings / Password storage). */}
      <DisclosureButton
        open={open}
        onToggle={() => setOpen(!open)}
        controls={regionId}
        icon={hasError
          ? <AlertCircle size={14} aria-hidden className="shrink-0 text-destructive" />
          : form.tlsSkipVerify
            ? <ShieldAlert size={14} aria-hidden className="shrink-0 text-warning" />
            : <ShieldCheck size={14} aria-hidden className="shrink-0 text-success" />}
        className="w-full px-2 h-control rounded text-foreground hover:bg-accent focus-visible:-outline-offset-2"
      >
        <span className="font-medium shrink-0">TLS trust</span>
        <span className={cn('truncate', form.tlsSkipVerify ? 'text-warning' : 'text-muted-foreground')}>- {summary}</span>
        {hasError && !open && <span className="ml-auto shrink-0 text-destructive">needs attention</span>}
      </DisclosureButton>

      {open && (
        <div id={regionId} className="px-3 pb-3 pt-1 space-y-3">
          {/* CA certificate */}
          <Field
            label="CA certificate (optional)"
            error={errors.tlsCACertFile}
            help="Trusted in addition to the system trust store. PEM or DER file, or paste PEM."
          >
            <PathInput
              value={form.tlsCACertFile ?? ''}
              onChange={(v) => update('tlsCACertFile', v)}
              onBrowse={async () => { const p = await wailsAuth.BrowseCertificateFile('ca'); if (p) update('tlsCACertFile', p); }}
              placeholder="/path/to/ca.pem"
            />
          </Field>
          {/* What the CA file holds, checked when the path changes (DEF-03). */}
          {caFile && (
            <div className="-mt-1.5 space-y-0.5 text-xs" role="status" aria-live="polite" aria-label="CA certificate file check">
              {caInfo?.loading && !caInfo.certs && (
                <p className="flex items-center gap-1.5 text-muted-foreground">
                  <Spinner size="sm" decorative /> Checking the CA certificate file…
                </p>
              )}
              {caInfo?.error && (
                <p className="flex items-start gap-1.5 text-destructive break-words">
                  <AlertCircle size={12} aria-hidden className="shrink-0 mt-0.5" />
                  <span className="min-w-0">{caInfo.error}</span>
                </p>
              )}
              {caLines.map((l, i) => (
                <p key={`${l.name}-${i}`} className="flex items-center gap-1.5 min-w-0">
                  {l.tone === 'ok' ? (
                    <ShieldCheck size={12} aria-hidden className="shrink-0 text-success" />
                  ) : (
                    <ShieldAlert size={12} aria-hidden className={cn('shrink-0', l.tone === 'danger' ? 'text-destructive' : 'text-warning')} />
                  )}
                  <span className="text-foreground truncate" title={caInfo?.certs?.[i]?.subject}>{l.name}</span>
                  <span className={cn('shrink-0', l.tone === 'danger' ? 'text-destructive' : l.tone === 'warning' ? 'text-warning' : 'text-muted-foreground')}>{l.text}</span>
                </p>
              ))}
            </div>
          )}
          <div className="flex items-center gap-3 -mt-1.5">
            <Button variant="link" size="sm" onClick={() => setShowPEM(!showPEM)} aria-expanded={showPEM}>
              {showPEM ? 'Hide PEM text' : form.tlsCACertPEM?.trim() ? 'Edit PEM text' : 'Paste PEM instead'}
            </Button>
            {caFile && (
              <Button variant="link" size="sm" onClick={() => { checkNow.current = true; setCACheckSeq((n) => n + 1); }} disabled={caInfo?.loading} title="Read the CA certificate file again">
                Check again
              </Button>
            )}
          </div>
          {pasted.length > 0 && (
            <ul className="space-y-1 -mt-1.5" aria-label="CA certificates stored in the profile">
              {pasted.map((p, i) => {
                const fromServer = !!p.cert && serverCAs.includes(p.cert.sha256);
                const expired = !!p.cert && certValidityState(p.cert) === 'expired';
                const name = p.cert ? commonNameOf(p.cert.subject) : `Certificate ${i + 1}`;
                return (
                  <li key={p.pem} className="flex items-center gap-1.5 text-xs pl-2 pr-0.5 min-h-control-sm rounded bg-muted">
                    <ShieldCheck size={12} aria-hidden className={cn('shrink-0', expired || p.error ? 'text-destructive' : 'text-success')} />
                    <span className="min-w-0 flex-1 truncate" title={p.cert?.subject ?? p.error}>
                      <span className="text-muted-foreground">{fromServer ? 'CA from server: ' : 'CA certificate: '}</span>
                      <span className="text-foreground">{name}</span>
                      {p.cert && <span className="text-muted-foreground">, {expired ? 'expired' : 'expires'} {formatDate(p.cert.notAfter)}</span>}
                      {p.error && <span className="text-destructive"> - {p.error}</span>}
                    </span>
                    {expired && <Badge size="sm" tone="danger" className="shrink-0">expired</Badge>}
                    <Button variant="ghost" size="sm" leftIcon={Trash2} onClick={() => removePastedCA(p.pem)} aria-label={`Remove CA certificate ${name}`} className="shrink-0">
                      Remove
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          {showPEM && (
            <Field label="CA certificate (PEM)" error={pemError ?? undefined}>
              <Textarea
                value={form.tlsCACertPEM ?? ''}
                onChange={(e) => update('tlsCACertPEM', e.target.value)}
                placeholder={'-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----'}
                rows={4}
                mono
                className="text-xs"
                spellCheck={false}
              />
            </Field>
          )}
          {!showPEM && pemError && <InlineAlert tone="danger" body={`CA certificate (PEM): ${pemError}`} />}

          {/* Client certificate */}
          <div className="flex gap-3">
            <Field className="flex-1 min-w-0" label="Client certificate (mutual TLS)" error={errors.tlsClientCertFile}>
              <PathInput
                value={form.tlsClientCertFile ?? ''}
                onChange={(v) => update('tlsClientCertFile', v)}
                onBrowse={async () => { const p = await wailsAuth.BrowseCertificateFile('cert'); if (p) update('tlsClientCertFile', p); }}
                placeholder="client.crt"
              />
            </Field>
            <Field className="flex-1 min-w-0" label="Private key" help="PEM, unencrypted. Only the path is stored.">
              <PathInput
                value={form.tlsClientKeyFile ?? ''}
                onChange={(v) => update('tlsClientKeyFile', v)}
                onBrowse={async () => { const p = await wailsAuth.BrowseCertificateFile('key'); if (p) update('tlsClientKeyFile', p); }}
                placeholder="client.key"
              />
            </Field>
          </div>

          {/* Pinned certificates */}
          <Field
            label="Pin a server certificate"
            error={errors.tlsPinnedCerts || pinError}
            help="Pinned certificates are trusted even if issuer, host name or validity cannot be verified. Use Test Connection to pin the server's certificate."
          >
            <div className="flex gap-1.5">
              <Input
                value={newPin}
                onChange={(e) => { setNewPin(e.target.value); setPinError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPin(); } }}
                placeholder="SHA-256 fingerprint, e.g. 4F:75:4D:..."
                mono
                spellCheck={false}
              />
              <Button variant="secondary" leftIcon={Plus} onClick={addPin} disabled={!newPin.trim()} className="shrink-0">
                Pin
              </Button>
            </div>
          </Field>
          {pins.length > 0 && (
            <ul className="space-y-1 -mt-1.5" aria-label="Pinned server certificates">
              {pins.map((fp) => {
                // Subject, issuer and expiry when known (DEF-04); manual and older pins have none.
                const info = form.tlsPinnedInfo?.[normalizeFingerprint(fp) ?? fp];
                const detail = pinDetailText(info);
                const expired = !!info?.notAfter && new Date(info.notAfter) < new Date();
                const pinnedAt = form.tlsPinnedAt?.[fp];
                return (
                  <li key={fp} className="flex items-center gap-1.5 text-xs pl-2 pr-0.5 py-0.5 min-h-control-sm rounded bg-muted">
                    <Fingerprint size={12} aria-hidden className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className={cn('block truncate', detail ? 'text-foreground' : 'text-muted-foreground italic')} title={info ? [info.subject, info.issuer && `Issuer: ${info.issuer}`].filter(Boolean).join('\n') : undefined}>
                        {detail ?? 'Certificate details not known (manual or older pin)'}
                      </span>
                      <span className="block font-mono truncate text-muted-foreground" title={fp}>
                        {shortFingerprint(fp)}
                        {pinnedAt && <span className="font-sans"> · pinned {formatDate(pinnedAt)}</span>}
                      </span>
                    </span>
                    {expired && <Badge size="sm" tone="danger" className="shrink-0">expired</Badge>}
                    <IconButton
                      label={`Remove pin ${shortFingerprint(fp)}`}
                      icon={Trash2}
                      size="sm"
                      className="enabled:hover:text-destructive"
                      onClick={() => update('tlsPinnedCerts', pins.filter((p) => p !== fp))}
                    />
                  </li>
                );
              })}
            </ul>
          )}
          {pins.length > 0 && onRefreshPins && (pinsWithoutDetails > 0 || pinRefresh) && (
            <div className="-mt-1.5 flex items-center gap-2 min-w-0 text-xs" role="status" aria-live="polite">
              {pinsWithoutDetails > 0 && (
                <Button variant="link" size="sm" leftIcon={RefreshCw} onClick={onRefreshPins} disabled={pinRefresh?.loading} className="shrink-0" title="Reads the certificate the server presents now (no bind)">
                  {pinRefresh?.loading && <Spinner size="sm" decorative />}
                  Refresh details from the server
                </Button>
              )}
              {pinRefresh?.message && (
                <span className={cn('min-w-0 break-words', pinRefresh.tone === 'warning' ? 'text-warning' : 'text-muted-foreground')}>{pinRefresh.message}</span>
              )}
            </div>
          )}

          {/* Skip verification - discouraged */}
          <Checkbox
            checked={form.tlsSkipVerify}
            onCheckedChange={(c) => update('tlsSkipVerify', c)}
            label="Skip certificate verification (insecure, not recommended)"
          />
          {form.tlsSkipVerify && (
            <InlineAlert
              tone="warning"
              body="Any server - including an attacker on the network path - is accepted and receives your credentials. Pin the server certificate or configure its CA instead."
            />
          )}
        </div>
      )}
    </div>
  );
}
