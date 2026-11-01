/**
 * Bulk operation types - mirror Go internal/models/bulk.go.
 */
import type { AttributeChange, LDAPAttribute } from './ldap'
import type { PasswordWriteOptions } from './passwordPolicy'

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
export type LDIFRecordStatus = 'ok' | 'warning' | 'error' | 'invalid';

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
