import { useState } from 'react'
import { FileText, Play, Loader2, Users, Lock, KeyRound, UserX, Shield, Clock, AlertTriangle, Server } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import { useSearchStore } from '../../stores/searchStore'
import { useUIStore } from '../../stores/uiStore'
import { cn } from '../../lib/utils'

interface ReportDefinition {
  id: string;
  name: string;
  description: string;
  icon: any;
  iconColor: string;
  filter: string;
  displayColumns: string[];
  category: 'users' | 'security' | 'groups' | 'system';
}

const REPORTS: ReportDefinition[] = [
  // Users
  {
    id: 'all-users',
    name: 'All Users',
    description: 'List all user accounts in the directory',
    icon: Users,
    iconColor: 'text-blue-400',
    filter: '(&(objectClass=person)(objectClass=user))',
    displayColumns: ['cn', 'mail', 'sAMAccountName', 'description'],
    category: 'users',
  },
  {
    id: 'users-no-email',
    name: 'Users Without Email',
    description: 'Users who have no email address set',
    icon: UserX,
    iconColor: 'text-orange-400',
    filter: '(&(objectClass=user)(!(mail=*)))',
    displayColumns: ['cn', 'sAMAccountName', 'description', 'department'],
    category: 'users',
  },
  {
    id: 'users-no-login',
    name: 'Users Never Logged On',
    description: 'Users who have never logged into the domain',
    icon: Clock,
    iconColor: 'text-yellow-400',
    filter: '(&(objectClass=user)(!(lastLogonTimestamp=*)))',
    displayColumns: ['cn', 'sAMAccountName', 'whenCreated', 'description'],
    category: 'users',
  },
  {
    id: 'service-accounts',
    name: 'Service Accounts',
    description: 'Managed Service Accounts (MSA/gMSA)',
    icon: Server,
    iconColor: 'text-cyan-400',
    filter: '(objectClass=msDS-ManagedServiceAccount)',
    displayColumns: ['cn', 'sAMAccountName', 'description', 'whenCreated'],
    category: 'users',
  },

  // Security
  {
    id: 'disabled-accounts',
    name: 'Disabled Accounts',
    description: 'User accounts that are currently disabled',
    icon: UserX,
    iconColor: 'text-red-400',
    filter: '(&(objectClass=user)(userAccountControl:1.2.840.113556.1.4.803:=2))',
    displayColumns: ['cn', 'sAMAccountName', 'description', 'whenChanged'],
    category: 'security',
  },
  {
    id: 'locked-accounts',
    name: 'Locked-Out Users',
    description: 'User accounts that are currently locked out',
    icon: Lock,
    iconColor: 'text-red-500',
    filter: '(&(objectClass=user)(lockoutTime>=1))',
    displayColumns: ['cn', 'sAMAccountName', 'mail', 'description'],
    category: 'security',
  },
  {
    id: 'pwd-never-expires',
    name: 'Password Never Expires',
    description: 'Accounts with non-expiring passwords',
    icon: KeyRound,
    iconColor: 'text-amber-400',
    filter: '(&(objectClass=user)(userAccountControl:1.2.840.113556.1.4.803:=65536))',
    displayColumns: ['cn', 'sAMAccountName', 'mail', 'description'],
    category: 'security',
  },
  {
    id: 'pwd-not-required',
    name: 'Password Not Required',
    description: 'Accounts that don\'t require a password (security risk)',
    icon: AlertTriangle,
    iconColor: 'text-red-400',
    filter: '(&(objectClass=user)(userAccountControl:1.2.840.113556.1.4.803:=32))',
    displayColumns: ['cn', 'sAMAccountName', 'description'],
    category: 'security',
  },
  {
    id: 'admin-accounts',
    name: 'Admin Accounts',
    description: 'Members of built-in admin groups',
    icon: Shield,
    iconColor: 'text-purple-400',
    filter: '(&(objectClass=user)(adminCount=1))',
    displayColumns: ['cn', 'sAMAccountName', 'mail', 'description'],
    category: 'security',
  },

  // Groups
  {
    id: 'all-groups',
    name: 'All Groups',
    description: 'List all groups in the directory',
    icon: Users,
    iconColor: 'text-green-400',
    filter: '(objectClass=group)',
    displayColumns: ['cn', 'description', 'mail', 'sAMAccountName'],
    category: 'groups',
  },
  {
    id: 'empty-groups',
    name: 'Empty Groups',
    description: 'Groups with no members',
    icon: Users,
    iconColor: 'text-orange-400',
    filter: '(&(objectClass=group)(!(member=*)))',
    displayColumns: ['cn', 'description', 'sAMAccountName'],
    category: 'groups',
  },

  // System
  {
    id: 'all-ous',
    name: 'Organizational Units',
    description: 'All OUs in the directory',
    icon: FileText,
    iconColor: 'text-blue-300',
    filter: '(objectClass=organizationalUnit)',
    displayColumns: ['ou', 'description', 'l', 'st'],
    category: 'system',
  },
  {
    id: 'all-computers',
    name: 'Computers',
    description: 'All computer accounts',
    icon: Server,
    iconColor: 'text-teal-400',
    filter: '(objectClass=computer)',
    displayColumns: ['cn', 'description', 'operatingSystem', 'operatingSystemVersion'],
    category: 'system',
  },
  {
    id: 'posix-users',
    name: 'POSIX Users',
    description: 'Accounts with POSIX attributes (RFC 2307)',
    icon: Users,
    iconColor: 'text-indigo-400',
    filter: '(objectClass=posixAccount)',
    displayColumns: ['uid', 'cn', 'uidNumber', 'gidNumber', 'homeDirectory'],
    category: 'system',
  },
];

