/**
 * Copy Entry (LIFE-09): a copy of an entry under a new name, in a container
 * chosen with the ContainerPicker (default: the source's container).
 * Account copies never keep the source's login: they need a new uid (LDAP),
 * sAMAccountName / UPN (AD) and, for POSIX accounts, a new uidNumber, each
 * prefilled from the new name and checked for duplicates. Passwords are
 * never copied; a new one is typed twice (LDAP: userPassword through the
 * password write guard; AD: SetPassword over TLS, then optionally enabled).
 * "Copy group memberships" (default on for accounts) adds the copy to the
 * source's direct groups. The copy opens afterwards; ldapilot:entry-created
 * is emitted.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { CopyPlus } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import type { LDAPEntry } from '../../types/ldap'
import {
  buildCopyAttributes, COPY_PER_ACCOUNT_ATTRS, copyLoginFields, copySecretAttributes, copyTargetDN, parseRDN, planEntryCopy,
  splitFirstRDN, suggestSAMAccountName, suggestUid,
} from '../../lib/entryChanges'
import { looksLikeAccount } from '../../lib/accountActions'
import { base64ByteLength, formatByteSize } from '../../lib/binary'
import * as wails from '../../lib/wails'
import { CreateEntryWithOptions } from '../../lib/wails-pwpolicy'
import { SetPassword } from '../../lib/wails-password'
import { SetAccountEnabled } from '../../lib/wails-account'
import { AddToGroups, ResolveMemberOf, newMembershipRequestId } from '../../lib/wails-membership'
import { LoginNameHolders, NextPosixIDs } from '../../lib/wails-recycle'
import { normalizeDN } from '../../lib/dn'
import { PasswordPolicyHint } from '../password/PasswordPolicyHint'
import { NewPasswordInput, newPasswordReady } from '../password/NewPasswordInput'
import { notifyPasswordWrite, usePasswordWriteGuard } from '../password/PasswordWriteGuard'
import { toast } from '../ui/Toast'
import { errorMessage } from './useBinaryActions'
import { Dialog } from '../ui/Dialog'
import { DialogCancelButton } from './DialogCancelButton'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { Input } from '../ui/Input'
import { Checkbox } from '../ui/Checkbox'
import { InlineAlert } from '../ui/InlineAlert'
import { Spinner } from '../ui/Spinner'
import { Dn } from '../ui/Dn'
import { ContainerPicker, type TargetStatus } from '../lifecycle/ContainerPicker'
import { rememberTarget } from '../lifecycle/containerPicker'
import { emitEntryCreated } from '../lifecycle/events'
import { summarizeCreate, type CreateStep } from '../lifecycle/newEntry'

interface CopyEntryDialogProps {
  sourceDN: string;
  onClose: () => void;
  onCopied?: () => void;
  /** Connection (default: the active connection). */
  profileId?: string;
}

/** Duplicate check state of one login value. */
interface Dup {
  value: string;
  holders: string[] | null;
}

