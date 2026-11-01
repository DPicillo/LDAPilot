import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, ExternalLink, Globe, HardDrive, KeyRound, ShieldAlert, X } from 'lucide-react';
import type { ApprovalRequest, AttrDiff, PasswordPreview } from '../../types/ai';
import type { ApprovalState } from '../../lib/aiReducer';
import { formatCountdown, hasInvisible, mustChangeText } from '../../lib/aiFormat';
import { copyText } from '../../lib/ai';
import { useAIStore } from '../../stores/aiStore';
import { useEditorStore } from '../../stores/editorStore';
import { InvisibleText } from './InvisibleText';
import { tone } from './tone';
import { Badge } from '../ui/Badge';
import { Button, IconButton } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { UnencryptedConsent } from '../password/UnencryptedConsent';
import { UNENCRYPTED_RISK } from '../../lib/unencryptedConsent';
import { InlineAlert } from '../ui/InlineAlert';
import { Input } from '../ui/Input';
import { cn } from '../../lib/utils';
import { decodeAttrValue, describeUacChange } from '../../lib/aiDecode';
import { resolvedText } from '../../lib/aiApproval';
import { hasUnsavedEdits } from '../../stores/unsavedEdits';
import { maskAllPasswords, scanPasswords } from '../../lib/aiPassword';

/**
 * Whether the editor holds unsaved edits of the entry (A-28). The registry
 * is not reactive, so a pending card checks it every second.
 */
function useUnsavedEdits(profileId: string, dn: string, active: boolean): boolean {
  const [on, setOn] = useState(() => active && hasUnsavedEdits(profileId, dn));
  useEffect(() => {
    if (!active) return;
    const check = () => setOn(hasUnsavedEdits(profileId, dn));
    check();
    const t = setInterval(check, 1000);
    return () => clearInterval(t);
  }, [profileId, dn, active]);
  return active && on;
}

const OP_TITLE: Record<string, string> = {
  modify: 'Modify entry',
  create: 'Create entry',
  rename: 'Rename or move entry',
  delete: 'Delete entry',
  group_membership: 'Change group membership',
  unlock: 'Unlock account',
  enable: 'Enable account',
  disable: 'Disable account',
  must_change: 'Require password change at next logon',
  clear_must_change: 'Clear password change at next logon',
  reset_password: 'Reset password',
};

const POLICY_LABEL: Record<string, string> = {
  client: 'hash on the client',
  server: 'server-side hashing',
  ask: 'ask on every write',
  ad: 'Active Directory',
};

/**
 * How a reset stores the password (password track + the connection's
 * password storage policy, GitHub issue #1). Never shows a value. The
 * cleartext-over-plain-LDAP risk is stated here only (red box), not again
 * in the risk list (2b defect 4).
 */
