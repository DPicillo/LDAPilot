import { useEffect, useMemo, useState } from 'react'
import {
  Download, Upload, X, ShieldCheck, ShieldAlert, ShieldX, ChevronDown, ChevronRight,
  Copy, Check, Loader2, FileImage, Binary, Lock, MailCheck, TriangleAlert,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import {
  asciiPreview, base64ByteLength, base64ToBytes, binaryKind, certValidity, commonName, formatByteSize,
  hexDump, hexPreview, imageDataUrl, imageFormatName, isPKCS7SignedData, isSMIMEAttribute, sniffImageMime, toPEM,
} from '../../lib/binary'
import { DescribeCertificate, DescribePKCS7 } from '../../lib/wails-binary'
import { certAltNameLine, certAltNames, certExpiryNote, certPurpose } from './certificateCard'
import type { CertificateSummary, PKCS7Summary } from '../../types/binary'
import { Badge, type BadgeTone } from '../ui/Badge'
import { Button, IconButton } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { toast } from '../ui/Toast'

/** Per-value actions; omitted actions are not offered. */
export interface BinaryValueActions {
  onDownload?: () => void;
  onReplace?: () => void;
  onRemove?: () => void;
}

/** Bytes shown in the expanded hex dump. */
const HEX_DUMP_LIMIT = 4096;

/**
 * One value of a binary attribute (base64): images (JPEG/PNG/GIF by magic
 * bytes) as thumbnail (click to enlarge), X.509 certificates as summary,
 * PKCS #7 SignedData (userSMIMECertificate) with its embedded certificates,
 * everything else, incl. photo attributes holding non-image data, as size
 * plus hex preview. `compact` renders a single line for dense lists (edit dialog).
 */
export function BinaryValueView({ attrName, value, actions, compact = false }: {
  attrName: string;
  value: string;
  actions?: BinaryValueActions;
  compact?: boolean;
}) {
  const kind = binaryKind(attrName);
  // Photo attributes, and any other binary value that turns out to be a JPEG/PNG/GIF
  const imageUrl = useMemo(() => (kind === 'image' || kind === 'other' ? imageDataUrl(value) : null), [kind, value]);

  let body: React.ReactNode;
  if (imageUrl) {
    body = <ImageValue attrName={attrName} value={value} url={imageUrl} compact={compact} onDownload={actions?.onDownload} />;
  } else if (kind === 'certificate' && isPKCS7SignedData(base64ToBytes(value, 24))) {
    body = <PKCS7Value value={value} compact={compact} />;
  } else if (kind === 'certificate') {
    const unreadable = isSMIMEAttribute(attrName)
      ? 'Neither PKCS #7 S/MIME data nor an X.509 certificate'
      : 'Not a readable X.509 certificate';
    body = <CertificateValue value={value} compact={compact} unreadableLabel={unreadable} />;
  } else if (kind === 'image') {
    // A photo attribute whose value is no JPEG/PNG/GIF: say so instead of a silent hex dump (ED-19).
    body = <HexValue value={value} compact={compact} label="Not a valid image" warn title="The value is not JPEG, PNG or GIF data: it cannot be shown as a photo" />;
  } else {
    body = <HexValue value={value} compact={compact} label={kind === 'security-descriptor' ? 'Security descriptor' : undefined} />;
  }

  // @container: below 18rem the card stacks its details and the action buttons
  // stand in a column, so the value keeps its width (RW1-E-13).
  return (
    <div className="@container flex items-start gap-1 group/bin min-w-0">
      <div className="flex-1 min-w-0">{body}</div>
      {actions && <ValueActionButtons actions={actions} />}
    </div>
  );
}

function ValueActionButtons({ actions }: { actions: BinaryValueActions }) {
  return (
    <div className="flex flex-col @2xs:flex-row gap-0.5 shrink-0">
      {actions.onDownload && <IconButton size="sm" label="Save value to file" icon={Download} revealOnRowHover onClick={actions.onDownload} />}
      {actions.onReplace && <IconButton size="sm" label="Replace value from file" icon={Upload} revealOnRowHover onClick={actions.onReplace} />}
      {actions.onRemove && <IconButton size="sm" label="Remove this value" icon={X} revealOnRowHover className="enabled:hover:text-destructive" onClick={actions.onRemove} />}
    </div>
  );
}

// --- Images ---

function ImageValue({ attrName, value, url, compact, onDownload }: {
  attrName: string;
  value: string;
  url: string;
  compact: boolean;
  onDownload?: () => void;
}) {
  const [enlarged, setEnlarged] = useState(false);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [broken, setBroken] = useState(false);
  const bytes = base64ByteLength(value);
  const format = imageFormatName(sniffImageMime(base64ToBytes(value, 16)));

  if (broken) {
    return <HexValue value={value} compact={compact} label={`Unreadable ${format} image`} warn title="The image data is damaged or incomplete" />;
  }

  return (
    <div className={cn('flex flex-wrap gap-x-2 gap-y-0.5', compact ? 'items-center' : 'items-start')}>
      <button type="button"
        onClick={() => setEnlarged(true)}
        aria-label={`Enlarge ${attrName}`}
        className="shrink-0 rounded border border-border bg-background hover:border-primary"
        title="Click to enlarge"
      >
        <img
          src={url}
          alt={attrName}
          className={cn('object-contain rounded', compact ? 'max-w-[32px] max-h-[32px]' : 'max-w-[120px] max-h-[120px]')}
          onLoad={(e) => setSize({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={() => setBroken(true)}
        />
      </button>
      <span className="text-xs text-muted-foreground whitespace-nowrap">
        {format} · {size ? `${size.w}×${size.h} · ` : ''}{formatByteSize(bytes)}
      </span>
      {enlarged && (
        <ImagePreviewDialog
          url={url}
          title={attrName}
          caption={`${format} · ${size ? `${size.w}×${size.h} px · ` : ''}${formatByteSize(bytes)}`}
          natural={size}
          onDownload={onDownload}
          onClose={() => setEnlarged(false)}
        />
      )}
    </div>
  );
}

/**
 * Enlarged image (read-only dialog: Escape, the close button or a click
 * outside closes it). Small photos (96 px thumbnails) are scaled up to fill
 * the view, pixelated rather than blurred (ED-19).
 */
function ImagePreviewDialog({ url, title, caption, natural, onDownload, onClose }: {
  url: string;
  title: string;
  caption: string;
  natural?: { w: number; h: number } | null;
  onDownload?: () => void;
  onClose: () => void;
}) {
  const small = !!natural && Math.max(natural.w, natural.h) < 240;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="xl"
      dismissible="always"
      icon={<FileImage size={16} strokeWidth={1.75} aria-hidden className="text-primary" />}
      title={<span className="font-mono">{title}</span>}
      description={caption}
      footer={
        <>
          {onDownload && <Button variant="secondary" leftIcon={Download} onClick={onDownload} className="mr-auto">Save…</Button>}
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </>
      }
    >
      <img
        src={url}
        alt={title}
        style={small ? { imageRendering: 'pixelated' } : undefined}
        className="block mx-auto w-full h-[480px] object-contain rounded border border-border bg-background"
      />
    </Dialog>
  );
}

// --- Certificates ---

/** Parsed values by base64 value; values never change, so results are cached for the session. */
const certCache = new Map<string, Promise<CertificateSummary>>();
const pkcs7Cache = new Map<string, Promise<PKCS7Summary>>();
const DESCRIBE_CACHE_LIMIT = 200;

function describeCached<T>(cache: Map<string, Promise<T>>, value: string, describe: (v: string) => Promise<T>): Promise<T> {
  let p = cache.get(value);
  if (!p) {
    if (cache.size >= DESCRIBE_CACHE_LIMIT) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    p = describe(value);
    cache.set(value, p);
    p.catch(() => cache.delete(value));
  }
  return p;
}

/** The certificate summary of a base64 value (cached for the session; shared with the value picker). */
export function describeCertificateCached(value: string): Promise<CertificateSummary> {
  return describeCached(certCache, value, DescribeCertificate);
}

/** Loads a description of value (cached); null while loading. */
function useDescribed<T>(cache: Map<string, Promise<T>>, value: string, describe: (v: string) => Promise<T>) {
  const [result, setResult] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError(null);
    describeCached(cache, value, describe).then(
      (r) => { if (!cancelled) setResult(r); },
      (e) => { if (!cancelled) setError(errorText(e)); },
    );
    return () => { cancelled = true; };
  }, [cache, value, describe]);
  return { result, error };
}

function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  return 'Failed to parse certificate';
}

