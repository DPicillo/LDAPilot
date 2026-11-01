import { Fragment, type HTMLAttributes } from 'react'
import { cn } from '../../lib/utils'
import { parseRdn, splitDn } from './dnParse'

export interface DnProps extends HTMLAttributes<HTMLSpanElement> {
  dn: string
  /** Show the first RDN's value without its "CN=" prefix. */
  hideRdnType?: boolean
  /** No <wbr> break opportunities (single-line cells). */
  noWrap?: boolean
}

/**
 * A DN rendered for reading: <wbr> after every comma (wraps at RDN
 * boundaries), the attribute-type prefixes muted, mono font.
 */
export function Dn({ dn, hideRdnType, noWrap, className, ...rest }: DnProps) {
  const parts = splitDn(dn)
  if (!parts.length) {
    return (
      <span className={cn('font-mono text-muted-foreground', className)} {...rest}>
        (root)
      </span>
    )
  }
  return (
    <span className={cn('font-mono', noWrap ? 'whitespace-nowrap' : 'break-words', className)} {...rest}>
      {parts.map((raw, i) => {
        const r = parseRdn(raw)
        const eq = raw.indexOf('=')
        const valueRaw = eq >= 0 ? raw.slice(eq + 1) : raw
        return (
          <Fragment key={i}>
            {i > 0 && (
              <>
                <span className="text-muted-foreground">,</span>
                {!noWrap && <wbr />}
              </>
            )}
            {!(i === 0 && hideRdnType) && r.type && <span className="text-muted-foreground">{r.type}=</span>}
            <span>{valueRaw}</span>
          </Fragment>
        )
      })}
    </span>
  )
}
