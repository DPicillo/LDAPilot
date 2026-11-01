import { useEffect, useState } from 'react'
import { checkFilter } from '../../lib/wails-treesearch'
import { describeFilterError } from '../../lib/ldapFilter'
import type { FilterCheckState } from '../../types/treesearch'

/**
 * Validates `filter` on the server while the user types (debounced). The
 * server decides; a rejected filter is described by the local parser when it
 * finds the problem too ('Missing ")" at position 18'), else by the server's
 * message without the go-ldap prefixes. Pass null when there is nothing to
 * validate.
 */
export function useFilterCheck(filter: string | null, delayMs = 300): FilterCheckState {
  const [state, setState] = useState<FilterCheckState>({ status: 'idle' });

  useEffect(() => {
    if (filter === null) {
      setState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setState({ status: 'checking' });
    const timer = setTimeout(async () => {
      const error = await checkFilter(filter);
      if (!cancelled) setState(error ? { status: 'invalid', error: describeFilterError(filter, error) } : { status: 'valid' });
    }, delayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [filter, delayMs]);

  return state;
}