function PasswordStorage({ pw, serverType }: { pw: PasswordPreview; serverType?: string }) {
  return (
    <div className="rounded border border-border px-2 py-1" aria-label="Password storage">
      <div className="mb-0.5 flex items-center gap-1 font-semibold"><KeyRound size={12} aria-hidden /> Password storage</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-px">
        <dt className="text-muted-foreground">Method</dt>
        <dd>{pw.methodLabel || pw.method}</dd>
        {pw.schemeLabel && (
          <>
            <dt className="text-muted-foreground">Stored as</dt>
            <dd>
              {pw.scheme?.toUpperCase() === 'CLEARTEXT'
                ? <>cleartext value, hashed by the server{pw.serverHashes ? '' : ' (server hashing not confirmed)'}</>
                : <Badge tone="success">{pw.schemeLabel}</Badge>}
            </dd>
          </>
        )}
        {pw.policy && (
          <>
            <dt className="text-muted-foreground">Policy</dt>
            <dd>{POLICY_LABEL[pw.policy] ?? pw.policy}{pw.policySummary ? <span className="text-muted-foreground"> — {pw.policySummary}</span> : null}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Must change</dt>
        <dd>{mustChangeText(pw, serverType)}</dd>
      </dl>
      {pw.unencrypted && (
        <InlineAlert tone="danger" className="mt-1 text-xs" body={`${UNENCRYPTED_RISK} Approve only if that is acceptable on this network; LDAPS or StartTLS avoids it.`} />
      )}
      {!pw.unencrypted && pw.cleartextOnWire && <div className="mt-0.5 text-muted-foreground">The password is sent to the server over the encrypted connection; the server hashes it.</div>}
      {(pw.notes ?? []).map((n, i) => (
        <div key={i} className={cn('mt-0.5 flex items-start gap-1', tone.warningText)}><AlertTriangle size={12} className="mt-px shrink-0" aria-hidden /> {n}</div>
      ))}
    </div>
  );
}

function Countdown({ expiresAt }: { expiresAt: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = expiresAt - now;
  if (!expiresAt || left <= 0) return null;
  return <span className="text-xs text-muted-foreground" title="The request is denied automatically when the time runs out">expires in {formatCountdown(left)}</span>;
}

const KIND_TEXT: Record<'removed' | 'added', string> = { removed: 'removed', added: 'added' };

/**
 * Values of one side of the diff. Each value is its own box with spaces
 * kept and wrapped anywhere (never at a soft break that looks like a space
 * in the value), so the exact text can be checked in the narrow card.
 */
function ValueList({ values, kind, attribute }: { values: string[] | null | undefined; kind: 'removed' | 'added' | 'same'; attribute?: string }) {
  const vs = values ?? [];
  if (vs.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <ul className="space-y-0.5">
      {vs.map((v, i) => (
        <li key={i} className="flex min-w-0 flex-wrap items-start gap-x-1">
          {kind !== 'same' && (
            <span aria-hidden className={cn('w-2 shrink-0 font-mono', kind === 'removed' ? tone.dangerText : tone.successText)}>{kind === 'removed' ? '−' : '+'}</span>
          )}
          {kind !== 'same' && <span className="sr-only">{KIND_TEXT[kind]}: </span>}
          <span
            className={cn(
              'inline-block min-w-0 max-w-full rounded-sm border px-1 font-mono whitespace-break-spaces [overflow-wrap:anywhere]',
              kind === 'removed' && cn(tone.dangerBorder, tone.dangerBg, tone.dangerText, 'line-through decoration-1'),
              kind === 'added' && cn(tone.successBorder, tone.successBg, tone.successText),
              kind === 'same' && 'border-border',
            )}
          >
            <InvisibleText text={v} />
          </span>
          <Decoded attribute={attribute} value={v} />
        </li>
      ))}
    </ul>
  );
}

/** The readable form next to a raw account value ("514" → "Account disabled · Normal account"). */
function Decoded({ attribute, value }: { attribute?: string; value: string }) {
  const d = attribute ? decodeAttrValue(attribute, value) : null;
  if (!d || d === value) return null;
  return <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">{d}</span>;
}

/**
 * The exact diff, stacked: attribute name, then Before and After each at
 * the card's full width (three columns side by side left about 80px per
 * value in the sidebar).
 */
function DiffTable({ changes }: { changes: AttrDiff[] }) {
  return (
    <div className="space-y-1" role="list" aria-label="Changes">
      {changes.map((c, i) => {
        const before = c.before ?? [];
        const after = c.after ?? [];
        const removed = before.filter((v) => !after.includes(v));
        const added = after.filter((v) => !before.includes(v));
        const kept = before.filter((v) => after.includes(v));
        const uac = /^useraccountcontrol$/i.test(c.attribute) ? describeUacChange(before, after) : null;
        return (
          <div key={i} role="listitem" className="border-b border-border pb-1 last:border-b-0">
            <div className="flex flex-wrap items-baseline gap-x-1.5">
              <code className="font-mono font-medium [overflow-wrap:anywhere]"><InvisibleText text={c.attribute} /></code>
              <span className="text-muted-foreground">{c.op}</span>
            </div>
            {uac && (
              <div className={cn('mt-0.5', uac.danger.length ? tone.dangerText : 'text-muted-foreground')}>
                {uac.text}
                {uac.danger.map((d, j) => <div key={j} className="flex items-start gap-1"><AlertTriangle size={12} className="mt-px shrink-0" aria-hidden /> {d}</div>)}
              </div>
            )}
            <div className="mt-0.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
              <span className="text-muted-foreground">Before</span>
              <div className="min-w-0">
                {removed.length === 0 && kept.length === 0 ? <span className="text-muted-foreground">—</span> : (
                  <>
                    <ValueList values={removed} kind="removed" attribute={c.attribute} />
                    {kept.length > 0 && <ValueList values={kept} kind="same" attribute={c.attribute} />}
                  </>
                )}
              </div>
              <span className="text-muted-foreground">After</span>
              <div className="min-w-0">
                {added.length === 0 && kept.length === 0 ? <span className="text-muted-foreground">—</span> : (
                  <>
                    <ValueList values={added} kind="added" attribute={c.attribute} />
                    {kept.length > 0 && <ValueList values={kept} kind="same" attribute={c.attribute} />}
                  </>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Approval card (§6.3, §10.2): write approvals with the exact diff, and
 * access requests. Buttons are exactly the request's allowedDecisions. Focus
 * never moves to Approve automatically.
 */
export function ApprovalCard({ state, highlight }: { state: ApprovalState; highlight?: boolean }) {
  const req: ApprovalRequest = state.request;
  const respond = useAIStore((s) => s.respond);
  const stored = useAIStore((s) => s.config?.connectionAccess?.[req.connection.profileId]);
  const [confirmed, setConfirmed] = useState(false);
  // A reset over plain LDAP: the one unencrypted-send consent (DEF-21) as well.
  const [plainConsent, setPlainConsent] = useState(false);
  const [showLdif, setShowLdif] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const editsTarget = req.preview && req.preview.operation !== 'create' ? req.preview.dn : '';
  const unsaved = useUnsavedEdits(req.connection.profileId, editsTarget, !state.resolved && !!editsTarget);

  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlight]);

  const allowed = new Set(req.allowedDecisions ?? []);
  const p = req.preview;
  const isAccess = req.kind === 'access';
  const title = isAccess ? `Access to ${req.connection.label}` : (p && OP_TITLE[p.operation]) || req.toolDisplayName || req.tool;

  if (state.resolved) {
    return (
      <div ref={ref} className="my-1 flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground" role="status">
        {state.resolved.decision.startsWith('approved') ? <Check size={12} className={tone.successText} /> : <X size={12} />}
        <span>
          {title}: {resolvedText(state.resolved.decision, state.resolved.by, req.kind)}
          {state.lateAnswer && ' (this request was already resolved)'}
        </span>
      </div>
    );
  }

  const act = async (decision: string) => {
    setBusy(true);
    try {
      // A password typed into the note is never sent (A-13; Go masks it too).
      await respond(req.approvalId, decision, decision === 'deny' || decision === 'deny_remaining' ? maskAllPasswords(note) : '');
    } finally {
      setBusy(false);
    }
  };

  const noteScan = note ? scanPasswords(note) : null;
  const notePassword = !!noteScan && (noteScan.matches.length > 0 || noteScan.weak || noteScan.leftover);
  const high = p?.risk === 'high';
  // The approval of a plain-LDAP reset is what sends AllowUnencrypted: it needs the explicit consent.
  const needsPlainConsent = !!p?.password?.unencrypted && allowed.has('approve_confirmed');
  const invisible = !!p && (hasInvisible(p.dn) || hasInvisible(p.newDn ?? '') || (p.changes ?? []).some((c) => [...(c.before ?? []), ...(c.after ?? []), ...(c.values ?? [])].some(hasInvisible)));
  const warnings = (p?.warnings ?? []).filter((w) => !/invisible/i.test(w) || !invisible);
  const openEntry = (dn: string) => useEditorStore.getState().openEntry(req.connection.profileId, dn);

  return (
    <div
      ref={ref}
      role="group"
      aria-label={`Approval request: ${title}`}
      data-approval-id={req.approvalId}
      className={cn('my-1.5 rounded border bg-card text-xs', high ? tone.dangerBorder : tone.warningBorder, highlight && 'ring-1 ring-ring')}
    >
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1">
        {isAccess ? <Globe size={13} /> : <ShieldAlert size={13} className={high ? tone.dangerText : tone.warningText} />}
        <span className="font-semibold">{title}</span>
        {req.position.total > 1 && <Badge>{req.position.index} of {req.position.total}</Badge>}
        <span className="ml-auto"><Countdown expiresAt={req.expiresAt} /></span>
      </div>

      <div className="space-y-1.5 px-2 py-1.5">
        <div className="flex flex-wrap items-center gap-1 text-muted-foreground">
          <HardDrive size={12} />
          <span className="text-foreground">{req.connection.label}</span>
          {req.connection.serverType && <Badge>{req.connection.serverType}</Badge>}
          {req.connection.host && <span>{req.connection.host}</span>}
        </div>
        {!isAccess && req.connection.identity && (
          <div className="text-muted-foreground">
            runs as <code className="break-all rounded bg-secondary px-1 font-mono text-foreground">{req.connection.identity}</code>
          </div>
        )}

        {isAccess && (
          <div className="space-y-1">
            <p>
              The assistant wants to read from <b>{req.connection.label}</b>
              {req.toolDisplayName ? <> ({req.toolDisplayName})</> : null}.
            </p>
            <p className="flex items-center gap-1">
              Data will be sent to <b>{req.providerHost || 'the AI provider'}</b>
              <Badge tone={req.providerRemote ? 'warning' : 'success'}>{req.providerRemote ? 'remote' : 'local'}</Badge>
            </p>
            {req.providerRemote && stored?.level === 'write' && (
              <p className={cn('flex flex-wrap items-center gap-1', tone.warningText)}>
                Write is set for local models only, so {req.providerHost || 'this provider'} can at most read here. To let it propose changes, allow it for {req.connection.label} in the AI settings.
                <Button size="sm" variant="secondary" onClick={() => useAIStore.getState().setView('settings')}>
                  Open AI settings
                </Button>
              </p>
            )}
          </div>
        )}

        {p && (
          <>
            <div className="flex flex-wrap items-center gap-1">
              <code className="break-all font-mono"><InvisibleText text={p.dn} /></code>
              {p.newDn && (
                <>
                  <span className="text-muted-foreground">→</span>
                  <code className="break-all font-mono"><InvisibleText text={p.newDn} /></code>
                </>
              )}
              {p.operation !== 'create' && (
                <Button size="sm" variant="secondary" leftIcon={ExternalLink} onClick={() => openEntry(p.dn)}>
                  Open entry
                </Button>
              )}
            </div>

            {high && (
              <InlineAlert
                tone="danger"
                live={false}
                className="text-xs"
                title="High-risk change"
                body={(p.riskReasons ?? []).length > 0 ? (
                  <ul className="list-disc pl-4">
                    {(p.riskReasons ?? []).map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                ) : undefined}
              />
            )}
            {unsaved && (
              <InlineAlert
                tone="warning"
                live={false}
                className="text-xs"
                title="You have unsaved edits of this entry"
                body="The editor holds changes of this entry that are not saved. Approving changes the entry underneath them; saving your edits afterwards could overwrite this change. Finish or discard them first."
              />
            )}
            {req.grantsSuspended && (
              <InlineAlert tone="warning" live={false} className="text-xs" body="Auto-approval paused: this chat read suspicious directory data." />
            )}
            {invisible && (
              <InlineAlert tone="warning" live={false} className="text-xs" body="This change contains invisible characters (shown as ⟨U+…⟩). Check the values carefully." />
            )}
            {p.password && <PasswordStorage pw={p.password} serverType={req.connection.serverType} />}
            {warnings.map((w, i) => (
              <div key={i} className={cn('flex items-start gap-1', tone.warningText)}><AlertTriangle size={12} className="mt-px shrink-0" /> {w}</div>
            ))}

            {p.explanation && (
              <div>
                <div className="text-muted-foreground">Assistant's reason</div>
                <div className="whitespace-pre-wrap">{p.explanation}</div>
              </div>
            )}

            {p.operation === 'reset_password' && (
              <div className="flex items-start gap-1 text-muted-foreground">
                <KeyRound size={12} className="mt-px shrink-0" aria-hidden />
                LDAPilot generates the new password on this computer. You see it here after the reset; it is never sent to the AI, and a password typed into the chat is not used.
              </div>
            )}
            {(p.changes ?? []).length > 0 && <DiffTable changes={p.changes ?? []} />}
            {(p.entrySummary ?? []).length > 0 && (
              <div>
                <div className="text-muted-foreground">{p.operation === 'delete' ? 'Entry to delete' : 'New entry'}</div>
                <table className="w-full text-xs">
                  <tbody>
                    {(p.entrySummary ?? []).map((a, i) => (
                      <tr key={i} className="align-top">
                        <td className="w-1/4 py-px pr-2 font-mono text-muted-foreground"><InvisibleText text={a.attribute} /></td>
                        <td className="py-px"><ValueList values={a.values} kind="same" attribute={a.attribute} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {(p.unchanged ?? []).length > 0 && (
              <div className="text-muted-foreground">Unchanged (already in the requested state): {(p.unchanged ?? []).join('; ')}</div>
            )}
            {p.assertion && <div className={tone.successText}>The server checks the before-state atomically.</div>}

            <div>
              <button type="button" className="flex items-center gap-1 text-muted-foreground hover:text-foreground" aria-expanded={showLdif} aria-label={showLdif ? 'Hide LDIF' : 'Show LDIF'} onClick={() => setShowLdif(!showLdif)}>
                {showLdif ? <ChevronDown size={12} /> : <ChevronRight size={12} />} LDIF
              </button>
              {showLdif && (
                <div className="relative mt-0.5 rounded border border-border bg-background">
                  <IconButton size="sm" icon={Copy} label="Copy LDIF" className="absolute right-1 top-1" onClick={() => void copyText(p.ldif, 'LDIF')} />
                  <pre className="max-h-60 overflow-auto whitespace-pre p-1.5 font-mono text-xs"><InvisibleText text={p.ldif} /></pre>
                </div>
              )}
            </div>
          </>
        )}

        {req.requireConfirm && allowed.has('approve_confirmed') && (
          <Checkbox checked={confirmed} onCheckedChange={setConfirmed} label="I have reviewed this change" />
        )}
        {needsPlainConsent && <UnencryptedConsent checked={plainConsent} onCheckedChange={setPlainConsent} className="text-xs" />}

        {noteOpen && notePassword && (
          <div className={cn('text-xs', tone.warningText)} role="status">
            The note contains a password; LDAPilot removes it before sending. A password typed into the chat is never used: ask for a reset and
            LDAPilot generates one.
          </div>
        )}
        {noteOpen && (
          <Input
            size="sm"
            placeholder="Optional note for the assistant (why you deny)"
            value={note}
            maxLength={500}
            aria-label="Note for the assistant"
            autoFocus
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              // Esc closes the note (never stops the run); Enter denies with it.
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setNoteOpen(false);
                setNote('');
              } else if (e.key === 'Enter' && allowed.has('deny') && !busy) {
                e.preventDefault();
                void act('deny');
              }
            }}
          />
        )}

        <div className="flex flex-wrap items-center gap-1 pt-0.5">
          {allowed.has('approve') && (
            <Button size="sm" variant="primary" leftIcon={Check} disabled={busy} onClick={() => void act('approve')}>
              {isAccess ? 'Allow for this chat' : 'Approve'}
            </Button>
          )}
          {allowed.has('approve_confirmed') && (
            <Button size="sm" variant="primary" leftIcon={Check} disabled={busy || !confirmed || (needsPlainConsent && !plainConsent)} aria-label="Approve (confirmed)" onClick={() => void act('approve_confirmed')}>
              Approve (confirmed)
            </Button>
          )}
          {allowed.has('approve_chat') && (
            <Button size="sm" variant="secondary" disabled={busy} title={p?.grantScope?.description} onClick={() => void act('approve_chat')}>
              Approve for this chat
            </Button>
          )}
          {allowed.has('approve_always') && (
            // The host is on the "Data will be sent to …" line and in the hint below; a label with it did not fit the card.
            <Button size="sm" variant="secondary" disabled={busy} title={`Always allow read for ${req.providerHost ?? 'this provider'}`} aria-label={`Always allow read for ${req.providerHost ?? 'this provider'}`} onClick={() => void act('approve_always')}>
              Always allow read
            </Button>
          )}
          {allowed.has('deny') && (
            <Button size="sm" variant="danger-ghost" leftIcon={X} disabled={busy} onClick={() => void act('deny')}>
              Deny
            </Button>
          )}
          {allowed.has('deny_remaining') && req.position.total > 1 && (
            <Button size="sm" variant="danger-ghost" disabled={busy} aria-label="Deny remaining changes" onClick={() => void act('deny_remaining')}>
              Deny remaining
            </Button>
          )}
          {allowed.has('deny') && !noteOpen && (
            <Button size="sm" variant="link" aria-label="Add a note to the denial" onClick={() => setNoteOpen(true)}>
              add note
            </Button>
          )}
        </div>
        {allowed.has('approve_always') && (
          <div className="text-muted-foreground [overflow-wrap:anywhere]">"Always allow read": saved in the AI settings for {req.connection.label} with {req.providerHost || 'this provider'}.</div>
        )}
        {allowed.has('approve_chat') && p?.grantScope?.description && (
          <div className="text-muted-foreground">"Approve for this chat": {p.grantScope.description}</div>
        )}
      </div>
    </div>
  );
}
