import { useState, useRef, useEffect, useCallback } from 'react'
import { Bot, Send, Trash2, Loader2, AlertCircle, Settings, Eye, EyeOff, Plus, ChevronDown, MessageSquare, Pencil } from 'lucide-react'
import { useConnectionStore } from '../../stores/connectionStore'
import {
  ListChats,
  GetChat,
  CreateChat,
  DeleteChat,
  RenameChat,
  AIChat as AIChatAPI,
  GetAIConfig,
  SaveAIConfig,
  ListAIModels,
} from '../../lib/wails'
import type { AIConfig, ChatConversation, ChatMsg } from '../../lib/wails'
import { cn } from '../../lib/utils'
import { toast } from '../ui/Toast'

const PROVIDERS = [
  { value: 'litellm', label: 'LiteLLM', defaultUrl: 'https://your-litellm-server.com', defaultModel: 'gpt-4o' },
  { value: 'ollama', label: 'Ollama', defaultUrl: 'http://localhost:11434', defaultModel: 'llama3.1' },
  { value: 'openai', label: 'OpenAI', defaultUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o' },
];

/** Simple markdown-to-HTML renderer using regex replacements. */
function renderMarkdown(text: string): string {
  let html = text
    // Escape HTML entities
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  // Code blocks (triple backtick)
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code) => {
    return `<pre class="bg-background/80 rounded px-2 py-1.5 my-1 overflow-x-auto text-[11px] font-mono whitespace-pre-wrap">${code.trim()}</pre>`
  })

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="bg-background/80 rounded px-1 py-0.5 text-[11px] font-mono">$1</code>')

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')

  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')

  // Unordered list items
  html = html.replace(/^[\t ]*[-*] (.+)$/gm, '<li class="ml-3 list-disc">$1</li>')

  // Ordered list items
  html = html.replace(/^[\t ]*\d+\. (.+)$/gm, '<li class="ml-3 list-decimal">$1</li>')

  // Line breaks (double newline = paragraph break, single = <br>)
  html = html.replace(/\n\n/g, '</p><p class="mt-1.5">')
  html = html.replace(/\n/g, '<br/>')

  // Wrap in paragraph
  html = `<p>${html}</p>`

  return html
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp * 1000 // timestamps from backend are in seconds
  if (diff < 0) return 'just now'
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

