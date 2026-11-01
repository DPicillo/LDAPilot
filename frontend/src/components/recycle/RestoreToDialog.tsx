import { useEffect, useMemo, useRef, useState } from 'react'
import { FolderInput } from 'lucide-react'
import { Dialog } from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Field } from '../ui/Field'
import { Input } from '../ui/Input'
import { Dn } from '../ui/Dn'
import { EntriesExist } from '../../lib/wails-recycle'
import {
  countFollowingParent, isDeletedDN, nearestExisting, normalizeDN, plannedRestoreTargets, restoreTargetCandidates,
} from '../../lib/recycle'
import type { DeletedObject } from '../../types/recycle'
import { ContainerPicker, type ContainerSuggestion, type TargetStatus } from '../lifecycle/ContainerPicker'
import { rememberTarget } from '../lifecycle/containerPickerModel'

interface RestoreToDialogProps {
  /** Connection (container tree, existence checks). */
  profileId: string;
  objects: DeletedObject[];
  /** All listed deleted objects: followed to find the nearest live container of a deleted parent. */
  allObjects?: DeletedObject[];
  defaultNamingContext: string;
  /** Prefilled container (e.g. after a "container missing" error). */
  initialContainer?: string;
  onCancel: () => void;
  onRestore: (targetParentDN: string, newName: string) => void;
}

/**
 * Choose the target container (and, for one object, a new name) for a
 * restore (LIFE-06). The default is the nearest existing container on the
 * way up from the last known location (a deleted parent is followed to its
 * own last known location), never the shared CN=Users; the ContainerPicker
 * checks the typed target.
 */
export function RestoreToDialog({ profileId, objects, allObjects, defaultNamingContext, initialContainer, onCancel, onRestore }: RestoreToDialogProps) {
  const single = objects.length === 1 ? objects[0] : null;
  const [container, setContainer] = useState(initialContainer ?? '');
  const [edited, setEdited] = useState(!!initialContainer);
  const [status, setStatus] = useState<TargetStatus>({ dn: '', state: 'empty' });
  const [newName, setNewName] = useState(single?.name ?? '');
  const [nearest, setNearest] = useState<{ dn: string; original: boolean } | null>(null);
  const pickerInput = useRef<HTMLInputElement>(null);

  // Nearest existing container of the (first) object's last known location.
  const candidates = useMemo(() => {
    const first = objects[0];
    return first ? restoreTargetCandidates(first, allObjects ?? objects) : [];
  }, [objects, allObjects]);
  useEffect(() => {
    if (candidates.length === 0) return;
    let cancelled = false;
    EntriesExist(profileId, candidates).then((checks) => {
      if (cancelled) return;
      const exists = new Map(checks.map((c) => [normalizeDN(c.dn), c.exists]));
      const dn = nearestExisting(candidates, (d) => exists.get(normalizeDN(d)));
      if (!dn) return;
      const original = !!objects[0] && !objects[0].parentDeleted && normalizeDN(dn) === normalizeDN(objects[0].lastKnownParent);
      setNearest({ dn, original });
      setContainer((cur) => (edited || cur.trim() ? cur : dn));
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, candidates]);

  const trimmed = container.trim();
  const deletedTarget = isDeletedDN(trimmed);
  const nameProblem = single && !newName.trim() ? 'The name must not be empty.' : null;
  const ready = !deletedTarget && !nameProblem && status.state === 'ok' && normalizeDN(status.dn) === normalizeDN(trimmed);
  const targets = useMemo(() => plannedRestoreTargets(objects, trimmed, single ? newName : undefined), [objects, trimmed, single, newName]);
  const preview = objects.slice(0, 5).map((o) => targets.get(o.dn) ?? '');
  const following = useMemo(() => countFollowingParent(objects), [objects]);
  const suggestions: ContainerSuggestion[] = nearest
    ? [{ dn: nearest.dn, label: nearest.original ? 'Original location' : 'Nearest existing' }]
    : [];

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onCancel()}
      size="md"
      icon={<FolderInput size={16} strokeWidth={1.75} aria-hidden className="text-primary" />}
      title={`Restore ${objects.length === 1 ? `"${objects[0].name}"` : `${objects.length} objects`} to…`}
      description={defaultNamingContext ? <span>Naming context <Dn dn={defaultNamingContext} /></span> : undefined}
      initialFocus={pickerInput}
      onSubmit={() => {
        if (!ready) return;
        rememberTarget(profileId, trimmed);
        onRestore(trimmed, single ? newName.trim() : '');
      }}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!ready}>Restore</Button>
        </>
      }
    >
      <div className="space-y-3">
        <ContainerPicker
          profileId={profileId}
          value={container}
          onChange={(dn) => { setContainer(dn); setEdited(true); }}
          onStatusChange={setStatus}
          revealDN={nearest?.dn}
          inputRef={pickerInput}
          suggestions={suggestions}
        />
        {deletedTarget && <p className="text-sm text-destructive">The container is itself deleted; restore it first or pick a live container.</p>}
        {single && (
          <Field label={`Name (${single.rdnAttribute || 'CN'})`} hint="Change the name to resolve a name conflict. sAMAccountName is not changed." error={nameProblem ?? undefined}>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} />
          </Field>
        )}
        {ready && (
          <div className="space-y-0.5 text-sm" aria-live="polite">
            <div className="text-muted-foreground">Result</div>
            {preview.map((dn) => <Dn key={dn} dn={dn} className="block" />)}
            {objects.length > preview.length && <div className="text-xs text-muted-foreground">… and {objects.length - preview.length} more</div>}
            {following > 0 && (
              <div className="text-xs text-muted-foreground pt-1">
                {following} {following === 1 ? 'object goes' : 'objects go'} into {following === 1 ? 'its' : 'their'} deleted container, which is restored first (the structure is kept).
              </div>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
