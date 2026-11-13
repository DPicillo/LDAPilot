/**
 * Pure helpers of the bulk features: value template checks (mirrors Go
 * services/bulk_template.go), change rows of the batch dialog, list
 * selection and CSV reports.
 */
import type { AttributeChange, LDAPEntry } from '../types/ldap'
import type { BulkApplyResult, BulkPreview, BulkPreviewEntry, LDIFPreview, LDIFRecordPreview } from '../types/bulk'

// ---------------------------------------------------------------------------
// Value templates

const PLACEHOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9;._=-]*$/;

export interface TemplateCheck {
  /** Syntax error, null when the template is valid. */
  error: string | null;
  /** Placeholders as written, e.g. "%mail:lower%". */
  placeholders: string[];
}

/** Checks a value template like the backend does (%attr%, %attr:lower|upper%, %dn%, %rdn%, %parentdn%, %%). */
export function checkTemplate(s: string): TemplateCheck {
  const placeholders: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '%') { i++; continue; }
    if (s[i + 1] === '%') { i += 2; continue; }
    const end = s.indexOf('%', i + 1);
    if (end < 0) {
      return { error: `Unterminated placeholder at position ${i + 1} (write %% for a literal %)`, placeholders };
    }
    const inner = s.slice(i + 1, end);
    const text = s.slice(i, end + 1);
    const colon = inner.indexOf(':');
    const name = colon >= 0 ? inner.slice(0, colon) : inner;
    const modifier = colon >= 0 ? inner.slice(colon + 1).toLowerCase() : '';
    if (!PLACEHOLDER_NAME.test(name)) {
      return { error: `Invalid placeholder ${text} (write %% for a literal %)`, placeholders };
    }
    if (modifier !== '' && modifier !== 'lower' && modifier !== 'upper') {
      return { error: `Unknown modifier "${modifier}" in ${text} (use lower or upper)`, placeholders };
    }
    placeholders.push(text);
    i = end + 1;
  }
  return { error: null, placeholders };
}

/** Placeholder documentation shown in the batch dialog. */
export const TEMPLATE_HELP: { syntax: string; meaning: string }[] = [
  { syntax: '%attr%', meaning: 'first value of the attribute (name is case-insensitive)' },
  { syntax: '%attr:lower%', meaning: 'the same, lower-case' },
  { syntax: '%attr:upper%', meaning: 'the same, upper-case' },
  { syntax: '%dn%', meaning: 'DN of the entry' },
  { syntax: '%rdn%', meaning: 'first RDN as written, e.g. CN=Smith\\, John' },
  { syntax: '%parentdn%', meaning: 'DN of the parent entry' },
  { syntax: '%%', meaning: 'a literal %' },
];

// ---------------------------------------------------------------------------
// Change rows of the batch modify dialog

export type ChangeRowOp = 'add' | 'replace' | 'deleteValues' | 'removeAttribute';

export interface ChangeRow {
  id: string;
  op: ChangeRowOp;
  attribute: string;
  /** One value (template) per line. */
  values: string;
}

export const CHANGE_ROW_OPS: { value: ChangeRowOp; label: string }[] = [
  { value: 'add', label: 'Add values' },
  { value: 'replace', label: 'Replace with' },
  { value: 'deleteValues', label: 'Delete values' },
  { value: 'removeAttribute', label: 'Remove attribute' },
];

let rowSeq = 0;
export function newChangeRow(op: ChangeRowOp = 'replace'): ChangeRow {
  rowSeq++;
  return { id: `row-${rowSeq}`, op, attribute: '', values: '' };
}

/** Values of a row: one per line, blank lines dropped, line ends trimmed. */
export function rowValues(row: ChangeRow): string[] {
  if (row.op === 'removeAttribute') return [];
  return row.values.split('\n').map(v => v.replace(/\r$/, '').trim()).filter(v => v.length > 0);
}

const ATTR_DESC = /^(?:[A-Za-z][A-Za-z0-9-]*|[0-9]+(?:\.[0-9]+)*)(?:;[A-Za-z0-9=._-]+)*$/;

export interface RowProblem {
  rowId: string;
  message: string;
  /**
   * 'missing': something is not filled in yet (shown after the first Dry run
   * click); 'invalid': what was typed is wrong (unknown modifier, unclosed
   * %, bad attribute name; shown while typing).
   */
  kind?: 'missing' | 'invalid';
}

