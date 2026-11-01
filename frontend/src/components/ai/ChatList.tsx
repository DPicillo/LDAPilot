import { useState } from 'react';
import { AlertTriangle, Check, CircleDot, MessageSquare, Pencil, ShieldAlert, Trash2, X } from 'lucide-react';
import { formatRelativeTime } from '../../lib/aiFormat';
import { useAIStore } from '../../stores/aiStore';
import { runActive } from '../../lib/aiReducer';
import { chip, tone } from './tone';
import { Popover } from '../ui/Popover';
import { IconButton } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Input, SearchInput } from '../ui/Input';
import { cn } from '../../lib/utils';

/**
 * Chat selector dropdown (§10.2): search, relative time, rename, delete,
 * running / corrupt / pending-write badges. A ui Popover below the chat
 * header (LayerHost: zoom-safe, never clipped by the sidebar).
 */
export function ChatList({ open, anchor, onClose }: { open: boolean; anchor: HTMLElement | null; onClose: () => void }) {
  const chats = useAIStore((s) => s.chats);
  const activeChatId = useAIStore((s) => s.activeChatId);
  const selectChat = useAIStore((s) => s.selectChat);
  const renameChat = useAIStore((s) => s.renameChat);
  const deleteChat = useAIStore((s) => s.deleteChat);
  // chats whose run waits for an approval (A-07: they only showed "running")
  const waiting = useAIStore((s) => {
    const out: string[] = [];
    for (const [id, r] of Object.entries(s.runs)) {
      if (runActive(r) && Object.values(r.approvals).some((a) => !a.resolved)) out.push(id);
    }
    return out.join('|');
  });
  const [q, setQ] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const now = Date.now();

  const filtered = chats.filter((c) => !q || c.title.toLowerCase().includes(q.toLowerCase()));

  return (
    <Popover open={open} onOpenChange={(o) => !o && onClose()} anchor={anchor} placement="bottom-start" matchWidth offset={0} aria-label="Chats" className="text-xs">
     <div data-ai-popup className="flex min-h-0 flex-col">
      <div className="border-b border-border p-1">
        <SearchInput value={q} onValueChange={setQ} onEscape={onClose} placeholder="Search chats" aria-label="Search chats" size="sm" />
      </div>
      <div className="max-h-80 overflow-auto py-0.5" role="listbox" aria-label="Chats">
        {filtered.length === 0 && <div className="px-2 py-2 text-center text-muted-foreground">{chats.length ? 'No matching chat' : 'No chats yet'}</div>}
        {filtered.map((c) => (
          <div
            key={c.id}
            role="option"
            aria-selected={c.id === activeChatId}
            className={cn('group flex items-center gap-1.5 px-2 py-1 hover:bg-accent', c.id === activeChatId && 'bg-accent')}
          >
            {renaming === c.id ? (
              <form
                className="flex flex-1 items-center gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (renameValue.trim()) void renameChat(c.id, renameValue.trim());
                  setRenaming(null);
                }}
              >
                <Input
                  autoFocus
                  size="sm"
                  value={renameValue}
                  maxLength={120}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null); } }}
                  aria-label="New chat title"
                  wrapperClassName="flex-1"
                  className="flex-1"
                />
                <IconButton type="submit" size="sm" icon={Check} label="Save title" />
                <IconButton size="sm" icon={X} label="Cancel rename" onClick={() => setRenaming(null)} />
              </form>
            ) : confirmDelete === c.id ? (
              <div className="flex flex-1 items-center gap-1">
                <span className="flex-1 truncate">Delete “{c.title}”?</span>
                <IconButton size="sm" icon={Check} label="Confirm delete" className={tone.dangerText} onClick={() => { setConfirmDelete(null); void deleteChat(c.id); }} />
                <IconButton size="sm" icon={X} label="Cancel delete" onClick={() => setConfirmDelete(null)} />
              </div>
            ) : (
              <>
                <button type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  aria-label={`Open chat ${c.title}`}
                  onClick={() => { void selectChat(c.id); useAIStore.getState().setView('chat'); onClose(); }}
                >
                  {c.running ? <CircleDot size={11} className={cn('shrink-0 animate-pulse', tone.successText)} aria-label="running" /> : <MessageSquare size={11} className="shrink-0 text-muted-foreground" />}
                  <span className="truncate">{c.title || 'New chat'}</span>
                  {c.corrupt && <Badge tone="danger" icon={AlertTriangle} title={c.note || 'This chat could not be read'}>damaged</Badge>}
                  {c.pendingWrite && <Badge tone="warning" title="A change was being applied when LDAPilot stopped">write pending</Badge>}
                  {waiting.split('|').includes(c.id) && <Badge tone="warning" icon={ShieldAlert} title="The assistant waits for your approval in this chat">approval</Badge>}
                  <span className="ml-auto shrink-0 text-muted-foreground">{formatRelativeTime(c.updatedAt, now)}</span>
                </button>
                <IconButton size="sm" icon={Pencil} label={`Rename chat ${c.title}`} revealOnRowHover onClick={() => { setRenaming(c.id); setRenameValue(c.title); }} />
                <IconButton size="sm" icon={Trash2} label={`Delete chat ${c.title}`} revealOnRowHover onClick={() => setConfirmDelete(c.id)} />
              </>
            )}
          </div>
        ))}
      </div>
     </div>
    </Popover>
  );
}
