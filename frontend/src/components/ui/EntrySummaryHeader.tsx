/**
 * EntrySummaryHeader (SPEC 6.4, UX-1): who/what is this entry and what is
 * its account state, with the primary account action one click away.
 *
 * Compaction: container queries — below @2xl the meta line hides, below
 * @3xl secondary chips and action labels move into "…"; when the zoom
 * wrapper is <= 700 CSS px tall (`data-compact-h`, set by LayerHost) it
 * collapses to ONE 32px line: icon 16, name, first chip, icon-only actions.
 */
import type { ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Badge } from './Badge'
import { Button, IconButton, type IconType } from './Button'
import { ObjectIcon } from './ObjectIcon'
import { StatusChip } from './StatusChip'
import { DropdownMenu, CommandMenuItems } from './Menu'
import { formatDateTime, formatRelative, primaryStatus, type AccountStatus } from './accountStatus'
import { OBJECT_KIND_LABEL, OBJECT_KIND_TONE, resolveObjectKind, type ObjectKind } from './objectKind'
import { runCommand, useCommands, type CommandContext, type ResolvedCommand } from './commands'
import { primaryAccountVerb } from './primaryAction'

export interface EntrySummaryMeta {
  login?: string
  upn?: string
  lastLogon?: Date | null
  badPwdCount?: number
  memberOfCount?: number
  onMemberOfClick?: () => void
  /** Groups that are both a member of this group and contain it (a direct cycle; WF-3c). */
  cycleWith?: { dn: string; name: string }[]
}

export interface EntrySummaryHeaderProps {
  name: string
  dn?: string
  objectClass?: string[]
  kind?: ObjectKind
  /** Overrides the type badge text ("User", "Group"...). */
  typeLabel?: string
  statuses?: AccountStatus[]
  /** base64 (JPEG) or a data: URL. */
  photo?: string
  meta?: EntrySummaryMeta
  /** Command context of this entry; quick actions come from the registry (group 'account'). */
  ctx?: CommandContext
  /** Status chips become buttons (the editor opens its Account tab, ED-11). */
  onStatusClick?: (kind: AccountStatus['kind']) => void
  /** The server's (cached) status says locked: Unlock is the primary action even without a "Locked out" chip. */
  locked?: boolean
  /**
   * Replaces the primary account verb (the More actions menu stays): the
   * editor shows "Reconnect" while the tab's connection is lost (RW2-C-02).
   * `run` gets the clicked button (focus comes back to it or the work area).
   */
  primaryAction?: { title: string; icon: IconType; run: (button: HTMLElement) => void }
  /** Replace the generated actions. */
  actions?: ReactNode
  className?: string
}

/** Primary account verb: Unlock when locked, Enable when disabled, otherwise Reset Password (primaryAction.ts, shared with the palette). */
function pickPrimary(items: ResolvedCommand[], statuses: AccountStatus[] | undefined, locked = false): ResolvedCommand | undefined {
  return primaryAccountVerb(items, statuses?.map((s) => s.kind), { locked, fallback: true })
}

const COMPACT_HIDE = '[[data-compact-h]_&]:hidden'

