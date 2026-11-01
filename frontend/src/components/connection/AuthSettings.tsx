import { Check } from 'lucide-react'
import type { AuthMethod, ConnectionProfile } from '../../types/ldap'
import type { AuthEnvironment } from '../../types/auth'
import {
  AUTH_METHODS, authMethodInfo, defaultSPN, derivedRealm, describeCCache, effectiveRealm, effectiveSPN, needsExplicitSPN, ntlmAccount,
  ntlmDomainFromUser, spnSuggestion,
} from '../../lib/connectionAuth'
import * as wailsAuth from '../../lib/wails-auth'
import { Input, Select } from '../ui/Input'
import { InlineAlert } from '../ui/InlineAlert'
import { Checkbox } from '../ui/Checkbox'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import { Field, PathInput } from './FormField'
import type { ServerHostNameState } from './useServerHostName'

interface AuthSettingsProps {
  form: ConnectionProfile;
  update: <K extends keyof ConnectionProfile>(key: K, value: ConnectionProfile[K]) => void;
  errors: Record<string, string>;
  env: AuthEnvironment | null;
  isEdit: boolean;
  /** Placeholder of the simple-bind DN (an AD preset suggests a UPN). */
  bindPlaceholder?: string;
  /** The server's own name (RootDSE dnsHostName) for the Kerberos SPN suggestion (DEF-05). */
  serverName?: ServerHostNameState;
  /** Reads the server's name now ("Look up"). */
  onLookupServerName?: () => void;
}

/** Placeholder of the password field when a password is stored (it is never sent back to the UI). */
export const SAVED_PASSWORD_PLACEHOLDER = '•••• saved — leave empty to keep';