function CertificateValue({ value, compact, unreadableLabel }: { value: string; compact: boolean; unreadableLabel: string }) {
  const { result: info, error } = useDescribed(certCache, value, DescribeCertificate);

  if (error) {
    return <HexValue value={value} compact={compact} label={unreadableLabel} title={error} />;
  }
  if (!info) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 size={12} className="animate-spin" /> Reading certificate…
      </span>
    );
  }
  return <CertificateDetails info={info} compact={compact} />;
}

/**
 * A certificate: name, validity, CA / self-signed; issuer and dates; what it
 * is for (EKU, else key usage); its main alternative names; an expiry warning
 * with the date (DEF-12). Expandable to all details unless compact. A
 * container query stacks label and value of the details below 20rem and the
 * badges wrap under the name, so the name never disappears (RW1-E-13).
 */
function CertificateDetails({ info, compact }: { info: CertificateSummary; compact: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const validity = certValidity(info.notBefore, info.notAfter);
  const subjectCN = commonName(info.subject);
  const purpose = certPurpose(info);
  const alt = certAltNameLine(info);
  const expiry = certExpiryNote(info);

  if (compact) {
    return (
      <span
        className="flex items-center gap-1.5 min-w-0"
        title={[info.subject, `Issuer: ${info.issuer}`, `Valid until ${formatCertDate(info.notAfter)}`, purpose && `For: ${purpose}`, expiry?.text].filter(Boolean).join('\n')}
      >
        <ValidityBadge status={validity.status} days={validity.days} />
        <span className="truncate">{subjectCN}</span>
      </span>
    );
  }

  const altNames = certAltNames(info);
  const ekuOids = info.extKeyUsageOids ?? [];
  const critical = (on?: boolean) => (on ? ' (critical)' : '');
  const urls = (label: string, list?: string[]) => (list && list.length > 0 ? <DetailRow label={label} value={list.join('\n')} /> : null);

  return (
    <div className="@container rounded border border-border bg-background px-2 py-1 space-y-0.5 min-w-0">
      <div className="flex items-start gap-1.5 min-w-0">
        <IconButton size="sm" label={expanded ? 'Hide details' : 'Show details'} icon={expanded ? ChevronDown : ChevronRight} aria-expanded={expanded} noTooltip className="-ml-1 shrink-0" onClick={() => setExpanded(!expanded)} />
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0 flex-1 pt-0.5">
          <span className="font-medium truncate min-w-0 max-w-full" title={info.subject}>{subjectCN}</span>
          <span className="flex flex-wrap items-center gap-1">
            <ValidityBadge status={validity.status} days={validity.days} />
            {info.isCA && <Tag>CA</Tag>}
            {info.selfSigned && <Tag>self-signed</Tag>}
          </span>
        </div>
      </div>
      <div className="text-xs text-muted-foreground truncate" title={`Issuer: ${info.issuer}\n${formatCertDate(info.notBefore, true)} – ${formatCertDate(info.notAfter, true)}`}>
        Issued by {commonName(info.issuer)} · {formatCertDate(info.notBefore)} – {formatCertDate(info.notAfter)}
      </div>
      {purpose && (
        <div className="text-xs truncate" title={`${info.extKeyUsage.length ? 'Extended key usage' : 'Key usage'}: ${purpose.split(' · ').join(', ')}`}>
          <span className="text-muted-foreground">For </span>{purpose}
        </div>
      )}
      {alt.text && (
        <div className="text-xs font-mono truncate" title={alt.all}>
          {alt.text}{alt.more > 0 && <span className="font-sans text-muted-foreground"> +{alt.more} more</span>}
        </div>
      )}
      {expiry && (
        <div className={cn('flex items-start gap-1 text-xs', expiry.tone === 'danger' ? 'text-destructive' : 'text-warning')}>
          <TriangleAlert size={12} aria-hidden className="mt-0.5 shrink-0" />
          <span className="min-w-0">{expiry.text}</span>
        </div>
      )}
      {expanded && (
        <div className="grid grid-cols-1 @xs:grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pt-1 text-xs">
          <DetailRow label="Subject" value={info.subject} />
          <DetailRow label="Issuer" value={info.issuer} />
          <DetailRow label="Valid from" value={formatCertDate(info.notBefore, true)} />
          <DetailRow label="Valid until" value={formatCertDate(info.notAfter, true)} />
          <DetailRow label="Serial" value={info.serialNumber} copy />
          {altNames.length > 0 && <DetailRow label="Alt. names" value={altNames.map((n) => `${n.type}: ${n.value}`).join('\n')} />}
          {info.keyUsage.length > 0 && <DetailRow label="Key usage" value={info.keyUsage.join(', ') + critical(info.keyUsageCritical)} />}
          {info.extKeyUsage.length > 0 && (
            <DetailRow
              label="Ext. key usage"
              value={info.extKeyUsage.map((n, i) => (ekuOids[i] && ekuOids[i] !== n ? `${n} (${ekuOids[i]})` : n)).join('\n') + critical(info.extKeyUsageCritical)}
            />
          )}
          {info.isCA && <DetailRow label="CA" value={info.maxPathLen !== undefined && info.maxPathLen >= 0 ? `yes, path length ${info.maxPathLen}` : 'yes'} />}
          {info.template && <DetailRow label="Template" value={info.template} />}
          {info.sid && <DetailRow label="SID" value={info.sid} copy />}
          <DetailRow
            label="Public key"
            value={`${info.publicKeyAlgorithm}${info.publicKeyBits ? ` ${info.publicKeyBits} bit` : ''} · ${info.signatureAlgorithm} · v${info.version} · ${formatByteSize(info.size)}`}
          />
          {urls('CRL', info.crlDistributionPoints)}
          {urls('OCSP', info.ocspServers)}
          {urls('CA issuers', info.issuingCertificateUrls)}
          {info.policyOids && info.policyOids.length > 0 && <DetailRow label="Policies" value={info.policyOids.join('\n')} />}
          <DetailRow label="SHA-1" value={info.sha1Fingerprint} copy />
          <DetailRow label="SHA-256" value={info.sha256Fingerprint} copy />
          <span className="text-muted-foreground mt-1 @xs:mt-0">PEM</span>
          <span><CopyTextButton text={toPEM(info.der)} label="Copy as PEM" /></span>
        </div>
      )}
    </div>
  );
}

/** "1 certificate", "2 certificates". */
function plural(n: number, word: string): string {
  return `${n} ${word}${n !== 1 ? 's' : ''}`;
}

/** PKCS #7 SignedData (userSMIMECertificate): a header plus each embedded certificate. */
function PKCS7Value({ value, compact }: { value: string; compact: boolean }) {
  const { result: summary, error } = useDescribed(pkcs7Cache, value, DescribePKCS7);

  if (error) {
    return <HexValue value={value} compact={compact} label="Unreadable PKCS #7 data" title={error} />;
  }
  if (!summary) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 size={12} className="animate-spin" /> Reading S/MIME data…
      </span>
    );
  }

  const certs = summary.certificates;
  const contents = [
    plural(certs.length, 'certificate'),
    summary.otherCertificates ? `${summary.otherCertificates} other` : '',
    summary.signerCount ? plural(summary.signerCount, 'signer') : 'certificates only',
    formatByteSize(summary.size),
  ].filter(Boolean).join(' · ');

  if (compact) {
    const first = certs[0];
    return (
      <span className="flex items-center gap-1.5 min-w-0" title={`PKCS #7 S/MIME data: ${contents}`}>
        <MailCheck size={12} className="text-muted-foreground shrink-0" />
        {first && <ValidityBadge {...certValidity(first.notBefore, first.notAfter)} />}
        <span className="truncate">{first ? commonName(first.subject) : 'PKCS #7, no certificates'}</span>
        {certs.length > 1 && <span className="text-xs text-muted-foreground shrink-0">+{certs.length - 1}</span>}
      </span>
    );
  }

  return (
    <div className="rounded border border-border bg-background px-2 py-1 space-y-1 min-w-0">
      <div className="flex items-center gap-1.5 min-w-0 text-xs text-muted-foreground">
        <MailCheck size={12} className="shrink-0" />
        <span className="truncate">PKCS #7 S/MIME data · {contents}</span>
        <CopyTextButton text={toPEM(value, 'PKCS7')} label="Copy as PEM" />
      </div>
      {certs.map((c, i) => <CertificateDetails key={`${i}-${c.sha256Fingerprint}`} info={c} compact={false} />)}
    </div>
  );
}

