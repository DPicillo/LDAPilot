import { useState } from 'react'
import { X, Type, Loader2, AlertCircle } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import * as wails from '../../lib/wails'
import { toast } from '../ui/Toast'

interface RenameEntryDialogProps {
  dn: string;
  onClose: () => void;
  onRenamed?: () => void;
}

export function RenameEntryDialog({ dn, onClose, onRenamed }: RenameEntryDialogProps) {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const currentRDN = dn.split(',')[0] || '';
  const parentDN = dn.split(',').slice(1).join(',');

  const [newRDN, setNewRDN] = useState(currentRDN);
  const [deleteOldRDN, setDeleteOldRDN] = useState(true);
  const [newSuperior, setNewSuperior] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMove = newSuperior.trim() !== '' && newSuperior.trim() !== parentDN;
  const hasChanged = newRDN !== currentRDN || isMove;

  async function handleRename() {
    if (!activeProfileId || !hasChanged) return;
    setLoading(true);
    setError(null);
    try {
      await wails.RenameEntry(
        activeProfileId,
        dn,
        newRDN,
        deleteOldRDN,
        newSuperior.trim() || '',
      );
      const newDN = isMove ? `${newRDN},${newSuperior.trim()}` : `${newRDN},${parentDN}`;
      toast.success(`Entry renamed to ${newDN}`);
      onRenamed?.();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Rename failed');
      toast.error('Rename failed', err?.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-lg shadow-2xl w-[500px] max-w-[90vw] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <Type size={14} className="text-primary" />
            Rename / Move Entry
          </h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {/* Current DN */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Current DN</label>
            <div className="text-xs font-mono bg-background/50 px-2 py-1.5 rounded border border-border text-muted-foreground truncate" title={dn}>
              {dn}
            </div>
          </div>

          {/* New RDN */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">New RDN</label>
            <input
              type="text"
              value={newRDN}
              onChange={e => setNewRDN(e.target.value)}
              className="input-field font-mono"
              placeholder="cn=NewName"
              autoFocus
            />
          </div>

          {/* Delete old RDN */}
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={deleteOldRDN}
              onChange={e => setDeleteOldRDN(e.target.checked)}
              className="rounded"
            />
            Delete old RDN value
          </label>

          {/* Move to new parent */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">
              Move to new parent DN <span className="text-muted-foreground/50">(optional)</span>
            </label>
            <input
              type="text"
              value={newSuperior}
              onChange={e => setNewSuperior(e.target.value)}
              className="input-field font-mono"
              placeholder={parentDN}
            />
          </div>

          {/* Preview */}
          {hasChanged && (
            <div className="text-xs bg-primary/5 border border-primary/20 rounded px-3 py-2">
              <span className="text-muted-foreground">New DN: </span>
              <span className="font-mono text-primary">
                {newRDN},{isMove ? newSuperior.trim() : parentDN}
              </span>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 text-xs px-3 py-2 rounded bg-destructive/10 text-destructive">
              <AlertCircle size={12} />
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded border border-border hover:bg-accent"
          >
            Cancel
          </button>
          <button
            onClick={handleRename}
            disabled={loading || !hasChanged || !newRDN.trim()}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {loading && <Loader2 size={12} className="animate-spin" />}
            {isMove ? 'Rename & Move' : 'Rename'}
          </button>
        </div>
      </div>
    </div>
  );
}