/** Authentication method and its method-specific fields. */
export function AuthSettings({ form, update, errors, env, isEdit, bindPlaceholder = 'cn=admin,dc=example,dc=com', serverName, onLookupServerName }: AuthSettingsProps) {
  const method = form.authMethod;
  const ask = !!form.askPassword;
  const passwordSaved = isEdit && form.hasPassword && !ask;
  const krbSystem = form.krbCredSource === 'system';
  const windows = env?.sspiAvailable ?? false;
  // The domain carried by DOMAIN\user or user@domain (the Domain field is ignored then).
  const userDomain = ntlmDomainFromUser(form.bindDN);

  // "Ask for the password on every connect" (DEF-07): the field only feeds Test Connection and
  // the first connect of Create and Connect; nothing is saved.
  const passwordField = (
    <>
      <Field
        label={ask ? 'Password (not saved)' : 'Password'}
        required={!passwordSaved && !ask}
        error={errors.password}
        help={ask
          ? 'Used for Test Connection and by Create and Connect; LDAPilot asks for it on every connect.'
          : passwordSaved ? 'A password is stored for this connection. Type a new one to replace it.' : undefined}
      >
        <Input
          type="password"
          value={form.password}
          onChange={(e) => update('password', e.target.value)}
          placeholder={passwordSaved ? SAVED_PASSWORD_PLACEHOLDER : ask ? 'Optional: to test the connection' : 'Enter password'}
          autoComplete="new-password"
        />
      </Field>
      <Checkbox
        checked={ask}
        onCheckedChange={(c) => update('askPassword', c)}
        label="Ask for the password on every connect"
        description={ask && isEdit && form.hasPassword
          ? 'The stored password is removed when you save.'
          : 'No password is stored with this connection; Connect and Reconnect ask for it.'}
      />
    </>
  );
  const suggestedSPN = spnSuggestion(form, serverName?.name);

  return (
    <div className="space-y-3">
      <Field label="Authentication" error={errors.authMethod} help={authMethodInfo(method).description}>
        <Select
          value={method}
          onChange={(e) => update('authMethod', e.target.value as AuthMethod)}
          options={AUTH_METHODS.map((m) => ({ value: m.value, label: m.label }))}
        />
      </Field>

      {method === 'simple' && (
        <>
          <Field label="Bind DN" required error={errors.bindDN} help="Active Directory also accepts user@domain or DOMAIN\user here.">
            <Input
              value={form.bindDN}
              onChange={(e) => update('bindDN', e.target.value)}
              placeholder={bindPlaceholder}
              mono
              spellCheck={false}
            />
          </Field>
          {passwordField}
        </>
      )}

      {method === 'ntlm' && (
        <>
          <div className="flex gap-3">
            <Field
              className="flex-1 min-w-0"
              label="User name"
              required
              error={errors.bindDN}
              help={form.bindDN.trim() ? <>Authenticates as <span className="font-mono">{ntlmAccount(form.bindDN, form.ntlmDomain)}</span></> : 'DOMAIN\\user, user@domain or user'}
            >
              <Input
                value={form.bindDN}
                onChange={(e) => update('bindDN', e.target.value)}
                placeholder="EXAMPLE\administrator"
                spellCheck={false}
              />
            </Field>
            <Field className="w-36 shrink-0" label="Domain (optional)" help={userDomain ? 'From the user name' : undefined}>
              <Input
                value={userDomain || (form.ntlmDomain ?? '')}
                onChange={(e) => update('ntlmDomain', e.target.value)}
                placeholder="EXAMPLE"
                disabled={!!userDomain}
                title={userDomain ? 'The user name names the domain; this field is not used' : undefined}
                spellCheck={false}
              />
            </Field>
          </div>
          {passwordField}
          <InlineAlert
            tone="info"
            live={false}
            body={
              <>
                NTLMv2 without signing, sealing or channel binding: use LDAPS or StartTLS. Domain controllers that require
                LDAP signing reject NTLM on plain LDAP; DCs that enforce LDAP channel binding ("always") reject it on LDAPS too.
              </>
            }
          />
        </>
      )}

      {method === 'kerberos' && (
        <>
          <Field label="Credentials">
            <Select
              value={krbSystem ? 'system' : 'password'}
              onChange={(e) => update('krbCredSource', e.target.value as 'password' | 'system')}
              options={[
                { value: 'password', label: 'User name and password' },
                { value: 'system', label: windows ? 'Current Windows logon (SSPI, single sign-on)' : 'Kerberos ticket cache (kinit)' },
              ]}
            />
          </Field>

          {!krbSystem && (
            <>
              <Field label="User name" required error={errors.bindDN} help="user or user@REALM">
                <Input
                  value={form.bindDN}
                  onChange={(e) => update('bindDN', e.target.value)}
                  placeholder="alice@EXAMPLE.COM"
                  spellCheck={false}
                />
              </Field>
              {passwordField}
            </>
          )}

          {krbSystem && windows && (
            <p className="text-xs text-muted-foreground">
              Uses the Kerberos tickets of the Windows user running LDAPilot. On LDAPS/StartTLS, channel binding to the
              server certificate is added automatically. The realm and KDC fields below do not apply to SSPI.
            </p>
          )}
          {krbSystem && !windows && (
            <Field
              label="Credential cache (optional)"
              error={errors.krbCCache}
              help={env
                ? <>Default: <span className="font-mono">{describeCCache(env)}</span>{env.ccacheSupported ? '. Run kinit first.' : ' - cannot be read, only FILE: caches are supported. Run kinit -c FILE:/tmp/krb5cc_<uid> and enter that file here.'}</>
                : 'Default: KRB5CCNAME, default_ccache_name of krb5.conf, or /tmp/krb5cc_<uid>. Run kinit first.'}
            >
              <PathInput
                value={form.krbCCache ?? ''}
                onChange={(v) => update('krbCCache', v)}
                onBrowse={async () => { const p = await wailsAuth.BrowseCertificateFile('ccache'); if (p) update('krbCCache', p); }}
                placeholder={env?.ccacheSupported && env.defaultCCache ? env.defaultCCache : '/tmp/krb5cc_<uid>'}
              />
            </Field>
          )}

          <div className="flex gap-3">
            <Field
              className="flex-1 min-w-0"
              label="Realm"
              error={errors.krbRealm}
              help={krbSystem ? 'Taken from the ticket cache / Windows logon.' : 'Always uppercase - for Active Directory the DNS domain, e.g. AD.EXAMPLE.COM.'}
            >
              <Input
                value={form.krbRealm ?? ''}
                onChange={(e) => update('krbRealm', e.target.value)}
                onBlur={(e) => {
                  const upper = e.target.value.trim().toUpperCase();
                  if (upper !== (form.krbRealm ?? '')) update('krbRealm', upper);
                }}
                placeholder={(!krbSystem && derivedRealm(form)) || 'EXAMPLE.COM'}
                className="uppercase"
                disabled={krbSystem}
                spellCheck={false}
              />
            </Field>
            <Field className="flex-1 min-w-0" label="KDC (optional)" error={errors.krbKDC}>
              <Input
                value={form.krbKDC ?? ''}
                onChange={(e) => update('krbKDC', e.target.value)}
                placeholder="kdc.example.com:88"
                disabled={krbSystem && windows}
                spellCheck={false}
              />
            </Field>
          </div>
          <Field
            label="Service principal (SPN)"
            error={errors.krbSPN}
            help={needsExplicitSPN(form.host)
              ? <>Connecting via <span className="font-mono">{form.host || 'an IP address'}</span>: set the DC's real name, e.g. <span className="font-mono">ldap/dc1.example.com</span>.</>
              : <>Default: <span className="font-mono">{defaultSPN(form.host || '<host>')}</span>. Needed when connecting via an IP address or alias.</>}
          >
            <Input
              value={form.krbSPN ?? ''}
              onChange={(e) => update('krbSPN', e.target.value)}
              placeholder={defaultSPN(form.host || 'host')}
              mono
              spellCheck={false}
            />
          </Field>
          {/* The server's own name from its RootDSE (DEF-05): offered as SPN for an IP address / alias. */}
          {(needsExplicitSPN(form.host) || serverName?.name) && !!form.host.trim() && (
            <div className="-mt-1.5 flex items-center gap-2 min-w-0 text-xs text-muted-foreground" role="status" aria-live="polite">
              {serverName?.loading ? (
                <>
                  <Spinner size="sm" decorative />
                  <span>Reading the server's name from its RootDSE…</span>
                </>
              ) : suggestedSPN ? (
                <>
                  <span className="min-w-0 truncate">
                    The server calls itself <span className="font-mono text-foreground">{serverName?.name}</span>.
                  </span>
                  <Button size="sm" variant="secondary" className="shrink-0" onClick={() => update('krbSPN', suggestedSPN)}>
                    Use {suggestedSPN}
                  </Button>
                </>
              ) : serverName?.name ? (
                <span className="flex items-center gap-1 min-w-0">
                  <Check size={12} aria-hidden className="shrink-0 text-success" />
                  <span className="truncate">
                    <span className="font-mono">{effectiveSPN(form)}</span> matches the server's name.
                  </span>
                </span>
              ) : (
                <>
                  {serverName?.error && <span className="min-w-0 truncate" title={serverName.error}>Server name not available: {serverName.error}</span>}
                  {onLookupServerName && (
                    <Button size="sm" variant="link" className="shrink-0" onClick={onLookupServerName}>
                      {serverName?.error ? 'Try again' : "Look up the server's name"}
                    </Button>
                  )}
                </>
              )}
            </div>
          )}
          {!(krbSystem && windows) && (
            <p className="text-xs text-muted-foreground">
              {form.krbKDC?.trim()
                ? <>Uses only the KDC above (TCP){!krbSystem && effectiveRealm(form) ? <> for realm <span className="font-mono">{effectiveRealm(form)}</span></> : null}.</>
                : env?.krb5ConfigFound
                  ? <>Uses <span className="font-mono">{env.krb5Config}</span>, then DNS SRV records to find the KDC.</>
                  : <>No krb5.conf found{env ? <> at <span className="font-mono">{env.krb5Config}</span></> : null}: the KDC is looked up in DNS (_kerberos._tcp). Set a KDC if that does not work.</>}
            </p>
          )}
          <InlineAlert
            tone="info"
            live={false}
            body={
              <>
                GSSAPI here authenticates but does not add LDAP signing or sealing. Domain controllers that require LDAP
                signing reject such binds on plain LDAP - use LDAPS or StartTLS with Kerberos.
                {!(krbSystem && windows) && ' Channel binding is only added for the Windows logon (SSPI), so DCs that enforce LDAP channel binding ("always") reject this bind on LDAPS.'}
              </>
            }
          />
        </>
      )}

      {method === 'external' && (
        <>
          <InlineAlert
            tone="info"
            live={false}
            body="Configure the client certificate and key under TLS trust above. The server must request and accept client certificates and map them to an entry."
          />
          {errors.tlsClientCertFile && (
            <InlineAlert tone="danger" body={`${errors.tlsClientCertFile} - set them under TLS trust above.`} />
          )}
        </>
      )}
    </div>
  );
}
