import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, FlaskConical, Plug, Server } from 'lucide-react'
import { ConnectionProfile, AuthMethod, TLSMode, newConnectionProfile } from '../../types/ldap'
import type { CertificateInfo, ConnectionTestResult } from '../../types/auth'
import * as wailsAuth from '../../lib/wails-auth'
import {
  ADVANCED_ERROR_FIELDS, PROFILE_LIMITS, appendPEM, certValidityState, cleanProfileForSave, commonNameOf, formErrorSummary, formatDate,
  normalizeFingerprint, pinInfoFromCertificate, pinInfoFromChain, portForTLSMode, profileForSave, sendsPassword, testBlockingErrors, validateConnectionForm,
} from '../../lib/connectionAuth'
import { useAuthEnvironment } from '../../stores/authEnvStore'
import { primeConnectPassword, useConnectionStore } from '../../stores/connectionStore'
import { Dialog, useDialogContext, useDialogStore } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Disclosure } from '../ui/Disclosure'
import { Input, Select } from '../ui/Input'
import { Checkbox } from '../ui/Checkbox'
import { InlineAlert } from '../ui/InlineAlert'
import { Field } from './FormField'
import { cn } from '../../lib/utils'
import { AuthSettings } from './AuthSettings'
import { TLSTrustSettings } from './TLSTrustSettings'
import { ConnectionTestResultView } from './ConnectionTestResultView'
import { PasswordStorageSettings } from './PasswordStorageSettings'
import { ConfirmDialog } from '../ui/ConfirmDialog'
import { connectAndBrowse } from './connectFlow'
import { useServerHostName } from './useServerHostName'

/** Bind DN placeholder of the Active Directory presets (a UPN is the usual AD bind name). */
const AD_BIND_PLACEHOLDER = 'admin@corp.example.com'

const CONNECTION_PRESETS: { id: string; label: string; description: string; ad?: boolean; bindPlaceholder?: string; apply: (p: ConnectionProfile) => ConnectionProfile }[] = [
  {
    id: 'ad',
    ad: true,
    label: 'Active Directory',
    description: 'Microsoft AD with LDAPS',
    apply: (p) => ({
      ...p,
      port: 636,
      tlsMode: 'ssl' as TLSMode,
      // Verification stays on: Test Connection offers to trust the DC's
      // certificate (or its CA) if the system does not trust it.
      tlsSkipVerify: false,
      authMethod: 'simple' as AuthMethod,
      pageSize: 1000,
    }),
  },
  {
    id: 'ad-gc',
    ad: true,
    label: 'AD Global Catalog',
    description: 'Forest-wide, read-only, LDAPS 3269 (3268 plain)',
    apply: (p) => ({
      ...p,
      port: 3269,
      tlsMode: 'ssl' as TLSMode,
      tlsSkipVerify: false,
      authMethod: 'simple' as AuthMethod,
      pageSize: 1000,
      // The Global Catalog holds a partial, read-only replica of every domain.
      readOnly: true,
    }),
  },
  {
    id: 'openldap',
    label: 'OpenLDAP',
    description: 'Standard OpenLDAP server',
    apply: (p) => ({
      ...p,
      port: 389,
      tlsMode: 'starttls' as TLSMode,
      authMethod: 'simple' as AuthMethod,
      pageSize: 500,
    }),
  },
  {
    id: '389ds',
    label: '389 Directory Server',
    // The 389DS administrator (RW1-C-13).
    bindPlaceholder: 'cn=Directory Manager',
    description: '389DS / Red Hat DS with StartTLS',
    apply: (p) => ({
      ...p,
      port: 389,
      tlsMode: 'starttls' as TLSMode,
      authMethod: 'simple' as AuthMethod,
      bindDN: p.bindDN || 'cn=Directory Manager',
      pageSize: 500,
    }),
  },
  {
    id: 'freeipa',
    label: 'FreeIPA',
    bindPlaceholder: 'uid=admin,cn=users,cn=accounts,dc=example,dc=com',
    description: 'Red Hat / FreeIPA with LDAPS',
    apply: (p) => ({
      ...p,
      port: 636,
      tlsMode: 'ssl' as TLSMode,
      authMethod: 'simple' as AuthMethod,
      pageSize: 500,
    }),
  },
  {
    id: 'plain',
    label: 'Plain (dev)',
    description: 'No TLS, anonymous',
    apply: (p) => ({
      ...p,
      port: 389,
      tlsMode: 'none' as TLSMode,
      authMethod: 'none' as AuthMethod,
      pageSize: 500,
    }),
  },
];

