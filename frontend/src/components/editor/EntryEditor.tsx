import { RefreshCw, Loader2, ArrowLeft, ArrowRight, Lock } from 'lucide-react'
import { useEditorStore } from '../../stores/editorStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { AttributeTable } from './AttributeTable'
import * as wails from '../../lib/wails'
import { toast } from '../ui/Toast'

interface EntryEditorProps {
  tabId: string;
}

export function EntryEditor({ tabId }: EntryEditorProps) {
  const tab = useEditorStore((s) => s.tabs.find(t => t.id === tabId));
  const entry = useEditorStore((s) => s.entries[tabId]);
  const isLoading = useEditorStore((s) => s.loadingEntries[tabId]);
  const refreshEntry = useEditorStore((s) => s.refreshEntry);
  const markDirty = useEditorStore((s) => s.markDirty);
  const goBack = useEditorStore((s) => s.goBack);
  const goForward = useEditorStore((s) => s.goForward);
  const canBack = useEditorStore((s) => s.canGoBack());
  const canForward = useEditorStore((s) => s.canGoForward());
  const profiles = useConnectionStore((s) => s.profiles);
  const isReadOnly = tab ? profiles.find(p => p.id === tab.profileId)?.readOnly ?? false : false;

  if (!tab) return null;

  async function handleModify(attrName: string, values: string[]) {
    try {
      await wails.ModifyAttribute(tab!.profileId, tab!.dn, attrName, values);
      markDirty(tabId);
      refreshEntry(tab!.profileId, tab!.dn);
      toast.success(`Attribute "${attrName}" modified`);
    } catch (err: any) {
      toast.error(err?.message || `Failed to modify "${attrName}"`);
    }
  }

  async function handleAdd(attrName: string, values: string[]) {
    try {
      await wails.AddAttribute(tab!.profileId, tab!.dn, attrName, values);
      markDirty(tabId);
      refreshEntry(tab!.profileId, tab!.dn);
      toast.success(`Attribute "${attrName}" added`);
    } catch (err: any) {
      toast.error(err?.message || `Failed to add "${attrName}"`);
    }
  }

  async function handleDelete(attrName: string) {
    if (!confirm(`Delete attribute "${attrName}"?`)) return;
    try {
      await wails.DeleteAttribute(tab!.profileId, tab!.dn, attrName);
      markDirty(tabId);
      refreshEntry(tab!.profileId, tab!.dn);
      toast.success(`Attribute "${attrName}" deleted`);
    } catch (err: any) {
      toast.error(err?.message || `Failed to delete "${attrName}"`);
    }
  }

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <Loader2 size={24} className="animate-spin mr-2" />
        <span className="text-sm">Loading entry...</span>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Entry Header */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border bg-card shrink-0">
        <button
          onClick={goBack}
          disabled={!canBack}
          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground shrink-0 disabled:opacity-30"
          title="Go Back (Alt+Left)"
        >
          <ArrowLeft size={12} />
        </button>
        <button
          onClick={goForward}
          disabled={!canForward}
          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground shrink-0 disabled:opacity-30"
          title="Go Forward (Alt+Right)"
        >
          <ArrowRight size={12} />
        </button>
        {isReadOnly && <span title="Read-Only"><Lock size={12} className="text-yellow-500 shrink-0 ml-1" /></span>}
        <span className="text-xs font-mono text-muted-foreground truncate flex-1 ml-1" title={tab.dn}>
          {tab.dn}
        </span>
        <button
          onClick={() => refreshEntry(tab.profileId, tab.dn)}
          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground shrink-0"
          title="Refresh"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {/* Attribute Table */}
      <div className="flex-1 overflow-hidden">
        {entry ? (
          <AttributeTable
            attributes={entry.attributes || []}
            onModify={handleModify}
            onAdd={handleAdd}
            onDelete={handleDelete}
            readOnly={isReadOnly}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            No entry data loaded
          </div>
        )}
      </div>
    </div>
  );
}
