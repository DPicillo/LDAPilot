import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, KeyRound } from 'lucide-react'
import { Disclosure } from '../ui/Disclosure'
import type { ConnectionProfile } from '../../types/ldap'
import type { EffectivePasswordPolicy, PasswordPolicyCatalog } from '../../types/passwordPolicy'
import { GetPasswordPolicy, GetPasswordPolicyCatalog } from '../../lib/wails-pwpolicy'
import {
  POLICY_SETTINGS, SERVER_TYPE_LABELS, defaultClientScheme, describePolicyDefault, normalizePolicySetting, schemeSupportSummary,
} from '../../lib/passwordPolicy'
import { schemeOptionLabel, schemeWithStrength } from '../../lib/passwordMethod'
import { Field } from './FormField'
import { Select } from '../ui/Input'


/**
 * "Password storage" section of the connection dialog: the per-connection
 * password storage policy (issue #1) applied to every write of userPassword
 * (create, edit, bulk modify, LDIF import, password dialog defaults). On
 * Active Directory the setting is ignored (passwords go through unicodePwd),
 * so the section is a read-only note there.
 */
export function PasswordStorageSettings({ form, update, connected, serverType, defaultOpen = false }: {
  form: ConnectionProfile;
  update: <K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]) => void;
  /** The profile is connected: show what the saved setting resolves to on that server. */
  connected: boolean;
  /** Server type known from a connection test (before the profile is connected). */
  serverType?: string;
  /** Open the section (the status bar's password storage chip opens Edit Connection here). */
  defaultOpen?: boolean;
}) {
  const [catalog, setCatalog] = useState<PasswordPolicyCatalog | null>(null);
  const [effective, setEffective] = useState<EffectivePasswordPolicy | null>(null);

  useEffect(() => {
    GetPasswordPolicyCatalog().then(setCatalog, () => setCatalog(null));
  }, []);
  useEffect(() => {
    if (!connected || !form.id) return;
    GetPasswordPolicy(form.id).then(setEffective, () => setEffective(null));
  }, [connected, form.id]);

  const setting = normalizePolicySetting(form.passwordPolicy) || 'auto';
  const schemeLabel = (id: string) => catalog?.schemes.find((s) => s.id === id)?.label ?? id;
  const detected = (effective?.serverType ?? serverType) as EffectivePasswordPolicy['serverType'] | undefined;
  const isAD = detected === 'ad';
  const selectedScheme = form.passwordScheme ? catalog?.schemes.find((s) => s.id === form.passwordScheme) : undefined;
  // Support of the chosen (or default) scheme: on the detected server type,
  // or on every server type that needs a module / the system crypt(3)
  // while the profile is not connected.
  const supportNotes = useMemo(() => {
    const id = form.passwordScheme || (detected ? defaultClientScheme(detected) : '');
    const sc = catalog?.schemes.find((s) => s.id === id);
    if (!sc) return [];
    return sc.support
      .filter((x) => (detected ? x.server === detected : x.server !== 'ad') && x.level !== 'native')
      .map((x) => `${SERVER_TYPE_LABELS[x.server] ?? x.server}: ${x.level === 'no' ? 'not supported' : x.note}`);
  }, [catalog, form.passwordScheme, detected]);
  const defaultLabel = detected
    ? `Default of the server type (${schemeLabel(defaultClientScheme(detected))})`
    : `Default of the server type (OpenLDAP: ${schemeLabel(defaultClientScheme('openldap'))}; 389DS: ${schemeLabel(defaultClientScheme('389ds'))}; others: ${schemeLabel(defaultClientScheme('other'))})`;
  const schemeHelp = selectedScheme?.description ??
    (detected
      ? catalog?.schemes.find((s) => s.id === defaultClientScheme(detected))?.description
      : 'The scheme the detected server type verifies without extra modules.');

  // Open while the setting is not automatic when the dialog opens; the user
  // opens and closes it afterwards (choosing "Automatic" must not collapse it).
  const [open, setOpen] = useState(() => defaultOpen || setting !== 'auto');

  if (isAD) {
    return (
      <Disclosure
        title="Password storage"
        icon={KeyRound}
        summary="not used on Active Directory"
        open={open}
        onOpenChange={setOpen}
        contentClassName="mt-1 pl-2 border-l border-border"
      >
        <p className="text-xs text-muted-foreground leading-snug">
          Active Directory stores passwords via unicodePwd (Reset Password…); this setting is ignored, and userPassword values are passed to the server unchanged.
        </p>
      </Disclosure>
    );
  }

  return (
    <Disclosure
      title="Password storage"
      icon={KeyRound}
      summary={POLICY_SETTINGS.find((p) => p.value === setting)?.label}
      open={open}
      onOpenChange={setOpen}
      contentClassName="space-y-2 mt-1 pl-2 border-l border-border"
    >
        <Field
          label="How cleartext userPassword values are stored"
          help={POLICY_SETTINGS.find((p) => p.value === setting)?.description}
        >
          <Select
            value={setting}
            onChange={(e) => {
              const v = normalizePolicySetting(e.target.value);
              update('passwordPolicy', v || undefined);
              if (v !== 'client') update('passwordScheme', undefined);
            }}
            options={POLICY_SETTINGS.map((p) => ({ value: p.value, label: p.label }))}
          />
        </Field>

        {setting === 'client' && (
          <Field label="Scheme" help={schemeHelp}>
            <Select
              value={form.passwordScheme || ''}
              onChange={(e) => update('passwordScheme', e.target.value || undefined)}
              options={[
                { value: '', label: defaultLabel },
                ...(catalog?.schemes ?? []).map((s) => ({
                  value: s.id,
                  label: detected ? schemeWithStrength(schemeOptionLabel(s, detected, ''), s.security) : `${schemeWithStrength(s.label, s.security)}${schemeSupportSummary(s)}`,
                })),
              ]}
            />
          </Field>
        )}
        {setting === 'client' && supportNotes.length > 0 && (
          <div className="space-y-0.5 text-xs text-warning">
            {supportNotes.map((n, i) => (
              <p key={i} className="flex items-start gap-1">
                <AlertTriangle size={12} aria-hidden className="mt-0.5 shrink-0" />
                <span>{n}{i === supportNotes.length - 1 ? '. Without it the server cannot verify the hash and passwords hashed with it will not work.' : ''}</span>
              </p>
            ))}
          </div>
        )}

        {setting === 'auto' && catalog && (
          <ul className="text-xs text-muted-foreground space-y-0.5">
            {catalog.defaults.map((d) => <li key={d.serverType}>{describePolicyDefault(d, schemeLabel)}</li>)}
          </ul>
        )}

        <p className="text-xs text-muted-foreground leading-snug">
          Applies to every userPassword write. Values with a known {'{SCHEME}'} prefix are kept as they are.
          {form.tlsMode === 'none' && ' Without TLS, sending a cleartext password asks first.'}
        </p>

        {effective && (
          <p className="text-xs text-muted-foreground leading-snug">
            Saved setting on this server ({SERVER_TYPE_LABELS[effective.serverType] ?? effective.serverType}): {effective.summary}
          </p>
        )}
    </Disclosure>
  );
}
