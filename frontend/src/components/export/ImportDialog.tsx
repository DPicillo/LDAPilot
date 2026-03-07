import { useState } from 'react'
import { Upload, FileText, Loader2, X, AlertCircle, CheckCircle } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { ImportResult } from '../../types/ldap'
import * as wails from '../../lib/wails'
import { toast } from '../ui/Toast'

interface ImportDialogProps {
  onClose: () => void;
}

export function ImportDialog({ onClose }: ImportDialogProps) {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);

  const [ldifContent, setLdifContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleImportFromFile() {
    if (!activeProfileId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await wails.ImportLDIFFromFile(activeProfileId);
      if (res) {
        setResult(res);
        if (res.failed === 0) {
          toast.success(`Imported ${res.succeeded} entries`);
        } else {
          toast.error(`${res.failed} of ${res.total} entries failed`);
        }
      }
    } catch (err: any) {
      setError(err?.message || 'Import failed');
      toast.error(err?.message || 'Import failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleImportFromText() {
    if (!activeProfileId || !ldifContent.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await wails.ImportLDIF(activeProfileId, ldifContent);
      setResult(res);
      if (res.failed === 0) {
        toast.success(`Imported ${res.succeeded} entries`);
      } else {
        toast.error(`${res.failed} of ${res.total} entries failed`);
      }
    } catch (err: any) {
      setError(err?.message || 'Import failed');
      toast.error(err?.message || 'Import failed');
    } finally {
      setLoading(false);
    }
  }

  async function handlePreview() {
    if (!ldifContent.trim()) return;
    setError(null);
    try {
      const entries = await wails.PreviewLDIF(ldifContent);
      toast.info(`Parsed ${entries.length} entries`);
    } catch (err: any) {
      setError(err?.message || 'Parse failed');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-card border border-border rounded-md shadow-2xl w-[600px] max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Import LDIF</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-3 border-b border-border">
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Paste LDIF content</label>
            <textarea
              value={ldifContent}
              onChange={(e) => setLdifContent(e.target.value)}
              placeholder="version: 1&#10;&#10;dn: cn=example,dc=test&#10;objectClass: top&#10;cn: example"
              className="input-field font-mono text-xs h-40 resize-none"
            />
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleImportFromText}
              disabled={loading || !ldifContent.trim()}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              Import from Text
            </button>
            <button
              onClick={handleImportFromFile}
              disabled={loading}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-border hover:bg-accent disabled:opacity-50"
            >
              <FileText size={14} />
              Import from File
            </button>
            <button
              onClick={handlePreview}
              disabled={!ldifContent.trim()}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-border hover:bg-accent disabled:opacity-50"
            >
              Preview
            </button>
          </div>

          {error && (
            <div className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded flex items-center gap-1.5">
              <AlertCircle size={12} className="shrink-0" />
              {error}
            </div>
          )}
        </div>

        {/* Results */}
        <div className="flex-1 overflow-auto p-4">
          {result ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                {result.failed === 0 ? (
                  <CheckCircle size={16} className="text-green-400" />
                ) : (
                  <AlertCircle size={16} className="text-destructive" />
                )}
                <span>
                  {result.succeeded} of {result.total} entries imported successfully
                </span>
              </div>
              {result.errors.length > 0 && (
                <div className="space-y-1 mt-2">
                  <span className="text-xs text-muted-foreground">Errors:</span>
                  <div className="bg-background border border-border rounded p-2 max-h-[200px] overflow-auto">
                    {result.errors.map((err, i) => (
                      <div key={i} className="text-xs text-destructive font-mono">{err}</div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground text-center py-8">
              Paste LDIF content or select a file to import
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
