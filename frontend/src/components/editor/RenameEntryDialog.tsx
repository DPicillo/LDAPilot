/**
 * Rename (LIFE-03): the naming attribute is a label, the user types the plain
 * new name (escaped with escapeDNValue, so "Doe, John" needs no backslash),
 * the current value is preselected. "Delete old RDN value" is hidden on
 * Active Directory (AD refuses to keep it). AD users can update the display
 * name and logon names (sAMAccountName, UPN prefix) in the same run. Moving
 * to another container is the separate Move to… dialog (button below).
 * Emits ldapilot:entry-moved (a rename is a move within the parent).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { FolderInput, Type } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import * as wails from '../../lib/wails'
import { toast } from '../ui/Toast'
import { escapeDNValue, firstRDN, getParentDN, normalizeDN, parseRDN } from '../../lib/dn'
import { suggestSAMAccountName, suggestUid } from '../../lib/entryChanges'
import type { AttributeChange, LDAPEntry, ServerType } from '../../types/ldap'
import { Dialog, useDialogStore } from '../ui/Dialog'
import { DialogCancelButton } from './DialogCancelButton'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { Input } from '../ui/Input'
import { Checkbox } from '../ui/Checkbox'
import { InlineAlert } from '../ui/InlineAlert'
import { Dn } from '../ui/Dn'
import { ensureServerType } from '../ui/commands'
import { MoveEntryDialog } from '../lifecycle/MoveEntryDialog'
import { emitEntryMoved } from '../lifecycle/events'
import { refreshOpenTabsOf } from '../../stores/editorStore'
import { planLogonNameChanges, renamedRDN } from '../lifecycle/rename'
import { focusActiveEditorAfterDialog, requestEditorFocus } from './editorFocus'

interface RenameEntryDialogProps {
  dn: string;
  onClose: () => void;
  onRenamed?: () => void;
  /** Connection of the entry (default: the active connection). */
  profileId?: string;
  /**
   * The renamed entry is the active tab, started from the editor / Entry menu /
   * palette: its re-keyed tab's editor takes focus (current crumb), not the
   * tab button (RW2-E-04 a).
   */
  focusEditorAfter?: boolean;
}

function attr(entry: LDAPEntry | null, name: string): string {
  return entry?.attributes.find((a) => a.name.toLowerCase() === name.toLowerCase())?.values[0] ?? '';
}

