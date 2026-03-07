import { Download } from 'lucide-react'
import { useUIStore } from '../../stores/uiStore'
import { Activity } from '../../types/ui'
import { ConnectionManager } from '../connection/ConnectionManager'
import { DirectoryTree } from '../tree/DirectoryTree'
import { SearchPanel } from '../search/SearchPanel'
import { SchemaBrowser } from '../schema/SchemaBrowser'

function PlaceholderPanel({ title, icon: Icon, description }: { title: string; icon: React.ElementType; description: string }) {
  return (
    <div className="h-full flex flex-col bg-sidebar overflow-hidden">
      <div className="flex items-center px-4 h-9 shrink-0 border-b border-border">
        <span className="text-xs font-semibold uppercase tracking-wider text-secondary-foreground">{title}</span>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
          <Icon size={48} strokeWidth={1} className="mb-4 opacity-40" />
          <p className="text-sm text-center">{description}</p>
        </div>
      </div>
    </div>
  );
}

export function Sidebar() {
  const activeActivity = useUIStore((s) => s.activeActivity);

  switch (activeActivity) {
    case 'connections': return <ConnectionManager />;
    case 'explorer': return <DirectoryTree />;
    case 'search': return <SearchPanel />;
    case 'export': return <PlaceholderPanel title="Export" icon={Download} description="Select entries to export" />;
    case 'schema': return <SchemaBrowser />;
    default: return null;
  }
}