const TLS_OPTIONS = [
  { value: 'none', label: 'None (Plain)' },
  { value: 'starttls', label: 'StartTLS' },
  { value: 'ssl', label: 'SSL/TLS (LDAPS)' },
];

export interface ConnectionDialogProps {
  profile?: ConnectionProfile;
  /**
   * Saves the profile; a rejected promise keeps the dialog open (the error
   * is shown in the dialog). Resolving with the saved profile (as
   * connectionStore.saveProfile does) enables "Create and Connect".
   */
  onSave: (profile: ConnectionProfile, opts?: { quiet?: boolean }) => unknown;
  /** Closes the dialog (DialogHost passes it). */
  onClose: () => void;
  /** The profile is a copy to save as a new profile: title "Clone Connection". */
  clone?: boolean;
  /**
   * Opens with this section expanded and scrolled into view: 'tls' (TLS
   * trust), 'password' (Password storage: the status bar chip),
   * 'credentials' (Authentication with the bind password focused: "Edit…"
   * of a refused bind, RW2-C-04), 'advanced'.
   */
  initialSection?: 'tls' | 'password' | 'credentials' | 'advanced';
}

export type ConnectionDialogSection = NonNullable<ConnectionDialogProps['initialSection']>;

/**
 * Opens the connection dialog through DialogHost: new (no profile), edit,
 * or clone (`clone`: the profile is a copy without id and password), saving
 * with connectionStore.saveProfile. `initialSection` opens it at TLS trust,
 * Password storage or Advanced settings (status bar chips).
 */
export function openConnectionDialog(profile?: ConnectionProfile, opts: { clone?: boolean; initialSection?: ConnectionDialogSection } = {}) {
  useDialogStore.getState().open(ConnectionDialog, { profile, onSave: useConnectionStore.getState().saveProfile, ...opts });
}

/** Edit Connection for a saved profile id (status bar, switcher). */
export function editConnection(profileId: string, initialSection?: ConnectionDialogSection) {
  const profile = useConnectionStore.getState().profiles.find((p) => p.id === profileId);
  if (profile) openConnectionDialog(profile, { initialSection });
}

/** Clone Connection: a copy of the profile without id and password. */
export function cloneConnection(profile: ConnectionProfile) {
  openConnectionDialog({ ...profile, id: '', name: `Copy of ${profile.name}`, password: '', hasPassword: false }, { clone: true });
}

/** Cancel honours the dirty guard ("Discard changes?") like Escape. */
function CancelButton({ fallback }: { fallback: () => void }) {
  const dialog = useDialogContext();
  return (
    <Button variant="ghost" onClick={() => (dialog ? dialog.requestClose() : fallback())}>
      Cancel
    </Button>
  );
}

/**
 * New / edit / clone connection (Dialog md): every label is wired to its
 * control (Field), Enter saves, Escape or Cancel on a changed form asks
 * before discarding, the backdrop never closes it. A stored password is
 * never sent back: the field stays empty ("•••• saved — leave empty to
 * keep"). A new profile's primary button is "Create and Connect" (saves,
 * connects, shows the Explorer and focuses the first tree row); "Create"
 * only saves. A blocked save or test focuses the first invalid field.
 */