function formatCertDate(iso: string, withTime = false): string {
  // RFC 3339 UTC from the backend: "2027-01-02T03:04:05Z"
  return withTime ? iso.replace('T', ' ').replace('Z', ' UTC') : iso.slice(0, 10);
}

function ValidityBadge({ status, days }: { status: ReturnType<typeof certValidity>['status']; days: number }) {
  const badge = ({
    valid: { Icon: ShieldCheck, tone: 'success', text: 'valid', title: `Expires in ${days} days` },
    expiring: { Icon: ShieldAlert, tone: 'warning', text: days === 0 ? 'expires today' : `expires in ${days}d`, title: `Expires in ${days} days` },
    expired: { Icon: ShieldX, tone: 'danger', text: 'expired', title: days === 0 ? 'Expired today' : `Expired ${days} days ago` },
    'not-yet-valid': { Icon: ShieldAlert, tone: 'warning', text: 'not yet valid', title: `Valid in ${days} days` },
  } satisfies Record<typeof status, { Icon: typeof ShieldCheck; tone: BadgeTone; text: string; title: string }>)[status];
  return (
    <Badge tone={badge.tone} icon={badge.Icon} className="shrink-0" title={badge.title}>
      {badge.text}
    </Badge>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return <Badge className="shrink-0">{children}</Badge>;
}

/** What a detail row's copy button copies ("Copy SHA-1 fingerprint", "SHA-1 fingerprint copied"). */
const DETAIL_COPY_NAMES: Record<string, string> = { Serial: 'serial number', 'SHA-1': 'SHA-1 fingerprint', 'SHA-256': 'SHA-256 fingerprint' };

function DetailRow({ label, value, copy }: { label: string; value: string; copy?: boolean }) {
  return (
    <>
      <span className="text-muted-foreground whitespace-nowrap mt-1 @xs:mt-0">{label}</span>
      <span className="font-mono break-all whitespace-pre-wrap flex items-start gap-1 min-w-0">
        <span className="min-w-0">{value}</span>
        {copy && <CopyTextButton text={value} what={DETAIL_COPY_NAMES[label] ?? label} />}
      </span>
    </>
  );
}

/** Copy button with the same "… copied" toast as every other copy verb (RW2-E-05). `what`: "SHA-1 fingerprint". */
function CopyTextButton({ text, label, what }: { text: string; label?: string; what?: string }) {
  const [copied, setCopied] = useState(false);
  const thing = what ?? (label === 'Copy as PEM' ? 'PEM' : 'value');
  const name = label || `Copy ${thing}`;
  return (
    <button type="button"
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text).then(
          () => toast.success(`${thing.charAt(0).toUpperCase()}${thing.slice(1)} copied`),
          () => toast.error('Could not copy to the clipboard'),
        );
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      aria-label={label ? undefined : name}
      className="inline-flex items-center gap-1 p-0.5 rounded-xs text-muted-foreground hover:text-foreground hover:bg-accent shrink-0"
      title={name}
    >
      {copied ? <Check size={12} strokeWidth={1.75} aria-hidden className="text-success" /> : <Copy size={12} strokeWidth={1.75} aria-hidden />}
      {label && <span>{copied ? 'Copied' : label}</span>}
    </button>
  );
}

