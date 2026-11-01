import type { ElementType, HTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { tooltipTriggerProps } from './Tooltip'
import type { Placement } from './layer'

export interface TruncatedTextProps extends HTMLAttributes<HTMLElement> {
  /** Full text (also the tooltip content unless `tooltip` is given). */
  text?: string
  tooltip?: ReactNode
  as?: ElementType
  placement?: Placement
  children?: ReactNode
}

const isTruncated = (el: HTMLElement) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1

/** Single-line ellipsis; shows a tooltip ONLY when the text is actually cut off. */
export function TruncatedText({ text, tooltip, as: Tag = 'span', placement = 'bottom-start', className, children, ...rest }: TruncatedTextProps) {
  const t = tooltipTriggerProps(tooltip ?? text ?? children, { placement, condition: isTruncated })
  return (
    <Tag
      {...rest}
      className={cn('block min-w-0 truncate', className)}
      onPointerEnter={t.onPointerEnter}
      onPointerLeave={t.onPointerLeave}
      onFocus={t.onFocus}
      onBlur={t.onBlur}
    >
      {children ?? text}
    </Tag>
  )
}
