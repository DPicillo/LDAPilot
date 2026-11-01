/**
 * Chips picker for groups ("Member of" of New User / Copy Entry) or members
 * (new groups): search as you type (names, DNs), Enter adds the highlighted
 * hit or a typed DN, Backspace removes the last chip. Hits are ranked exact >
 * prefix > kind, with the tree's object-kind icons.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { X } from 'lucide-react'
import * as wails from '../../lib/wails'
import { ScopeSub } from '../../types/ldap'
import { dnKey, objectTypeFromClasses, pickerSearchFilter, rankPickerHits, rdnValue } from '../../lib/membership'
import { ensureLoginAttributes, knownLoginAttributes } from '../commands/presence'
import { useConnectionStore } from '../../stores/connectionStore'
import { cn } from '../../lib/utils'
import { Badge } from '../ui/Badge'
import { Input } from '../ui/Input'
import { Spinner } from '../ui/Spinner'
import { ComboboxPopup, ListboxOptions } from '../ui/Listbox'
import { OBJECT_KIND_COLOR, OBJECT_KIND_ICON, resolveObjectKind } from '../ui/objectKind'

interface Hit {
  dn: string
  name: string
  type: string
  classes: string[]
}

export interface GroupPickerProps {
  profileId: string
  /** Chosen DNs. */
  value: string[]
  onChange: (dns: string[]) => void
  /** Search groups only (Member of), else any entry (members). */
  groupsOnly?: boolean
  placeholder?: string
  'aria-label'?: string
  id?: string
  disabled?: boolean
  /** DNs never offered (the entry itself). */
  exclude?: string[]
}