export function EntrySummaryHeader({ name, dn, objectClass, kind, typeLabel, statuses = [], photo, meta, ctx, onStatusClick, locked, primaryAction, actions, className }: EntrySummaryHeaderProps) {
  const k = kind ?? resolveObjectKind(objectClass)
  const sorted = [...statuses].sort((a, b) => (a.kind === primaryStatus(statuses) ? -1 : b.kind === primaryStatus(statuses) ? 1 : 0))
  const accountItems = useCommands(ctx ?? EMPTY_CTX, { group: 'account' })
  const primary = ctx ? pickPrimary(accountItems, statuses, locked) : undefined
  const photoSrc = photo ? (photo.startsWith('data:') ? photo : `data:image/jpeg;base64,${photo}`) : undefined

  return (
    <header className={cn('@container border-b border-border bg-background', className)} aria-label={`${name} summary`}>
      <div className="flex items-start gap-3 px-3 py-2 min-w-0 [[data-compact-h]_&]:items-center [[data-compact-h]_&]:h-8 [[data-compact-h]_&]:py-0 [[data-compact-h]_&]:gap-2">
        {/* Icon / photo: 32px, 16px in the one-line layout */}
        <span className="shrink-0 [[data-compact-h]_&]:hidden">
          {photoSrc ? (
            <img src={photoSrc} alt="" className="size-10 rounded object-cover border border-border" />
          ) : (
            <ObjectIcon kind={k} status={statuses} size={32} />
          )}
        </span>
        <span className="shrink-0 hidden [[data-compact-h]_&]:inline-flex">
          <ObjectIcon kind={k} status={statuses} size={16} />
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="text-xl font-semibold text-foreground truncate min-w-[16ch] [[data-compact-h]_&]:text-base" title={dn}>
              {name}
            </h1>
            <Badge tone={OBJECT_KIND_TONE[k]} className={cn('shrink-0', COMPACT_HIDE)}>
              {typeLabel ?? OBJECT_KIND_LABEL[k]}
            </Badge>
            {sorted.map((s, i) => (
              <StatusChip
                key={s.kind}
                status={s}
                focusable
                onClick={onStatusClick ? () => onStatusClick(s.kind) : undefined}
                actionLabel={onStatusClick ? `${s.label} – open the Account tab` : undefined}
                className={cn('shrink-0', i > 0 && ['hidden @3xl:inline-flex', COMPACT_HIDE])}
              />
            ))}
          </div>
          {meta && (
            <div className={cn('hidden @2xl:flex items-center gap-x-3 gap-y-0.5 flex-wrap mt-1 text-base text-muted-foreground', COMPACT_HIDE)}>
              {meta.login && (
                <span>
                  {/* Groups cannot log on: their sAMAccountName is the pre-Windows 2000 name (M-17). */}
                  {k === 'group' ? 'Pre-Windows 2000 name' : 'Login'} <span className="font-mono text-foreground">{meta.login}</span>
                </span>
              )}
              {meta.upn && <span className="font-mono truncate max-w-[40ch]">{meta.upn}</span>}
              {meta.lastLogon !== undefined && (
                <span className="tabular-nums">
                  Last logon{' '}
                  <span className="text-foreground">{meta.lastLogon ? `${formatDateTime(meta.lastLogon)} (${formatRelative(meta.lastLogon)})` : 'never'}</span>
                </span>
              )}
              {meta.badPwdCount !== undefined && (
                <span className={cn('tabular-nums', meta.badPwdCount > 0 && 'text-warning')}>
                  {meta.badPwdCount} bad password{meta.badPwdCount === 1 ? '' : 's'}
                </span>
              )}
              {meta.memberOfCount !== undefined && (
                <button type="button" onClick={meta.onMemberOfClick} disabled={!meta.onMemberOfClick} className="text-primary hover:underline disabled:no-underline disabled:text-muted-foreground">
                  Member of {meta.memberOfCount} group{meta.memberOfCount === 1 ? '' : 's'}
                </button>
              )}
              {!!meta.cycleWith?.length && (
                <button type="button" onClick={meta.onMemberOfClick} disabled={!meta.onMemberOfClick} className="text-warning hover:underline disabled:no-underline" title={meta.cycleWith.map((c) => c.dn).join('\n')}>
                  Circular nesting with {meta.cycleWith.length === 1 ? meta.cycleWith[0].name : `${meta.cycleWith.length} groups`}
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {actions ??
            (ctx && (
              <>
                {primaryAction ? (
                  <>
                    {/* Own keys: when the override ends, these buttons go away (focus is handed on by the
                        host) instead of turning into the account verb under the keyboard focus. */}
                    <Button key="override" variant="primary" size="sm" leftIcon={primaryAction.icon} className="hidden @3xl:inline-flex [[data-compact-h]_&]:hidden" onClick={(e) => primaryAction.run(e.currentTarget)}>
                      {primaryAction.title}
                    </Button>
                    <IconButton
                      key="override-icon"
                      label={primaryAction.title}
                      icon={primaryAction.icon}
                      variant="subtle"
                      className="@3xl:hidden [[data-compact-h]_&]:inline-flex"
                      onClick={(e) => primaryAction.run(e.currentTarget)}
                    />
                  </>
                ) : primary && (
                  <>
                    <Button variant="primary" size="sm" leftIcon={primary.command.icon} disabled={!primary.enabled} className="hidden @3xl:inline-flex [[data-compact-h]_&]:hidden" onClick={() => runCommand(primary.id, ctx)}>
                      {primary.title}
                    </Button>
                    <IconButton
                      label={primary.title}
                      icon={primary.command.icon}
                      variant="subtle"
                      disabled={!primary.enabled}
                      className="@3xl:hidden [[data-compact-h]_&]:inline-flex"
                      onClick={() => runCommand(primary.id, ctx)}
                    />
                  </>
                )}
                <DropdownMenu label={`Actions for ${name}`} placement="bottom-end" trigger={<IconButton label="More actions" icon={MoreHorizontal} />}>
                  {() => <CommandMenuItems ctx={ctx} showDnHeader />}
                </DropdownMenu>
              </>
            ))}
        </div>
      </div>
    </header>
  )
}

const EMPTY_CTX: CommandContext = { profileId: null, serverType: null, connected: false, readOnly: false, selection: [], source: 'editor' }
