import { useState, useMemo } from 'react'
import { RefreshCw, Loader2, ArrowLeft, ArrowRight, Lock, Copy, Check, ChevronRight, Star, List, Users, FileText } from 'lucide-react'
import { useEditorStore } from '../../stores/editorStore'
import { useConnectionStore } from '../../stores/connectionStore'
import { useBookmarkStore } from '../../stores/bookmarkStore'
import { AttributeTable } from './AttributeTable'
import { MembershipPanel } from './MembershipPanel'
import { cn } from '../../lib/utils'
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

  const openEntry = useEditorStore((s) => s.openEntry);
  const { addBookmark, removeBookmark, isBookmarked: checkBookmarked } = useBookmarkStore();

  const [dnCopied, setDnCopied] = useState(false);
  const [activeSubTab, setActiveSubTab] = useState<'attributes' | 'members'>('attributes');

  // Split DN into breadcrumb parts: each part is an RDN + full DN to navigate to
  const breadcrumbs = useMemo(() => {
    if (!tab) return [];
    const parts = tab.dn.split(',');
    const crumbs: { rdn: string; dn: string }[] = [];
    for (let i = 0; i < parts.length; i++) {
      crumbs.push({
        rdn: parts[i],
        dn: parts.slice(i).join(','),
      });
    }
    return crumbs;
  }, [tab?.dn]);

  const bookmarked = tab ? checkBookmarked(tab.profileId, tab.dn) : false;

  function toggleBookmark() {
    if (!tab) return;
    if (bookmarked) {
      removeBookmark(tab.profileId, tab.dn);
      toast.info('Bookmark removed');
    } else {
      addBookmark(tab.profileId, tab.dn);
      toast.info('Bookmark added');
    }
  }

  function copyDN() {
    if (!tab) return;
    navigator.clipboard.writeText(tab.dn);
    setDnCopied(true);
    setTimeout(() => setDnCopied(false), 1500);
  }

  function copyAsLDIF() {
    if (!tab || !entry) return;
    const lines: string[] = [`dn: ${tab.dn}`];
    for (const attr of entry.attributes || []) {
      if (attr.binary) {
        lines.push(`${attr.name}:: (binary data)`);
      } else {
        for (const val of attr.values) {
          // Use base64 encoding marker if value contains special chars
          if (val.includes('\n') || val.includes('\r') || val.startsWith(' ') || val.startsWith(':') || val.startsWith('<')) {
            lines.push(`${attr.name}:: ${btoa(val)}`);
          } else {
            lines.push(`${attr.name}: ${val}`);
          }
        }
      }
    }
    lines.push('');
    navigator.clipboard.writeText(lines.join('\n'));
    toast.info('Copied as LDIF');
  }

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

        {/* Breadcrumb DN navigation */}
        <div className="flex items-center flex-1 ml-1 min-w-0 overflow-hidden">
          {breadcrumbs.map((crumb, i) => (
            <span key={crumb.dn} className="flex items-center shrink-0">
              {i > 0 && <ChevronRight size={10} className="text-muted-foreground/50 mx-0.5 shrink-0" />}
              {i === 0 ? (
                <span className="text-xs font-mono text-foreground font-medium truncate max-w-[200px]" title={crumb.dn}>
                  {crumb.rdn}
                </span>
              ) : (
                <button
                  onClick={() => openEntry(tab.profileId, crumb.dn)}
                  className="text-xs font-mono text-muted-foreground hover:text-primary hover:underline truncate max-w-[150px]"
                  title={`Navigate to ${crumb.dn}`}
                >
                  {crumb.rdn}
                </button>
              )}
            </span>
          ))}
        </div>

        {/* Bookmark */}
        <button
          onClick={toggleBookmark}
          className="p-1 rounded hover:bg-accent shrink-0"
          title={bookmarked ? 'Remove bookmark' : 'Bookmark this entry'}
        >
          <Star size={12} className={bookmarked ? 'text-yellow-500 fill-yellow-500' : 'text-muted-foreground hover:text-yellow-500'} />
        </button>

        <button
          onClick={copyDN}
          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground shrink-0"
          title="Copy DN"
        >
          {dnCopied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
        </button>
        <button
          onClick={copyAsLDIF}
          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground shrink-0"
          title="Copy as LDIF"
        >
          <FileText size={12} />
        </button>
        <button
          onClick={() => refreshEntry(tab.profileId, tab.dn)}
          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground shrink-0"
          title="Refresh"
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {/* Sub-tab bar */}
      {entry && hasMembershipAttrs(entry) && (
        <div className="flex items-center border-b border-border bg-card/50 px-2 shrink-0">
          <SubTabButton
            label="Attributes"
            icon={List}
            active={activeSubTab === 'attributes'}
            onClick={() => setActiveSubTab('attributes')}
          />
          <SubTabButton
            label="Members"
            icon={Users}
            active={activeSubTab === 'members'}
            onClick={() => setActiveSubTab('members')}
            badge={getMemberCount(entry)}
          />
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {!entry ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            No entry data loaded
          </div>
        ) : activeSubTab === 'members' && hasMembershipAttrs(entry) ? (
          <MembershipPanel tabId={tabId} />
        ) : (
          <AttributeTable
            attributes={entry.attributes || []}
            onModify={handleModify}
            onAdd={handleAdd}
            onDelete={handleDelete}
            onNavigateDN={(dn) => openEntry(tab.profileId, dn)}
            readOnly={isReadOnly}
          />
        )}
      </div>
    </div>
  );
}

function SubTabButton({ label, icon: Icon, active, onClick, badge }: {
  label: string;
  icon: React.ElementType;
  active: boolean;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 px-2.5 py-1.5 text-xs border-b-2 -mb-px transition-colors',
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
      )}
    >
      <Icon size={12} />
      {label}
      {badge !== undefined && badge > 0 && (
        <span className="text-[9px] bg-accent px-1 rounded-full ml-0.5">{badge}</span>
      )}
    </button>
  );
}

function hasMembershipAttrs(entry: { attributes?: { name: string; values: string[] }[] }): boolean {
  if (!entry.attributes) return false;
  return entry.attributes.some(a => {
    const lower = a.name.toLowerCase();
    return lower === 'member' || lower === 'uniquemember' || lower === 'memberof';
  });
}

function getMemberCount(entry: { attributes?: { name: string; values: string[] }[] }): number {
  if (!entry.attributes) return 0;
  const memberAttr = entry.attributes.find(a =>
    ['member', 'uniquemember', 'memberof'].includes(a.name.toLowerCase())
  );
  return memberAttr?.values.length || 0;
}
