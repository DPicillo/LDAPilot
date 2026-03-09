import { useState, useMemo } from 'react'
import { Download, Copy, Check, Loader2, X, Plus, Columns3 } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import * as wails from '../../lib/wails'
import { toast } from '../ui/Toast'

type ExportFormat = 'ldif' | 'csv';

const COMMON_CSV_COLUMNS = [
  'cn', 'sn', 'givenName', 'displayName', 'mail', 'telephoneNumber',
  'sAMAccountName', 'userPrincipalName', 'description', 'title',
  'department', 'company', 'physicalDeliveryOfficeName', 'l', 'st',
  'memberOf', 'member', 'ou', 'uid', 'objectClass',
  'whenCreated', 'whenChanged', 'userAccountControl',
];

interface ExportDialogProps {
  dn?: string;
  onClose: () => void;
}

export function ExportDialog({ dn, onClose }: ExportDialogProps) {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const profiles = useConnectionStore((s) => s.profiles);
  const activeProfile = activeProfileId ? profiles.find(p => p.id === activeProfileId) : null;

  const [baseDN, setBaseDN] = useState(dn || activeProfile?.baseDN || '');
  const [exportType, setExportType] = useState<'entry' | 'subtree'>('subtree');
  const [format, setFormat] = useState<ExportFormat>('ldif');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // CSV column selection
  const [selectedColumns, setSelectedColumns] = useState<string[]>(['cn', 'mail', 'description', 'objectClass']);
  const [columnFilter, setColumnFilter] = useState('');
  const [showColumnSelector, setShowColumnSelector] = useState(false);

  const filteredColumnOptions = useMemo(() => {
    const available = COMMON_CSV_COLUMNS.filter(c => !selectedColumns.includes(c));
    if (!columnFilter) return available;
    const lf = columnFilter.toLowerCase();
    return available.filter(c => c.toLowerCase().includes(lf));
  }, [columnFilter, selectedColumns]);

  function addColumn(col: string) {
    if (!selectedColumns.includes(col)) {
      setSelectedColumns([...selectedColumns, col]);
    }
    setColumnFilter('');
  }

  function removeColumn(col: string) {
    setSelectedColumns(selectedColumns.filter(c => c !== col));
  }

  function addCustomColumn() {
    const col = columnFilter.trim();
    if (col && !selectedColumns.includes(col)) {
      setSelectedColumns([...selectedColumns, col]);
      setColumnFilter('');
    }
  }

  async function handleExport() {
    if (!activeProfileId || !baseDN.trim()) return;
    setLoading(true);
    setError(null);
    try {
      let content: string;
      if (format === 'csv') {
        content = await wails.ExportCSV(activeProfileId, baseDN, selectedColumns);
        toast.success('CSV generated');
      } else if (exportType === 'subtree') {
        content = await wails.ExportSubtree(activeProfileId, baseDN);
        toast.success('LDIF generated');
      } else {
        content = await wails.ExportEntries(activeProfileId, [baseDN]);
        toast.success('LDIF generated');
      }
      setResult(content);
    } catch (err: any) {
      setError(err?.message || 'Export failed');
      toast.error(err?.message || 'Export failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    if (!result) return;
    await navigator.clipboard.writeText(result);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleSaveToFile() {
    if (!activeProfileId) return;
    try {
      if (format === 'csv') {
        await wails.ExportCSVToFile(activeProfileId, baseDN, selectedColumns);
      } else {
        await wails.ExportToFile(activeProfileId, [baseDN]);
      }
      toast.success(`${format.toUpperCase()} saved to file`);
    } catch (err: any) {
      setError(err?.message || 'Save failed');
      toast.error(err?.message || 'Save failed');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-card border border-border rounded-md shadow-2xl w-[640px] max-h-[80%] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold">Export</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground">
            <X size={16} />
          </button>
        </div>

        {/* Settings */}
        <div className="p-4 space-y-3 border-b border-border">
          <div>
            <label className="block text-xs text-muted-foreground mb-1">Base DN</label>
            <input
              type="text"
              value={baseDN}
              onChange={(e) => setBaseDN(e.target.value)}
              className="input-field font-mono"
            />
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs text-muted-foreground mb-1">Format</label>
              <select
                value={format}
                onChange={(e) => { setFormat(e.target.value as ExportFormat); setResult(null); }}
                className="input-field"
              >
                <option value="ldif">LDIF</option>
                <option value="csv">CSV</option>
              </select>
            </div>
            {format === 'ldif' && (
              <div className="flex-1">
                <label className="block text-xs text-muted-foreground mb-1">Scope</label>
                <select
                  value={exportType}
                  onChange={(e) => setExportType(e.target.value as 'entry' | 'subtree')}
                  className="input-field"
                >
                  <option value="entry">Single Entry</option>
                  <option value="subtree">Entire Subtree</option>
                </select>
              </div>
            )}
          </div>

          {/* CSV Column Selection */}
          {format === 'csv' && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs text-muted-foreground">CSV Columns</label>
                <button
                  onClick={() => setShowColumnSelector(!showColumnSelector)}
                  className="flex items-center gap-0.5 text-[10px] text-primary hover:text-primary/80"
                >
                  <Columns3 size={10} />
                  {showColumnSelector ? 'Hide' : 'Edit'}
                </button>
              </div>
              {/* Active columns */}
              <div className="flex flex-wrap gap-1 mb-1">
                {selectedColumns.map(col => (
                  <span
                    key={col}
                    className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 bg-primary/15 text-primary rounded-sm font-mono"
                  >
                    {col}
                    <button onClick={() => removeColumn(col)} className="hover:text-destructive ml-0.5">
                      <X size={9} />
                    </button>
                  </span>
                ))}
                {selectedColumns.length === 0 && (
                  <span className="text-[10px] text-muted-foreground italic">All attributes (default)</span>
                )}
              </div>

              {showColumnSelector && (
                <div className="space-y-1 mt-1 p-2 border border-border rounded bg-background/50">
                  <div className="flex gap-1">
                    <input
                      type="text"
                      value={columnFilter}
                      onChange={(e) => setColumnFilter(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          addCustomColumn();
                        }
                      }}
                      placeholder="Type to filter or add custom..."
                      className="input-field text-xs flex-1 font-mono"
                      autoFocus
                    />
                    {columnFilter.trim() && !COMMON_CSV_COLUMNS.includes(columnFilter.trim()) && (
                      <button
                        onClick={addCustomColumn}
                        className="text-[10px] px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90"
                      >
                        Add
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-0.5 max-h-24 overflow-auto">
                    {filteredColumnOptions.map(col => (
                      <button
                        key={col}
                        onClick={() => addColumn(col)}
                        className="text-[10px] px-1.5 py-0.5 rounded-sm bg-accent/50 hover:bg-accent text-muted-foreground hover:text-foreground font-mono transition-colors"
                      >
                        <Plus size={8} className="inline mr-0.5" />
                        {col}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={handleExport}
              disabled={loading || !baseDN.trim()}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              Generate {format.toUpperCase()}
            </button>
            {result && (
              <>
                <button
                  onClick={handleCopy}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-border hover:bg-accent"
                >
                  {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                  {copied ? 'Copied!' : 'Copy'}
                </button>
                <button
                  onClick={handleSaveToFile}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-border hover:bg-accent"
                >
                  <Download size={14} />
                  Save to File
                </button>
              </>
            )}
          </div>
          {error && (
            <div className="text-xs text-destructive bg-destructive/10 px-3 py-2 rounded">{error}</div>
          )}
        </div>

        {/* Preview */}
        <div className="flex-1 overflow-auto p-4">
          {result ? (
            <pre className="text-xs font-mono whitespace-pre-wrap text-foreground bg-background p-3 rounded border border-border max-h-[300px] overflow-auto">
              {result}
            </pre>
          ) : (
            <div className="text-xs text-muted-foreground text-center py-8">
              Click "Generate" to preview the export
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
