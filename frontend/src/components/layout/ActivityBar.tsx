import { useState, useRef, useEffect } from 'react'
import { Plug, FolderTree, Search, Download, BookOpen, Star, Info, ExternalLink, Github, X, Bot, FileBarChart, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'
import { useUIStore } from '../../stores/uiStore'
import { Activity } from '../../types/ui'
import { BrowserOpenURL } from '../../../wailsjs/runtime/runtime'
import { NotificationBell } from '../ui/NotificationLog'
import logoImg from '../../assets/logo.png'

interface ActivityItem {
  id: Activity;
  icon: React.ElementType;
  label: string;
}

const activities: ActivityItem[] = [
  { id: 'connections', icon: Plug, label: 'Connections' },
  { id: 'explorer', icon: FolderTree, label: 'Explorer' },
  { id: 'search', icon: Search, label: 'Search' },
  { id: 'bookmarks', icon: Star, label: 'Bookmarks' },
  { id: 'export', icon: Download, label: 'Export' },
  { id: 'schema', icon: BookOpen, label: 'Schema' },
  { id: 'reports', icon: FileBarChart, label: 'Reports' },
  { id: 'ai', icon: Bot, label: 'AI Chat' },
];

export function ActivityBar() {
  const activeActivity = useUIStore((s) => s.activeActivity);
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const setActivity = useUIStore((s) => s.setActivity);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const [showInfo, setShowInfo] = useState(false);
  const infoRef = useRef<HTMLDivElement>(null);

  const handleClick = (activity: Activity) => {
    if (activeActivity === activity && sidebarVisible) {
      toggleSidebar();
    } else {
      setActivity(activity);
      if (!sidebarVisible) {
        toggleSidebar();
      }
    }
  };

  // Close info popup when clicking outside
  useEffect(() => {
    if (!showInfo) return;
    function handleClickOutside(e: MouseEvent) {
      if (infoRef.current && !infoRef.current.contains(e.target as Node)) {
        setShowInfo(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showInfo]);

  return (
    <div className="flex flex-col items-center w-12 bg-activity-bar border-r border-border select-none shrink-0">
      {/* Activity buttons */}
      <div className="flex flex-col items-center flex-1">
        {activities.map((item) => {
          const isActive = activeActivity === item.id && sidebarVisible;
          const Icon = item.icon;

          return (
            <button
              key={item.id}
              onClick={() => handleClick(item.id)}
              className={cn(
                'relative w-12 h-12 flex items-center justify-center',
                'transition-colors duration-150',
                'hover:text-activity-bar-active',
                'group',
                isActive
                  ? 'text-activity-bar-active'
                  : 'text-activity-bar-foreground'
              )}
              title={item.label}
            >
              {/* Active indicator - left border */}
              {isActive && (
                <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-activity-bar-active" />
              )}
              <Icon size={24} strokeWidth={1.5} />

              {/* Tooltip */}
              <div
                className={cn(
                  'absolute left-14 z-50 px-2 py-1',
                  'bg-popover text-popover-foreground text-sm',
                  'border border-border rounded shadow-lg',
                  'whitespace-nowrap',
                  'opacity-0 pointer-events-none',
                  'group-hover:opacity-100',
                  'transition-opacity duration-150 delay-300'
                )}
              >
                {item.label}
              </div>
            </button>
          );
        })}
      </div>

      {/* Notification bell */}
      <NotificationBell />

      {/* Info button at bottom */}
      <div className="relative" ref={infoRef}>
        <button
          onClick={() => setShowInfo(!showInfo)}
          className={cn(
            'relative w-12 h-12 flex items-center justify-center',
            'transition-colors duration-150',
            'hover:text-activity-bar-active',
            'group',
            showInfo
              ? 'text-activity-bar-active'
              : 'text-activity-bar-foreground'
          )}
          title="About LDAPilot"
        >
          <Info size={24} strokeWidth={1.5} />

          {/* Tooltip */}
          <div
            className={cn(
              'absolute left-14 z-50 px-2 py-1',
              'bg-popover text-popover-foreground text-sm',
              'border border-border rounded shadow-lg',
              'whitespace-nowrap',
              'opacity-0 pointer-events-none',
              'group-hover:opacity-100',
              'transition-opacity duration-150 delay-300'
            )}
          >
            About LDAPilot
          </div>
        </button>

        {/* Info Popup */}
        {showInfo && (
          <div
            className={cn(
              'absolute left-14 bottom-0 z-50 w-72',
              'rounded-xl overflow-hidden',
              'border border-white/10',
              'shadow-2xl shadow-black/50',
              'animate-in slide-in-from-left-2 fade-in duration-200'
            )}
            style={{
              background: 'linear-gradient(135deg, rgba(30,30,40,0.98) 0%, rgba(20,20,30,0.98) 100%)',
              backdropFilter: 'blur(20px)',
            }}
          >
            {/* Gradient accent bar */}
            <div
              className="h-1 w-full"
              style={{
                background: 'linear-gradient(90deg, #6366f1, #8b5cf6, #a855f7)',
              }}
            />

            {/* Header */}
            <div className="px-4 pt-4 pb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <img src={logoImg} alt="LDAPilot" className="w-8 h-8 rounded-lg" />
                <div>
                  <h3 className="text-sm font-semibold text-white">LDAPilot</h3>
                  <p className="text-[10px] text-white/40">LDAP Management Tool</p>
                </div>
              </div>
              <button
                onClick={() => setShowInfo(false)}
                className="p-1 rounded-md hover:bg-white/10 text-white/40 hover:text-white/70 transition-colors"
              >
                <X size={14} />
              </button>
            </div>

            {/* Divider */}
            <div className="mx-4 h-px bg-white/10" />

            {/* Content */}
            <div className="p-4 space-y-3">
              <p className="text-xs text-white/60 leading-relaxed">
                Developed by{' '}
                <button
                  onClick={() => BrowserOpenURL('https://www.picillo.de/')}
                  className="text-purple-400 hover:text-purple-300 font-medium transition-colors inline-flex items-center gap-0.5 cursor-pointer"
                >
                  David Picillo
                  <ExternalLink size={10} />
                </button>
              </p>

              <button
                onClick={() => BrowserOpenURL('https://github.com/DPicillo/LDAPilot')}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2.5 rounded-lg w-full text-left',
                  'bg-white/5 hover:bg-white/10 border border-white/5 hover:border-white/10',
                  'transition-all duration-200 group/link cursor-pointer'
                )}
              >
                <Github size={16} className="text-white/50 group-hover/link:text-white/80 transition-colors" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-white/80 group-hover/link:text-white transition-colors">
                    Bugs & Feature Requests
                  </p>
                  <p className="text-[10px] text-white/40 truncate">
                    github.com/DPicillo/LDAPilot
                  </p>
                </div>
                <ExternalLink size={12} className="text-white/30 group-hover/link:text-white/50 transition-colors flex-shrink-0" />
              </button>
            </div>

            {/* Footer */}
            <div className="px-4 pb-3">
              <p className="text-[10px] text-white/25 text-center">
                © {new Date().getFullYear()} David Picillo
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