/** Validates the rows; an empty list means they can be sent. */
export function validateChangeRows(rows: ChangeRow[]): RowProblem[] {
  const problems: RowProblem[] = [];
  if (rows.length === 0) problems.push({ rowId: '', message: 'Add at least one change', kind: 'missing' });
  for (const row of rows) {
    const attr = row.attribute.trim();
    if (!attr) {
      problems.push({ rowId: row.id, message: 'Attribute name is missing', kind: 'missing' });
    } else if (!ATTR_DESC.test(attr)) {
      problems.push({ rowId: row.id, message: `Invalid attribute name "${attr}"`, kind: 'invalid' });
      continue;
    }
    const values = rowValues(row);
    if (attr && (row.op === 'add' || row.op === 'deleteValues') && values.length === 0) {
      problems.push({ rowId: row.id, message: 'Enter at least one value', kind: 'missing' });
    }
    // Templates are checked as soon as they are typed (also before the attribute).
    for (const v of values) {
      const check = checkTemplate(v);
      if (check.error) {
        problems.push({ rowId: row.id, message: check.error, kind: 'invalid' });
        break;
      }
    }
  }
  return problems;
}

/** Problems to show while typing: invalid input always, missing input only after the first attempt (`touched`). */
export function visibleRowProblems(problems: RowProblem[], touched: boolean): RowProblem[] {
  return touched ? problems : problems.filter((p) => p.kind === 'invalid');
}

/**
 * Attribute names a row's templates read ("%givenName%.%sn:lower%" ->
 * givenName, sn), without the built-in placeholders (dn, rdn, parentdn).
 */
export function templateAttributes(row: ChangeRow): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of rowValues(row)) {
    for (const p of checkTemplate(v).placeholders) {
      const inner = p.slice(1, -1);
      const name = (inner.includes(':') ? inner.slice(0, inner.indexOf(':')) : inner).split(';')[0];
      const l = name.toLowerCase();
      if (!name || l === 'dn' || l === 'rdn' || l === 'parentdn' || seen.has(l)) continue;
      seen.add(l);
      out.push(name);
    }
  }
  return out;
}

/**
 * Converts dialog rows to backend changes. "Remove attribute" is a delete
 * without values; "Replace with" without values removes the attribute too.
 */
export function rowsToChanges(rows: ChangeRow[]): AttributeChange[] {
  return rows.map(row => {
    const attribute = row.attribute.trim();
    switch (row.op) {
      case 'add': return { operation: 'add', attribute, values: rowValues(row) };
      case 'replace': return { operation: 'replace', attribute, values: rowValues(row) };
      case 'deleteValues': return { operation: 'delete', attribute, values: rowValues(row) };
      default: return { operation: 'delete', attribute, values: [] };
    }
  });
}

// ---------------------------------------------------------------------------
// Selection in lists (search results)

/**
 * Applies a click on `target` to a selection over `order`:
 * a plain click toggles it, a shift click selects (or, if the anchor is not
 * selected, deselects) the range between anchor and target.
 */
export function applySelectionClick(order: string[], selected: ReadonlySet<string>, anchor: string | null, target: string, shift: boolean): Set<string> {
  const next = new Set(selected);
  const to = order.indexOf(target);
  const from = anchor !== null ? order.indexOf(anchor) : -1;
  if (!shift || from < 0 || to < 0) {
    if (next.has(target)) next.delete(target); else next.add(target);
    return next;
  }
  const select = selected.has(anchor!) || anchor === target;
  const [lo, hi] = from <= to ? [from, to] : [to, from];
  for (let i = lo; i <= hi; i++) {
    if (select) next.add(order[i]); else next.delete(order[i]);
  }
  return next;
}

/** State of a "select all" checkbox. */
export function selectAllState(order: string[], selected: ReadonlySet<string>): 'none' | 'some' | 'all' {
  let n = 0;
  for (const dn of order) if (selected.has(dn)) n++;
  if (n === 0) return 'none';
  return n === order.length ? 'all' : 'some';
}

/** Selected items in list order (items no longer in the list are dropped). */
export function selectedInOrder(order: string[], selected: ReadonlySet<string>): string[] {
  return order.filter(dn => selected.has(dn));
}