export function AIChatPanel() {
  // Chat list and selection state
  const [chatList, setChatList] = useState<ChatConversation[]>([])
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([])
  const [chatListOpen, setChatListOpen] = useState(false)
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [chatListLoading, setChatListLoading] = useState(true)

  // Input and messaging state
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Settings state
  const [showSettings, setShowSettings] = useState(false)
  const [aiConfig, setAiConfig] = useState<AIConfig | null>(null)
  const [configLoaded, setConfigLoaded] = useState(false)

  // Connection state - check if ANY server is connected
  const connectionStatuses = useConnectionStore((s) => s.connectionStatuses)
  const hasAnyConnection = Object.values(connectionStatuses).some((status) => status === true)

  const isConfigured = aiConfig && aiConfig.url !== ''

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const chatListRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Find active chat object
  const activeChat = chatList.find((c) => c.id === activeChatId) || null

  // Load AI config and chat list on mount
  useEffect(() => {
    GetAIConfig().then((cfg) => {
      setAiConfig(cfg)
      setConfigLoaded(true)
      if (!cfg.url) setShowSettings(true)
    })
    loadChatList()
  }, [])

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px'
    }
  }, [input])

  // Close dropdown on click outside or Escape
  useEffect(() => {
    if (!chatListOpen) return

    function handleClickOutside(e: MouseEvent) {
      if (chatListRef.current && !chatListRef.current.contains(e.target as Node)) {
        setChatListOpen(false)
      }
    }

    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setChatListOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [chatListOpen])

  // Focus rename input when renaming starts
  useEffect(() => {
    if (renamingChatId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingChatId])

  async function loadChatList() {
    setChatListLoading(true)
    try {
      const chats = await ListChats()
      if (!chats || chats.length === 0) {
        // No chats exist, create one automatically
        const newChat = await CreateChat('New Chat')
        setChatList([newChat])
        setActiveChatId(newChat.id)
        setMessages([])
      } else {
        // Sort by updatedAt descending
        const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt)
        setChatList(sorted)
        // Select the most recent chat
        await selectChat(sorted[0].id, sorted)
      }
    } catch (err: any) {
      console.error('Failed to load chats:', err)
      // Fallback: try to create a new chat
      try {
        const newChat = await CreateChat('New Chat')
        setChatList([newChat])
        setActiveChatId(newChat.id)
        setMessages([])
      } catch {
        // Complete failure
      }
    }
    setChatListLoading(false)
  }

  async function selectChat(chatId: string, knownList?: ChatConversation[]) {
    setActiveChatId(chatId)
    setError(null)
    try {
      const chat = await GetChat(chatId)
      if (chat && chat.messages) {
        // Filter to only user and assistant messages
        const filtered = chat.messages.filter(
          (m: ChatMsg) => m.role === 'user' || m.role === 'assistant'
        )
        setMessages(filtered)
      } else {
        setMessages([])
      }
    } catch {
      setMessages([])
    }
    setChatListOpen(false)
  }

  async function handleNewChat() {
    try {
      const newChat = await CreateChat('New Chat')
      const updated = [newChat, ...chatList]
      setChatList(updated)
      setActiveChatId(newChat.id)
      setMessages([])
      setError(null)
      setChatListOpen(false)
    } catch (err: any) {
      toast.error('Failed to create chat', err?.message)
    }
  }

  async function handleDeleteChat(chatId: string, e: React.MouseEvent) {
    e.stopPropagation()
    try {
      await DeleteChat(chatId)
      const remaining = chatList.filter((c) => c.id !== chatId)
      if (remaining.length === 0) {
        // No chats left, create a new one
        const newChat = await CreateChat('New Chat')
        setChatList([newChat])
        setActiveChatId(newChat.id)
        setMessages([])
      } else {
        setChatList(remaining)
        // If we deleted the active chat, switch to the first remaining
        if (activeChatId === chatId) {
          await selectChat(remaining[0].id, remaining)
        }
      }
    } catch (err: any) {
      toast.error('Failed to delete chat', err?.message)
    }
  }

  function startRename(chatId: string, currentTitle: string, e: React.MouseEvent) {
    e.stopPropagation()
    setRenamingChatId(chatId)
    setRenameValue(currentTitle)
  }

  async function commitRename() {
    if (!renamingChatId || !renameValue.trim()) {
      setRenamingChatId(null)
      return
    }
    try {
      await RenameChat(renamingChatId, renameValue.trim())
      setChatList((prev) =>
        prev.map((c) =>
          c.id === renamingChatId ? { ...c, title: renameValue.trim() } : c
        )
      )
    } catch (err: any) {
      toast.error('Failed to rename chat', err?.message)
    }
    setRenamingChatId(null)
  }

  function handleRenameKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitRename()
    } else if (e.key === 'Escape') {
      setRenamingChatId(null)
    }
  }

  const handleSend = useCallback(async () => {
    if (!input.trim() || !activeChatId || loading) return

    const userMsg = { role: 'user', content: input.trim() }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setLoading(true)
    setError(null)

    try {
      const response = await AIChatAPI(activeChatId, userMsg.content)
      const assistantMsg = { role: 'assistant', content: response }
      setMessages((prev) => [...prev, assistantMsg])

      // Refresh chat list because the backend may have auto-updated the title
      try {
        const chats = await ListChats()
        if (chats && chats.length > 0) {
          const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt)
          setChatList(sorted)
        }
      } catch {
        // Non-critical
      }
    } catch (err: any) {
      setError(err?.message || String(err) || 'Failed to get response')
    } finally {
      setLoading(false)
    }
  }, [input, activeChatId, loading])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  if (!hasAnyConnection) {
    return (
      <div className="h-full flex flex-col bg-sidebar">
        <div className="flex items-center px-4 h-9 shrink-0 border-b border-border">
          <span className="text-xs font-semibold uppercase tracking-wider text-secondary-foreground">
            AI Chat
          </span>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-4">
          <Bot size={48} strokeWidth={1} className="mb-4 opacity-40" />
          <p className="text-sm text-center">Connect to a server to use AI Chat</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-sidebar">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-9 shrink-0 border-b border-border">
        <span className="text-xs font-semibold uppercase tracking-wider text-secondary-foreground">
          AI Chat
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={cn(
              'p-1 rounded',
              showSettings ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
            )}
            title="AI Settings"
          >
            <Settings size={12} />
          </button>
        </div>
      </div>

      {/* Chat Selector Bar */}
      <div className="relative shrink-0 border-b border-border" ref={chatListRef}>
        <div className="flex items-center gap-1 px-2 py-1.5">
          {/* Chat selector button */}
          <button
            onClick={() => setChatListOpen(!chatListOpen)}
            className={cn(
              'flex-1 flex items-center gap-1.5 min-w-0 px-2 py-1 rounded text-xs',
              'hover:bg-accent transition-colors text-left',
              chatListOpen && 'bg-accent'
            )}
          >
            <MessageSquare size={12} className="shrink-0 text-muted-foreground" />
            <span className="truncate text-foreground">
              {chatListLoading ? 'Loading...' : activeChat?.title || 'No chat selected'}
            </span>
            <ChevronDown
              size={10}
              className={cn(
                'shrink-0 text-muted-foreground transition-transform',
                chatListOpen && 'rotate-180'
              )}
            />
          </button>

          {/* New chat button */}
          <button
            onClick={handleNewChat}
            className="shrink-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            title="New Chat"
          >
            <Plus size={14} />
          </button>
        </div>

        {/* Chat list dropdown */}
        {chatListOpen && (
          <div className="absolute left-0 right-0 top-full z-50 bg-popover border border-border rounded-b-md shadow-lg max-h-[60vh] overflow-auto">
            {/* New Chat option at top */}
            <button
              onClick={handleNewChat}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-accent transition-colors border-b border-border text-primary"
            >
              <Plus size={12} />
              New Chat
            </button>

            {chatList.length === 0 && !chatListLoading && (
              <div className="px-3 py-4 text-xs text-muted-foreground text-center">
                No chats yet
              </div>
            )}

            {chatList.map((chat) => (
              <div
                key={chat.id}
                className={cn(
                  'group flex items-center gap-1 px-3 py-1.5 cursor-pointer transition-colors',
                  chat.id === activeChatId
                    ? 'bg-accent/70'
                    : 'hover:bg-accent/50'
                )}
                onClick={() => selectChat(chat.id)}
              >
                {renamingChatId === chat.id ? (
                  <input
                    ref={renameInputRef}
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={handleRenameKeyDown}
                    onBlur={commitRename}
                    onClick={(e) => e.stopPropagation()}
                    className="flex-1 text-xs bg-background border border-border rounded px-1.5 py-0.5 outline-none focus:border-primary min-w-0"
                  />
                ) : (
                  <div
                    className="flex-1 min-w-0"
                    onDoubleClick={(e) => startRename(chat.id, chat.title, e)}
                  >
                    <div className="text-xs text-foreground truncate">{chat.title}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {formatRelativeTime(chat.updatedAt)}
                    </div>
                  </div>
                )}

                {/* Action buttons - visible on hover */}
                {renamingChatId !== chat.id && (
                  <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => startRename(chat.id, chat.title, e)}
                      className="p-0.5 rounded text-muted-foreground hover:text-foreground"
                      title="Rename"
                    >
                      <Pencil size={10} />
                    </button>
                    <button
                      onClick={(e) => handleDeleteChat(chat.id, e)}
                      className="p-0.5 rounded text-muted-foreground hover:text-destructive"
                      title="Delete"
                    >
                      <Trash2 size={10} />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Settings Panel */}
      {showSettings && (
        <AISettingsPanel
          config={aiConfig}
          onSave={async (cfg) => {
            try {
              await SaveAIConfig(cfg)
              const updated = await GetAIConfig()
              setAiConfig(updated)
              setShowSettings(false)
              toast.success('AI settings saved')
            } catch (err: any) {
              toast.error('Failed to save settings', err?.message)
            }
          }}
          onCancel={() => setShowSettings(false)}
        />
      )}

      {/* Messages area */}
      <div className="flex-1 overflow-auto p-3 space-y-3">
        {!isConfigured && !showSettings && configLoaded && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Settings size={36} strokeWidth={1} className="mb-3 opacity-40" />
            <p className="text-xs text-center leading-relaxed px-2">
              Configure an AI provider to start chatting.
            </p>
            <button
              onClick={() => setShowSettings(true)}
              className="mt-3 text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90"
            >
              Configure AI
            </button>
          </div>
        )}
        {isConfigured && messages.length === 0 && !loading && !showSettings && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Bot size={36} strokeWidth={1} className="mb-3 opacity-40" />
            <p className="text-xs text-center leading-relaxed px-2">
              Ask me about your directory. I can search, read entries, and answer questions across all connected servers. I can only read, never modify.
            </p>
          </div>
        )}

        {messages.map((msg, idx) => (
          <div
            key={idx}
            className={cn(
              'flex',
              msg.role === 'user' ? 'justify-end' : 'justify-start'
            )}
          >
            <div
              className={cn(
                'max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed',
                msg.role === 'user'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-card border border-border text-card-foreground'
              )}
            >
              {msg.role === 'assistant' ? (
                <div
                  className="prose-sm [&_pre]:my-1 [&_li]:my-0.5 [&_p]:my-0"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
                />
              ) : (
                <span className="whitespace-pre-wrap">{msg.content}</span>
              )}
            </div>
          </div>
        ))}

        {/* Loading indicator */}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-card border border-border rounded-lg px-3 py-2 text-xs text-muted-foreground flex items-center gap-2">
              <Loader2 size={12} className="animate-spin" />
              Thinking...
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="flex items-center gap-2 text-xs px-3 py-2 rounded bg-destructive/10 text-destructive">
            <AlertCircle size={14} className="shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t border-border p-2">
        <div className="flex items-end gap-1.5">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about your directory..."
            className="input-field flex-1 resize-none min-h-[32px] max-h-[120px] text-xs py-1.5"
            rows={1}
            disabled={loading}
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || loading || !activeChatId}
            className={cn(
              'shrink-0 p-1.5 rounded',
              'bg-primary text-primary-foreground',
              'hover:bg-primary/90',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'transition-colors'
            )}
            title="Send (Enter)"
          >
            <Send size={14} />
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground mt-1 px-0.5">
          Enter to send, Shift+Enter for newline
          {aiConfig?.provider && (
            <span className="float-right opacity-60">
              {aiConfig.provider}{aiConfig.model ? ` / ${aiConfig.model}` : ''}
            </span>
          )}
        </p>
      </div>
    </div>
  )
}

function AISettingsPanel({
  config,
  onSave,
  onCancel,
}: {
  config: AIConfig | null;
  onSave: (cfg: AIConfig) => void;
  onCancel: () => void;
}) {
  const [provider, setProvider] = useState(config?.provider || 'litellm')
  const [url, setUrl] = useState(config?.url || '')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(config?.model || '')
  const [showKey, setShowKey] = useState(false)
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const hasExistingKey = config?.hasKey ?? false

  const selectedProvider = PROVIDERS.find(p => p.value === provider) || PROVIDERS[0]

  async function fetchModels() {
    setLoadingModels(true)
    try {
      // Save current config first so the backend can use it to fetch models
      await SaveAIConfig({ provider, url: url.trim(), apiKey, model: model.trim(), hasKey: false })
      const models = await ListAIModels()
      setAvailableModels(models || [])
      if (models.length === 0) toast.error('No models found')
    } catch (err: any) {
      toast.error('Failed to fetch models', err?.message)
      setAvailableModels([])
    }
    setLoadingModels(false)
  }

  function handleSave() {
    if (!url.trim()) {
      toast.error('URL is required')
      return
    }
    onSave({
      provider,
      url: url.trim(),
      apiKey: apiKey, // empty = keep existing
      model: model.trim(),
      hasKey: false,
    })
  }

  return (
    <div className="border-b border-border bg-card/50 p-3 space-y-3">
      <div className="text-xs font-semibold text-foreground">AI Provider Settings</div>

      {/* Provider */}
      <div>
        <label className="block text-[10px] text-muted-foreground mb-0.5">Provider</label>
        <select
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value)
            const p = PROVIDERS.find(pr => pr.value === e.target.value)
            if (p && !url) setUrl(p.defaultUrl)
            if (p && !model) setModel(p.defaultModel)
          }}
          className="input-field text-xs"
        >
          {PROVIDERS.map(p => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
      </div>

      {/* URL */}
      <div>
        <label className="block text-[10px] text-muted-foreground mb-0.5">URL</label>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={selectedProvider.defaultUrl}
          className="input-field text-xs"
        />
      </div>

      {/* API Key */}
      <div>
        <label className="block text-[10px] text-muted-foreground mb-0.5">
          API Key
          {hasExistingKey && !apiKey && (
            <span className="text-green-400 ml-1">(configured)</span>
          )}
        </label>
        <div className="flex gap-1">
          <input
            type={showKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={hasExistingKey ? 'Leave empty to keep existing key' : 'Enter API key'}
            className="input-field text-xs flex-1"
          />
          <button
            onClick={() => setShowKey(!showKey)}
            className="p-1 text-muted-foreground hover:text-foreground"
          >
            {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        </div>
      </div>

      {/* Model */}
      <div>
        <label className="block text-[10px] text-muted-foreground mb-0.5">Model</label>
        <div className="flex gap-1">
          {availableModels.length > 0 ? (
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="input-field text-xs flex-1"
            >
              {!model && <option value="">Select a model...</option>}
              {availableModels.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={selectedProvider.defaultModel}
              className="input-field text-xs flex-1"
            />
          )}
          <button
            onClick={fetchModels}
            disabled={!url.trim() || loadingModels}
            className="px-2 py-1 text-[10px] rounded border border-border hover:bg-accent disabled:opacity-40 shrink-0 flex items-center gap-1"
            title="Fetch available models from server"
          >
            {loadingModels ? <Loader2 size={10} className="animate-spin" /> : <Settings size={10} />}
            Models
          </button>
        </div>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-1.5">
        <button
          onClick={onCancel}
          className="text-xs px-2.5 py-1 rounded border border-border hover:bg-accent"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          className="text-xs px-2.5 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90"
        >
          Save
        </button>
      </div>
    </div>
  )
}