// --- Other binary data ---

function HexValue({ value, compact, label, title, warn }: { value: string; compact: boolean; label?: string; title?: string; warn?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const total = base64ByteLength(value);
  const head = useMemo(() => base64ToBytes(value, 16), [value]);
  const dump = useMemo(() => (expanded ? hexDump(base64ToBytes(value, HEX_DUMP_LIMIT)) : ''), [expanded, value]);
  const isSD = label === 'Security descriptor';

  return (
    <div className="min-w-0" title={title}>
      <div className="flex items-center gap-1.5 min-w-0">
        {!compact && (
          <IconButton size="sm" label={expanded ? 'Hide hex dump' : 'Show hex dump'} icon={expanded ? ChevronDown : ChevronRight} aria-expanded={expanded} noTooltip className="-ml-1" onClick={() => setExpanded(!expanded)} />
        )}
        {warn ? (
          <TriangleAlert size={12} aria-hidden className="text-warning shrink-0" />
        ) : isSD ? (
          <Lock size={12} className="text-muted-foreground shrink-0" />
        ) : (
          <Binary size={12} className="text-muted-foreground shrink-0" />
        )}
        <span className={cn('italic shrink-0', warn ? 'text-warning' : 'text-muted-foreground')}>{label ? `${label}, ` : ''}{formatByteSize(total)}</span>
        {total > 0 && (
          <span className="font-mono text-xs text-muted-foreground truncate">
            {hexPreview(head, compact ? 8 : 16, total)}
            {!compact && <span className="ml-2 text-muted-foreground">|{asciiPreview(head, 16, total)}|</span>}
          </span>
        )}
      </div>
      {expanded && (
        <div className="mt-1">
          <pre className="text-xs leading-4 font-mono bg-background border border-border rounded p-1.5 overflow-x-auto whitespace-pre select-text">{dump}</pre>
          {total > HEX_DUMP_LIMIT && (
            <div className="text-xs text-muted-foreground mt-0.5">First {formatByteSize(HEX_DUMP_LIMIT)} of {formatByteSize(total)} — save the value to see all of it.</div>
          )}
        </div>
      )}
    </div>
  );
}
