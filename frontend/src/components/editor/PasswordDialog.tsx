import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  KeyRound, AlertCircle, AlertTriangle, Info, Eye, EyeOff, Check, Copy, Wand2, X,
  SlidersHorizontal, ShieldCheck, ShieldAlert, Lock, CheckCircle2, RefreshCw, Settings2,
} from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { GetPasswordContext, SetPassword } from '../../lib/wails-password'
import { ModifyEntryWithOptions } from '../../lib/wails-pwpolicy'
import {
  passThroughResetNote, reportHeadline, reportOutcome, reportSuccessDetail, reportSummary, typedStoredValue,
} from '../../lib/passwordPolicy'
import {
  accountOptions, availableMethods, defaultAccountFlags, defaultSchemeFor, defaultSelection, deviatesFromPolicy, groupSchemes,
  hasAdvancedMethods, isAdvancedSelection, loadRememberedSelection, methodDescription, methodOptionLabel, passwordSubmitBlock,
  passwordDialogText, passwordSummaryLine, policyLine, resultOutcome, resultSummary, saveRememberedSelection, schemeLabelOptions,
  schemeOptionLabel, schemeSupportFor, selectionNotices, selectMethod, selectScheme, sendsCleartext, storedSchemeText, verifyHint, SERVER_LABELS,
  type DialogNotice, type PasswordSelection, type ResultOutcome,
} from '../../lib/passwordMethod'
import {
  assessPassword, clampLength, generatePassword, lengthChoices, parseGeneratorOptions, type GeneratorOptions, type PasswordAssessment,
} from '../../lib/passwordGenerator'
import { accountDisplayName } from '../../lib/accountActions'
import type { PasswordChangeResult, PasswordContext, PasswordScheme, SchemeSupportLevel } from '../../types/password'
import type { ServerType } from '../../types/ldap'
import { toast } from '../ui/Toast'
import { UnencryptedSendDialog } from '../password/UnencryptedConsent'
import { resetCleartextParts, unencryptedWhat } from '../../lib/unencryptedConsent'
import { cn } from '../../lib/utils'
import { Badge } from '../ui/Badge'
import { Dialog, useDialogStore } from '../ui/Dialog'
import { Button, IconButton } from '../ui/Button'
import { DisclosureButton } from '../ui/Disclosure'
import { Field } from '../ui/Field'
import { Input, Select } from '../ui/Input'
import { Checkbox } from '../ui/Checkbox'
import { InlineAlert } from '../ui/InlineAlert'
import { Spinner } from '../ui/Spinner'
import { Dn } from '../ui/Dn'
import { ConnectionDialog } from '../connection/ConnectionDialog'
import { dismissPasswordWarnings } from '../password/passwordToastRegistry'
import { DialogCancelButton } from './DialogCancelButton'
import { afterAccountChange } from '../commands/accountState'

interface PasswordDialogProps {
  dn: string;
  onClose: () => void;
  onChanged?: () => void;
  /** Connection of the entry (an editor tab, a results row); default: the active connection. */
  profileId?: string;
  /** 'set': the first password of an LDAP person without a login (Set Password…); default: a reset. */
  verb?: 'reset' | 'set';
}

const GENERATOR_STORAGE_KEY = 'ldapilot.password.generator';

function loadGeneratorOptions(): GeneratorOptions {
  try {
    return parseGeneratorOptions(localStorage.getItem(GENERATOR_STORAGE_KEY));
  } catch {
    return parseGeneratorOptions(null);
  }
}

function saveGeneratorOptions(opts: GeneratorOptions) {
  try {
    localStorage.setItem(GENERATOR_STORAGE_KEY, JSON.stringify(opts));
  } catch {
    // not remembered
  }
}

/** Notices already said by the summary line (transport) are not repeated. */
function isTransportNotice(n: DialogNotice): boolean {
  return n.text.startsWith('This connection is not encrypted:');
}

/**
 * Reset Password (ADUC-style): password, generator and the account options
 * first; one summary line says how the password is stored and how it
 * travels, the method/scheme choice and the server facts are under
 * "Details". Resets the server would refuse anyway (AD without TLS) are
 * blocked with the reason and a way to fix the connection.
 */
