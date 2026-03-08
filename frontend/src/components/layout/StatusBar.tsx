import { useState, useRef, useEffect } from 'react'
import { Plug, PlugZap, Lock, ShieldCheck, Shield, ShieldOff, ChevronUp, Check } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useConnectionStore } from '../../stores/connectionStore'
import { useEditorStore } from '../../stores/editorStore'
import { useSearchStore } from '../../stores/searchStore'

export function StatusBar() {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const profiles = useConnectionStore((s) => s.profiles);
  const connectionStatuses = useConnectionStore((s) => s.connectionStatuses);
  const setActiveProfile = useConnectionStore((s) => s.setActiveProfile);
  const connect = useConnectionStore((s) => s.connect);
  const tabs = useEditorStore((s) => s.tabs);
  const searchResults = useSearchStore((s) => s.results);

  const [showSwitcher, setShowSwitcher] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);

  const isConnected = activeProfileId
    ? connectionStatuses[activeProfileId] === true
    : false;

  const activeProfile = activeProfileId
    ? profiles.find((p) => p.id === activeProfileId)
    : null;

  const TlsIcon = activeProfile?.tlsMode === 'ssl'
    ? ShieldCheck
    : activeProfile?.tlsMode === 'starttls'
    ? Shield
    : ShieldOff;

  const tlsLabel = activeProfile?.tlsMode === 'ssl'
    ? 'LDAPS'
    : activeProfile?.tlsMode === 'starttls'
    ? 'StartTLS'
    : 'Plain';

  // Close switcher when clicking outside
  useEffect(() => {
    if (!showSwitcher) return;
    function handleClick(e: MouseEvent) {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setShowSwitcher(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showSwitcher]);

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
      <div className="flex items-center gap-3">
        {isConnected ? (
          <>
            {/* Connection name - clickable for quick switch */}
            <div className="relative" ref={switcherRef}>
              <button
                onClick={() => setShowSwitcher(!showSwitcher)}
                className="flex items-center gap-1 hover:opacity-80 transition-opacity"
              >
                <PlugZap size={12} />
                <span className="font-medium">
                  {activeProfile?.name || 'Connected'}
                </span>
                <ChevronUp size={10} className={cn('transition-transform', showSwitcher ? '' : 'rotate-180')} />
              </button>

              {/* Quick switch dropdown */}
              {showSwitcher && (
                <div className="absolute bottom-full left-0 mb-1 bg-popover border border-border rounded shadow-xl py-1 min-w-[200px] z-50">
                  <div className="px-2 py-1 text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">
                    Switch Connection
                  </div>
                  {profiles.map(profile => {
                    const connected = connectionStatuses[profile.id] === true;
                    const isActive = profile.id === activeProfileId;
                    return (
                      <button
                        key={profile.id}
                        onClick={() => {
                          if (!isActive) {
                            setActiveProfile(profile.id);
                            if (!connected) {
                              connect(profile.id);
                            }
                          }
                          setShowSwitcher(false);
                        }}
                        className={cn(
                          'w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left',
                          'hover:bg-accent text-popover-foreground',
                          isActive && 'bg-accent/50'
                        )}
                      >
                        <span className={cn(
                          'w-1.5 h-1.5 rounded-full shrink-0',
                          connected ? 'bg-green-400' : 'bg-muted-foreground/30'
                        )} />
                        <span className="flex-1 truncate" title={profile.name}>{profile.name}</span>
                        <span className="text-[10px] text-muted-foreground">{profile.host}:{profile.port}</span>
                        {isActive && <Check size={10} className="text-primary shrink-0" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <span className="opacity-60">
              {activeProfile?.host}:{activeProfile?.port}
            </span>
            {activeProfile?.baseDN && (
              <span className="opacity-60 truncate max-w-[200px]" title={activeProfile.baseDN}>
                {activeProfile.baseDN}
              </span>
            )}
          </>
        ) : (
          <div className="flex items-center gap-1">
            <Plug size={12} />
            <span>No Connection</span>
          </div>
        )}
      </div>

      {/* Right side */}
      <div className="flex items-center gap-3">
        {isConnected && activeProfile && (
          <span className="flex items-center gap-1 opacity-70" title={`TLS: ${tlsLabel}`}>
            <TlsIcon size={10} />
            {tlsLabel}
          </span>
        )}
        {activeProfile?.readOnly && (
          <span className="flex items-center gap-1 bg-yellow-500/20 px-1.5 rounded text-yellow-200">
            <Lock size={10} />
            Read-Only
          </span>
        )}
        {searchResults && searchResults.totalCount > 0 && (
          <span className="opacity-70">
            {searchResults.totalCount} result{searchResults.totalCount !== 1 ? 's' : ''}
            {searchResults.truncated && ' (truncated)'}
          </span>
        )}
        {tabs.length > 0 && (
          <span className="opacity-70">
            {tabs.length} tab{tabs.length !== 1 ? 's' : ''}
          </span>
        )}
        <span className="font-medium opacity-50">LDAPilot</span>
      </div>
    </div>
  );
}