const CATEGORIES = [
  { id: 'users' as const, label: 'Users', icon: Users },
  { id: 'security' as const, label: 'Security', icon: Shield },
  { id: 'groups' as const, label: 'Groups', icon: Users },
  { id: 'system' as const, label: 'System', icon: Server },
];

export function ReportsPanel() {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const connectionStatuses = useConnectionStore((s) => s.connectionStatuses);
  const isConnected = activeProfileId ? connectionStatuses[activeProfileId] === true : false;
  const profiles = useConnectionStore((s) => s.profiles);
  const activeProfile = activeProfileId ? profiles.find(p => p.id === activeProfileId) : null;
  const { executeSearch, setParams, setDisplayColumns } = useSearchStore();
  const { showBottomTab, bottomPanelVisible } = useUIStore();
  const [runningReport, setRunningReport] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  async function runReport(report: ReportDefinition) {
    if (!activeProfileId || !isConnected) return;
    setRunningReport(report.id);

    // Set search params
    setParams({
      baseDN: activeProfile?.baseDN || '',
      filter: report.filter,
      sizeLimit: 5000,
      attributes: [],
    });

    // Set display columns
    setDisplayColumns(report.displayColumns);

    // Show results panel
    if (!bottomPanelVisible) showBottomTab('search-results');

    // Execute
    await executeSearch(activeProfileId, report.filter);
    setRunningReport(null);
  }

  if (!isConnected) {
    return (
      <div className="h-full flex flex-col bg-sidebar">
        <div className="flex items-center px-4 h-9 shrink-0 border-b border-border">
          <span className="text-xs font-semibold uppercase tracking-wider text-secondary-foreground">Reports</span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-4">
          <FileText size={48} strokeWidth={1} className="mb-4 opacity-40" />
          <p className="text-sm text-center">Connect to a server to run reports</p>
        </div>
      </div>
    );
  }

  const displayReports = selectedCategory
    ? REPORTS.filter(r => r.category === selectedCategory)
    : REPORTS;

  return (
    <div className="h-full flex flex-col bg-sidebar">
      {/* Header */}
      <div className="flex items-center px-4 h-9 shrink-0 border-b border-border">
        <span className="text-xs font-semibold uppercase tracking-wider text-secondary-foreground">Reports</span>
      </div>

      {/* Category Filter */}
      <div className="flex border-b border-border shrink-0 px-2 py-1.5 gap-1">
        <button
          onClick={() => setSelectedCategory(null)}
          className={cn(
            'text-[10px] px-2 py-0.5 rounded-full transition-colors',
            !selectedCategory ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
          )}
        >
          All
        </button>
        {CATEGORIES.map(cat => (
          <button
            key={cat.id}
            onClick={() => setSelectedCategory(selectedCategory === cat.id ? null : cat.id)}
            className={cn(
              'text-[10px] px-2 py-0.5 rounded-full transition-colors flex items-center gap-0.5',
              selectedCategory === cat.id ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            )}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Report Cards */}
      <div className="flex-1 overflow-auto p-2 space-y-1">
        {displayReports.map(report => {
          const IconComponent = report.icon;
          const isRunning = runningReport === report.id;
          return (
            <button
              key={report.id}
              onClick={() => runReport(report)}
              disabled={isRunning}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-accent/50 transition-colors text-left group disabled:opacity-60"
            >
              <div className={cn('shrink-0', report.iconColor)}>
                {isRunning ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <IconComponent size={16} />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-foreground">{report.name}</div>
                <div className="text-[10px] text-muted-foreground truncate">{report.description}</div>
              </div>
              <Play
                size={12}
                className="text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              />
            </button>
          );
        })}
      </div>
    </div>
  );
}