export function ConnectionDialog({ profile, onSave, onClose, clone = false, initialSection }: ConnectionDialogProps) {
  const close = onClose;
  const [initial] = useState<ConnectionProfile>(() => (profile ? { ...profile } : newConnectionProfile()));
  const [form, setForm] = useState<ConnectionProfile>(initial);
  // Fetched again on open: krb5.conf or the ticket cache may have changed.
  const env = useAuthEnvironment(true);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  // Incremented whenever Save/Test is blocked by validation errors.
  const [revealErrors, setRevealErrors] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [preset, setPreset] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(initialSection === 'advanced');
  // CA certificates added from the server ("Use as CA certificate"), by fingerprint.
  const [serverCAs, setServerCAs] = useState<string[]>([]);
  // An expired CA waiting for confirmation before it is added.
  const [pendingCA, setPendingCA] = useState<{ pem: string; cert: CertificateInfo } | null>(null);
  // "Refresh details" of the pinned certificates (DEF-04).
  const [pinRefresh, setPinRefresh] = useState<{ loading?: boolean; message?: string; tone?: 'info' | 'warning' } | null>(null);
  // The server's own name for the Kerberos SPN (DEF-05): RootDSE lookup, or what a test reported.
  const hostName = useServerHostName(form);
  const bodyRef = useRef<HTMLDivElement>(null);
  const tlsRef = useRef<HTMLDivElement>(null);
  const passwordRef = useRef<HTMLDivElement>(null);
  const credentialsRef = useRef<HTMLDivElement>(null);
  const advancedRef = useRef<HTMLDivElement>(null);
  // Incremented on every form change and test start; a test result is only
  // shown if nothing changed while it ran.
  const testSeq = useRef(0);
  const resultRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const isEdit = !!profile?.id;
  const isClone = !isEdit && clone;
  const connected = useConnectionStore((s) => (profile?.id ? !!s.connectionStatuses[profile.id] : false));
  const validation = useMemo(() => validateConnectionForm(form, env), [form, env]);
  const errors = showErrors ? validation.errors : {};
  const errorSummary = formErrorSummary(errors);
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initial), [form, initial]);

  // Bring the test report into view (it is below the form).
  useEffect(() => {
    if (testResult) resultRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [testResult]);

  // Opened from a status bar chip: show that section.
  useEffect(() => {
    const target =
      initialSection === 'tls' ? tlsRef
        : initialSection === 'password' ? passwordRef
          : initialSection === 'credentials' ? credentialsRef
            : initialSection === 'advanced' ? advancedRef
              : null;
    if (!target) return;
    // …and focus its first control, so typing never edits the hidden name field (RW1-C-09).
    let raf2 = 0;
    const raf = requestAnimationFrame(() => {
      target.current?.scrollIntoView({ block: 'start' });
      raf2 = requestAnimationFrame(() => {
        // The section's first field; its disclosure button while it is closed.
        // Credentials: the bind password, else the first text field, never the method select:
        // a password typed into a focused select picks an option by type-ahead (RW2-C-04).
        const root = target.current;
        const field =
          initialSection === 'credentials'
            ? root?.querySelector<HTMLElement>('input[type="password"]:not([disabled])') ??
              root?.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"])')
            : root?.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled])') ??
              root?.querySelector<HTMLElement>('button:not([disabled])');
        field?.focus({ preventScroll: true });
      });
    });
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(raf2);
    };
  }, [initialSection]);

  // A blocked save/test: open the section with the error and focus the first invalid field.
  useEffect(() => {
    if (revealErrors === 0) return;
    if (ADVANCED_ERROR_FIELDS.some((k) => validation.errors[k])) setAdvancedOpen(true);
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => {
      const el = bodyRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      el?.focus();
      el?.scrollIntoView({ block: 'nearest' });
    }));
    return () => cancelAnimationFrame(raf);
  }, [revealErrors]);

  function updateField<K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    testSeq.current++;
    setTestResult(null);
    setTesting(false);
    setSaveError(null);
    if (key === 'tlsPinnedCerts' || key === 'host' || key === 'port' || key === 'tlsMode') setPinRefresh(null);
  }

  async function handleSave(connectAfter: boolean) {
    setShowErrors(true);
    if (Object.keys(validation.errors).length > 0) {
      setRevealErrors((n) => n + 1);
      return;
    }
    // A profile that asks for the password on every connect is saved without one (DEF-07).
    const finalProfile = profileForSave(form);
    finalProfile.port = portForTLSMode(finalProfile.port, finalProfile.tlsMode);
    const typedForConnect = form.askPassword && sendsPassword(form) ? form.password : '';
    setSaving(true);
    setSaveError(null);
    let saved: unknown;
    try {
      // Create and Connect confirms the save together with the connect (one toast, RW3-C-03).
      saved = await onSave(finalProfile, connectAfter ? { quiet: true } : undefined);
    } catch (err: any) {
      // The form stays open with the input; the error is shown here (toasts sit below dialogs).
      setSaveError(err?.message || (typeof err === 'string' ? err : 'The connection could not be saved'));
      setSaving(false);
      return;
    }
    close();
    const id = saved && typeof saved === 'object' && 'id' in saved ? String((saved as { id: unknown }).id) : '';
    // Create and Connect uses the password typed here once instead of asking again (not saved).
    if (connectAfter && id && typedForConnect) primeConnectPassword(id, typedForConnect);
    if (connectAfter && id) void connectAndBrowse(id, { saved: true });
  }

  async function runTest(p: ConnectionProfile) {
    const blocking = testBlockingErrors(validateConnectionForm(p, env).errors);
    if (Object.keys(blocking).length > 0) {
      setShowErrors(true);
      setRevealErrors((n) => n + 1);
      return;
    }
    const seq = ++testSeq.current;
    setTesting(true);
    setTestResult(null);
    let result: ConnectionTestResult;
    try {
      result = await wailsAuth.TestConnectionDetailed(cleanProfileForSave(p));
    } catch (err: any) {
      result = {
        success: false,
        error: err?.message || (typeof err === 'string' ? err : 'Connection test failed'),
        authMethod: p.authMethod,
        tlsMode: p.tlsMode,
        durationMs: 0,
      };
    }
    if (seq !== testSeq.current) return; // the form changed meanwhile
    setTestResult(result);
    setTesting(false);
  }

  /** "Trust this certificate": pin it in the form (with its subject, issuer and expiry, DEF-04) and test again. */
  function trustCertificate(fingerprint: string) {
    const pins = form.tlsPinnedCerts ?? [];
    const chain = [...(testResult?.certProblem?.chain ?? []), ...(testResult?.serverCertificates ?? [])];
    const cert = chain.find((c) => c.sha256 === fingerprint);
    const fp = normalizeFingerprint(fingerprint) ?? fingerprint;
    const next: ConnectionProfile = {
      ...form,
      tlsPinnedCerts: pins.includes(fingerprint) ? pins : [...pins, fingerprint],
      tlsPinnedInfo: cert ? { ...(form.tlsPinnedInfo ?? {}), [fp]: pinInfoFromCertificate(cert) } : form.tlsPinnedInfo,
      tlsSkipVerify: false,
    };
    setForm(next);
    void runTest(next);
  }

  /**
   * "Refresh details" of the pins (DEF-04): reads the certificate the server
   * presents now (TLS handshake, no bind) and records subject, issuer and
   * expiry of the pins it matches.
   */
  async function refreshPinDetails() {
    const pins = form.tlsPinnedCerts ?? [];
    if (pins.length === 0) return;
    setPinRefresh({ loading: true });
    try {
      const certs = await wailsAuth.GetServerCertificates(cleanProfileForSave({ ...form, password: '' }));
      const { info, found } = pinInfoFromChain(form.tlsPinnedInfo, pins, certs);
      if (found.length > 0) {
        setForm((f) => ({ ...f, tlsPinnedInfo: info }));
        const missing = pins.length - found.length;
        setPinRefresh({
          message: `Details of ${found.length === 1 ? 'the pin' : `${found.length} pins`} read from the server.${missing > 0 ? ` The server does not present ${missing === 1 ? 'the other pinned certificate' : `${missing} other pinned certificates`}.` : ''}`,
        });
      } else {
        const leaf = certs[0];
        setPinRefresh({
          tone: 'warning',
          message: `The server presents none of the pinned certificates${leaf ? ` (it presents ${commonNameOf(leaf.subject)}, expires ${formatDate(leaf.notAfter)})` : ''}. Test Connection shows it.`,
        });
      }
    } catch (err: any) {
      setPinRefresh({ tone: 'warning', message: `Could not read the server's certificate: ${err?.message || String(err)}` });
    }
  }

  /** "Use as CA certificate": add it to the profile's CA certificates and test again (an expired CA asks first). */
  function useAsCA(pem: string, cert?: CertificateInfo) {
    if (cert && certValidityState(cert) === 'expired' && pendingCA?.pem !== pem) {
      setPendingCA({ pem, cert });
      return;
    }
    setPendingCA(null);
    const next: ConnectionProfile = { ...form, tlsCACertPEM: appendPEM(form.tlsCACertPEM, pem) };
    if (cert) setServerCAs((list) => (list.includes(cert.sha256) ? list : [...list, cert.sha256]));
    setForm(next);
    void runTest(next);
  }

  /** "Use as base DN" in the test result (keeps the result: the base DN does not change the test). */
  function useBaseDN(dn: string) {
    setForm((f) => ({ ...f, baseDN: dn }));
  }

  // The test's dnsHostName (also read after a failed Kerberos bind) answers the SPN question too.
  const serverName = hostName.state.name || hostName.state.loading || !testResult?.dnsHostName
    ? hostName.state
    : { name: testResult.dnsHostName };

  const presetInfo = CONNECTION_PRESETS.find((p) => p.id === preset);
  const adHint = !!presetInfo?.ad || testResult?.serverType === 'ad';
  const title = isEdit ? 'Edit Connection' : isClone ? 'Clone Connection' : 'New Connection';

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !saving && close()}
      title={title}
      description={isEdit ? `${profile?.host}:${profile?.port}` : isClone ? `Copy of ${profile?.host}:${profile?.port} — the password is not copied` : undefined}
      icon={Server}
      size="md"
      dismissible={saving ? 'never' : 'when-clean'}
      dirty={dirty}
      initialFocus={nameRef}
      onSubmit={() => void handleSave(!isEdit)}
      footer={
        <>
          <Button
            variant="secondary"
            leftIcon={FlaskConical}
            loading={testing}
            onClick={() => void runTest(form)}
            title="Connect and bind with these settings, then disconnect"
            className="mr-auto"
          >
            Test Connection
          </Button>
          <CancelButton fallback={close} />
          {isEdit ? (
            <Button variant="primary" type="submit" loading={saving}>
              Save Changes
            </Button>
          ) : (
            <>
              <Button variant="secondary" disabled={saving} onClick={() => void handleSave(false)} title="Save the profile without connecting">
                Create
              </Button>
              <Button variant="primary" type="submit" leftIcon={Plug} loading={saving}>
                Create and Connect
              </Button>
            </>
          )}
        </>
      }
    >
      <div ref={bodyRef} className="space-y-4">
      {/* Presets - only for new connections */}
      {!isEdit && (
        <div role="group" aria-labelledby="connection-presets-label">
          <p id="connection-presets-label" className="text-sm font-medium text-muted-foreground mb-1">Quick start</p>
          <div className="grid grid-cols-3 gap-1.5">
            {CONNECTION_PRESETS.map((p) => {
              const applied = preset === p.id;
              return (
                <button type="button"
                  key={p.id}
                  aria-pressed={applied}
                  onClick={() => {
                    // Leaving the Global Catalog preset undoes its read-only default.
                    const base = preset === 'ad-gc' && p.id !== 'ad-gc' ? { ...form, readOnly: initial.readOnly } : form;
                    setForm(p.apply(base));
                    setPreset(p.id);
                    testSeq.current++;
                    setTestResult(null);
                    setTesting(false);
                  }}
                  className={cn(
                    'relative flex flex-col items-center gap-0.5 px-2 py-2 rounded border outline-hidden focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-1',
                    applied ? 'border-primary bg-accent' : 'border-border-strong hover:bg-accent',
                  )}
                >
                  {applied ? (
                    <Check size={14} strokeWidth={2} aria-hidden className="text-primary" />
                  ) : (
                    <Server size={14} strokeWidth={1.75} aria-hidden className="text-muted-foreground" />
                  )}
                  <span className="text-xs font-medium text-foreground">{p.label}</span>
                  <span className="text-xs text-muted-foreground text-center">{p.description}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <Field label="Connection name" error={errors.name} required>
        <Input ref={nameRef} value={form.name} onChange={(e) => updateField('name', e.target.value)} placeholder="My LDAP Server" />
      </Field>

      <div className="flex gap-3">
        <Field className="flex-1 min-w-0" label="Host" error={errors.host} required>
          <Input value={form.host} onChange={(e) => updateField('host', e.target.value)} placeholder="ldap.example.com" spellCheck={false} />
        </Field>
        <Field className="w-24 shrink-0" label="Port" error={errors.port}>
          <Input type="number" value={form.port} onChange={(e) => updateField('port', parseInt(e.target.value) || 389)} className="tabular-nums" />
        </Field>
      </div>

      <Field label="Base DN" help={form.baseDN.trim() ? undefined : 'empty = all naming contexts of the server (Test Connection lists them)'}>
        <Input value={form.baseDN} onChange={(e) => updateField('baseDN', e.target.value)} placeholder="dc=example,dc=com" mono spellCheck={false} />
      </Field>

      <Field
        label="Security"
        help={form.tlsMode === 'none' ? 'Unencrypted: credentials and data are visible on the network.' : undefined}
      >
        <Select
          value={form.tlsMode}
          onChange={(e) => {
            const mode = e.target.value as TLSMode;
            updateField('tlsMode', mode);
            updateField('port', portForTLSMode(form.port, mode));
          }}
          options={TLS_OPTIONS}
        />
      </Field>

      {form.tlsMode !== 'none' && (
        <div ref={tlsRef}>
          <TLSTrustSettings
            form={form}
            update={updateField}
            errors={errors}
            revealErrors={revealErrors}
            defaultOpen={initialSection === 'tls'}
            serverCAs={serverCAs}
            onRefreshPins={() => void refreshPinDetails()}
            pinRefresh={pinRefresh ?? undefined}
          />
        </div>
      )}

      <div ref={credentialsRef}>
        <AuthSettings
          form={form}
          update={updateField}
          errors={errors}
          env={env}
          isEdit={isEdit}
          bindPlaceholder={adHint ? AD_BIND_PLACEHOLDER : presetInfo?.bindPlaceholder}
          serverName={serverName}
          onLookupServerName={hostName.lookup}
        />
      </div>

      {validation.warnings.length > 0 && (
        <InlineAlert
          tone="warning"
          live={false}
          body={validation.warnings.length === 1 ? validation.warnings[0] : (
            <ul className="list-disc pl-4 space-y-0.5">{validation.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          )}
        />
      )}

      {/* Password storage policy (issue #1) */}
      <div ref={passwordRef}>
        <PasswordStorageSettings form={form} update={updateField} connected={connected} serverType={testResult?.serverType} defaultOpen={initialSection === 'password'} />
      </div>

      {/* Advanced */}
      <div ref={advancedRef}>
      <Disclosure
        title="Advanced settings"
        summary={ADVANCED_ERROR_FIELDS.some((k) => errors[k]) ? 'check the values' : undefined}
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        contentClassName="space-y-3 mt-1 pl-3 border-l border-border"
      >
          <div className="flex gap-3">
            <Field className="flex-1 min-w-0" label="Page size" error={errors.pageSize} help={`${PROFILE_LIMITS.pageSize.min}-${PROFILE_LIMITS.pageSize.max} entries per page`}>
              <Input
                type="number"
                min={PROFILE_LIMITS.pageSize.min}
                max={PROFILE_LIMITS.pageSize.max}
                value={Number.isFinite(form.pageSize) ? form.pageSize : ''}
                onChange={(e) => updateField('pageSize', e.target.value === '' ? Number.NaN : Math.trunc(Number(e.target.value)))}
                className="tabular-nums"
              />
            </Field>
            <Field className="flex-1 min-w-0" label="Timeout (sec)" error={errors.timeout} help={`${PROFILE_LIMITS.timeout.min}-${PROFILE_LIMITS.timeout.max} seconds`}>
              <Input
                type="number"
                min={PROFILE_LIMITS.timeout.min}
                max={PROFILE_LIMITS.timeout.max}
                value={Number.isFinite(form.timeout) ? form.timeout : ''}
                onChange={(e) => updateField('timeout', e.target.value === '' ? Number.NaN : Math.trunc(Number(e.target.value)))}
                className="tabular-nums"
              />
            </Field>
          </div>
          <Checkbox
            checked={form.readOnly}
            onCheckedChange={(c) => updateField('readOnly', c)}
            label="Read-only mode"
            description="Prevents accidental modifications: every write is refused."
          />
          <Checkbox
            checked={form.disableReferrals}
            onCheckedChange={(c) => updateField('disableReferrals', c)}
            label="Disable referral chasing"
            description="Avoids cross-domain lookups in AD forests."
          />
      </Disclosure>
      </div>

      {testResult && (
        <div ref={resultRef}>
          <ConnectionTestResultView
            result={testResult}
            pinned={form.tlsPinnedCerts ?? []}
            onTrust={trustCertificate}
            onUseAsCA={useAsCA}
            onUseBaseDN={useBaseDN}
            baseDN={form.baseDN}
            spnProfile={form}
            onUseSPN={(spn) => {
              updateField('krbSPN', spn);
            }}
          />
        </div>
      )}

      {errorSummary.length > 0 && (
        <InlineAlert
          tone="danger"
          title="Check the highlighted fields"
          body={<ul className="list-disc pl-4 space-y-0.5">{errorSummary.map((line) => <li key={line}>{line}</li>)}</ul>}
        />
      )}
      {saveError && (
        <InlineAlert tone="danger" title="The connection was not saved" body={<span className="break-words select-text">{saveError}</span>} onDismiss={() => setSaveError(null)} />
      )}
      </div>
      {pendingCA && (
        <ConfirmDialog
          tone="warning"
          title="Use an expired CA certificate?"
          message={`${commonNameOf(pendingCA.cert.subject)} expired on ${formatDate(pendingCA.cert.notAfter)}. Certificates it issued fail verification once the CA has expired, so trusting it usually does not help; ask the server administrator for the current CA certificate.`}
          confirmLabel="Use Anyway"
          onConfirm={() => useAsCA(pendingCA.pem, pendingCA.cert)}
          onCancel={() => setPendingCA(null)}
        />
      )}
    </Dialog>
  );
}
