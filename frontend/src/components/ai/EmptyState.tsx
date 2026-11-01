import { useEffect, useState } from 'react';
import { Bot, Lightbulb } from 'lucide-react';
import type { ServerType } from '../../types/ldap';
import { GetServerInfo } from '../../lib/wails';
import { useAIStore } from '../../stores/aiStore';
import { useConnectionStore } from '../../stores/connectionStore';

const AD_PROMPTS = [
  'Which accounts are locked out?',
  'Who is in Domain Admins, including nested groups?',
  "Which users haven't logged on for 90 days?",
  'Explain the selected entry',
];

const LDAP_PROMPTS = [
  'Which accounts are locked by the password policy?',
  'List the members of …',
  'Show the schema of inetOrgPerson',
  'Explain the selected entry',
];

const GENERIC_PROMPTS = [
  'Which directories can you see?',
  'How many users are in the directory?',
  'Explain the selected entry',
];

const serverTypes: Record<string, ServerType> = {};

/** Suggestions by the active connection's server type (§10.2); clicking fills the composer. */
export function EmptyState({ configured = true }: { configured?: boolean }) {
  const activeProfileId = useConnectionStore((s) => s.activeProfileId);
  const connected = useConnectionStore((s) => (s.activeProfileId ? !!s.connectionStatuses[s.activeProfileId] : false));
  const profileName = useConnectionStore((s) => s.profiles.find((p) => p.id === s.activeProfileId)?.name);
  const setComposerText = useAIStore((s) => s.setComposerText);
  const [type, setType] = useState<ServerType | null>(activeProfileId ? serverTypes[activeProfileId] ?? null : null);

  useEffect(() => {
    if (!activeProfileId || !connected) {
      setType(null);
      return;
    }
    if (serverTypes[activeProfileId]) {
      setType(serverTypes[activeProfileId]);
      return;
    }
    let live = true;
    GetServerInfo(activeProfileId)
      .then((si) => {
        if (!si || !live) return;
        serverTypes[activeProfileId] = si.serverType;
        setType(si.serverType);
      })
      .catch(() => { /* suggestions stay generic */ });
    return () => { live = false; };
  }, [activeProfileId, connected]);

  const prompts = type === 'ad' ? AD_PROMPTS : type === 'openldap' || type === '389ds' ? LDAP_PROMPTS : GENERIC_PROMPTS;

  return (
    <div className="flex h-full flex-col items-center justify-center px-4 py-6 text-center">
      <Bot size={36} strokeWidth={1.25} className="mb-2 text-muted-foreground" />
      <div className="text-sm font-semibold">LDAPilot assistant</div>
      <p className="mt-1 max-w-xs text-xs text-muted-foreground">
        Ask about accounts, groups and entries{profileName && connected ? <> in <b>{profileName}</b></> : ''}. Changes are only made after you approve the exact diff.
      </p>
      {/* Without a provider the composer is disabled: suggestions would only fill it (A-11). */}
      {configured && <div className="mt-3 flex w-full max-w-xs flex-col gap-1">
        {prompts.map((p) => (
          <button type="button"
            key={p}
            className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label={`Use suggestion: ${p}`}
            onClick={() => setComposerText(p, true)}
          >
            <Lightbulb size={11} className="shrink-0 text-muted-foreground" />
            {p}
          </button>
        ))}
      </div>}
    </div>
  );
}