function useDuplicateCheck(profileId: string, attr: string, value: string, enabled: boolean): Dup {
  const [dup, setDup] = useState<Dup>({ value: '', holders: null });
  useEffect(() => {
    const v = value.trim();
    if (!enabled || !v || !profileId) {
      setDup({ value: v, holders: [] });
      return;
    }
    let cancelled = false;
    setDup({ value: v, holders: null });
    const timer = setTimeout(() => {
      LoginNameHolders(profileId, attr, v)
        .then((holders) => { if (!cancelled) setDup({ value: v, holders }); })
        .catch(() => { if (!cancelled) setDup({ value: v, holders: [] }); });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [profileId, attr, value, enabled]);
  return dup;
}

export function CopyEntryDialog({ sourceDN, onClose, onCopied, profileId: profileProp }: CopyEntryDialogProps) {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const profileId = profileProp ?? activeProfileId ?? '';
  const tlsOK = useConnectionStore((s) => (s.profiles.find((p) => p.id === profileId)?.tlsMode ?? 'none') !== 'none');

  // Escaped commas ("CN=Doe\, John") belong to the RDN
  const { rdn: sourceRDN, parent: sourceParent } = splitFirstRDN(sourceDN);
  const { attr: rdnAttr, value: rdnVal } = parseRDN(sourceRDN);

  // A uid is a login name: "copy.of.jdoe" instead of "Copy of jdoe" for uid-named entries.
  const initialName = rdnAttr.toLowerCase() === 'uid' ? suggestUid(`Copy of ${rdnVal}`) || `${rdnVal}-copy` : `Copy of ${rdnVal}`;
  const [newRDNValue, setNewRDNValue] = useState(initialName);
  const [source, setSource] = useState<LDAPEntry | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [target, setTarget] = useState(sourceParent);
  const [targetStatus, setTargetStatus] = useState<TargetStatus>({ dn: '', state: 'empty' });
  const [login, setLogin] = useState({ sam: '', uid: '', uidNumber: '' });
  const [loginEdited, setLoginEdited] = useState({ sam: false, uid: false, uidNumber: false });
  const [nextUidNumber, setNextUidNumber] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [enable, setEnable] = useState(true);
  const [mustChange, setMustChange] = useState(true);
  const [copyGroups, setCopyGroups] = useState(true);
  const [sourceGroups, setSourceGroups] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordGuard = usePasswordWriteGuard();
  const passwordFieldId = `copy-pw${useId().replace(/:/g, '')}`;
  const nameRef = useRef<HTMLInputElement>(null);

  // Read the source once: login fields, binary values, secrets left out.
  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;
    wails.GetEntry(profileId, sourceDN).then(
      (e) => {
        if (cancelled) return;
        if (e) setSource(e);
        else setSourceError('Source entry not found');
      },
      (err) => { if (!cancelled) setSourceError(errorMessage(err, 'Failed to read source entry')); },
    );
    return () => { cancelled = true; };
  }, [profileId, sourceDN]);

  const attrs = source?.attributes ?? [];
  const fields = useMemo(() => copyLoginFields(attrs, rdnAttr), [attrs, rdnAttr]);
  const isADAccount = fields.sAMAccountName;
  const isComputer = fields.computer;
  // AD users/computers are created disabled (userAccountControl | ACCOUNTDISABLE).
  const isADUserAccount = isADAccount && attrs.some((a) => a.name.toLowerCase() === 'useraccountcontrol');
  const objectClasses = attrs.find((a) => a.name.toLowerCase() === 'objectclass')?.values;
  const looksAccount = looksLikeAccount(objectClasses);
  const droppedSecrets = useMemo(() => copySecretAttributes(attrs), [attrs]);
  const isAccount = isADUserAccount || fields.uid || looksAccount || fields.posix;
  // LDAP accounts get their userPassword right away; AD accounts via SetPassword (TLS).
  const offerLDAPPassword = !isADAccount && isAccount;
  const offerADPassword = isADUserAccount && !isComputer;

  // Login names follow the new name until edited.
  useEffect(() => {
    setLogin((l) => ({
      // Users: the New User rule (lowercase, "first.last"; M-11); computers keep NAME$.
      sam: loginEdited.sam ? l.sam : isComputer ? suggestSAMAccountName(newRDNValue, true) : suggestSAMAccountName(suggestUid(newRDNValue)),
      uid: loginEdited.uid ? l.uid : suggestUid(newRDNValue),
      uidNumber: loginEdited.uidNumber ? l.uidNumber : nextUidNumber,
    }));
  }, [newRDNValue, isComputer, loginEdited, nextUidNumber]);

  // POSIX copies: the next free uidNumber.
  useEffect(() => {
    if (!fields.posix || !profileId) return;
    let cancelled = false;
    NextPosixIDs(profileId).then((ids) => { if (!cancelled && ids) setNextUidNumber(String(ids.uidNumber)); }).catch(() => {});
    return () => { cancelled = true; };
  }, [fields.posix, profileId]);

  // Direct groups of the source (all server types), for "Copy group memberships".
  useEffect(() => {
    if (!source || !isAccount || !profileId) return;
    let cancelled = false;
    ResolveMemberOf(profileId, sourceDN, false, newMembershipRequestId()).then((res) => {
      if (cancelled) return;
      setSourceGroups((res?.items ?? []).filter((it) => it.direct && it.dn && !it.primaryOnly && !it.external && !it.self).map((it) => it.dn));
    }).catch(() => { if (!cancelled) setSourceGroups([]); });
    return () => { cancelled = true; };
  }, [source, isAccount, profileId, sourceDN]);

  const samValue = login.sam.trim() ? (isComputer && !login.sam.trim().endsWith('$') ? `${login.sam.trim()}$` : login.sam.trim()) : '';
  const upn = isADAccount && fields.upnSuffix && samValue && !isComputer ? `${samValue}${fields.upnSuffix}` : '';
  const samDup = useDuplicateCheck(profileId, 'sAMAccountName', samValue, isADAccount);
  const upnDup = useDuplicateCheck(profileId, 'userPrincipalName', upn, !!upn);
  const uidDup = useDuplicateCheck(profileId, 'uid', login.uid, fields.uid);
  const uidNumberDup = useDuplicateCheck(profileId, 'uidNumber', login.uidNumber, fields.posix);
  // uid-named accounts: the new RDN value is the login name (another container may hold it).
  const rdnUidDup = useDuplicateCheck(profileId, 'uid', newRDNValue, fields.rdnIsLogin);
  const dupProblem = (d: Dup, label: string) => d.holders === null
    ? null
    : d.holders.length > 0 ? `${label} "${d.value}" is already used by ${d.holders[0]}${d.holders.length > 1 ? ` (+${d.holders.length - 1})` : ''}` : null;
  const problems = [
    isADAccount && !samValue ? 'Enter a sAMAccountName' : dupProblem(samDup, 'sAMAccountName'),
    dupProblem(upnDup, 'userPrincipalName'),
    fields.uid && !login.uid.trim() ? 'Enter a uid' : dupProblem(uidDup, 'uid'),
    fields.posix && !login.uidNumber.trim() ? 'Enter a uidNumber' : dupProblem(uidNumberDup, 'uidNumber'),
    dupProblem(rdnUidDup, 'uid'),
  ].filter((x): x is string => !!x);
  const checking = [samDup, upnDup, uidDup, uidNumberDup, rdnUidDup].some((d) => d.holders === null && d.value);

  const newDN = copyTargetDN(sourceDN, newRDNValue, target);
  const targetOK = targetStatus.state === 'ok' && normalizeDN(targetStatus.dn) === normalizeDN(target);
  const passwordOK = !password && !confirm ? true : newPasswordReady(password, confirm);

  // SPNs, DNS host names etc. must stay unique per account
  const droppedPerAccount = useMemo(
    () => attrs.filter((a) => COPY_PER_ACCOUNT_ATTRS.has(a.name.toLowerCase().split(';')[0])).map((a) => a.name),
    [attrs],
  );

  const binarySummary = useMemo(() => {
    if (!source) return null;
    const bin = buildCopyAttributes(source.attributes, rdnAttr, newRDNValue).filter((a) => a.binary);
    if (bin.length === 0) return null;
    const values = bin.reduce((n, a) => n + a.values.length, 0);
    const bytes = bin.reduce((n, a) => n + a.values.reduce((m, v) => m + base64ByteLength(v), 0), 0);
    return `${values} binary value${values !== 1 ? 's' : ''} (${bin.map((a) => a.name).join(', ')}; ${formatByteSize(bytes)})`;
  }, [source, rdnAttr, newRDNValue]);

  const canCopy = !!source && !loading && !!newRDNValue.trim() && targetOK && problems.length === 0 && !checking && passwordOK;

  async function handleCopy() {
    if (!profileId || !source || !canCopy) return;
    setLoading(true);
    setError(null);
    const steps: CreateStep[] = [];
    try {
      // Drop operational attributes and the source's login identity, set the
      // new name; binary values (photos, certificates) stay base64.
      const copy = planEntryCopy(sourceDN, source.attributes, newRDNValue, {
        sAMAccountName: isADAccount ? samValue : undefined,
        uid: fields.uid ? login.uid.trim() : undefined,
        uidNumber: fields.posix ? login.uidNumber.trim() : undefined,
        parentDN: target.trim(),
      });
      const withPassword = offerLDAPPassword && !!password;
      const attributes = withPassword
        ? [...copy.attributes, { name: 'userPassword', values: [password], binary: false }]
        : copy.attributes;
      const opts = await passwordGuard.check(profileId, { attributes });
      if (!opts) return; // cancelled: nothing was sent
      let report;
      try {
        report = await CreateEntryWithOptions(profileId, copy.dn, attributes, opts);
      } catch (err) {
        setError(errorMessage(err, 'Failed to copy entry'));
        return;
      }
      steps.push({ id: 'create', state: 'done', text: 'created' });
      if (isADUserAccount) {
        let passwordSet = false;
        // The password field is only offered over TLS (AD refuses unicodePwd otherwise).
        if (offerADPassword && password && tlsOK) {
          try {
            await SetPassword(profileId, { dn: copy.dn, password, method: 'unicodePwd', scheme: '', mustChange, unlock: false, verifyBind: false });
            passwordSet = true;
            steps.push({ id: 'password', state: 'done', text: mustChange ? 'password set (must change)' : 'password set' });
          } catch (err) {
            steps.push({ id: 'password', state: 'failed', text: 'password', detail: errorMessage(err, 'failed') });
          }
        }
        if (offerADPassword && enable && passwordSet) {
          try {
            await SetAccountEnabled(profileId, copy.dn, true);
            steps.push({ id: 'enable', state: 'done', text: 'enabled' });
          } catch (err) {
            steps.push({ id: 'enable', state: 'failed', text: 'account enabled', detail: errorMessage(err, 'failed') });
          }
        } else if (passwordSet || !password || !offerADPassword) {
          steps.push({ id: 'disabled', state: 'done', text: passwordSet ? 'disabled' : 'disabled (no password)' });
        }
      }
      const groups = copyGroups && isAccount ? sourceGroups ?? [] : [];
      if (groups.length > 0) {
        try {
          const res = await AddToGroups(profileId, copy.dn, groups);
          const failed = res.failed ?? [];
          steps.push(failed.length
            ? { id: 'groups', state: 'failed', text: `member of ${groups.length - failed.length} of ${groups.length} groups`, detail: failed.map((f) => `${f.dn}: ${f.error}`).join('\n') }
            : { id: 'groups', state: 'done', text: `added to ${groups.length} group${groups.length === 1 ? '' : 's'}` });
        } catch (err) {
          steps.push({ id: 'groups', state: 'failed', text: 'group memberships', detail: errorMessage(err, 'failed') });
        }
      }

      const name = newRDNValue.trim();
      const summary = summarizeCreate(`Copy "${name}"`, steps);
      if (withPassword && report) {
        notifyPasswordWrite(report, summary.message, { profileId, dn: copy.dn });
        if (summary.level === 'warning') toast.warning('Not everything was done', summary.detail);
      } else if (summary.level === 'success') {
        toast.success(summary.message + (!withPassword && isAccount && !isADUserAccount && droppedSecrets.length ? ' (no password)' : ''));
      } else toast.warning(summary.message, summary.detail);

      rememberTarget(profileId, target.trim());
      onCopied?.();
      onClose();
      useEditorStore.getState().openEntry(profileId, copy.dn, { preview: true });
      emitEntryCreated(profileId, copy.dn, { select: true, parentDN: target.trim() });
    } catch (err) {
      setError(errorMessage(err, 'Failed to copy entry'));
    } finally {
      setLoading(false);
    }
  }

  const dirty = newRDNValue !== initialName || loginEdited.sam || loginEdited.uid || password !== '' || normalizeDN(target) !== normalizeDN(sourceParent);
  const groupCount = sourceGroups?.length ?? 0;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !loading && onClose()}
      size="lg"
      icon={<CopyPlus size={16} strokeWidth={1.75} aria-hidden className="text-primary" />}
      title={`Copy "${rdnVal}"`}
      description={<span>Source <Dn dn={sourceDN} /></span>}
      dismissible={loading ? 'never' : 'when-clean'}
      dirty={dirty}
      initialFocus={nameRef}
      onSubmit={() => { if (canCopy) void handleCopy(); }}
      footer={
        <>
          <DialogCancelButton disabled={loading} />
          <Button type="submit" variant="primary" leftIcon={CopyPlus} loading={loading} disabled={!canCopy}>Copy Entry</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field
          label={`New name (${rdnAttr})`}
          required
          hint={fields.rdnIsLogin ? `The login name of the copy; the source's uid "${rdnVal}" stays with the source.` : undefined}
        >
          <Input
            ref={nameRef}
            value={newRDNValue}
            onChange={(e) => setNewRDNValue(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            invalid={!!dupProblem(rdnUidDup, 'uid')}
            placeholder="Name of the copy"
          />
        </Field>

        {/* Login identity: never the source's */}
        {(isADAccount || fields.uid || fields.posix) && (
          <div className="grid grid-cols-2 gap-2">
            {isADAccount && (
              <Field
                label={`sAMAccountName (${isComputer ? 'max. 15 characters + $' : 'max. 20 characters'})`}
                required
                className={upn ? undefined : 'col-span-2'}
              >
                <Input
                  value={login.sam}
                  maxLength={isComputer ? 16 : 20}
                  onChange={(e) => { setLogin((l) => ({ ...l, sam: e.target.value })); setLoginEdited((x) => ({ ...x, sam: true })); }}
                  invalid={!!dupProblem(samDup, 'sAMAccountName')}
                />
              </Field>
            )}
            {upn && (
              <Field label="User logon name (UPN)">
                <div className="h-control flex items-center px-2 rounded border border-border bg-background text-sm font-mono truncate" title={upn}>{upn}</div>
              </Field>
            )}
            {fields.uid && (
              <Field label="User ID (uid)" required hint={`The source's uid "${fields.sourceUid}" stays with the source.`}>
                <Input
                  value={login.uid}
                  onChange={(e) => { setLogin((l) => ({ ...l, uid: e.target.value })); setLoginEdited((x) => ({ ...x, uid: true })); }}
                  invalid={!!dupProblem(uidDup, 'uid')}
                />
              </Field>
            )}
            {fields.posix && (
              <Field label="uidNumber" required hint={nextUidNumber ? `Next free: ${nextUidNumber}` : undefined}>
                <Input
                  value={login.uidNumber}
                  onChange={(e) => { setLogin((l) => ({ ...l, uidNumber: e.target.value })); setLoginEdited((x) => ({ ...x, uidNumber: true })); }}
                  invalid={!!dupProblem(uidNumberDup, 'uidNumber')}
                />
              </Field>
            )}
          </div>
        )}
        {problems.length > 0 && <InlineAlert tone="danger" body={<ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul>} />}
        {checking && (
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground" role="status">
            <Spinner size="sm" decorative /> Checking for duplicates…
          </div>
        )}

        <ContainerPicker
          profileId={profileId}
          value={target}
          onChange={setTarget}
          onStatusChange={setTargetStatus}
          revealDN={sourceParent}
          label="Container of the copy"
          disabled={loading}
        />

        {newRDNValue.trim() && targetOK && (
          <div className="text-sm text-muted-foreground bg-background px-2 py-1 rounded border border-border">
            New DN: <Dn dn={newDN} className="text-foreground" />
          </div>
        )}

        {/* Password: typed twice; never the source's */}
        {offerADPassword && !tlsOK && (
          <InlineAlert tone="info" body="Passwords are not copied, and Active Directory accepts a new one only over LDAPS or StartTLS: the copy is created disabled and without a password. Set it with Reset Password… over a TLS connection, then enable the account." />
        )}
        {(offerLDAPPassword || (offerADPassword && tlsOK)) && (
          <div className="space-y-1.5">
            <Field
              label={offerADPassword ? 'Password of the copy' : 'Password of the copy (userPassword, optional)'}
              id={passwordFieldId}
              hint={`Passwords are not copied${droppedSecrets.length ? ` (${droppedSecrets.join(', ')})` : ''}.`}
            >
              <NewPasswordInput
                id={passwordFieldId}
                size="md"
                value={password}
                onChange={setPassword}
                confirm={confirm}
                onConfirmChange={setConfirm}
                placeholder="Leave empty to create the copy without a password"
              />
            </Field>
            {offerLDAPPassword && password && <PasswordPolicyHint profileId={profileId} />}
            {offerADPassword && (
              <div className="flex flex-wrap gap-x-6 gap-y-1">
                <Checkbox checked={mustChange && !!password} onCheckedChange={setMustChange} label="User must change password at next logon" disabled={!password} />
                <Checkbox checked={enable && !!password} onCheckedChange={setEnable} label="Account enabled" description={!password ? 'Without a password the copy stays disabled' : undefined} disabled={!password} />
              </div>
            )}
          </div>
        )}
        {isComputer && <p className="text-sm text-muted-foreground">The computer copy is created disabled; join a machine to it to use it.</p>}

        {isAccount && (
          <Checkbox
            checked={copyGroups}
            onCheckedChange={setCopyGroups}
            disabled={sourceGroups === null || groupCount === 0}
            label={sourceGroups === null ? 'Copy group memberships (reading the groups…)' : `Copy group memberships (${groupCount} direct group${groupCount === 1 ? '' : 's'})`}
            description={groupCount > 0 ? sourceGroups!.slice(0, 4).map((g) => parseRDN(splitFirstRDN(g).rdn).value).join(', ') + (groupCount > 4 ? ', …' : '') : undefined}
          />
        )}

        {binarySummary && <p className="text-sm text-muted-foreground">Also copies {binarySummary}.</p>}
        {droppedPerAccount.length > 0 && (
          <p className="text-sm text-muted-foreground">
            Not copied (unique per account): <span className="font-mono">{droppedPerAccount.join(', ')}</span>
          </p>
        )}

        {!source && !sourceError && (
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground" role="status">
            <Spinner size="sm" decorative /> Reading source entry…
          </div>
        )}

        {(error || sourceError) && <InlineAlert tone="danger" body={error || sourceError} />}
      </div>
      {passwordGuard.element}
    </Dialog>
  );
}
