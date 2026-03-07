import { X, Database } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useEditorStore } from '../../stores/editorStore'
import { EntryEditor } from '../editor/EntryEditor'

export function MainPanel() {
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const closeTab = useEditorStore((s) => s.closeTab);

  if (tabs.length === 0) {
    return <WelcomeScreen />;
  }

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Tab Bar */}
      <div className="flex items-center bg-secondary border-b border-border overflow-x-auto shrink-0">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={cn(
              'group relative flex items-center gap-1.5 px-3 h-[35px] cursor-pointer',
              'text-sm border-r border-border select-none shrink-0',
              'transition-colors duration-100',
              tab.id === activeTabId
                ? 'bg-background text-foreground'
                : 'text-muted-foreground hover:bg-accent'
            )}
          >
            {tab.id === activeTabId && (
              <div className="absolute top-0 left-0 right-0 h-px bg-primary" />
            )}
            <Database size={14} className="shrink-0 opacity-70" />
            <span className="truncate max-w-[120px]">
              {tab.dirty && <span className="mr-0.5 text-primary">*</span>}
              {tab.label}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
              className={cn(
                'ml-1 p-0.5 rounded-sm shrink-0',
                'opacity-0 group-hover:opacity-100',
                'hover:bg-accent',
                tab.id === activeTabId && 'opacity-60 hover:opacity-100'
              )}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-hidden">
        {activeTabId && <EntryEditor tabId={activeTabId} />}
      </div>
    </div>
  );
}

function WelcomeScreen() {
  return (
    <div className="h-full flex flex-col items-center justify-center bg-background select-none">
      <div className="flex flex-col items-center gap-4 opacity-40">
        <div className="flex items-center gap-3">
          <Database size={48} strokeWidth={1} />
          <div>
            <h1 className="text-2xl font-light tracking-wide">LDAPilot</h1>
            <p className="text-xs text-muted-foreground">Modern LDAP Browser</p>
          </div>
        </div>
        <div className="mt-8 space-y-2 text-sm text-muted-foreground text-center">
          <p>Connect to an LDAP server to get started</p>
          <div className="flex flex-col gap-1 mt-4 text-xs">
            <div className="flex items-center gap-2 justify-center">
              <kbd className="px-1.5 py-0.5 bg-secondary rounded text-xs border border-border">Ctrl+N</kbd>
              <span>New Connection</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
