/**
 * Listbox / Combobox (SPEC 6.3): role=listbox/option with
 * aria-activedescendant. Combobox accepts static `items` or async
 * `loadOptions` (debounced 250 ms; stale requests are aborted and ignored).
 * Uses: Compare "Entry B", add-to-group, attribute picker, tab overflow, palette.
 */
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react'
import { Check } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Portal, useAnchoredPosition, useOverlayZ } from './layer'
import { useDismiss } from './useDismiss'
import { Input } from './Input'
import { Spinner } from './Spinner'
import { domId } from './dn'

export interface OptionState {
  active: boolean
  selected: boolean
}

export interface ListboxOptionsProps<T> {
  id: string
  items: T[]
  getKey: (item: T) => string
  getLabel: (item: T) => string
  renderItem?: (item: T, state: OptionState) => ReactNode
  activeKey: string | null
  onActiveChange: (key: string) => void
  selectedKeys?: Set<string> | string | null
  onChoose: (item: T) => void
  emptyText?: ReactNode
  loading?: boolean
  className?: string
  'aria-label'?: string
  /** Element id of the option for a key (for aria-activedescendant). */
  optionId?: (key: string) => string
  /** Make the list itself focusable (standalone Listbox). */
  focusable?: boolean
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void
  ref?: Ref<HTMLDivElement>
}

export const optionDomId = (listId: string, key: string) => `${listId}-o-${domId(key)}`

/** Presentational option list (shared by Listbox, Combobox and the palette). */
export function ListboxOptions<T>({
  id,
  items,
  getKey,
  getLabel,
  renderItem,
  activeKey,
  onActiveChange,
  selectedKeys,
  onChoose,
  emptyText = 'No matches',
  loading,
  className,
  optionId = (k) => optionDomId(id, k),
  focusable,
  onKeyDown,
  ref,
  ...aria
}: ListboxOptionsProps<T>) {
  const isSel = (k: string) => (selectedKeys instanceof Set ? selectedKeys.has(k) : selectedKeys === k)
  useEffect(() => {
    if (!activeKey) return
    document.getElementById(optionId(activeKey))?.scrollIntoView({ block: 'nearest' })
  }, [activeKey, optionId])
  return (
    <div
      ref={ref}
      id={id}
      role="listbox"
      tabIndex={focusable ? 0 : -1}
      aria-activedescendant={focusable && activeKey ? optionId(activeKey) : undefined}
      aria-busy={loading || undefined}
      onKeyDown={onKeyDown}
      className={cn(
        'group/lb py-1 overflow-y-auto outline-hidden',
        // A focusable list (aria-activedescendant) shows the focus frame itself, too.
        focusable && 'focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2',
        className,
      )}
      {...aria}
    >
      {items.map((item) => {
        const k = getKey(item)
        const active = k === activeKey
        const selected = isSel(k)
        return (
          <div
            key={k}
            id={optionId(k)}
            role="option"
            aria-selected={selected}
            data-active={active || undefined}
            onPointerMove={() => !active && onActiveChange(k)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onChoose(item)}
            className={cn(
              'flex items-center gap-2 min-h-6 mx-1 px-2 rounded-sm text-sm cursor-default select-none',
              active && 'bg-accent text-accent-foreground',
              active && focusable && 'group-focus-visible/lb:outline-2 group-focus-visible/lb:outline-focus group-focus-visible/lb:-outline-offset-2',
            )}
          >
            {renderItem ? (
              renderItem(item, { active, selected })
            ) : (
              <>
                <span className="w-3.5 shrink-0 flex justify-center">{selected && <Check size={14} strokeWidth={2} aria-hidden />}</span>
                <span className="flex-1 min-w-0 truncate">{getLabel(item)}</span>
              </>
            )}
          </div>
        )
      })}
      {loading && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground" role="status">
          <Spinner size="sm" decorative /> Searching…
        </div>
      )}
      {!loading && items.length === 0 && <div className="px-3 py-1.5 text-sm text-muted-foreground">{emptyText}</div>}
    </div>
  )
}

/** Moves the active key in a list (Up/Down/Home/End/PgUp/PgDn). Returns the new key or undefined if not handled. */
export function moveActive<T>(key: string, items: T[], getKey: (i: T) => string, active: string | null, page = 8): string | undefined {
  if (!items.length) return undefined
  const idx = active ? items.findIndex((i) => getKey(i) === active) : -1
  let n: number
  switch (key) {
    case 'ArrowDown': n = idx < 0 ? 0 : Math.min(items.length - 1, idx + 1); break
    case 'ArrowUp': n = idx < 0 ? items.length - 1 : Math.max(0, idx - 1); break
    case 'Home': n = 0; break
    case 'End': n = items.length - 1; break
    case 'PageDown': n = Math.min(items.length - 1, Math.max(idx, 0) + page); break
    case 'PageUp': n = Math.max(0, idx - page); break
    default: return undefined
  }
  return getKey(items[n])
}

