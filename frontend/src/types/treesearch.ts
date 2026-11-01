/** How literal search text is matched against an attribute value. */
export type MatchType = 'contains' | 'startsWith' | 'endsWith' | 'exact';

/**
 * Interpretation of the text typed into a quick search box
 * (see parseQuickSearchInput in lib/searchFilter.ts).
 * - `empty`: nothing but blanks
 * - `raw`:   starts with "(" and is used as an LDAP filter as typed
 * - `text`:  literal text; every filter special character is escaped
 */
export interface QuickSearchInput {
  kind: 'empty' | 'raw' | 'text';
  /** The input without leading/trailing blanks. */
  text: string;
}

/** State of the server-side validation of a raw filter. */
export type FilterCheckState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'valid' }
  | { status: 'invalid'; error: string };
