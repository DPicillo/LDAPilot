/**
 * Texts of a resolved approval (the card's status line and the tool card's
 * "Change: / Access:" line). Pure, so Node's test runner loads it
 * (tests/ai/approval.test.mjs).
 */

export const RESOLVED_LABEL: Record<string, string> = {
  approved: 'Approved',
  approved_chat: 'Approved for this chat',
  approved_always: 'Allowed (always, read)',
  denied: 'Denied',
  timeout: 'Not answered in time',
  cancelled: 'Cancelled',
  policy_denied: 'Denied: LDAPilot settings changed while this was waiting',
};

const BY_LABEL: Record<string, string> = {
  user: 'by you',
  grant: 'automatically (approved for this chat)',
  policy: 'by policy',
  timeout: '',
  run: 'because the response was stopped',
};

/** Access requests are allowed, not approved (A-24: "Allow for this chat" said "Approved by you"). */
const ACCESS_LABEL: Record<string, string> = {
  approved: 'Allowed for this chat',
  approved_always: 'Allowed (always, read)',
  denied: 'Not allowed',
};

/** "Approved by you", "Allowed for this chat", "Not answered in time". */
export function resolvedText(decision: string, by: string, kind?: string): string {
  const access = kind === 'access' ? ACCESS_LABEL[decision] : undefined;
  const d = access ?? RESOLVED_LABEL[decision] ?? decision;
  const b = access && by === 'user' ? '' : BY_LABEL[by] ?? '';
  return b ? `${d} ${b}` : d;
}