export function GroupPicker({ profileId, value, onChange, groupsOnly = true, placeholder, id, disabled, exclude, 'aria-label': ariaLabel }: GroupPickerProps) {
  const baseDN = useConnectionStore((s) => s.profiles.find((p) => p.id === profileId)?.baseDN ?? '')
  const [text, setText] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [searching, setSearching] = useState(false)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const [inputEl, setInputEl] = useState<HTMLInputElement | null>(null)
  const setInput = useCallback((el: HTMLInputElement | null) => {
    inputRef.current = el
    setInputEl(el)
  }, [])
  const chosen = useMemo(() => new Set(value.map(dnKey)), [value])
  const excluded = useMemo(() => new Set((exclude ?? []).map(dnKey)), [exclude])
  // Unique per picker: New Entry shows two (Members, Member of) at once.
  const autoId = useId()
  const listId = `gp${(id ?? autoId).replace(/[^\w-]/g, '')}-list`

  useEffect(() => {
    const q = text.trim()
    if (q.length < 2 || q.includes('=')) {
      setHits([])
      setSearching(false)
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      setSearching(true)
      try {
        const res = await wails.SearchLDAP(profileId, {
          baseDN,
          scope: ScopeSub,
          filter: pickerSearchFilter(q, groupsOnly),
          attributes: ['cn', 'objectClass'],
          sizeLimit: 25,
          timeLimit: 5,
        })
        if (cancelled) return
        const classesOf = (e: { attributes?: { name: string; values: string[] }[] }) => e.attributes?.find((a) => a.name.toLowerCase() === 'objectclass')?.values ?? []
        // LDAP persons without a login are contacts (M-06): one batched, unlogged read of the hits.
        await ensureLoginAttributes(profileId, (res?.entries ?? []).map((e) => ({ dn: e.dn, objectClass: classesOf(e) }))).catch(() => {})
        if (cancelled) return
        setHits(rankPickerHits((res?.entries ?? []).filter((e) => !excluded.has(dnKey(e.dn))).map((e) => {
          const classes = classesOf(e)
          return { dn: e.dn, name: rdnValue(e.dn), type: objectTypeFromClasses(classes, knownLoginAttributes(profileId, e.dn)), classes }
        }), q))
        setActive(-1)
        setOpen(true)
      } catch {
        if (!cancelled) setHits([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [text, profileId, baseDN, groupsOnly, excluded])

  const visible = hits.filter((h) => !chosen.has(dnKey(h.dn)))

  const add = (dn: string) => {
    if (!dn.trim() || chosen.has(dnKey(dn)) || excluded.has(dnKey(dn))) return
    onChange([...value, dn.trim()])
    setText('')
    setActive(-1)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setActive((i) => Math.min(i + 1, visible.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(i - 1, -1))
    } else if (e.key === 'Enter' && text.trim()) {
      // Enter adds a chip; it never submits the dialog while text is typed.
      e.preventDefault()
      e.stopPropagation()
      if (text.includes('=')) add(text.trim())
      else if (open && active >= 0 && visible[active]) add(visible[active].dn)
      else if (visible.length === 1) add(visible[0].dn)
    } else if (e.key === 'Backspace' && !text && value.length > 0) {
      onChange(value.slice(0, -1))
    } else if (e.key === 'Escape' && open && visible.length > 0) {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
    }
  }

  return (
    <div className="space-y-1">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1" aria-label={groupsOnly ? 'Chosen groups' : 'Chosen members'}>
          {value.map((dn) => (
            <li key={dn}>
              <Badge tone="primary" className="pr-0.5 max-w-full" title={dn}>
                <span className="truncate">{rdnValue(dn)}</span>
                <button type="button"
                  onClick={() => onChange(value.filter((v) => v !== dn))}
                  aria-label={`Remove ${rdnValue(dn)}`}
                  disabled={disabled}
                  className="inline-flex items-center justify-center size-3.5 rounded-xs hover:bg-background"
                >
                  <X size={12} strokeWidth={1.75} aria-hidden />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <Input
        ref={setInput}
        id={id}
        size="sm"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open && visible.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 && visible[active] ? `${listId}-o-${active}` : undefined}
        value={text}
        disabled={disabled}
        onChange={(e) => { setText(e.target.value); setOpen(true) }}
        onFocus={() => visible.length > 0 && setOpen(true)}
        onBlur={() => setTimeout(() => { if (document.activeElement !== inputRef.current) setOpen(false) }, 150)}
        onKeyDown={onKeyDown}
        placeholder={placeholder ?? (groupsOnly ? 'Search groups by name, or paste a DN' : 'Search entries by name, or paste a DN')}
        autoComplete="off"
        spellCheck={false}
        suffix={<span className="inline-flex size-3 items-center justify-center">{searching && <Spinner size="sm" label="Searching" />}</span>}
      />
      {open && visible.length > 0 && (
        <ComboboxPopup anchor={inputEl} onClose={() => setOpen(false)} inputRef={inputRef}>
          <ListboxOptions
            id={listId}
            items={visible}
            getKey={(h) => h.dn}
            getLabel={(h) => h.name}
            activeKey={active >= 0 ? visible[active]?.dn ?? null : null}
            onActiveChange={(k) => setActive(visible.findIndex((h) => h.dn === k))}
            optionId={(k) => `${listId}-o-${visible.findIndex((h) => h.dn === k)}`}
            onChoose={(h) => add(h.dn)}
            aria-label={groupsOnly ? 'Groups' : 'Entries'}
            className="max-h-[220px]"
            renderItem={(h) => {
              const kind = h.type === 'contact' ? 'contact' : resolveObjectKind(h.classes) // a person without a login is a contact (M-06)
              const Icon = OBJECT_KIND_ICON[kind]
              return (
                <>
                  <Icon size={14} strokeWidth={1.75} aria-hidden className={cn('shrink-0', OBJECT_KIND_COLOR[kind])} />
                  <span className="flex-1 min-w-0 py-0.5">
                    <span className="block truncate font-medium">{h.name}</span>
                    <span className="block truncate text-xs text-muted-foreground font-mono">{h.dn}</span>
                  </span>
                </>
              )
            }}
          />
        </ComboboxPopup>
      )}
    </div>
  )
}
