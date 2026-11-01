/**
 * Pure time helpers for account status display: local date/time, relative
 * times ("in 3 days", "2 hours ago"), durations, and display formatting of
 * AD FILETIME and LDAP Generalized Time account attributes.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Parses an RFC 3339 string; null for empty or invalid values. */
export function parseTime(iso?: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

/** Local date and time, e.g. "Oct 30, 2026, 7:59 AM" (browser locale). */
export function formatDateTime(iso?: string | null): string {
  const d = parseTime(iso);
  if (!d) return '';
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Local date only. */
export function formatDate(iso?: string | null): string {
  const d = parseTime(iso);
  if (!d) return '';
  return d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

/** Relative time to now: "in 3 days", "2 hours ago", "just now". */
export function formatRelative(iso: string | null | undefined, now: Date): string {
  const d = parseTime(iso);
  if (!d) return '';
  const diffSec = (d.getTime() - now.getTime()) / 1000;
  const abs = Math.abs(diffSec);
  if (abs < 45) return 'just now';
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const pick = (unit: Intl.RelativeTimeFormatUnit, size: number) => rtf.format(Math.round(diffSec / size), unit);
  if (abs < 45 * MINUTE) return pick('minute', MINUTE);
  if (abs < 22 * HOUR) return pick('hour', HOUR);
  if (abs < 26 * DAY) return pick('day', DAY);
  if (abs < 320 * DAY) return pick('month', 30 * DAY);
  return pick('year', 365 * DAY);
}

/** "Oct 30, 2026, 7:59 AM (in 8 hours)"; '' when unset. */
export function formatDateTimeWithRelative(iso: string | null | undefined, now: Date): string {
  const abs = formatDateTime(iso);
  if (!abs) return '';
  return `${abs} (${formatRelative(iso, now)})`;
}

/** Days from now until iso (fractional, negative in the past); null when unset. */
export function daysUntil(iso: string | null | undefined, now: Date): number | null {
  const d = parseTime(iso);
  if (!d) return null;
  return (d.getTime() - now.getTime()) / (DAY * 1000);
}

/** One day in milliseconds. */
export const DAY_MS = DAY * 1000;

/**
 * Whole days from now until `until`: the one rounding rule for every "in n
 * days" text (status chips, Account tab badges, report columns). It rounds
 * like the relative time formatters (formatRelative here and in
 * ui/accountStatus), so a chip never says 4 days while its tooltip and the
 * Account tab say 3. Negative in the past.
 */
export function wholeDaysUntil(until: Date | number, now: Date | number): number {
  const t = typeof until === 'number' ? until : until.getTime();
  const n = typeof now === 'number' ? now : now.getTime();
  return Math.round((t - n) / DAY_MS);
}

/**
 * Account expiration for display. AD stores "expires at the end of
 * <day>" as 00:00 local time of the next day (endOfLocalDayISO); that is
 * shown as "End of Dec 24, 2026" like ADUC, any other instant as date and
 * time.
 */
export function formatAccountExpiry(iso?: string | null): string {
  const d = parseTime(iso);
  if (!d) return '';
  if (d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0) {
    const day = new Date(d.getTime() - 1);
    return `End of ${day.toLocaleDateString(undefined, { dateStyle: 'medium' })}`;
  }
  return formatDateTime(iso);
}

/** Local "2026-10-29 20:59" (sorts chronologically as text; report columns). */
export function formatSortableDateTime(iso?: string | null): string {
  const d = parseTime(iso);
  if (!d) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Human duration of seconds: "30 min", "10 h", "1 h 30 min", "42 days". */
export function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return '0';
  if (seconds % DAY === 0) {
    const d = seconds / DAY;
    return `${d} day${d === 1 ? '' : 's'}`;
  }
  if (seconds >= 2 * DAY) return `${Math.round(seconds / DAY)} days`;
  const h = Math.floor(seconds / HOUR);
  const m = Math.floor((seconds % HOUR) / MINUTE);
  const s = Math.floor(seconds % MINUTE);
  const parts: string[] = [];
  if (h) parts.push(`${h} h`);
  if (m) parts.push(`${m} min`);
  if (!h && s) parts.push(`${s} s`);
  return parts.join(' ') || '0';
}

/**
 * RFC 3339 instant at the end of the given local calendar day
 * (yyyy-mm-dd), i.e. the next day at 00:00 local time. AD "account expires
 * end of <day>" uses this convention. null for invalid input.
 */
export function endOfLocalDayISO(date: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [y, mo, day] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  // Reject days that do not exist (2026-02-30 would roll over to March).
  const check = new Date(y, mo, day);
  if (check.getFullYear() !== y || check.getMonth() !== mo || check.getDate() !== day) return null;
  const d = new Date(y, mo, day + 1, 0, 0, 0, 0);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The local calendar day (yyyy-mm-dd) whose end is iso, the inverse of endOfLocalDayISO. */
export function localDayEndingAt(iso: string | null | undefined): string {
  const d = parseTime(iso);
  if (!d) return '';
  const day = new Date(d.getTime() - 1); // 00:00 next day -> previous day
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

// ---- Attribute value formatting (search results / reports) ----

const FILETIME_EPOCH_OFFSET = 116444736000000000n;
const FILETIME_NEVER = '9223372036854775807';

/** AD attributes holding a FILETIME. */
const FILETIME_ATTRS = new Set([
  'pwdlastset', 'accountexpires', 'lockouttime', 'badpasswordtime', 'lastlogon',
  'lastlogontimestamp', 'lastlogoff', 'msds-userpasswordexpirytimecomputed',
]);

/** Attributes holding LDAP Generalized Time that account reports show. */
const GENERALIZED_TIME_ATTRS = new Set([
  'whencreated', 'whenchanged', 'createtimestamp', 'modifytimestamp',
  'pwdchangedtime', 'pwdaccountlockedtime', 'pwdfailuretime', 'pwdlastsuccess',
  'accountunlocktime', 'passwordexpirationtime', 'retrycountresettime', 'lastlogintime',
]);

/** Converts a FILETIME decimal string to a Date; null for 0 / never / invalid. */
export function fileTimeToDate(value: string): Date | null {
  const v = value.trim();
  if (!/^-?\d+$/.test(v) || v === '0' || v === FILETIME_NEVER) return null;
  const big = BigInt(v);
  if (big <= 0n) return null;
  const ms = Number((big - FILETIME_EPOCH_OFFSET) / 10000n);
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d;
}

/** Parses LDAP Generalized Time (YYYYMMDDHH[MM[SS[.f]]]Z or ±hhmm). */
export function generalizedTimeToDate(value: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})?(\d{2})?(?:[.,](\d+))?(Z|[+-]\d{2}(?:\d{2})?)$/i.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi = '00', s = '00', frac = '0', zone] = m;
  let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Math.round(Number('0.' + frac) * 1000));
  if (zone.toUpperCase() !== 'Z') {
    const sign = zone[0] === '-' ? -1 : 1;
    const oh = Number(zone.slice(1, 3));
    const om = zone.length > 3 ? Number(zone.slice(3, 5)) : 0;
    ms -= sign * (oh * 60 + om) * 60000;
  }
  const date = new Date(ms);
  return isNaN(date.getTime()) ? null : date;
}

function localShort(d: Date): string {
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Display text for a single value of a time-based account attribute, or
 * null when the attribute is not one of them (show the raw value).
 */
export function formatAccountAttributeValue(attrName: string, value: string): string | null {
  const name = attrName.toLowerCase();
  const v = value.trim();
  if (FILETIME_ATTRS.has(name)) {
    if (v === '') return '';
    if (name === 'pwdlastset' && v === '0') return 'Must change at next logon';
    if (name === 'accountexpires' && (v === '0' || v === FILETIME_NEVER)) return 'Never';
    if (name === 'msds-userpasswordexpirytimecomputed' && v === FILETIME_NEVER) return 'Never';
    if (name === 'msds-userpasswordexpirytimecomputed' && v === '0') return 'Must change / not set';
    if (name === 'lockouttime' && v === '0') return 'Not locked';
    if ((name === 'lastlogon' || name === 'lastlogontimestamp' || name === 'lastlogoff' || name === 'badpasswordtime') && v === '0') return 'Never';
    const d = fileTimeToDate(v);
    return d ? localShort(d) : null;
  }
  if (GENERALIZED_TIME_ATTRS.has(name)) {
    if (v === '') return '';
    if (name === 'pwdaccountlockedtime' && v === '000001010000Z') return 'Permanent (disabled)';
    if (name === 'accountunlocktime' && v === '19700101000000Z') return 'Permanent (until an administrator unlocks)';
    if (name === 'passwordexpirationtime' && v === '19700101000000Z') return 'Must change at next bind';
    const d = generalizedTimeToDate(v);
    return d ? localShort(d) : null;
  }
  return null;
}

/**
 * Formats a joined multi-value cell ("a; b") of a time attribute; returns
 * null for other attributes.
 */
export function formatAccountAttributeCell(attrName: string, joined: string): string | null {
  if (!joined) return null;
  const parts = joined.split('; ');
  const formatted = parts.map(p => formatAccountAttributeValue(attrName, p));
  if (formatted.every(f => f === null)) return null;
  return formatted.map((f, i) => f ?? parts[i]).join('; ');
}
