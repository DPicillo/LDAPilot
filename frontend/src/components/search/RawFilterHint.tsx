import { Check, CircleAlert, Code, Type } from 'lucide-react'
import type { FilterCheckState } from '../../types/treesearch'
import { cn } from '../../lib/utils'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'

interface RawFilterHintProps {
  check: FilterCheckState;
  /** Runs the input as literal text instead (shown while the filter is invalid). */
  onSearchAsText?: () => void;
  className?: string;
}

/**
 * Hint below a quick-search box whose input starts with "(": the input is
 * used as a raw LDAP filter. Shows the server-side validation result.
 */
export function RawFilterHint({ check, onSearchAsText, className }: RawFilterHintProps) {
  const invalid = check.status === 'invalid';
  return (
    <div
      role="status"
      className={cn(
        'text-xs rounded border border-border px-2 py-1 flex flex-col gap-0.5',
        invalid ? 'bg-destructive-subtle text-destructive' : 'bg-info-subtle text-info',
        className
      )}
    >
      <div className="flex items-center gap-1">
        <Code size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
        <span className="font-medium">Raw LDAP filter</span>
        {check.status === 'checking' && <Spinner size="sm" label="Checking the filter" />}
        {check.status === 'valid' && <Check size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />}
        {invalid && <CircleAlert size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />}
        <span className="ml-auto text-foreground">{invalid ? 'invalid' : 'used as typed'}</span>
      </div>
      {check.status === 'invalid' && (
        <div className="break-all text-foreground">
          {check.error}
          {onSearchAsText && (
            <>
              {' '}
              <Button size="sm" variant="link" onClick={onSearchAsText} className="text-xs">
                Search as text instead
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface TextOverrideHintProps {
  /** Switches back to using the input as a raw LDAP filter. */
  onUseAsFilter: () => void;
  className?: string;
}

/**
 * Hint below a quick-search box whose input starts with "(" but is searched
 * as literal text, because the user chose "Search as text instead".
 */
export function TextOverrideHint({ onUseAsFilter, className }: TextOverrideHintProps) {
  return (
    <div className={cn('text-xs rounded border border-border px-2 py-1 flex items-center gap-1 bg-muted text-muted-foreground', className)}>
      <Type size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
      <span>Searched as text</span>
      <Button size="sm" variant="link" onClick={onUseAsFilter} className="ml-auto text-xs">
        Use as LDAP filter
      </Button>
    </div>
  );
}
