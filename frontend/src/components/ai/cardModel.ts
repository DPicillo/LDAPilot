import type { ApprovalRecord, Block, ToolStatus, WriteInfo } from '../../types/ai';
import type { ToolCardState } from '../../lib/aiReducer';
import { extractFilter, parseJSONObject, resultErrorCode, statusFromResult } from '../../lib/aiFormat';
import type { FilterUse } from './DnLink';

/** Display names of the harness tools (Go: ldaptools Def.DisplayName). */
export const TOOL_DISPLAY: Record<string, string> = {
  list_connections: 'List connections',
  get_server_info: 'Server info',
  search_ldap: 'Search',
  find_by_name: 'Find by name',
  get_entry: 'Read entry',
  get_children: 'List children',
  get_schema_definition: 'Schema definition',
  validate_filter: 'Validate filter',
  decode_value: 'Decode value',
  get_membership: 'Group membership',
  get_account_status: 'Account status',
  find_accounts: 'Find accounts',
  count_entries: 'Count entries',
  list_deleted_objects: 'Deleted objects',
  modify_entry: 'Modify entry',
  create_entry: 'Create entry',
  move_or_rename_entry: 'Move or rename',
  delete_entry: 'Delete entry',
  update_group_membership: 'Change group members',
  unlock_account: 'Unlock account',
  set_account_enabled: 'Enable/disable account',
  set_password_must_change: 'Must change password',
  reset_password: 'Reset password',
};

export function toolName(n: string): string {
  return n.replace(/^mcp__ldapilot__/, '');
}

/** One tool call as the card shows it: persisted blocks overlaid with live event state. */
export interface CardView {
  toolCallId: string;
  name: string;
  displayName: string;
  kind: string;
  args: string;
  rawArgs?: string;
  connectionId: string;
  connectionLabel: string;
  status: ToolStatus;
  warnings: string[];
  durationMs?: number;
  summary?: string;
  result?: string;
  isError?: boolean;
  errorCode?: string;
  dns: string[];
  write?: WriteInfo;
  cleared?: boolean;
  shrunk?: boolean;
  approval?: ApprovalRecord;
  synthetic?: boolean;
}

export function buildCard(use: Block | undefined, result: Block | undefined, live: ToolCardState | undefined, runActive = false): CardView | null {
  const id = live?.toolCallId ?? use?.id;
  if (!id) return null;
  const name = toolName(live?.name || use?.name || 'tool');
  const persistedStatus = use ? statusFromResult(use, result) : undefined;
  // A live terminal status wins; a persisted result wins over a stale live
  // non-terminal one (e.g. after a re-sync).
  let status: ToolStatus = live?.status ?? persistedStatus ?? 'queued';
  if (result && live && !['ok', 'error', 'denied', 'cancelled', 'not_executed', 'outcome_unknown'].includes(live.status)) {
    status = persistedStatus ?? status;
  }
  if (!result && !live && runActive) status = 'running';
  const warnings = [...new Set([...(use?.meta?.warnings ?? []), ...(result?.meta?.warnings ?? []), ...(live?.warnings ?? [])])];
  return {
    toolCallId: id,
    name,
    displayName: (live?.displayName && live.displayName !== live.name ? live.displayName : '') || TOOL_DISPLAY[name] || name,
    kind: live?.kind || use?.meta?.kind || (TOOL_DISPLAY[name] && /^(modify|create|move|delete|update|unlock|set|reset)_/.test(name) ? 'write' : 'read'),
    args: live?.args || (use?.input ? JSON.stringify(use.input) : '{}'),
    rawArgs: use?.meta?.rawArgs,
    // Read calls carry their connection on the tool_result meta only.
    connectionId: live?.connectionId || use?.meta?.connectionId || result?.meta?.connectionId || '',
    connectionLabel: live?.connectionLabel || use?.meta?.connectionLabel || result?.meta?.connectionLabel || '',
    status,
    warnings,
    durationMs: live?.durationMs ?? result?.meta?.durationMs,
    summary: live?.summary || result?.meta?.summary,
    result: live?.result ?? result?.content,
    isError: live?.isError ?? result?.isError,
    errorCode: live?.errorCode || resultErrorCode(result) || undefined,
    dns: live?.dns ?? result?.meta?.dns ?? [],
    write: live?.write,
    cleared: !!result?.meta?.clearedAt,
    shrunk: !!result?.meta?.shrunk,
    approval: use?.meta?.approval,
    synthetic: result?.meta?.synthetic,
  };
}