export function RenameEntryDialog({ dn, onClose, onRenamed, profileId: profileProp, focusEditorAfter = false }: RenameEntryDialogProps) {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const profileId = profileProp ?? activeProfileId ?? '';
  const parentDN = getParentDN(dn);
  const currentRDN = firstRDN(dn);
  const { attr: rdnAttr, value: currentValue } = parseRDN(currentRDN);
  // Multi-valued RDNs ("cn=a+uid=b") are edited raw.
  const multiValued = /(^|[^\\])\+/.test(currentRDN);

  const [value, setValue] = useState(multiValued ? currentRDN : currentValue);
  const [deleteOldRDN, setDeleteOldRDN] = useState(true);
  const [serverType, setServerType] = useState<ServerType | null>(null);
  const [entry, setEntry] = useState<LDAPEntry | null>(() => {
    const es = useEditorStore.getState();
    const tab = es.tabs.find((t) => t.profileId === profileId && normalizeDN(t.dn) === normalizeDN(dn));
    return tab ? es.entries[tab.id] ?? null : null;
  });
  const [updateLogon, setUpdateLogon] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [sam, setSam] = useState('');
  const [upnPrefix, setUpnPrefix] = useState('');
  const [logonEdited, setLogonEdited] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valueRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;
    ensureServerType(profileId).then((t) => { if (!cancelled) setServerType(t); });
    return () => { cancelled = true; };
  }, [profileId]);

  const isAD = serverType === 'ad';
  // AD: the logon names belong to user objects (not computers, contacts, groups).
  useEffect(() => {
    if (!isAD || entry || !profileId) return;
    let cancelled = false;
    wails.GetEntry(profileId, dn).then((e) => { if (!cancelled && e) setEntry(e); }).catch(() => {});
    return () => { cancelled = true; };
  }, [isAD, entry, profileId, dn]);
  const classes = (entry?.attributes.find((a) => a.name.toLowerCase() === 'objectclass')?.values ?? []).map((c) => c.toLowerCase());
  const isADUser = isAD && classes.includes('user') && !classes.includes('computer');
  const currentUPN = attr(entry, 'userPrincipalName');
  const upnSuffix = currentUPN.includes('@') ? currentUPN.slice(currentUPN.lastIndexOf('@')) : '';

  // Logon names follow the new name until edited.
  useEffect(() => {
    if (logonEdited) return;
    const name = value.trim();
    // The New User rule: lowercase ASCII, words joined by "." (M-11).
    const derivedSam = suggestSAMAccountName(suggestUid(name));
    setDisplayName(name);
    setSam(derivedSam);
    setUpnPrefix(derivedSam);
  }, [value, logonEdited]);

  // Select the current name so typing replaces it.
  useEffect(() => {
    const el = valueRef.current;
    if (el) requestAnimationFrame(() => el.select());
  }, []);

  const newRDN = useMemo(() => (multiValued ? value.trim() : renamedRDN(rdnAttr, value)), [multiValued, value, rdnAttr]);
  const newDN = parentDN ? `${newRDN},${parentDN}` : newRDN;
  // Exact compare: AD renames that only change the case are real renames.
  const changed = value.trim() !== '' && (multiValued ? value.trim() !== currentRDN : value.trim() !== currentValue);
  const logonChanges: AttributeChange[] = useMemo(() => (isADUser && updateLogon)
    ? planLogonNameChanges(
      { displayName: attr(entry, 'displayName'), sAMAccountName: attr(entry, 'sAMAccountName'), userPrincipalName: currentUPN },
      { displayName, sAMAccountName: sam, userPrincipalName: upnPrefix.trim() ? upnPrefix.trim() + (upnSuffix || '') : '' },
    )
    : [], [isADUser, updateLogon, entry, currentUPN, displayName, sam, upnPrefix, upnSuffix]);
  const canRename = !loading && !!profileId && value.trim() !== '' && (changed || logonChanges.length > 0);

  async function handleRename() {
    if (!canRename) return;
    setLoading(true);
    setError(null);
    let renamed = false;
    try {
      if (changed) {
        await wails.RenameEntry(profileId, dn, newRDN, isAD ? true : deleteOldRDN, '');
        renamed = true;
        // Before the re-key: the new tab's editor takes the hand-over when it mounts.
        if (focusEditorAfter) requestEditorFocus('crumb');
        emitEntryMoved(profileId, dn, newDN);
      }
      const target = renamed ? newDN : dn;
      const name = multiValued ? newRDN : value.trim();
      if (logonChanges.length > 0) {
        try {
          await wails.ModifyEntry(profileId, target, logonChanges);
          // The tab re-keyed on entry-moved loaded before this write: show the new names (M-11).
          refreshOpenTabsOf(profileId, [target]);
        } catch (err: any) {
          toast.warning(renamed ? `Renamed to ${name}, but the logon names were not updated` : 'The logon names were not updated', err?.message);
          onRenamed?.();
          onClose();
          return;
        }
      }
      toast.success(renamed
        ? `Renamed to ${name}${logonChanges.length ? ' (display and logon names updated)' : ''}`
        : 'Display and logon names updated');
      onRenamed?.();
      onClose();
      if (focusEditorAfter) focusActiveEditorAfterDialog();
    } catch (err: any) {
      setError(err?.message || 'Rename failed');
    } finally {
      setLoading(false);
    }
  }

  function openMove() {
    onClose();
    useDialogStore.getState().open(MoveEntryDialog, { profileId, dns: [dn], onMoved: () => onRenamed?.() });
  }

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !loading && onClose()}
      size="md"
      icon={<Type size={16} strokeWidth={1.75} aria-hidden className="text-primary" />}
      title={`Rename "${currentValue || currentRDN}"`}
      description={parentDN ? <span>In <Dn dn={parentDN} /></span> : undefined}
      dismissible={loading ? 'never' : 'when-clean'}
      dirty={changed || logonChanges.length > 0}
      initialFocus={valueRef}
      onSubmit={() => { if (canRename) void handleRename(); }}
      footer={
        <>
          <Button variant="ghost" leftIcon={FolderInput} onClick={openMove} disabled={loading} className="mr-auto">
            Move to Another Container…
          </Button>
          <DialogCancelButton disabled={loading} />
          <Button type="submit" variant="primary" loading={loading} disabled={!canRename}>Rename</Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field
          label={multiValued ? 'New RDN (attribute=value+attribute=value)' : `New name (${rdnAttr})`}
          hint={multiValued ? 'Multi-valued RDN: escape special characters yourself.' : 'Type the name as it should read; commas and other special characters are escaped automatically.'}
          required
        >
          <Input
            ref={valueRef}
            mono={multiValued}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="New name"
          />
        </Field>

        {!isAD && serverType !== null && (
          <Checkbox
            checked={deleteOldRDN}
            onCheckedChange={setDeleteOldRDN}
            label="Delete old RDN value"
            description={`Removes "${currentValue}" from ${rdnAttr}; otherwise the entry keeps it as an additional value.`}
          />
        )}

        {isADUser && (
          <div className="space-y-2">
            <Checkbox
              checked={updateLogon}
              onCheckedChange={setUpdateLogon}
              label="Also update display name and logon names"
              description="displayName, sAMAccountName (pre-Windows 2000) and the user logon name (UPN prefix), in one change after the rename."
            />
            {updateLogon && (
              <div className="grid grid-cols-2 gap-2 pl-6">
                <Field label="Display name" className="col-span-2">
                  <Input value={displayName} onChange={(e) => { setDisplayName(e.target.value); setLogonEdited(true); }} />
                </Field>
                <Field label={`User logon name${upnSuffix ? ` (${upnSuffix})` : ''}`}>
                  <Input value={upnPrefix} onChange={(e) => { setUpnPrefix(e.target.value); setLogonEdited(true); }} />
                </Field>
                <Field label="Pre-Windows 2000 (sAMAccountName)">
                  <Input value={sam} maxLength={20} onChange={(e) => { setSam(e.target.value); setLogonEdited(true); }} />
                </Field>
              </div>
            )}
          </div>
        )}

        {changed && (
          <div className="text-sm bg-primary-subtle rounded px-3 py-2" aria-live="polite">
            <span className="text-muted-foreground">New DN: </span>
            <Dn dn={newDN} className="text-primary" />
          </div>
        )}

        {error && <InlineAlert tone="danger" body={error} />}
      </div>
    </Dialog>
  );
}
