/**
 * Bulk operation types - mirror Go internal/models/bulk.go.
 */
import type { AttributeChange, LDAPAttribute } from './ldap'
import type { PasswordWriteOptions, PasswordWritePlan } from './passwordPolicy'

/** Options of a bulk preview / apply run (Go models.BulkOptions). */
export interface BulkOptions {
  /** Identifies the run for "bulk:progress" events and StopBulkRun. */
  runId: string;
  /** Keep going after a failed entry / record (else stop at the first failure). */
  continueOnError: boolean;
  /** Skip entries where a template placeholder is empty instead of failing them. */
  skipEmptyPlaceholders: boolean;
  /** Batch modify: drop adds of present values / deletes of absent values instead of failing. */
  ignoreNoOps: boolean;
  /** Password storage decisions for userPassword values (LDIF opt-out asIs, "ask" answer, unencrypted confirmation). */
  passwords?: PasswordWriteOptions;
  /** LDIF import: what the import adapts, decided once for the file (Go models.LDIFImportOptions). */
  import?: LDIFImportOptions;
  /** LDIF apply with empty content: the file of this large dry run, kept by the backend. */
  previewRunId?: string;
}

/** Go models.LDIFImportOptions: empty / missing fields are the defaults (the first value). */
export interface LDIFImportOptions {
  /** Attributes the server maintains (IDs, timestamps, back-links): leave out, or send where the server allows it. */
  serverAttributes?: 'omit' | 'send';
  /** Attribute types / object classes the server does not define (or the entry's classes do not allow). */
  unknownSchema?: 'omit' | 'send';
  /** Active Directory: DN values of entries that do not exist. */
  missingReferences?: 'omit' | 'send';
  /** Add records of entries that exist already. */
  existing?: 'skip' | 'update' | 'fail';
}

/** Go models.LDIFAdjust* kinds. */
export type LDIFAdjustmentKind = 'serverOmitted' | 'serverSent' | 'unknownOmitted' | 'classOmitted' | 'refOmitted' | 'refDeferred' | 'existing';

/** What the import changes in a record before sending it (Go models.LDIFAdjustment). */
export interface LDIFAdjustment {
  kind: LDIFAdjustmentKind;
  attributes: string[];
  values?: string[];
  reason: string;
  /** The whole adjustment as one sentence. */
  text: string;
}

/** Records per adjustment kind, attribute and reason over the file (Go models.LDIFAdjustmentTotal). */
export interface LDIFAdjustmentTotal {
  kind: LDIFAdjustmentKind;
  attribute: string;
  reason: string;
  records: number;
}

export type BulkPreviewStatus = 'change' | 'unchanged' | 'skipped' | 'error';
export type BulkResultStatus = 'success' | 'failed' | 'skipped' | 'unchanged' | 'notProcessed';

/** Predicted effect on one attribute (Go models.BulkAttrDiff). */
export interface BulkAttrDiff {
  attribute: string;
  operations: string[];
  /** At most 25 values; see beforeCount / afterCount. */
  before: string[];
  after: string[];
  beforeCount: number;
  afterCount: number;
  added: string[];
  removed: string[];
  changed: boolean;
  masked: boolean;
  binary: boolean;
}

/** Dry run result of one entry (Go models.BulkPreviewEntry). */
export interface BulkPreviewEntry {
  dn: string;
  status: BulkPreviewStatus;
  errors: string[];
  warnings: string[];
  notes: string[];
  diffs: BulkAttrDiff[];
  /** Resolved changes that would be sent (password values masked). */
  changes: AttributeChange[];
}

/** Dry run result of a batch modify (Go models.BulkPreview). */
export interface BulkPreview {
  entries: BulkPreviewEntry[];
  total: number;
  changed: number;
  unchanged: number;
  skipped: number;
  errors: number;
  stopped: boolean;
}

/** Outcome of one entry / record (Go models.BulkResultItem). */
export interface BulkResultItem {
  line?: number;
  dn: string;
  operation: string;
  status: BulkResultStatus;
  message?: string;
  details?: string;
  newDn?: string;
  /** LDIF import: what was changed in the record before sending it (attributes left out, existing entry updated). */
  adjusted?: string;
  /** A written password needs attention (read back after the write); the item is still a success */
  passwordWarning?: BulkPasswordWarning;
  durationMs: number;
}

/** Go models.PasswordWarning* */
export type BulkPasswordWarning = 'ineffective' | 'cleartext' | 'unconfirmed' | 'warning';

/** Outcome of an apply run (Go models.BulkApplyResult). */
export interface BulkApplyResult {
  runId: string;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  unchanged: number;
  notProcessed: number;
  stopped: boolean;
  stopReason?: string;
  /** Items with a passwordWarning: will not work, stored in cleartext, other warnings */
  passwordIneffective: number;
  passwordCleartext: number;
  passwordWarnings: number;
  items: BulkResultItem[];
}

/** Payload of the "bulk:progress" Wails event (Go models.BulkProgress). */
export interface BulkProgress {
  runId: string;
  phase: 'preview' | 'apply';
  current: number;
  total: number;
  dn: string;
  succeeded: number;
  failed: number;
  skipped: number;
}

export type LDIFChangeType = 'add' | 'modify' | 'delete' | 'modrdn';
export type LDIFRecordStatus = 'ok' | 'warning' | 'error' | 'invalid' | 'skip';

/** Dry run result of one LDIF record (Go models.LDIFRecordPreview). */
export interface LDIFRecordPreview {
  index: number;
  line: number;
  dn: string;
  changeType: LDIFChangeType | '';
  status: LDIFRecordStatus;
  errors: string[];
  warnings: string[];
  /** e.g. how the record's password values are stored */
  notes?: string[];
  /** What the import changes in the record before sending it. */
  adjustments?: LDIFAdjustment[];
  summary: string;
  attributes?: LDAPAttribute[];
  changes?: AttributeChange[];
  diffs?: BulkAttrDiff[];
  newRdn?: string;
  deleteOldRdn?: boolean;
  newSuperior?: string;
  newDn?: string;
}

export interface LDIFSyntaxError {
  line: number;
  message: string;
}

/** Dry run result of an LDIF file (Go models.LDIFPreview). */
export interface LDIFPreview {
  version: number;
  records: LDIFRecordPreview[];
  syntaxErrors: LDIFSyntaxError[];
  byChangeType: Record<string, number>;
  byStatus: Record<string, number>;
  total: number;
  /** No syntax errors and at least one record. */
  applicable: boolean;
  stopped: boolean;
  /** Records per adjustment, in the order they first appear. */
  adjustments?: LDIFAdjustmentTotal[];
  /** Notes about the whole file on this server (e.g. AD accounts without passwords). */
  notes?: string[];
  /** Server type the dry run checked against. */
  serverType?: string;
  /** The password plan of every record together (no password values: missing): what applying asks. */
  passwords?: PasswordWritePlan;
  /** Large file: records holds only the first records per status; the rest come from GetLDIFPreviewRecords(runId, …). */
  partial?: boolean;
  runId?: string;
}

/** A page of a large dry run's records (Go models.LDIFRecordPage). */
export interface LDIFRecordPage {
  records: LDIFRecordPreview[];
  /** Records with the status (all: of the file). */
  total: number;
}

/** LDIF file read through the open dialog (Go models.LDIFFile). */
export interface LDIFFile {
  path: string;
  name: string;
  size: number;
  content: string;
}

/** Name of the Wails event carrying BulkProgress. */
export const BULK_PROGRESS_EVENT = 'bulk:progress';