export function PasswordDialog({ dn, onClose, onChanged, profileId: profileProp, verb = 'reset' }: PasswordDialogProps) {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const profileId = profileProp ?? activeProfileId;

  const [ctx, setCtx] = useState<PasswordContext | null>(null);
  const [ctxLoading, setCtxLoading] = useState(true);
  const [ctxError, setCtxError] = useState<string | null>(null);

  const [advanced, setAdvanced] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [sel, setSel] = useState<PasswordSelection>({ method: 'userPassword', scheme: 'SSHA', verifyBind: true });
  const [mustChange, setMustChange] = useState(false);
  const [unlock, setUnlock] = useState(false);
  const [enable, setEnable] = useState(false);

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [copied, setCopied] = useState(false);
  /** Short confirmation next to Generate / Copy ("Generated and copied", WF-2). */
  const [copyNote, setCopyNote] = useState<{ ok: boolean; text: string } | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);
  const [genOpts, setGenOpts] = useState<GeneratorOptions>(loadGeneratorOptions);
  const [showGenOpts, setShowGenOpts] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PasswordChangeResult | null>(null);
  // Cleartext over an unencrypted connection needs an explicit confirmation.
  const [confirmPlain, setConfirmPlain] = useState(false);
  // One write at a time, also against a second Enter in the same tick.
  const inFlight = useRef(false);
  const pwId = `pw-new${useId().replace(/:/g, '')}`;
  const detailsId = `pw-details${useId().replace(/:/g, '')}`;
  const name = accountDisplayName(dn);
  const text = passwordDialogText(verb);

  const loadContext = useCallback(async () => {
    if (!profileId) {
      setCtxLoading(false);
      setCtxError('No active connection');
      return;
    }
    setCtxLoading(true);
    setCtxError(null);
    try {
      const c = await GetPasswordContext(profileId, dn);
      if (!c) throw new Error('Password information is only available in the desktop app');
      const initial = defaultSelection(c, loadRememberedSelection(profileId));
      const flags = defaultAccountFlags(c);
      setCtx(c);
      setSel(initial);
      const adv = isAdvancedSelection(c, initial);
      setAdvanced(adv);
      setShowDetails(adv);
      setMustChange(flags.mustChange);
      setUnlock(flags.unlock);
      setEnable(flags.enable);
    } catch (err: any) {
      setCtxError(err?.message || String(err));
    } finally {
      setCtxLoading(false);
    }
  }, [profileId, dn]);

  useEffect(() => { loadContext(); }, [loadContext]);

  const methods = useMemo(() => (ctx ? availableMethods(ctx, advanced) : []), [ctx, advanced]);
  const scheme = ctx?.schemes.find((s) => s.id === sel.scheme);
  const options = ctx ? accountOptions(ctx) : null;
  const notices = ctx ? selectionNotices(ctx, sel, mustChange).filter((n) => !isTransportNotice(n)) : [];
  // Read-only is said once, at the top.
  const warnings = notices.filter((n) => n.level === 'warning' && !n.text.startsWith('This connection profile is read-only'));
  const infos = notices.filter((n) => n.level !== 'warning');
  const block = ctx ? passwordSubmitBlock(ctx, sel) : null;
  const summary = ctx ? passwordSummaryLine(ctx, sel) : null;
  const assessment = useMemo(
    () => assessPassword(newPassword, { names: ctx?.accountNames ?? [name], policy: ctx?.accountPolicy }),
    [newPassword, ctx, name],
  );
  const passwordsMatch = newPassword === confirmPassword;
  const ready = !!ctx && !ctx.readOnly && !!profileId && !block && newPassword.length > 0 && passwordsMatch && !loading;
  // A stored value typed as the password ({SASL}user of pass-through authentication, a hash):
  // the reset would hash the text itself. Not on AD: unicodePwd takes every text as a password.
  const typedStored = ctx && ctx.serverType !== 'ad' ? typedStoredValue(newPassword) : null;
  const passThroughNote = ctx ? passThroughResetNote(ctx.currentScheme) : '';
  // Hashing such a text takes a click on Reset Password: Enter in a field must never do it.
  const hashAsPassword = useRef(false);
  useEffect(() => { hashAsPassword.current = false; }, [newPassword]);

  function handleMethodChange(method: PasswordSelection['method']) {
    if (!ctx) return;
    setSel((s) => selectMethod(ctx, s, method));
    setResult(null);
  }

  function handleSchemeChange(schemeId: string) {
    if (!ctx) return;
    setSel((s) => selectScheme(ctx, s, schemeId));
    setResult(null);
  }

  function toggleAdvanced() {
    if (!ctx) return;
    const next = !advanced;
    setAdvanced(next);
    if (!next && !availableMethods(ctx, false).some((m) => m.method === sel.method)) {
      setSel(defaultSelection(ctx, null));
    }
  }

  function updateGenOpts(patch: Partial<GeneratorOptions>) {
    const next = { ...genOpts, ...patch };
    setGenOpts(next);
    saveGeneratorOptions(next);
  }

  /** Puts the password on the clipboard and says so briefly (a failed write says that instead). */
  function copyPassword(pwd: string, okText: string) {
    const done = (ok: boolean) => {
      setCopied(ok);
      setCopyNote({ ok, text: ok ? okText : 'Could not copy to the clipboard' });
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => {
        setCopied(false);
        setCopyNote(null);
      }, 2000);
    };
    try {
      navigator.clipboard.writeText(pwd).then(() => done(true), () => done(false));
    } catch {
      done(false);
    }
  }

  function handleGenerate() {
    try {
      const pwd = generatePassword(genOpts);
      setNewPassword(pwd);
      setConfirmPassword(pwd);
      setShowPassword(true);
      setResult(null);
      // Generate also copies the password (WF-2: one step less); Copy stays for a typed one.
      copyPassword(pwd, 'Generated and copied');
    } catch (err: any) {
      toast.error(err?.message || 'Could not generate a password');
    }
  }

  function handleCopy() {
    copyPassword(newPassword, 'Copied');
  }

  /** Closes this dialog and opens the connection settings (to switch to LDAPS / StartTLS). */
  function editConnection() {
    const profile = useConnectionStore.getState().profiles.find((p) => p.id === profileId);
    if (!profile) return;
    onClose();
    useDialogStore.getState().open(ConnectionDialog, { profile, onSave: useConnectionStore.getState().saveProfile });
  }

  async function handleSubmit(allowUnencrypted = false) {
    if (!ready || !ctx || !options || !profileId || inFlight.current) return;
    if (typedStored && !hashAsPassword.current) return;
    if (!ctx.tls && sendsCleartext(sel) && !allowUnencrypted) {
      setConfirmPlain(true);
      return;
    }
    // The confirmation is answered: it must not come back with the result.
    setConfirmPlain(false);
    inFlight.current = true;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await SetPassword(profileId, {
        dn,
        password: newPassword,
        method: sel.method,
        scheme: sel.method === 'userPassword' ? sel.scheme : '',
        mustChange: options.mustChange.available && mustChange,
        unlock: options.unlock.available && unlock,
        enable: options.enable.available && enable,
        verifyBind: sel.verifyBind,
        allowUnencrypted,
      });
      const outcome = resultOutcome(res);
      // The dialog may stay open (warnings): show what is stored now.
      if (res.storedScheme) {
        setCtx((c) => (c ? { ...c, hasUserPassword: true, currentScheme: res.storedScheme!, currentSchemeLabel: res.storedSchemeLabel ?? '' } : c));
      }
      // A choice that just proved ineffective is not remembered.
      if (outcome !== 'failed') saveRememberedSelection(profileId, sel);
      // The account changed (password, maybe lock / enabled state): every view refreshes.
      // One status read the views share; they get it with the event (RW1-P-06).
      void afterAccountChange(profileId, dn);
      onChanged?.();
      if (outcome === 'success') {
        // A working password supersedes earlier "stored in cleartext" / "will not work" toasts of this entry.
        dismissPasswordWarnings(profileId, dn);
        toast.success(resultSummary(res, name, verb));
        onClose();
      } else if (outcome === 'warning') {
        setResult(res);
        toast.info(`${resultSummary(res, name, verb)} - see the notes in the dialog`);
      } else {
        setResult(res);
        toast.error(`Password for ${name} written, but it may not work`, [res.verifyError, ...res.warnings].filter(Boolean).join('\n'));
      }
    } catch (err: any) {
      const msg = err?.message || String(err) || text.failed(name);
      setError(msg);
      toast.error(text.failed(name), msg);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  /**
   * Writes the typed text to userPassword exactly as typed: the generic
   * write path keeps a stored value ({SASL}user, a hash), SetPassword would
   * hash it. asIs: stored as typed or refused, whatever the storage policy;
   * such a value is no cleartext password, so nothing needs a confirmation.
   */
  async function handleStoreAsTyped() {
    if (!ctx || ctx.readOnly || !profileId || !typedStored || !passwordsMatch || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const report = await ModifyEntryWithOptions(profileId, dn, [{ operation: 'replace', attribute: 'userPassword', values: [newPassword] }], { asIs: true });
      void afterAccountChange(profileId, dn);
      onChanged?.();
      const outcome = reportOutcome(report);
      if (!report || outcome === 'none' || outcome === 'ok') {
        dismissPasswordWarnings(profileId, dn);
        const detail = reportSuccessDetail(report);
        toast.success(`Stored as typed for ${name}${detail ? `: ${detail}` : ''}`);
        onClose();
        return;
      }
      // Written, but not stored as sent (a server that does not know the scheme hashes it) or with warnings.
      const detail = [`${reportSummary(report)}.`, ...report.warnings].join('\n\n');
      setError(`${reportHeadline(report)}\n\n${detail}`);
      (outcome === 'error' ? toast.error : toast.warning)(`userPassword of ${name}: ${reportHeadline(report)}`, detail);
    } catch (err: any) {
      const msg = err?.message || String(err) || 'Failed to write userPassword';
      setError(msg);
      toast.error(`Storing userPassword of ${name} failed`, msg);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  const dirty = newPassword !== '' || confirmPassword !== '';

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !loading && onClose()}
      size="md"
      icon={<KeyRound size={16} strokeWidth={1.75} aria-hidden className="text-primary" />}
      title={text.title}
      description={<Dn dn={dn} />}
      dismissible={loading ? 'never' : 'when-clean'}
      dirty={dirty && !result}
      // A submit while the confirmation is open is the confirmation's own (never ours).
      onSubmit={() => { if (!confirmPlain && ready) void handleSubmit(); }}
      footer={
        <>
          <DialogCancelButton disabled={loading}>{result ? 'Close' : 'Cancel'}</DialogCancelButton>
          <Button
            // No submit button while a stored value is typed: Enter then has nothing to activate.
            type={typedStored ? 'button' : 'submit'}
            onClick={typedStored ? () => { hashAsPassword.current = true; if (!confirmPlain) void handleSubmit(); } : undefined}
            variant="primary"
            leftIcon={KeyRound}
            loading={loading}
            disabled={!ready || confirmPlain}
            title={block?.reason}
          >
            {result ? text.again : text.submit}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {ctxLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2" role="status">
            <Spinner size="sm" decorative /> Reading server capabilities…
          </div>
        )}
        {ctxError && (
          <InlineAlert
            tone="danger"
            body={<span className="break-words">{ctxError}</span>}
            actions={<Button size="sm" variant="secondary" leftIcon={RefreshCw} onClick={loadContext}>Retry</Button>}
          />
        )}

        {ctx && (
          <>
            {block && (
              <InlineAlert
                tone="danger"
                title={text.blocked}
                body={<span className="break-words">{block.reason} {block.fix}</span>}
                actions={<Button size="sm" variant="secondary" leftIcon={Settings2} onClick={editConnection}>Edit Connection…</Button>}
              />
            )}
            {ctx.readOnly && <InlineAlert tone="warning" body="This connection profile is read-only; the password cannot be changed." />}
            {passThroughNote && <InlineAlert tone="warning" body={passThroughNote} />}

            {/* New Password */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label htmlFor={pwId} className="text-sm font-medium text-muted-foreground">New password<span className="text-destructive ml-0.5" aria-hidden>*</span></label>
                <div className="flex items-center gap-1">
                  <span role="status" aria-live="polite" className={cn('text-xs', copyNote?.ok === false ? 'text-destructive' : 'text-success')}>
                    {copyNote?.text ?? ''}
                  </span>
                  <IconButton label="Generator options" icon={SlidersHorizontal} pressed={showGenOpts} onClick={() => setShowGenOpts(!showGenOpts)} />
                  <Button size="sm" variant="ghost" leftIcon={Wand2} onClick={handleGenerate}>Generate {genOpts.length}</Button>
                  {newPassword && (
                    <IconButton label={copied ? 'Copied' : 'Copy password'} icon={copied ? Check : Copy} onClick={handleCopy} />
                  )}
                </div>
              </div>
              {showGenOpts && <GeneratorOptionsPanel opts={genOpts} onChange={updateGenOpts} />}
              <Input
                id={pwId}
                required
                mono
                type={showPassword ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => { setNewPassword(e.target.value); setResult(null); }}
                placeholder="Enter new password…"
                autoComplete="new-password"
                autoFocus
                suffix={
                  <button type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    aria-pressed={showPassword}
                    tabIndex={-1}
                    className="inline-flex items-center justify-center size-4 rounded-xs text-muted-foreground hover:text-foreground"
                  >
                    {showPassword ? <EyeOff size={12} strokeWidth={1.75} aria-hidden /> : <Eye size={12} strokeWidth={1.75} aria-hidden />}
                  </button>
                }
              />
              {typedStored ? (
                // No password to rate: say what the text is and offer to store it unchanged.
                <InlineAlert
                  tone="warning"
                  className="mt-1.5"
                  title={typedStored.title}
                  body={typedStored.text}
                  actionsBelow
                  actions={
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void handleStoreAsTyped()}
                      disabled={ctx.readOnly || !passwordsMatch || loading}
                      title={passwordsMatch ? undefined : 'Type the value a second time under "Confirm password" first'}
                    >
                      Store as Typed
                    </Button>
                  }
                />
              ) : (
                <StrengthMeter assessment={assessment} empty={!newPassword} />
              )}
            </div>

            <Field label="Confirm password" required error={confirmPassword && !passwordsMatch ? 'Passwords do not match' : undefined}>
              <Input
                mono
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm password…"
                autoComplete="new-password"
              />
            </Field>

            {/* Account options */}
            {options && (options.mustChange.available || options.unlock.available || options.enable.available || options.info) && (
              <div className="space-y-1.5">
                {options.mustChange.available && (
                  <Checkbox checked={mustChange} onCheckedChange={setMustChange} label={options.mustChange.label} description={options.mustChange.hint} />
                )}
                {options.unlock.available && (
                  <Checkbox
                    checked={unlock}
                    onCheckedChange={setUnlock}
                    label={<span className="inline-flex items-center gap-1.5">{options.unlock.label}{ctx.locked && <Badge tone="warning" icon={Lock}>locked</Badge>}{ctx.disabled && ctx.serverType === 'openldap' && <Badge>disabled</Badge>}</span>}
                    description={options.unlock.hint}
                  />
                )}
                {options.enable.available && (
                  <Checkbox
                    checked={enable}
                    onCheckedChange={setEnable}
                    label={<span className="inline-flex items-center gap-1.5">{options.enable.label}<Badge>disabled</Badge></span>}
                    description={options.enable.hint}
                  />
                )}
                {options.info && (
                  <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
                    <Info size={12} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0" /> {options.info}
                  </p>
                )}
              </div>
            )}

            {/* One summary line: storage + transport, the rest under Details */}
            {summary && (
              <div className="space-y-1.5 pt-1 border-t border-border">
                <div className="flex items-start gap-2 text-sm">
                  <KeyRound size={12} strokeWidth={1.75} aria-hidden className="mt-1 shrink-0 text-muted-foreground" />
                  <p className="flex-1 min-w-0 break-words">
                    <span className="text-foreground">{summary.storage}</span>
                    <span className="text-muted-foreground"> · </span>
                    <span className={summary.transportWarning ? 'text-warning' : 'text-muted-foreground'}>{summary.transport}</span>
                    {sel.verifyBind && <span className="text-muted-foreground"> · test bind afterwards</span>}
                  </p>
                  <DisclosureButton open={showDetails} onToggle={() => setShowDetails(!showDetails)} controls={detailsId} className="shrink-0 -my-1">
                    Details
                  </DisclosureButton>
                </div>
                <NoticeList notices={warnings} />
              </div>
            )}

            {showDetails && (
              <div id={detailsId} className="space-y-3 pl-3 border-l-2 border-border">
                <ServerSummary ctx={ctx} />
                {policyLine(ctx) && (
                  <p className="flex items-start gap-1.5 text-sm text-muted-foreground" title={ctx.policy?.summary}>
                    <KeyRound size={12} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0" />
                    <span>
                      {policyLine(ctx)}
                      {deviatesFromPolicy(ctx, sel) && <span className="text-warning"> The selection below differs from it (this reset only).</span>}
                    </span>
                  </p>
                )}

                {/* Method */}
                <Field label="Method" hint={methodDescription(ctx, sel)}>
                  {methods.length === 1 ? (
                    <div className="text-sm px-2 h-control flex items-center rounded border border-border bg-background">{methodOptionLabel(ctx, methods[0])}</div>
                  ) : (
                    <Select
                      value={sel.method}
                      onChange={(e) => handleMethodChange(e.target.value as PasswordSelection['method'])}
                      options={methods.map((m) => ({ value: m.method, label: methodOptionLabel(ctx, m) }))}
                    />
                  )}
                </Field>
                {hasAdvancedMethods(ctx) && (
                  <DisclosureButton open={advanced} onToggle={toggleAdvanced} className="-mt-2">
                    Advanced methods
                  </DisclosureButton>
                )}

                {/* Scheme */}
                {sel.method === 'userPassword' && (
                  <Field
                    label="Hashing scheme"
                    hint={ctx.hasUserPassword ? <>Currently stored: <span className="font-mono">{storedSchemeText(ctx.currentScheme, ctx.currentSchemeLabel)}</span></> : undefined}
                  >
                    <Select value={sel.scheme} onChange={(e) => handleSchemeChange(e.target.value)}>
                      {groupSchemes(ctx.schemes).map((g) => (
                        <optgroup key={g.label} label={g.label}>
                          {g.schemes.map((sc) => (
                            <option key={sc.id} value={sc.id}>
                              {schemeOptionLabel(sc, ctx.serverType, defaultSchemeFor(ctx), schemeLabelOptions(ctx))}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </Select>
                    {scheme && <SchemeDetails scheme={scheme} serverType={ctx.serverType} />}
                  </Field>
                )}

                <NoticeList notices={infos} />

                <Checkbox
                  checked={sel.verifyBind}
                  onCheckedChange={(v) => setSel((x) => ({ ...x, verifyBind: v }))}
                  label="Verify with a test bind as this entry"
                  description={verifyHint(ctx)}
                />
              </div>
            )}

            {result && <ResultPanel result={result} outcome={resultOutcome(result)} />}

            {error && <InlineAlert tone="danger" body={<span className="break-words whitespace-pre-wrap">{error}</span>} />}
          </>
        )}
      </div>
      {confirmPlain && (
        // The one unencrypted-send confirmation (DEF-21): consent box, Cancel · Continue.
        <UnencryptedSendDialog
          what={`This connection has no LDAPS/StartTLS. ${unencryptedWhat(resetCleartextParts(sel), text.sends)}`}
          dn={dn}
          onCancel={() => setConfirmPlain(false)}
          onConfirm={() => { setConfirmPlain(false); void handleSubmit(true); }}
        />
      )}
    </Dialog>
  );
}

function ServerSummary({ ctx }: { ctx: PasswordContext }) {
  const tlsLabel = ctx.tlsMode === 'ssl' ? 'LDAPS' : ctx.tlsMode === 'starttls' ? 'StartTLS' : 'unencrypted';
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <Badge size="md" title={[ctx.vendorName, ctx.vendorVersion].filter(Boolean).join(' ')}>
        {SERVER_LABELS[ctx.serverType] ?? ctx.serverType}
      </Badge>
      <Badge
        size="md"
        tone={ctx.tls ? 'neutral' : 'danger'}
        icon={ctx.tls ? ShieldCheck : ShieldAlert}
        title={ctx.tls ? 'The connection is encrypted' : 'The connection is not encrypted'}
      >
        {tlsLabel}
      </Badge>
      {ctx.passwordModifyExop && <Badge size="md" title="Password Modify extended operation (1.3.6.1.4.1.4203.1.11.1)">RFC 3062</Badge>}
      {ctx.ppolicyControl && ctx.serverType !== 'ad' && <Badge size="md" title="Password policy control (1.3.6.1.4.1.42.2.27.8.5.1)">ppolicy</Badge>}
      {ctx.locked && (
        <Badge size="md" tone="danger" icon={Lock}>locked out</Badge>
      )}
      {ctx.mustChange && <Badge size="md">change pending</Badge>}
      {ctx.disabled && <Badge size="md">disabled</Badge>}
      {ctx.passwordNeverExpires && (
        <Badge size="md" title="userAccountControl DONT_EXPIRE_PASSWORD">password never expires</Badge>
      )}
    </div>
  );
}

const SUPPORT_STYLE: Record<SchemeSupportLevel, string> = {
  native: 'text-success',
  module: 'text-warning',
  system: 'text-warning',
  no: 'text-destructive',
};

const SUPPORT_TEXT: Record<SchemeSupportLevel, string> = {
  native: 'supported',
  module: 'needs module',
  system: 'depends on crypt(3)',
  no: 'not supported',
};

function SchemeDetails({ scheme, serverType }: { scheme: PasswordScheme; serverType: ServerType }) {
  return (
    <div className="mt-1.5 space-y-1 text-xs">
      <p className="text-muted-foreground">{scheme.description}</p>
      <div className="flex flex-col gap-0.5">
        {scheme.support.filter((s) => s.server !== 'ad' || serverType === 'ad').map((s) => (
          <div key={s.server} className={cn('flex items-baseline gap-1.5', s.server === serverType ? 'text-foreground' : 'text-muted-foreground')}>
            <span className={cn('w-36 shrink-0', s.server === serverType && 'font-semibold')}>
              {SERVER_LABELS[s.server] ?? s.server}{s.server === serverType ? ' (this server)' : ''}
            </span>
            <span className={cn('shrink-0', SUPPORT_STYLE[s.level])}>{SUPPORT_TEXT[s.level]}</span>
            <span className="truncate" title={s.note}>{s.note}</span>
          </div>
        ))}
      </div>
      {!schemeSupportFor(scheme, serverType) && serverType !== 'openldap' && serverType !== '389ds' && (
        <p className="text-muted-foreground">Support on this server is unknown.</p>
      )}
    </div>
  );
}

function NoticeList({ notices }: { notices: DialogNotice[] }) {
  if (notices.length === 0) return null;
  return (
    <div className="space-y-1">
      {notices.map((n, i) => (
        <div
          key={i}
          className={cn(
            'flex items-start gap-2 text-sm px-2.5 py-1.5 rounded',
            n.level === 'warning' ? 'bg-warning-subtle text-warning' : 'bg-secondary text-muted-foreground',
          )}
        >
          {n.level === 'warning' ? <AlertTriangle size={12} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0" /> : <Info size={12} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0" />}
          <span>{n.text}</span>
        </div>
      ))}
    </div>
  );
}

function StrengthMeter({ assessment, empty }: { assessment: PasswordAssessment; empty: boolean }) {
  const { level, label, problems, requirements } = assessment;
  const color = level <= 1 ? 'bg-destructive' : level === 2 ? 'bg-warning' : level === 3 ? 'bg-info' : 'bg-success';
  const text = level <= 1 ? 'text-destructive' : level === 2 ? 'text-warning' : level === 3 ? 'text-info' : 'text-success';
  if (empty && requirements.length === 0) return null;
  return (
    <div className="mt-1.5 space-y-1">
      {!empty && (
        <div className="flex items-center gap-2">
          <div className="flex-1 flex gap-0.5" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className={cn('h-1 flex-1 rounded-full transition-colors', i < level ? color : 'bg-muted')} />
            ))}
          </div>
          <span className={cn('text-xs', text)}>{label}</span>
        </div>
      )}
      {!empty && problems.length > 0 && (
        <ul className="space-y-0.5 text-xs text-destructive">
          {problems.map((p) => (
            <li key={p} className="flex items-start gap-1"><AlertTriangle size={12} strokeWidth={1.75} aria-hidden className="mt-px shrink-0" />{p}</li>
          ))}
        </ul>
      )}
      {requirements.length > 0 && (
        <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs" aria-label="Password policy requirements">
          {requirements.map((r) => {
            const Icon = r.met === null || empty ? Info : r.met ? Check : X;
            const tone = r.met === null || empty ? 'text-muted-foreground' : r.met ? 'text-success' : 'text-destructive';
            return (
              <li key={r.label} className={cn('flex items-center gap-1', tone)}>
                <Icon size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
                <span>{r.label}</span>
                {!empty && r.met !== null && <span className="sr-only">{r.met ? '(met)' : '(not met)'}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function GeneratorOptionsPanel({ opts, onChange }: { opts: GeneratorOptions; onChange: (patch: Partial<GeneratorOptions>) => void }) {
  const classes: { key: 'upper' | 'lower' | 'digits' | 'symbols'; label: string }[] = [
    { key: 'upper', label: 'A-Z' },
    { key: 'lower', label: 'a-z' },
    { key: 'digits', label: '0-9' },
    { key: 'symbols', label: '!@#' },
  ];
  const enabled = classes.filter((c) => opts[c.key]).length;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1.5 rounded border border-border bg-background text-sm text-muted-foreground" role="group" aria-label="Generator options">
      <label className="flex items-center gap-1.5">
        Length
        <Select
          size="sm"
          value={String(opts.length)}
          onChange={(e) => onChange({ length: clampLength(parseInt(e.target.value, 10)) })}
          options={lengthChoices(opts.length).map((l) => ({ value: String(l), label: String(l) }))}
          className="w-16"
        />
      </label>
      {classes.map((c) => (
        <Checkbox
          key={c.key}
          checked={opts[c.key]}
          disabled={opts[c.key] && enabled === 1}
          onCheckedChange={(v) => onChange({ [c.key]: v })}
          label={<span className="font-mono">{c.label}</span>}
        />
      ))}
      <Checkbox
        checked={opts.avoidAmbiguous}
        onCheckedChange={(v) => onChange({ avoidAmbiguous: v })}
        label={<span title="Leave out I l 1 O 0 o | `">avoid look-alikes</span>}
      />
    </div>
  );
}

const RESULT_HINT: Record<ResultOutcome, string> = {
  success: '',
  warning: 'Review the notes above, then close the dialog or set the password again.',
  failed: 'Choose another method or scheme and set the password again, or close the dialog.',
};

function ResultPanel({ result, outcome }: { result: PasswordChangeResult; outcome: ResultOutcome }) {
  return (
    <div className="space-y-1.5 text-sm px-3 py-2 rounded border border-border bg-background" role="status">
      <div className="flex items-center gap-1.5 font-medium">
        {outcome === 'failed'
          ? <AlertCircle size={12} className="text-destructive" />
          : <CheckCircle2 size={12} className="text-success" />}
        {outcome === 'failed' ? 'The password was written, but it most likely does not work' : 'The password was written'}
        {result.storedScheme && <span className="font-normal text-muted-foreground">(stored as {storedSchemeText(result.storedScheme, result.storedSchemeLabel)})</span>}
      </div>
      {result.operations.length > 0 && (
        <ul className="list-disc pl-5 text-muted-foreground">
          {result.operations.map((op, i) => <li key={i}>{op}</li>)}
        </ul>
      )}
      {result.verifyError && (
        <div className="flex items-start gap-1.5 text-destructive">
          <AlertCircle size={12} className="mt-px shrink-0" />
          <span className="break-words">{result.verifyError}</span>
        </div>
      )}
      {result.warnings.map((w, i) => (
        <div key={i} className="flex items-start gap-1.5 text-warning">
          <AlertTriangle size={12} className="mt-px shrink-0" />
          <span>{w}</span>
        </div>
      ))}
      {RESULT_HINT[outcome] && <p className="text-muted-foreground">{RESULT_HINT[outcome]}</p>}
    </div>
  );
}