export interface ListboxProps<T> {
  items: T[]
  getKey: (item: T) => string
  getLabel: (item: T) => string
  renderItem?: (item: T, state: OptionState) => ReactNode
  value?: string | null
  onValueChange?: (key: string, item: T) => void
  /** Enter / double-click. */
  onActivate?: (item: T) => void
  emptyText?: ReactNode
  className?: string
  'aria-label'?: string
  'aria-labelledby'?: string
}

/** Standalone focusable single-select list (type-ahead, aria-activedescendant). */
export function Listbox<T>({ items, getKey, getLabel, renderItem, value = null, onValueChange, onActivate, emptyText, className, ...aria }: ListboxProps<T>) {
  const id = `lb${useId().replace(/:/g, '')}`
  const [active, setActive] = useState<string | null>(value)
  const ta = useRef({ buf: '', t: 0 })
  useEffect(() => {
    if (value !== null) setActive(value)
  }, [value])
  const choose = (item: T) => {
    const k = getKey(item)
    setActive(k)
    onValueChange?.(k, item)
  }
  return (
    <ListboxOptions
      id={id}
      focusable
      items={items}
      getKey={getKey}
      getLabel={getLabel}
      renderItem={renderItem}
      activeKey={active}
      onActiveChange={setActive}
      selectedKeys={value}
      onChoose={choose}
      emptyText={emptyText}
      className={cn('max-h-60 border border-border-strong rounded bg-input', className)}
      {...aria}
      onKeyDown={(e) => {
        const next = moveActive(e.key, items, getKey, active)
        if (next !== undefined) {
          e.preventDefault()
          setActive(next)
          const it = items.find((i) => getKey(i) === next)
          if (it) onValueChange?.(next, it)
          return
        }
        const cur = items.find((i) => getKey(i) === active)
        if ((e.key === 'Enter' || e.key === ' ') && cur) {
          e.preventDefault()
          choose(cur)
          if (e.key === 'Enter') onActivate?.(cur)
          return
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const now = Date.now()
          ta.current.buf = now - ta.current.t > 500 ? e.key.toLowerCase() : ta.current.buf + e.key.toLowerCase()
          ta.current.t = now
          const hit = items.find((i) => getLabel(i).toLowerCase().startsWith(ta.current.buf))
          if (hit) {
            setActive(getKey(hit))
            onValueChange?.(getKey(hit), hit)
          }
        }
      }}
    />
  )
}

export interface ComboboxProps<T> {
  /** Static options (filtered by label). */
  items?: T[]
  /** Async options; called debounced with the query and an AbortSignal. */
  loadOptions?: (query: string, signal: AbortSignal) => Promise<T[]>
  getKey: (item: T) => string
  getLabel: (item: T) => string
  renderItem?: (item: T, state: OptionState) => ReactNode
  /** Custom filter for static items. */
  filter?: (item: T, query: string) => boolean
  onSelect: (item: T) => void
  /** Controlled input text (optional). */
  inputValue?: string
  onInputChange?: (value: string) => void
  /** Keep the chosen label in the input (default) or clear it after choosing. */
  clearOnSelect?: boolean
  placeholder?: string
  debounceMs?: number
  minChars?: number
  emptyText?: ReactNode
  mono?: boolean
  size?: 'sm' | 'md'
  disabled?: boolean
  autoFocus?: boolean
  /** Open the list when the input gets focus (default); false: only when typing, clicking or Down. */
  openOnFocus?: boolean
  /** Tab takes the highlighted option when the text is not exactly an option (focus still moves on). */
  acceptOnTab?: boolean
  id?: string
  className?: string
  'aria-label'?: string
}

