import { useEffect, useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { useUIStore } from '../../stores/uiStore'
import { ConnectionProfile } from '../../types/ldap'
import { ConnectionCard } from './ConnectionCard'
import { ConnectionDialog } from './ConnectionDialog'

export function ConnectionManager() {
  const {
    profiles, activeProfileId, connectionStatuses, error,
    loadProfiles, saveProfile, deleteProfile,
    connect, disconnect, testConnection, setActiveProfile, clearError,
  } = useConnectionStore();
  const setActivity = useUIStore((s) => s.setActivity);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<ConnectionProfile | undefined>();

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  function handleNewConnection() {
    setEditingProfile(undefined);
    setDialogOpen(true);
  }

  function handleEdit(profile: ConnectionProfile) {
    setEditingProfile(profile);
    setDialogOpen(true);
  }

  function handleClone(profile: ConnectionProfile) {
    const cloned: ConnectionProfile = {
      ...profile,
      id: '',
      name: `Copy of ${profile.name}`,
      password: '',
      hasPassword: false,
    };
    setEditingProfile(cloned);
    setDialogOpen(true);
  }

  async function handleSave(profile: ConnectionProfile) {
    try {
      await saveProfile(profile);
      setDialogOpen(false);
    } catch {
      // Error is set in store
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this connection profile?')) return;
    await deleteProfile(id);
  }

  async function handleConnect(id: string) {
    try {
      await connect(id);
      // Switch to explorer after connecting
      setActivity('explorer');
    } catch {
      // Error is set in store
    }
  }

  return (
    <div className="h-full flex flex-col bg-sidebar">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-9 shrink-0 border-b border-border">
        <span className="text-xs font-semibold uppercase tracking-wider text-secondary-foreground">
          Connections
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => loadProfiles()}
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
            title="Refresh"
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={handleNewConnection}
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
            title="New Connection"
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="mx-3 mt-2 px-3 py-2 text-xs bg-destructive/10 text-destructive rounded flex items-center justify-between">
          <span className="truncate">{error}</span>
          <button onClick={clearError} className="text-destructive/60 hover:text-destructive ml-2 shrink-0">
            &times;
          </button>
        </div>
      )}

      {/* Connection List */}
      <div className="flex-1 overflow-auto p-3 space-y-2">
        {profiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <p className="text-sm text-center">No connections yet</p>
            <button
              onClick={handleNewConnection}
              className="mt-3 flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Plus size={12} />
              Add Connection
            </button>
          </div>
        ) : (
          profiles.map((profile) => (
            <ConnectionCard
              key={profile.id}
              profile={profile}
              isConnected={connectionStatuses[profile.id] || false}
              isActive={activeProfileId === profile.id}
              onConnect={() => handleConnect(profile.id)}
              onDisconnect={() => disconnect(profile.id)}
              onEdit={() => handleEdit(profile)}
              onDelete={() => handleDelete(profile.id)}
              onClone={() => handleClone(profile)}
              onSelect={() => setActiveProfile(profile.id)}
            />
          ))
        )}
      </div>

      {/* Connection Dialog */}
      {dialogOpen && (
        <ConnectionDialog
          profile={editingProfile}
          onSave={handleSave}
          onCancel={() => setDialogOpen(false)}
          onTest={testConnection}
        />
      )}
    </div>
  );
}
