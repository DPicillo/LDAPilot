import { Plug, PlugZap, Pencil, Trash2, Server } from 'lucide-react'
import { ConnectionProfile } from '../../types/ldap'
import { cn } from '../../lib/utils'

interface ConnectionCardProps {
  profile: ConnectionProfile;
  isConnected: boolean;
  isActive: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSelect: () => void;
}

export function ConnectionCard({
  profile,
  isConnected,
  isActive,
  onConnect,
  onDisconnect,
  onEdit,
  onDelete,
  onSelect,
}: ConnectionCardProps) {
  return (
    <div
      className={cn(
        'group border rounded px-3 py-2 cursor-pointer transition-colors',
        isActive
          ? 'border-primary bg-accent'
          : 'border-border hover:border-muted-foreground/30 hover:bg-accent/50'
      )}
      onClick={onSelect}
    >
      <div className="flex items-center gap-2">
        <Server size={14} className={cn(
          isConnected ? 'text-green-400' : 'text-muted-foreground'
        )} />
        <span className="text-sm font-medium truncate flex-1">
          {profile.name || 'Unnamed'}
        </span>
        <div className={cn(
          'w-2 h-2 rounded-full shrink-0',
          isConnected ? 'bg-green-400' : 'bg-muted-foreground/30'
        )} />
      </div>

      <div className="text-xs text-muted-foreground mt-1 truncate">
        {profile.host}:{profile.port}
        {profile.baseDN && ` - ${profile.baseDN}`}
      </div>

      <div className="flex items-center gap-1 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
        {isConnected ? (
          <button
            onClick={(e) => { e.stopPropagation(); onDisconnect(); }}
            className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-destructive/10 text-destructive hover:bg-destructive/20"
            title="Disconnect"
          >
            <PlugZap size={12} />
            Disconnect
          </button>
        ) : (
          <button
            onClick={(e) => { e.stopPropagation(); onConnect(); }}
            className="flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary/20"
            title="Connect"
          >
            <Plug size={12} />
            Connect
          </button>
        )}
        <div className="flex-1" />
        <button
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
          title="Edit"
        >
          <Pencil size={12} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
          title="Delete"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}