/** Text input + popup listbox (aria-activedescendant; Down opens, Enter chooses, Escape closes). */
export function Combobox<T>({
  items,
  loadOptions,
  getKey,
  getLabel,
  renderItem,
  filter,
  onSelect,
  inputValue,
  onInputChange,
  clearOnSelect,
  placeholder,
  debounceMs = 250,
  minChars = 0,
  emptyText,
  mono,
  size,
  disabled,
  autoFocus,
  openOnFocus = true,
  acceptOnTab = false,
  id,
  className,
  ...aria
}: ComboboxProps<T>) {
  const listId = `cbx${useId().replace(/:/g, '')}`
  const [textState, setTextState] = useState('')
  const text = inputValue ?? textState
  const setText = (v: string) => {
    if (inputValue === undefined) setTextState(v)
    onInputChange?.(v)
  }
  const [open, setOpen] = useState(false)
  const [activeState, setActive] = useState<string | null>(null)
  const [asyncItems, setAsyncItems] = useState<T[]>([])
  const [loading, setLoading] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const seq = useRef(0)

  const shown = useMemo(() => {
    if (loadOptions) return asyncItems
    const q = text.trim().toLowerCase()
    const list = items ?? []
    if (!q) return list
    return list.filter((i) => (filter ? filter(i, text) : getLabel(i).toLowerCase().includes(q)))
  }, [loadOptions, asyncItems, items, text, filter, getLabel])

  useEffect(() => {
    if (!loadOptions || !open) return
    if (text.trim().length < minChars) {
      setAsyncItems([])
      setLoading(false)
      return
    }
    const my = ++seq.current
    const ctl = new AbortController()
    setLoading(true)
    const t = setTimeout(() => {
      loadOptions(text.trim(), ctl.signal)
        .then((res) => {
          if (my !== seq.current) return
          setAsyncItems(res)
          setActive(null)
        })
        .catch(() => {
          if (my === seq.current) setAsyncItems([])
        })
        .finally(() => {
          if (my === seq.current) setLoading(false)
        })
    }, debounceMs)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, open, minChars, debounceMs, loadOptions])

  // Derived: a key that is no longer shown falls back to the first option (no effect-driven state).
  const active = activeState && shown.some((i) => getKey(i) === activeState) ? activeState : shown.length ? getKey(shown[0]) : null

  const choose = (item: T) => {
    onSelect(item)
    setText(clearOnSelect ? '' : getLabel(item))
    setOpen(false)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && !open) {
      e.preventDefault()
      setOpen(true)
      return
    }
    if (open) {
      const next = moveActive(e.key, shown, getKey, active)
      if (next !== undefined) {
        e.preventDefault()
        setActive(next)
        return
      }
      if (e.key === 'Enter') {
        const cur = shown.find((i) => getKey(i) === active)
        if (cur) {
          e.preventDefault()
          e.stopPropagation()
          choose(cur)
        }
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        return
      }
      if (e.key === 'Tab') {
        const cur = shown.find((i) => getKey(i) === active)
        const exact = shown.some((i) => getLabel(i).toLowerCase() === text.trim().toLowerCase())
        if (acceptOnTab && cur && text.trim() && !exact) choose(cur)
        else setOpen(false)
      }
    }
  }

  return (
    <div ref={wrapRef} className={cn('relative w-full', className)}>
      <Input
        ref={inputRef}
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active ? optionDomId(listId, active) : undefined}
        aria-label={aria['aria-label']}
        value={text}
        placeholder={placeholder}
        mono={mono}
        size={size}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value)
          setOpen(true)
        }}
        onFocus={() => openOnFocus && !loadOptions && setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ComboboxPopup anchor={wrapRef.current} onClose={() => setOpen(false)} inputRef={inputRef}>
          <ListboxOptions
            id={listId}
            items={shown}
            getKey={getKey}
            getLabel={getLabel}
            renderItem={renderItem}
            activeKey={active}
            onActiveChange={setActive}
            onChoose={choose}
            loading={loading}
            emptyText={loadOptions && text.trim().length < minChars ? `Type at least ${minChars} characters` : emptyText}
            aria-label={aria['aria-label']}
            className="max-h-64"
          />
        </ComboboxPopup>
      )}
    </div>
  )
}

/** The Combobox popup (anchored, zoom-aware, outside click closes); exported for pickers with their own input logic. */
export function ComboboxPopup({ anchor, onClose, inputRef, children }: { anchor: HTMLElement | null; onClose: () => void; inputRef: React.RefObject<HTMLInputElement | null>; children: ReactNode }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const z = useOverlayZ()
  const pos = useAnchoredPosition({ anchor, placement: 'bottom-start', offset: 2, matchWidth: true })
  useDismiss(ref, onClose, { escape: false, ignore: () => [anchor, inputRef.current] })
  return (
    <Portal>
      <div
        ref={(el) => {
          ref.current = el
          pos.ref(el)
        }}
        style={pos.style}
        className={cn(z, 'flex flex-col bg-popover text-popover-foreground border border-border-strong/60 rounded-md shadow-popover overflow-hidden')}
      >
        {children}
      </div>
    </Portal>
  )
}