export function parseArgs(args: string): Record<string, unknown> {
  return parseJSONObject(args) ?? {};
}

/** RFC 4515 value escaping. */
export function escapeFilterValue(v: string): string {
  return v.replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

/** The search a tool card can be opened as ("Open in Search"), or null. */
export function searchOf(card: CardView): { filter: string; use: FilterUse } | null {
  const a = parseArgs(card.args);
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '');
  if (card.name === 'search_ldap') {
    const f = str('filter');
    if (!f) return null;
    return { filter: f, use: { profileId: card.connectionId, baseDn: str('base_dn'), scope: str('scope') || 'sub' } };
  }
  if (card.name === 'find_by_name') {
    const r = parseJSONObject(card.result);
    const f = typeof r?.filter === 'string' ? r.filter : '';
    if (!f) return null;
    return { filter: f, use: { profileId: card.connectionId, baseDn: str('base_dn'), scope: 'sub' } };
  }
  if (card.name === 'find_accounts') {
    const r = parseJSONObject(card.result);
    const method = typeof r?.method === 'string' ? r.method : '';
    const f = extractFilter(method);
    if (!f) return null;
    return { filter: f, use: { profileId: card.connectionId, baseDn: str('base_dn'), scope: 'sub' } };
  }
  if (card.name === 'get_membership') {
    const dn = str('dn');
    if (!dn) return null;
    const transitive = a.transitive === true;
    const memberOf = str('direction') === 'member_of';
    const r = parseJSONObject(card.result);
    const serverType = typeof r?.server_type === 'string' ? r.server_type : '';
    const v = escapeFilterValue(dn);
    if (serverType === 'ad') {
      // AD: the in-chain matching rule gives the same (nested) result.
      const rule = transitive ? ':1.2.840.113556.1.4.1941:' : '';
      return { filter: `(${memberOf ? 'member' : 'memberOf'}${rule}=${v})`, use: { profileId: card.connectionId, baseDn: '', scope: 'sub' } };
    }
    // Other servers: the tool expands nesting itself (and knows memberUid
    // groups); only the direct groups of an entry have an equivalent filter.
    if (memberOf && !transitive && serverType) {
      return { filter: `(|(member=${v})(uniqueMember=${v}))`, use: { profileId: card.connectionId, baseDn: '', scope: 'sub' } };
    }
    return null;
  }
  return null;
}

/**
 * Filters and DNs a card contributes to the links of its message. `dns`
 * (optional) collects the DNs as the tool results wrote them, so a DN the
 * model re-escaped in its answer opens the entry the tool saw (P3).
 */
export function cardLinks(card: CardView, dnProfiles: Record<string, string>, filters: Record<string, FilterUse>, key: (dn: string) => string, dns?: string[]) {
  if (card.connectionId) {
    for (const dn of card.dns) {
      dnProfiles[key(dn)] = card.connectionId;
      dns?.push(dn);
    }
    const a = parseArgs(card.args);
    for (const k of ['dn', 'base_dn', 'new_parent', 'group_dn']) {
      const v = a[k];
      if (typeof v === 'string' && v) {
        dnProfiles[key(v)] ??= card.connectionId;
        // a DN the call was made with: valid when the call succeeded
        if (card.status === 'ok') dns?.push(v);
      }
    }
  }
  const s = searchOf(card);
  if (s && card.name !== 'get_membership') filters[s.filter.trim()] = s.use;
}
