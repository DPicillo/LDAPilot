import { Plug, PlugZap, Lock } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'

export function StatusBar() {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const profiles = useConnectionStore((s) => s.profiles);
  const connectionStatuses = useConnectionStore((s) => s.connectionStatuses);
  const tabs = useEditorStore((s) => s.tabs);

  const isConnected = activeProfileId
    ? connectionStatuses[activeProfileId] === true
    : false;

  const activeProfile = activeProfileId
    ? profiles.find((p) => p.id === activeProfileId)
    : null;

  return (
    <div
      className={cn(
        'flex items-center justify-between px-2 h-[22px] text-xs select-none shrink-0',
        'transition-colors duration-300',
        isConnected
          ? 'bg-statusbar-connected text-white'
          : 'bg-statusbar text-white'
      )}
    >
      {/* Left side */}
      <div className="flex items-center gap-2">
        {isConnected ? (
          <div className="flex items-center gap-1">
            <PlugZap size={12} />
            <span>
              {activeProfile
                ? `${activeProfile.name} (${activeProfile.host}:${activeProfile.port})`
                : 'Connected'}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-1">
            <Plug size={12} />
            <span>No Connection</span>
          </div>
        )}
      </div>

      {/* Right side */}
      <div className="flex items-center gap-3">
        {activeProfile?.readOnly && (
          <span className="flex items-center gap-1">
            <Lock size={10} />
            Read-Only
          </span>
        )}
        {tabs.length > 0 && (
          <span>
            {tabs.length} tab{tabs.length !== 1 ? 's' : ''} open
          </span>
        )}
        <span>LDAPilot</span>
      </div>
    </div>
  );
}
