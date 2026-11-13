/**
 * LDIF import options (Go models.LDIFImportOptions): what the import adapts
 * instead of letting the server refuse a record, decided once for the whole
 * file before the dry run. Pure, node-tested (tests/ldifimport.test.ts).
 */
import type { LDIFAdjustmentKind, LDIFAdjustmentTotal, LDIFImportOptions } from '../../types/bulk.ts'

/** The dialog's choices: the Go options plus "continue on error". */
export interface ImportChoices {
  existing: NonNullable<LDIFImportOptions['existing']>;
  serverAttributes: NonNullable<LDIFImportOptions['serverAttributes']>;
  unknownSchema: NonNullable<LDIFImportOptions['unknownSchema']>;
  missingReferences: NonNullable<LDIFImportOptions['missingReferences']>;
  continueOnError: boolean;
}

/** Defaults: adapt what can be adapted, skip existing entries, keep going after a failed record. */
export const DEFAULT_IMPORT_CHOICES: ImportChoices = {
  existing: 'skip',
  serverAttributes: 'omit',
  unknownSchema: 'omit',
  missingReferences: 'omit',
  continueOnError: true,
}

const STORAGE_KEY = 'ldapilot-ldif-import-options'

/** Choices parsed from stored JSON; unknown or missing values fall back to the defaults. */
export function parseImportChoices(raw: string | null | undefined): ImportChoices {
  let v: Record<string, unknown> = {}
  try {
    const parsed = raw ? JSON.parse(raw) : null
    if (parsed && typeof parsed === 'object') v = parsed as Record<string, unknown>
  } catch {
    /* junk */
  }
  const pick = <T extends string>(value: unknown, allowed: readonly T[], def: T): T =>
    typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : def
  return {
    existing: pick(v.existing, ['skip', 'update', 'fail'] as const, DEFAULT_IMPORT_CHOICES.existing),
    serverAttributes: pick(v.serverAttributes, ['omit', 'send'] as const, DEFAULT_IMPORT_CHOICES.serverAttributes),
    unknownSchema: pick(v.unknownSchema, ['omit', 'send'] as const, DEFAULT_IMPORT_CHOICES.unknownSchema),
    missingReferences: pick(v.missingReferences, ['omit', 'send'] as const, DEFAULT_IMPORT_CHOICES.missingReferences),
    continueOnError: typeof v.continueOnError === 'boolean' ? v.continueOnError : DEFAULT_IMPORT_CHOICES.continueOnError,
  }
}

/** The remembered choices of this device (defaults when storage is blocked). */
export function readImportChoices(): ImportChoices {
  try {
    return parseImportChoices(localStorage.getItem(STORAGE_KEY))
  } catch {
    return { ...DEFAULT_IMPORT_CHOICES }
  }
}

export function writeImportChoices(c: ImportChoices): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(c))
  } catch {
    /* blocked storage */
  }
}

/** The Go options of the choices. */
export function importOptionsOf(c: ImportChoices): LDIFImportOptions {
  return { existing: c.existing, serverAttributes: c.serverAttributes, unknownSchema: c.unknownSchema, missingReferences: c.missingReferences }
}

/**
 * What the server does with server-maintained attributes (IDs, timestamps)
 * when the import sends them: said before the run, so nothing comes as a
 * surprise (checked against the lab servers).
 */
export function serverAttributesHint(serverType: string | null | undefined): string {
  switch (serverType) {
    case 'openldap':
      return 'OpenLDAP keeps entryUUID, createTimestamp, creatorsName, modifyTimestamp, modifiersName and the password policy times (pwdChangedTime, pwdHistory, …) when they are sent with the Relax Rules control; entryCSN, structuralObjectClass, entryDN and hasSubordinates cannot be set.'
    case '389ds':
      return '389 Directory Server assigns nsUniqueId, entryUUID and the create / modify timestamps itself: values from the file cannot be kept. Password policy state (passwordExpirationTime, passwordHistory, …) is stored as sent.'
    case 'ad':
      return 'Active Directory assigns objectGUID, objectSid, whenCreated, uSNCreated and the other system attributes itself and refuses them in an import; they are always left out. Only nTSecurityDescriptor is sent on request.'
    case 'other':
      return 'Unknown server type: LDAPilot sends them with the Relax Rules control and the server decides.'
  }
  return ''
}

/** Why passwords from an Active Directory export cannot be imported (the import dialog says it before the run). */
export const AD_EXPORT_PASSWORDS =
  'Active Directory never returns passwords (unicodePwd can only be written), so accounts exported from AD come without one. Set them after the import with Reset Password, or add unicodePwd lines to the file (needs LDAPS or StartTLS).'

/** A group of the dry run's adjustment totals: one kind and reason, with the attributes and their record counts. */
export interface AdjustmentGroup {
  kind: LDIFAdjustmentKind;
  reason: string;
  /** "Left out", "Sent", "Set at the end of the run", … */
  label: string;
  items: { name: string; records: number }[];
}

const KIND_LABEL: Record<LDIFAdjustmentKind, string> = {
  serverOmitted: 'Left out',
  serverSent: 'Sent',
  unknownOmitted: 'Left out',
  classOmitted: 'Object classes left out',
  refOmitted: 'References left out',
  refDeferred: 'References set at the end of the run',
  existing: 'Existing entries',
}

/** Groups the dry run's totals by kind and reason, in their order. */
export function adjustmentGroups(totals: LDIFAdjustmentTotal[] | null | undefined): AdjustmentGroup[] {
  const groups: AdjustmentGroup[] = []
  for (const t of totals || []) {
    let g = groups.find((x) => x.kind === t.kind && x.reason === t.reason)
    if (!g) {
      g = { kind: t.kind, reason: t.reason, label: KIND_LABEL[t.kind] ?? t.kind, items: [] }
      groups.push(g)
    }
    g.items.push({ name: t.attribute, records: t.records })
  }
  return groups
}

/** "entryUUID (7), createTimestamp (7)" or, when every count is the same, "entryUUID, createTimestamp (7 records each)". */
export function adjustmentItemsText(items: { name: string; records: number }[]): string {
  const named = items.filter((i) => i.name)
  if (named.length === 0) {
    const n = items.reduce((a, i) => a + i.records, 0)
    return `${n} record${n === 1 ? '' : 's'}`
  }
  const same = named.every((i) => i.records === named[0].records)
  if (same) {
    const n = named[0].records
    return `${named.map((i) => i.name).join(', ')} (${n} record${n === 1 ? '' : 's'}${named.length > 1 ? ' each' : ''})`
  }
  return named.map((i) => `${i.name} (${i.records})`).join(', ')
}

/** The sentence of an "existing entries" total ("The entry exists already: skipped" → "7 records: …"). */
export function existingText(group: AdjustmentGroup): string {
  return `${adjustmentItemsText(group.items)}: ${group.reason.replace(/^The entry exists/, 'the entry exists')}`
}
