import { useState } from 'react'
import { CopyPlus, Loader2, X } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { LDAPAttribute } from '../../types/ldap'
import * as wails from '../../lib/wails'
import { toast } from '../ui/Toast'

/** Operational attributes that should not be copied to a new entry */
const EXCLUDED_ATTRS = new Set([
  'objectguid',
  'whencreated',
  'whenchanged',
  'usncreated',
  'usnchanged',
  'objectsid',
  'distinguishedname',
  'entryuuid',
  'entrydn',
  'createtimestamp',
  'modifytimestamp',
  'creatorsname',
  'modifiersname',
  'structuralobjectclass',
  'subschemasubentry',
  'hassubordinates',
  'numsubordinates',
  'entrycsn',
  'contextcsn',
  'pwdchangedtime',
  'memberof',
  'dscorepropagationdata',
  'lastlogontimestamp',
  'lastlogon',
  'logoncount',
  'badpasswordtime',
  'badpwdcount',
  'primarygroupid',
  'objectcategory',
  'instancetype',
  'iscriticalsystemobject',
  'systemflags',
  'admincount',
  'samaccounttype',
  'showinadvancedviewonly',
])

interface CopyEntryDialogProps {
  sourceDN: string;
  onClose: () => void;
  onCopied?: () => void;
}

export function CopyEntryDialog({ sourceDN, onClose, onCopied }: CopyEntryDialogProps) {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);

  const sourceRDN = sourceDN.split(',')[0] || '';
  const parentDN = sourceDN.split(',').slice(1).join(',');

  // Pre-fill with "Copy of <current RDN>"
  const [rdnAttr] = sourceRDN.split('=', 1);
  const rdnVal = sourceRDN.substring(rdnAttr.length + 1);
  const [newRDNValue, setNewRDNValue] = useState(`Copy of ${rdnVal}`);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const newRDN = `${rdnAttr}=${newRDNValue}`;
  const newDN = parentDN ? `${newRDN},${parentDN}` : newRDN;

  async function handleCopy() {
    if (!activeProfileId || !newRDNValue.trim()) return;

    setLoading(true);
    setError(null);

    try {
      // 1. Read the source entry's attributes
      const sourceEntry = await wails.GetEntry(activeProfileId, sourceDN);
      if (!sourceEntry || !sourceEntry.attributes) {
        throw new Error('Failed to read source entry');
      }

      // 2. Filter out operational attributes and build new attribute list
      const newAttrs: LDAPAttribute[] = [];
      for (const attr of sourceEntry.attributes) {
        if (EXCLUDED_ATTRS.has(attr.name.toLowerCase())) continue;

        // Replace the RDN attribute value with the new value
        if (attr.name.toLowerCase() === rdnAttr.toLowerCase()) {
          newAttrs.push({ name: attr.name, values: [newRDNValue], binary: false });
        } else {
          newAttrs.push({ name: attr.name, values: [...attr.values], binary: attr.binary });
        }
      }

      // 3. Create the new entry
      await wails.CreateEntry(activeProfileId, newDN, newAttrs);
      toast.success(`Entry copied as "${newRDN}"`);
      onCopied?.();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to copy entry');
      toast.error(err?.message || 'Failed to copy entry');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-card border border-border rounded-md shadow-2xl w-[460px] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Copy Entry</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-3">
          {/* Source DN */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Source DN</label>
            <div className="text-xs font-mono bg-background px-2 py-1.5 rounded border border-border truncate" title={sourceDN}>
              {sourceDN}
            </div>
          </div>

          {/* Parent DN */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Parent DN</label>
            <div className="text-xs font-mono bg-background px-2 py-1.5 rounded border border-border truncate" title={parentDN}>
              {parentDN}
            </div>
          </div>

          {/* New RDN */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">New RDN Value ({rdnAttr}=)</label>
            <input
              type="text"
              value={newRDNValue}
              onChange={(e) => setNewRDNValue(e.target.value)}
              placeholder="Enter new RDN value..."
              className="input-field"
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handleCopy(); }}
            />
          </div>

          {/* Resulting DN */}
          {newRDNValue && (
            <div className="text-[10px] font-mono text-muted-foreground bg-background px-2 py-1 rounded border border-border truncate" title={newDN}>
              New DN: {newDN}
            </div>
          )}

          {error && (
            <div className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded">{error}</div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded border border-border hover:bg-accent">
            Cancel
          </button>
          <button
            onClick={handleCopy}
            disabled={loading || !newRDNValue.trim()}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <CopyPlus size={14} />}
            Copy Entry
          </button>
        </div>
      </div>
    </div>
  );
}
