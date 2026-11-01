import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AtSign, FileText, KeyRound, Loader2, MousePointerClick, Pencil, Plus, Send, Settings, Square, X } from 'lucide-react';
import type { Mention } from '../../types/ai';
import { classifyDestination, dnKey, MAX_MESSAGE_BYTES, rdnValue, utf8Length } from '../../lib/aiFormat';
import { dropBareAt, stripBareAt } from '../../lib/aiComposer';
import { hintOf, maskAllPasswords, removePasswords, resetRequest, scanPasswords, type PasswordScan } from '../../lib/aiPassword';
import { runActive } from '../../lib/aiReducer';
import { selectedEntry, selectionKey, useAIStore, type SelectedEntry } from '../../stores/aiStore';
import { useConnectionStore } from '../../stores/connectionStore';
import { useEditorStore } from '../../stores/editorStore';
import { useTreeStore } from '../../stores/treeStore';
import { matchCommands, runSlashCommand } from './slashCommands';
import { ModelPicker } from './ModelPicker';
import { tone } from './tone';
import { Button, IconButton } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { InlineAlert } from '../ui/InlineAlert';
import { Popover } from '../ui/Popover';
import { cn } from '../../lib/utils';

interface MentionOption {
  key: string;
  label: string;
  detail: string;
  mention: Mention | null;
  disabledReason?: string;
}

function accessLevel(profileId: string): string {
  const cfg = useAIStore.getState().config;
  return cfg?.connectionAccess?.[profileId]?.level || cfg?.defaultAccess || 'ask';
}