// ---------------------------------------------------------------------------
// Reports

/**
 * Text that spreadsheet apps (Excel, LibreOffice) would evaluate as a
 * formula when it starts a cell: = + - @ tab CR.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Neutralizes CSV/formula injection: directory values (descriptions, names,
 * server messages) are written to reports as is, so a value starting with
 * a formula character gets a leading ' and is shown as text.
 */
export function neutralizeFormula(s: string): string {
  return FORMULA_START.test(s) ? `'${s}` : s;
}

/** One CSV field: formula-neutralized, quoted when needed. */
export function csvField(v: string | number | boolean | undefined | null): string {
  const raw = v === undefined || v === null ? '' : String(v);
  const s = typeof v === 'string' ? neutralizeFormula(raw) : raw;
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCSV(header: string[], rows: (string | number | boolean | undefined | null)[][]): string {
  return [header, ...rows].map(r => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** Adds a trailing "connection" column when the connection name is known. */
function withConnection(header: string[], rows: (string | number)[][], connection?: string): string {
  if (!connection) return toCSV(header, rows);
  return toCSV([...header, 'connection'], rows.map(r => [...r, connection]));
}

/** CSV of a batch modify dry run: one row per entry and attribute. */
export function batchPreviewReport(preview: BulkPreview, connection?: string): string {
  const rows: (string | number)[][] = [];
  for (const e of preview.entries) {
    const messages = [...(e.errors || []), ...(e.warnings || []), ...(e.notes || [])].join(' | ');
    const diffs = e.diffs || [];
    if (diffs.length === 0) {
      rows.push([e.dn, e.status, '', '', '', '', messages]);
      continue;
    }
    for (const d of diffs) {
      rows.push([e.dn, e.status, d.attribute, (d.operations || []).join('+'), (d.removed || []).join(' | '), (d.added || []).join(' | '), messages]);
    }
  }
  return withConnection(['dn', 'status', 'attribute', 'operations', 'removed values', 'added values', 'messages'], rows, connection);
}

/** CSV of an apply run (batch modify or LDIF). */
export function applyResultReport(result: BulkApplyResult, connection?: string): string {
  const rows = (result.items || []).map(it => [
    it.line ?? '', it.dn, it.operation, it.status, it.passwordWarning ?? '', it.newDn ?? '', it.details ?? '', it.message ?? '', it.adjusted ?? '', it.durationMs,
  ]);
  return withConnection(['line', 'dn', 'operation', 'status', 'password warning', 'new dn', 'details', 'message', 'adjusted', 'duration ms'], rows, connection);
}

/** CSV of an LDIF dry run: syntax errors and one row per record. */
export function ldifPreviewReport(preview: LDIFPreview, connection?: string): string {
  const rows: (string | number)[][] = [];
  for (const r of preview.records) {
    rows.push([r.line, r.dn, r.changeType, r.status, r.summary, [...(r.errors || []), ...(r.warnings || [])].join(' | '), (r.adjustments || []).map(a => a.text).join(' | ')]);
  }
  for (const e of fileLevelSyntaxErrors(preview)) {
    rows.push([e.line, '', '', 'syntax error', '', e.message, '']);
  }
  return withConnection(['line', 'dn', 'changetype', 'status', 'summary', 'messages', 'adjustments'], rows, connection);
}

/** Syntax errors that do not belong to a record (version line, stray continuation lines). */
export function fileLevelSyntaxErrors(preview: LDIFPreview): { line: number; message: string }[] {
  const recordErrors = new Set<string>();
  for (const r of preview.records) for (const m of r.errors || []) recordErrors.add(m);
  return (preview.syntaxErrors || []).filter(e => !recordErrors.has(`line ${e.line}: ${e.message}`));
}

/**
 * Line to show in the editor for a dry run record: the line of the syntax
 * error for invalid records ("line N: ..."), else the dn: line.
 */
export function recordJumpLine(record: Pick<LDIFRecordPreview, 'line' | 'status' | 'errors'>): number {
  if (record.status === 'invalid') {
    for (const e of record.errors || []) {
      const m = /^line (\d+):/.exec(e);
      if (m) return Number(m[1]);
    }
  }
  return record.line;
}

/** File name like "bulk-modify-result-2026-10-30-1412.csv". */
export function reportFilename(prefix: string, ext = 'csv', now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${prefix}-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.${ext}`;
}

/** Splits a DN into the first RDN and the rest for display. */
export function splitDNForDisplay(dn: string): { rdn: string; parent: string } {
  let escaped = false;
  for (let i = 0; i < dn.length; i++) {
    const c = dn[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === ',') return { rdn: dn.slice(0, i).trim(), parent: dn.slice(i + 1).trim() };
  }
  return { rdn: dn, parent: '' };
}

/**
 * Parent DNs whose children changed in an apply run (added, deleted, renamed
 * or moved entries), unique and lower-case for comparison.
 */
export function affectedParentDNs(result: BulkApplyResult): string[] {
  const parents = new Set<string>();
  for (const it of result.items || []) {
    if (it.status !== 'success' || it.operation === 'modify') continue;
    const p = splitDNForDisplay(it.dn).parent;
    if (p) parents.add(p.toLowerCase());
    if (it.newDn) {
      const np = splitDNForDisplay(it.newDn).parent;
      if (np) parents.add(np.toLowerCase());
    }
  }
  return [...parents];
}

/** DNs (lower-case) of entries whose attributes changed in an apply run. */
export function modifiedDNs(result: BulkApplyResult): string[] {
  return (result.items || [])
    .filter(it => it.status === 'success' && it.operation === 'modify')
    .map(it => it.dn.toLowerCase());
}

/**
 * A re-read entry restricted to the attributes a search result row had
 * (names of `old` plus `keep`, case-insensitive), so that a refreshed row
 * keeps the shape of the other rows. The DN stays as in the result.
 */
export function restrictToAttributes(fresh: LDAPEntry, old: LDAPEntry, keep: string[]): LDAPEntry {
  const names = new Set<string>();
  for (const a of old.attributes || []) names.add(a.name.toLowerCase());
  for (const n of keep) names.add(n.toLowerCase());
  return { dn: old.dn, attributes: (fresh.attributes || []).filter(a => names.has(a.name.toLowerCase())) };
}

// ---------------------------------------------------------------------------
// Compact dry-run table of the batch modify dialog

/** A row of the compact dry-run table (BulkDryRunTable). */
export interface DryRunRow {
  key: string;
  entry: BulkPreviewEntry;
  rdn: string;
  parent: string;
  attribute: string;
  before: string;
  after: string;
  /** Errors, warnings and notes of the entry (on its first row). */
  messages: string;
}

/** Size of the raw value of a base64 string. */
function base64Bytes(b64: string): number {
  const s = b64.replace(/\s+/g, '');
  return Math.max(0, Math.floor((s.length * 3) / 4) - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0));
}

function valuesText(values: string[] | undefined, count: number, binary = false): string {
  const shown = (values || []).map((v) => (binary ? `<binary ${base64Bytes(v)} bytes>` : v === '' ? '(empty)' : v));
  const more = count - shown.length;
  return shown.join('; ') + (more > 0 ? ` (+${more} more)` : '');
}

/**
 * Rows of the compact dry-run table: one per entry and changed attribute
 * (errors show every diff), entries without diffs one row with their
 * messages; errors, warnings and notes on the entry's first row.
 */
export function dryRunRows(entries: BulkPreviewEntry[]): DryRunRow[] {
  const rows: DryRunRow[] = [];
  for (const e of entries) {
    const { rdn, parent } = splitDNForDisplay(e.dn);
    const messages = [...(e.errors || []), ...(e.warnings || []), ...(e.notes || [])].join(' · ');
    const diffs = (e.diffs || []).filter((d) => d.changed || e.status === 'error');
    if (!diffs.length) {
      rows.push({ key: e.dn, entry: e, rdn, parent, attribute: '', before: '', after: '', messages });
      continue;
    }
    diffs.forEach((d, i) => {
      rows.push({
        key: `${e.dn}|${d.attribute}|${i}`,
        entry: e,
        rdn,
        parent,
        attribute: d.attribute,
        before: valuesText(d.before, d.beforeCount, d.binary && !d.masked),
        after: valuesText(d.after, d.afterCount, d.binary && !d.masked),
        messages: i === 0 ? messages : '',
      });
    });
  }
  return rows;
}
