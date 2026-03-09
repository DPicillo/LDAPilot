import { useState, useEffect, useCallback } from 'react'
import { X, Trash2, Pencil, ArrowRightLeft, AlertTriangle, CheckCircle2, XCircle, ChevronDown, ChevronRight, Loader2 } from 'lucide-react'
import type { BatchResult, BatchModifyChange } from '../../types/ldap'
import * as wails from '../../lib/wails'

type BatchMode = 'delete' | 'modify' | 'move';

interface BatchOperationDialogProps {
  isOpen: boolean;
  onClose: () => void;
  selectedDNs: string[];
  profileID: string;
  initialMode?: BatchMode;
}

interface BatchProgress {
  current: number;
  total: number;
  currentDN: string;
  operation: string;
}

export function BatchOperationDialog({ isOpen, onClose, selectedDNs, profileID, initialMode = 'delete' }: BatchOperationDialogProps) {
  const [mode, setMode] = useState<BatchMode>(initialMode);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [result, setResult] = useState<BatchResult | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  // Modify tab state
  const [modifyAttr, setModifyAttr] = useState('');
  const [modifyValues, setModifyValues] = useState('');
  const [modifyOp, setModifyOp] = useState<'add' | 'replace' | 'delete'>('replace');

  // Move tab state
  const [moveTargetDN, setMoveTargetDN] = useState('');

  // Reset on open / mode change
  useEffect(() => {
    if (isOpen) {
      setResult(null);
      setProgress(null);
      setShowErrors(false);
      setRunning(false);
    }
  }, [isOpen]);

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  // Subscribe to batch:progress events
  useEffect(() => {
    if (!running) return;

    const runtime = (window as any)['runtime'];
    if (!runtime?.EventsOn) return;

    const cancel = runtime.EventsOn('batch:progress', (data: BatchProgress) => {
      setProgress(data);
    });

    return () => {
      if (cancel) cancel();
    };
  }, [running]);

  const handleExecute = useCallback(async () => {
    if (running) return;
    setRunning(true);
    setResult(null);
    setProgress(null);

    try {
      let res: BatchResult;

      switch (mode) {
        case 'delete':
          res = await wails.BatchDelete(profileID, selectedDNs);
          break;
        case 'modify': {
          const values = modifyValues
            .split('\n')
            .map(v => v.trim())
            .filter(Boolean);
          const change: BatchModifyChange = {
            operation: modifyOp,
            attribute: modifyAttr,
            values,
          };
          res = await wails.BatchModify(profileID, selectedDNs, [change]);
          break;
        }
        case 'move':
          res = await wails.BatchMove(profileID, selectedDNs, moveTargetDN);
          break;
        default:
          res = { total: 0, succeeded: 0, failed: 0, errors: [] };
      }

      setResult(res);
    } catch (err: any) {
      setResult({
        total: selectedDNs.length,
        succeeded: 0,
        failed: selectedDNs.length,
        errors: [{ dn: '', message: err?.message || 'Unknown error' }],
      });
    } finally {
      setRunning(false);
    }
  }, [running, mode, profileID, selectedDNs, modifyAttr, modifyValues, modifyOp, moveTargetDN]);

  const canExecute = useCallback(() => {
    if (running) return false;
    if (selectedDNs.length === 0) return false;
    switch (mode) {
      case 'delete':
        return true;
      case 'modify':
        return modifyAttr.trim().length > 0 && (modifyOp === 'delete' || modifyValues.trim().length > 0);
      case 'move':
        return moveTargetDN.trim().length > 0;
      default:
        return false;
    }
  }, [running, selectedDNs.length, mode, modifyAttr, modifyValues, modifyOp, moveTargetDN]);

  if (!isOpen) return null;

  const progressPct = progress ? Math.round((progress.current / progress.total) * 100) : 0;

  const tabs: { key: BatchMode; label: string; icon: React.ElementType }[] = [
    { key: 'delete', label: 'Delete', icon: Trash2 },
    { key: 'modify', label: 'Modify', icon: Pencil },
    { key: 'move', label: 'Move', icon: ArrowRightLeft },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-[#1e1e1e] border border-[#3c3c3c] rounded-lg shadow-2xl w-[90%] max-w-[600px] max-h-[80%] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#3c3c3c]">
          <h2 className="text-sm font-semibold text-[#cccccc]">
            Batch Operations ({selectedDNs.length} entries)
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[#333333] text-[#808080] hover:text-[#cccccc]"
          >
            <X size={16} />
          </button>
        </div>

        {/* Tab Bar */}
        <div className="flex border-b border-[#3c3c3c]">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = mode === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => {
                  if (!running) {
                    setMode(tab.key);
                    setResult(null);
                    setProgress(null);
                  }
                }}
                disabled={running}
                className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
                  isActive
                    ? 'border-[#0078d4] text-[#cccccc]'
                    : 'border-transparent text-[#808080] hover:text-[#cccccc] hover:bg-[#2a2a2a]'
                } ${running ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <Icon size={13} />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4 space-y-3">
          {/* Delete Tab */}
          {mode === 'delete' && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 p-2.5 rounded bg-red-900/20 border border-red-900/40">
                <AlertTriangle size={14} className="text-red-400 shrink-0 mt-0.5" />
                <span className="text-xs text-red-300">
                  This will permanently delete {selectedDNs.length} {selectedDNs.length === 1 ? 'entry' : 'entries'}. This action cannot be undone.
                </span>
              </div>
              <div className="text-xs text-[#808080] mb-1">Selected entries:</div>
              <div className="max-h-[200px] overflow-auto border border-[#3c3c3c] rounded bg-[#252526]">
                {selectedDNs.map((dn) => (
                  <div key={dn} className="px-3 py-1 text-xs text-[#cccccc] border-b border-[#3c3c3c] last:border-b-0 truncate" title={dn}>
                    {dn}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Modify Tab */}
          {mode === 'modify' && (
            <div className="space-y-3">
              <div className="text-xs text-[#808080]">
                Apply attribute changes to {selectedDNs.length} {selectedDNs.length === 1 ? 'entry' : 'entries'}.
              </div>
              <div>
                <label className="block text-xs text-[#cccccc] mb-1">Operation</label>
                <select
                  value={modifyOp}
                  onChange={(e) => setModifyOp(e.target.value as 'add' | 'replace' | 'delete')}
                  className="w-full text-xs px-2 py-1.5 bg-[#3c3c3c] border border-[#555555] rounded text-[#cccccc] outline-none focus:border-[#0078d4]"
                  disabled={running}
                >
                  <option value="add">Add values</option>
                  <option value="replace">Replace values</option>
                  <option value="delete">Delete attribute</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#cccccc] mb-1">Attribute name</label>
                <input
                  type="text"
                  value={modifyAttr}
                  onChange={(e) => setModifyAttr(e.target.value)}
                  placeholder="e.g. description"
                  className="w-full text-xs px-2 py-1.5 bg-[#3c3c3c] border border-[#555555] rounded text-[#cccccc] outline-none focus:border-[#0078d4] placeholder:text-[#666666]"
                  disabled={running}
                />
              </div>
              {modifyOp !== 'delete' && (
                <div>
                  <label className="block text-xs text-[#cccccc] mb-1">Values (one per line)</label>
                  <textarea
                    value={modifyValues}
                    onChange={(e) => setModifyValues(e.target.value)}
                    placeholder="Enter values, one per line"
                    rows={3}
                    className="w-full text-xs px-2 py-1.5 bg-[#3c3c3c] border border-[#555555] rounded text-[#cccccc] outline-none focus:border-[#0078d4] placeholder:text-[#666666] resize-y"
                    disabled={running}
                  />
                </div>
              )}
              <div className="max-h-[120px] overflow-auto border border-[#3c3c3c] rounded bg-[#252526]">
                <div className="px-3 py-1 text-[10px] text-[#808080] border-b border-[#3c3c3c] sticky top-0 bg-[#252526]">
                  Affected entries ({selectedDNs.length})
                </div>
                {selectedDNs.map((dn) => (
                  <div key={dn} className="px-3 py-0.5 text-xs text-[#999999] truncate" title={dn}>
                    {dn}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Move Tab */}
          {mode === 'move' && (
            <div className="space-y-3">
              <div className="text-xs text-[#808080]">
                Move {selectedDNs.length} {selectedDNs.length === 1 ? 'entry' : 'entries'} to a new parent container.
              </div>
              <div>
                <label className="block text-xs text-[#cccccc] mb-1">Target parent DN</label>
                <input
                  type="text"
                  value={moveTargetDN}
                  onChange={(e) => setMoveTargetDN(e.target.value)}
                  placeholder="e.g. OU=NewOU,DC=example,DC=com"
                  className="w-full text-xs px-2 py-1.5 bg-[#3c3c3c] border border-[#555555] rounded text-[#cccccc] outline-none focus:border-[#0078d4] placeholder:text-[#666666]"
                  disabled={running}
                />
              </div>
              <div className="max-h-[150px] overflow-auto border border-[#3c3c3c] rounded bg-[#252526]">
                <div className="px-3 py-1 text-[10px] text-[#808080] border-b border-[#3c3c3c] sticky top-0 bg-[#252526]">
                  Entries to move ({selectedDNs.length})
                </div>
                {selectedDNs.map((dn) => (
                  <div key={dn} className="px-3 py-0.5 text-xs text-[#999999] truncate" title={dn}>
                    {dn}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Progress Section */}
          {running && progress && (
            <div className="space-y-2 pt-2 border-t border-[#3c3c3c]">
              <div className="flex items-center justify-between text-xs text-[#cccccc]">
                <span className="flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin text-[#0078d4]" />
                  Processing...
                </span>
                <span>{progress.current} / {progress.total}</span>
              </div>
              <div className="w-full h-2 bg-[#3c3c3c] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#0078d4] rounded-full transition-all duration-150"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <div className="text-[10px] text-[#808080] truncate" title={progress.currentDN}>
                {progress.currentDN}
              </div>
            </div>
          )}

          {/* Result Section */}
          {result && !running && (
            <div className="space-y-2 pt-2 border-t border-[#3c3c3c]">
              <div className="text-xs font-medium text-[#cccccc]">Result</div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-1.5">
                  <CheckCircle2 size={13} className="text-green-400" />
                  <span className="text-xs text-green-400">{result.succeeded} succeeded</span>
                </div>
                {result.failed > 0 && (
                  <div className="flex items-center gap-1.5">
                    <XCircle size={13} className="text-red-400" />
                    <span className="text-xs text-red-400">{result.failed} failed</span>
                  </div>
                )}
              </div>
              {result.errors.length > 0 && (
                <div>
                  <button
                    onClick={() => setShowErrors(!showErrors)}
                    className="flex items-center gap-1 text-xs text-[#808080] hover:text-[#cccccc]"
                  >
                    {showErrors ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    {result.errors.length} error{result.errors.length !== 1 ? 's' : ''}
                  </button>
                  {showErrors && (
                    <div className="mt-1 max-h-[120px] overflow-auto border border-[#3c3c3c] rounded bg-[#252526]">
                      {result.errors.map((err, i) => (
                        <div key={i} className="px-3 py-1 border-b border-[#3c3c3c] last:border-b-0">
                          <div className="text-xs text-red-400 truncate" title={err.dn}>{err.dn || '(general)'}</div>
                          <div className="text-[10px] text-[#999999]">{err.message}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[#3c3c3c]">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs rounded border border-[#3c3c3c] text-[#cccccc] hover:bg-[#333333]"
            disabled={running}
          >
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result && (
            <button
              onClick={handleExecute}
              disabled={!canExecute()}
              className={`px-3 py-1.5 text-xs rounded text-white ${
                mode === 'delete'
                  ? 'bg-red-700 hover:bg-red-600 disabled:bg-red-900/50'
                  : 'bg-[#0078d4] hover:bg-[#1084d8] disabled:bg-[#0078d4]/50'
              } disabled:cursor-not-allowed disabled:text-white/50`}
            >
              {running ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin" />
                  Processing...
                </span>
              ) : (
                `Execute ${mode === 'delete' ? 'Delete' : mode === 'modify' ? 'Modify' : 'Move'}`
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