function recentEntries(): { profileId: string; dn: string; label: string }[] {
  try {
    const raw = JSON.parse(localStorage.getItem('ldapilot-recent-entries') || '[]');
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r.dn === 'string' && typeof r.profileId === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

function mentionOptions(query: string): MentionOption[] {
  const profiles = useConnectionStore.getState().profiles;
  const pname = (id: string) => profiles.find((p) => p.id === id)?.name ?? '';
  const sel = selectedEntry();
  const ui = { selectedDn: sel?.dn ?? '', selectedProfileId: sel?.profileId ?? '' };
  const out: MentionOption[] = [];
  if (ui.selectedDn && ui.selectedProfileId) {
    const none = accessLevel(ui.selectedProfileId) === 'none';
    out.push({
      key: 'entry',
      label: '@entry',
      detail: `${rdnValue(ui.selectedDn)} · ${pname(ui.selectedProfileId)}`,
      mention: { profileId: ui.selectedProfileId, dn: ui.selectedDn },
      disabledReason: none ? 'The assistant has no access to this connection (level "none").' : undefined,
    });
  } else {
    out.push({ key: 'entry', label: '@entry', detail: 'the selected entry', mention: null, disabledReason: 'Select an entry in the tree or open it in the editor first.' });
  }
  for (const r of recentEntries()) {
    if (r.dn === ui.selectedDn && r.profileId === ui.selectedProfileId) continue;
    const none = accessLevel(r.profileId) === 'none';
    out.push({
      key: r.profileId + ':' + r.dn,
      label: r.label || rdnValue(r.dn),
      detail: `${r.dn} · ${pname(r.profileId)}`,
      mention: { profileId: r.profileId, dn: r.dn },
      disabledReason: none ? 'The assistant has no access to this connection (level "none").' : undefined,
    });
  }
  const q = query.toLowerCase();
  return q ? out.filter((o) => o.label.toLowerCase().includes(q) || o.detail.toLowerCase().includes(q) || (o.key === 'entry' && 'entry'.startsWith(q))) : out;
}

/** The selected entry as the UI shows it (reactive version of selectedEntry()). */
function useSelectedEntry(): SelectedEntry | null {
  const tab = useEditorStore((s) => s.tabs.find((t) => t.id === s.activeTabId && t.dn && t.profileId));
  const treeSel = useTreeStore((s) => s.selectedNodes);
  const activePid = useConnectionStore((s) => s.activeProfileId);
  if (tab) return { profileId: tab.profileId, dn: tab.dn };
  if (treeSel.size === 1 && activePid) {
    const dn = treeSel.values().next().value ?? '';
    if (dn) return { profileId: activePid, dn };
  }
  return null;
}

type PwState = { scan: PasswordScan; reset: string | null } | null;

/**
 * Composer (§10.2): Enter sends, Shift+Enter adds a line, Esc stops, ↑ in an
 * empty input edits the last message; "/" opens commands, "@" mentions an
 * entry. A password next to a password word is never sent (A-13): the
 * composer offers the approval-card reset (LDAPilot generates the password)
 * or removes it; a plain word after a label ("PW: geheim"), a long
 * random-looking token or a password-shaped value left after a removal only
 * warns and can be sent as written. The entry selected
 * in the tree or editor is shown as a removable chip, since LDAPilot sends
 * it as context (A-18).
 */
export function Composer({ chatId, disabledReason }: { chatId: string | null; disabledReason?: string }) {
  const text = useAIStore((s) => s.composerText);
  const focusNonce = useAIStore((s) => s.composerFocus);
  const setText = useAIStore((s) => s.setComposerText);
  const editing = useAIStore((s) => s.editing);
  const run = useAIStore((s) => (chatId ? s.runs[chatId] : undefined));
  const config = useAIStore((s) => s.config);
  const modelPickerOpen = useAIStore((s) => s.modelPickerOpen);
  const s = useAIStore.getState;
  // Mentions live in the store so "Ask AI about this entry" can add them.
  const mentions = useAIStore((s) => s.composerMentions);
  const setMentions = useAIStore((s) => s.setComposerMentions);
  const [cmdIndex, setCmdIndex] = useState(0);
  const [cmdDismissed, setCmdDismissed] = useState(false);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const prevChat = useRef(chatId);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [pw, setPw] = useState<PwState>(null);
  const [sending, setSending] = useState(false);
  /** the text the user chose "Send anyway" for (a retry after a failed provider check keeps that choice) */
  const allowedText = useRef<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  /** the "@" button keeps the mention list open although the textarea blurs for a moment */
  const keepMentions = useRef(false);
  const preflight = useAIStore((s) => (s.preflight && s.preflight.chatId === (chatId ?? s.activeChatId) ? s.preflight : null));
  const checking = useAIStore((s) => s.preflightChecking);
  const stoppedHere = useAIStore((s) => !!chatId && s.preflightStopped === chatId);
  const selected = useSelectedEntry();
  const dismissed = useAIStore((s) => s.selectionDismissed);
  const profiles = useConnectionStore((s) => s.profiles);

  const running = runActive(run);
  const bytes = utf8Length(text);
  const tooLarge = bytes > MAX_MESSAGE_BYTES;
  const commands = matchCommands(text);
  const options = useMemo(() => (mentionQuery !== null ? mentionOptions(mentionQuery) : []), [mentionQuery]);
  const dest = config ? classifyDestination(config) : null;
  const showCommands = commands.length > 0 && !text.includes(' ') && !cmdDismissed;
  const showMentions = mentionQuery !== null && options.length > 0;

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.focus();
    // A suggestion with a placeholder ("List the members of …"): select it
    // so typing replaces it (A-11).
    const i = el.value.indexOf('…');
    if (i >= 0) el.setSelectionRange(i, i + 1);
  }, [focusNonce, chatId]);

  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 220) + 'px';
  }, [text]);

  useEffect(() => setCmdIndex(0), [commands.length]);
  useEffect(() => setCmdDismissed(false), [text]);
  // Highlight the first usable mention (@entry is disabled without a selection).
  useEffect(() => {
    const i = options.findIndex((o) => o.mention && !o.disabledReason);
    setMentionIndex(i >= 0 ? i : 0);
  }, [options]);
  useEffect(() => setPw(null), [text]);
  // Mentions belong to the chat they were made in: drop them when the user
  // switches chats or finishes editing (not on mount: "Ask AI" may have
  // added them before the panel was shown).
  const prevEditing = useRef(editing);
  useEffect(() => {
    const switched = prevChat.current !== chatId && prevChat.current !== null;
    const editEnded = prevEditing.current !== null && editing === null;
    prevChat.current = chatId;
    prevEditing.current = editing;
    // "Ask AI about …" may have opened a new chat for its mentions.
    if ((switched && useAIStore.getState().composerMentionsChat !== chatId) || editEnded) setMentions([]);
  }, [editing, chatId, setMentions]);

  /** Esc in the @ list: a bare "@" (typed or from the @ button) goes again (S4: it stayed in the input). */
  const removeBareAt = () => {
    const next = dropBareAt(text, ta.current?.selectionStart ?? text.length);
    if (!next) return;
    setText(next.text);
    requestAnimationFrame(() => ta.current?.setSelectionRange(next.caret, next.caret));
  };

  const updateMentionQuery = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    setMentionQuery(m ? m[2] : null);
  };

  const pickMention = (o: MentionOption) => {
    if (!o.mention || o.disabledReason) return;
    const el = ta.current;
    const caret = el?.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/(^|\s)@[^\s@]*$/, '$1');
    setText(before + text.slice(caret));
    if (!mentions.some((x) => x.dn === o.mention!.dn && x.profileId === o.mention!.profileId)) setMentions([...mentions, o.mention]);
    setMentionQuery(null);
    requestAnimationFrame(() => ta.current?.focus());
  };

  /**
   * Sends the composer's current text. allow = "Send anyway" for a warning
   * that is not a sure password; force = without the provider check. The
   * provider alert's buttons call this too, so they send what the composer
   * shows now (never an older text) and the password scan runs again.
   */
  const submit = async (allow = false, force = false) => {
    const t = stripBareAt(text);
    if (!t || sending || running || tooLarge || disabledReason) return;
    if (!editing && t.startsWith('/') && (await runSlashCommand(t))) return;
    if (allow) allowedText.current = t;
    const allowed = allowedText.current === t;
    const scan = scanPasswords(t);
    // A sure password is never sent; a plain word after a label, a long
    // random token (maybe an ID) or a leftover only warns.
    if (scan.matches.some((m) => m.sure) || (!allowed && (scan.matches.length > 0 || scan.weak || scan.leftover))) {
      setPw({ scan, reset: resetRequest(t, scan) });
      return;
    }
    setSending(true);
    try {
      const ok = editing ? await s().editLast(t, mentions, force) : await s().send(t, mentions, force);
      if (ok) {
        setPw(null);
        allowedText.current = null;
      }
    } finally {
      setSending(false);
    }
  };

  /** Try again / Send anyway of the provider alert: a send or edit repeats with the current text. */
  const retryPreflight = (force: boolean) => {
    const pf = s().preflight;
    if (pf && (pf.kind === 'send' || pf.kind === 'edit')) {
      s().clearPreflight();
      if (stripBareAt(text)) void submit(false, force);
      else ta.current?.focus();
      return;
    }
    void s().retryPreflight(force);
  };

  /** Replaces the composer text (the user then reviews and sends it). */
  const replaceText = (next: string) => {
    setText(next);
    setPw(null);
    requestAnimationFrame(() => {
      const el = ta.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.length, next.length);
    });
  };

  const selKey = selected ? selectionKey(selected) : '';
  const selMentioned = !!selected && mentions.some((m) => m.profileId === selected.profileId && dnKey(m.dn) === dnKey(selected.dn));
  const selDismissed = !!selected && dismissed === selKey;
  const selNone = !!selected && accessLevel(selected.profileId) === 'none';
  const selConn = selected ? profiles.find((p) => p.id === selected.profileId)?.name ?? '' : '';

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (mentionQuery !== null && options.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => (i + 1) % options.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => (i - 1 + options.length) % options.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(options[mentionIndex]); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (mentionQuery === '') removeBareAt(); setMentionQuery(null); return; }
    }
    if (showCommands) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIndex((i) => (i + 1) % commands.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIndex((i) => (i - 1 + commands.length) % commands.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && text.trim() !== commands[cmdIndex].name)) {
        e.preventDefault();
        const c = commands[cmdIndex];
        setText(c.args ? c.name + ' ' : c.name);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setText(''); return; }
    }
    if (pw && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setPw(null); return; }
    if (e.key === 'Escape' && editing) { e.preventDefault(); e.stopPropagation(); s().cancelEdit(); return; }
    if (e.key === 'ArrowUp' && !text && !running) {
      if (s().startEditLast()) e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const disabled = !!disabledReason;

  return (
    <div className="shrink-0 border-t border-border p-2" data-ai-composer>
      {editing && (
        <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
          <Pencil size={11} /> Editing your last message; sending replaces it and the answer.
          <Button size="sm" variant="secondary" className="ml-auto" onClick={() => s().cancelEdit()}>Cancel</Button>
        </div>
      )}
      {checking && !preflight && (
        <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground" role="status">
          <Loader2 size={12} className="animate-spin" aria-hidden /> Checking the AI provider at {checking} before sending… (Esc stops)
        </div>
      )}
      {stoppedHere && !checking && !preflight && (
        <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground" role="status">
          Stopped; the message was not sent and is still in the input.
          <IconButton size="sm" icon={X} label="Dismiss" className="ml-auto" onClick={() => useAIStore.setState({ preflightStopped: null })} />
        </div>
      )}
      {preflight && (
        <InlineAlert
          tone="danger"
          className="mb-1 text-xs"
          title={preflight.title}
          body={
            <>
              <div className="[overflow-wrap:anywhere]">{preflight.message}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                <Button size="sm" variant="primary" onClick={() => retryPreflight(false)}>Try again</Button>
                <Button size="sm" variant="secondary" leftIcon={Settings} onClick={() => { s().clearPreflight(); s().setView('settings'); }}>AI settings</Button>
                <Button size="sm" variant="ghost" title="Send without the check; the answer fails if the provider is really unreachable" onClick={() => retryPreflight(true)}>Send anyway</Button>
              </div>
            </>
          }
          onDismiss={() => s().clearPreflight()}
        />
      )}
      {pw && pw.scan.matches.some((m) => m.sure) && (
        <InlineAlert
          tone="warning"
          className="mb-1 text-xs"
          title="Passwords are not sent to the assistant"
          body={
            <>
              <div>
                Your message contains a password ({pw.scan.matches.map((m) => hintOf(stripBareAt(text), m)).join(', ')}). LDAPilot can reset the password instead: it
                generates a new one on this computer and shows it only to you, after you approve the change.
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {pw.reset && (
                  <Button size="sm" variant="primary" leftIcon={KeyRound} title={pw.reset} onClick={() => replaceText(pw.reset!)}>Reset with a generated password</Button>
                )}
                <Button size="sm" variant={pw.reset ? 'secondary' : 'primary'} onClick={() => replaceText(removePasswords(stripBareAt(text)))}>Remove the password</Button>
                <Button size="sm" variant="ghost" onClick={() => { setPw(null); ta.current?.focus(); }}>Edit</Button>
              </div>
            </>
          }
        />
      )}
      {pw && pw.scan.matches.length > 0 && !pw.scan.matches.some((m) => m.sure) && (
        <InlineAlert
          tone="warning"
          className="mb-1 text-xs"
          title="This may be a password"
          body={
            <>
              <div>
                {pw.scan.matches.map((m) => `“${stripBareAt(text).slice(m.keywordStart, m.keywordEnd)}: ${hintOf(stripBareAt(text), m)}”`).join(', ')} looks like a
                password. Passwords are not sent to the assistant; remove it, or send the message as written if it is not one.
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                <Button size="sm" variant="primary" onClick={() => replaceText(removePasswords(stripBareAt(text)))}>Remove it</Button>
                <Button size="sm" variant="ghost" onClick={() => { setPw(null); ta.current?.focus(); }}>Edit</Button>
                <Button size="sm" variant="secondary" onClick={() => void submit(true)}>Send as written</Button>
              </div>
            </>
          }
        />
      )}
      {pw && pw.scan.matches.length === 0 && (pw.scan.weak || pw.scan.leftover) && (
        <InlineAlert
          tone="warning"
          className="mb-1 text-xs"
          body={
            <>
              <div>
                {pw.scan.leftover
                  ? 'A password was removed from this message, but it still contains a value that may be one.'
                  : 'Your message contains a long random-looking value that may be a password.'}{' '}
                It will be sent to <b>{dest?.host || 'the AI provider'}</b>{dest && !dest.local ? ' (remote)' : ''}.
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                <Button size="sm" variant="secondary" onClick={() => replaceText(maskAllPasswords(stripBareAt(text)))}>Remove it</Button>
                <Button size="sm" variant="ghost" onClick={() => { setPw(null); ta.current?.focus(); }}>Edit</Button>
                <Button size="sm" variant="primary" onClick={() => void submit(true)}>Send anyway</Button>
              </div>
            </>
          }
        />
      )}
      {selected && !selMentioned && !editing && (
        <div className="mb-1 flex flex-wrap gap-1">
          {selDismissed ? (
            <button type="button"
              className="inline-flex items-center gap-1 rounded border border-dashed border-border px-1.5 text-xs text-muted-foreground hover:text-foreground"
              title={`Send ${selected.dn} as the selected entry again`}
              onClick={() => s().dismissSelection(null)}
            >
              <Plus size={10} aria-hidden /> selected entry
            </button>
          ) : (
            <Badge
              appearance="outline"
              icon={MousePointerClick}
              className={cn(selNone && 'text-muted-foreground')}
              title={selNone
                ? `${selected.dn} — not shared: the assistant has no access to ${selConn || 'this connection'} (level "none")`
                : `${selected.dn}${selConn ? ` · ${selConn}` : ''} — sent as the selected entry; the assistant uses it for "this user" or "here"`}
            >
              {selNone ? 'not shared: ' : 'selected: '}{rdnValue(selected.dn)}
              <button type="button" className="text-muted-foreground hover:text-foreground" aria-label={`Do not send the selected entry ${rdnValue(selected.dn)}`} onClick={() => s().dismissSelection(selected)}>
                <X size={10} aria-hidden />
              </button>
            </Badge>
          )}
        </div>
      )}
      {mentions.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1">
          {mentions.map((m) => (
            <Badge key={m.profileId + m.dn} appearance="outline" icon={AtSign} title={m.dn}>
              {rdnValue(m.dn)}
              <button type="button" className="text-muted-foreground hover:text-foreground" aria-label={`Remove mention ${rdnValue(m.dn)}`} onClick={() => setMentions(mentions.filter((x) => x !== m))}>
                <X size={10} aria-hidden />
              </button>
            </Badge>
          ))}
        </div>
      )}

      <div>
        <Popover
          open={showCommands}
          onOpenChange={(o) => !o && setCmdDismissed(true)}
          anchor={box}
          placement="top-start"
          matchWidth
          autoFocus={false}
          restoreFocus={false}
          role="listbox"
          aria-label="Commands"
          className="py-1 text-xs"
        >
          <div data-ai-popup>
            {commands.map((c, i) => (
              <button type="button"
                key={c.name}
                role="option"
                tabIndex={-1}
                aria-selected={i === cmdIndex}
                className={cn('flex w-full gap-2 px-2 py-0.5 text-left hover:bg-accent', i === cmdIndex && 'bg-accent')}
                onMouseDown={(e) => { e.preventDefault(); setText(c.args ? c.name + ' ' : c.name); ta.current?.focus(); }}
              >
                <span className="font-mono">{c.name}{c.args ? ' ' + c.args : ''}</span>
                <span className="text-muted-foreground">{c.description}</span>
              </button>
            ))}
          </div>
        </Popover>
        <Popover
          open={showMentions}
          onOpenChange={(o) => !o && setMentionQuery(null)}
          anchor={box}
          placement="top-start"
          matchWidth
          autoFocus={false}
          restoreFocus={false}
          role="listbox"
          aria-label="Mention an entry"
          className="max-h-56 py-1 text-xs"
        >
          <div data-ai-popup>
            {options.map((o, i) => (
              <button type="button"
                key={o.key}
                role="option"
                tabIndex={-1}
                aria-selected={i === mentionIndex}
                aria-disabled={!!o.disabledReason || !o.mention}
                title={o.disabledReason ?? o.detail}
                className={cn('flex w-full items-center gap-1.5 px-2 py-0.5 text-left hover:bg-accent', i === mentionIndex && 'bg-accent', (o.disabledReason || !o.mention) && 'text-disabled-foreground')}
                onMouseDown={(e) => { e.preventDefault(); pickMention(o); }}
              >
                {o.key === 'entry' ? <AtSign size={11} /> : <FileText size={11} />}
                <span className="shrink-0">{o.label}</span>
                <span className="truncate text-muted-foreground">{o.detail}</span>
              </button>
            ))}
          </div>
        </Popover>
        {chatId && <ModelPicker chatId={chatId} open={modelPickerOpen} anchor={box} onClose={() => s().setModelPickerOpen(false)} />}

        <div ref={setBox} className={cn('flex items-end gap-1 rounded border border-border bg-input px-1.5 py-1 focus-within:ring-1 focus-within:ring-ring', disabled && 'opacity-60')}>
          <textarea
            ref={ta}
            rows={1}
            value={text}
            disabled={disabled}
            placeholder={disabledReason ?? (running ? 'The assistant is answering… (Esc stops)' : checking ? 'Checking the AI provider… (Esc stops)' : 'Ask about your directory… (/ for commands, @ to mention an entry)')}
            aria-label="Message to the assistant"
            className="max-h-[220px] min-h-[22px] flex-1 resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            onChange={(e) => {
              setText(e.target.value);
              if (stoppedHere) useAIStore.setState({ preflightStopped: null });
              updateMentionQuery(e.target.value, e.target.selectionStart ?? e.target.value.length);
            }}
            onKeyDown={onKeyDown}
            onBlur={() => setTimeout(() => {
              // The "@" button opens the list while it holds the focus for a
              // moment; only a real blur closes it (A-14).
              if (keepMentions.current || document.activeElement === ta.current) return;
              setMentionQuery(null);
            }, 150)}
          />
          <IconButton
            icon={AtSign}
            label="Mention an entry (@)"
            disabled={disabled}
            onMouseDown={(e) => {
              // keep the focus (and the caret) in the textarea
              e.preventDefault();
              keepMentions.current = true;
            }}
            onClick={() => {
              const el = ta.current;
              const next = text && !/\s$/.test(text) ? text + ' @' : text + '@';
              setText(next);
              setMentionQuery('');
              el?.focus();
              requestAnimationFrame(() => {
                el?.setSelectionRange(next.length, next.length);
                keepMentions.current = false;
              });
            }}
          />
          {running ? (
            <IconButton icon={Square} label="Stop the answer" shortcut="Escape" className={tone.dangerText} onClick={() => void s().stop(chatId ?? undefined)} />
          ) : checking ? (
            // The check before a send can take the dial timeout (~18 s, P4).
            <IconButton icon={Square} label="Stop: do not send" shortcut="Escape" className={tone.dangerText} onClick={() => s().cancelPreflight()} />
          ) : (
            <IconButton
              icon={Send}
              label={editing ? 'Send edited message' : 'Send message'}
              shortcut={editing ? undefined : 'Enter'}
              className={cn(text.trim() && !tooLarge && 'text-primary')}
              disabled={!text.trim() || tooLarge || sending || disabled}
              onClick={() => void submit()}
            />
          )}
        </div>
      </div>
      {bytes > MAX_MESSAGE_BYTES * 0.8 && (
        <div className={cn('mt-0.5 text-right text-xs', tooLarge ? tone.dangerText : 'text-muted-foreground')}>
          {Math.round(bytes / 1024)} / 64 KB{tooLarge ? ' — too long to send' : ''}
        </div>
      )}
    </div>
  );
}
