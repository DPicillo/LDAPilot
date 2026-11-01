/**
 * Wails binding wrappers.
 * These functions wrap the auto-generated Wails bindings.
 * During development without wails dev, they fall back to stubs.
 */
import type { ConnectionExportResult, ConnectionImportReport, ConnectionProfile, SearchParams, SearchResult, TreeNode, LDAPEntry, LDAPAttribute, AttributeChange, ServerInfo, SchemaInfo, SchemaObjectClass, ObjectClassInfo, ValidationError, BatchResult } from '../types/ldap';

// Dynamic import helpers - the wailsjs directory is auto-generated
// We use dynamic access to avoid build errors when bindings aren't generated yet

/**
 * Returns the Wails binding object of a Go service (window.go.services.<name>),
 * or null when not running under Wails. Exported so feature modules can define
 * their own wrappers next to their code.
 */
export function getBinding(serviceName: string): any {
  try {
    // The wailsjs bindings are available at runtime when running under wails
    const w = (window as any)['go'];
    if (w && w['services'] && w['services'][serviceName]) {
      return w['services'][serviceName];
    }
  } catch {
    // Not running under Wails
  }
  return null;
}

// --- ConnectionService ---

export async function GetConnections(): Promise<ConnectionProfile[]> {
  const svc = getBinding('ConnectionService');
  if (svc?.GetConnections) return svc.GetConnections();
  return [];
}

export async function GetConnection(id: string): Promise<ConnectionProfile | null> {
  const svc = getBinding('ConnectionService');
  if (svc?.GetConnection) return svc.GetConnection(id);
  return null;
}

export async function SaveConnection(profile: ConnectionProfile): Promise<ConnectionProfile> {
  const svc = getBinding('ConnectionService');
  if (svc?.SaveConnection) return svc.SaveConnection(profile);
  // Stub: return with a generated id
  return { ...profile, id: profile.id || crypto.randomUUID() };
}

export async function DeleteConnection(id: string): Promise<void> {
  const svc = getBinding('ConnectionService');
  if (svc?.DeleteConnection) return svc.DeleteConnection(id);
}

export async function Connect(profileID: string): Promise<void> {
  const svc = getBinding('ConnectionService');
  if (svc?.Connect) return svc.Connect(profileID);
}

export async function Disconnect(profileID: string): Promise<void> {
  const svc = getBinding('ConnectionService');
  if (svc?.Disconnect) return svc.Disconnect(profileID);
}

export async function TestConnection(profile: ConnectionProfile): Promise<void> {
  const svc = getBinding('ConnectionService');
  if (svc?.TestConnection) return svc.TestConnection(profile);
  throw new Error('Not running under Wails - cannot test connection');
}

export async function GetConnectionStatus(profileID: string): Promise<boolean> {
  const svc = getBinding('ConnectionService');
  if (svc?.GetConnectionStatus) return svc.GetConnectionStatus(profileID);
  return false;
}

export async function Reconnect(profileID: string): Promise<void> {
  const svc = getBinding('ConnectionService');
  if (svc?.Reconnect) return svc.Reconnect(profileID);
}

/** Error text of the Go sentinel ldap.ErrConnectCancelled. */
export const CONNECT_CANCELLED_MESSAGE = 'connection attempt cancelled';

/**
 * True if a rejected Connect/Reconnect call was cancelled by a Disconnect of
 * the same profile while it was dialing (not a connection failure).
 */
export function isConnectCancelled(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return msg.includes(CONNECT_CANCELLED_MESSAGE);
}

export async function PingConnection(profileID: string): Promise<boolean> {
  const svc = getBinding('ConnectionService');
  if (svc?.PingConnection) return svc.PingConnection(profileID);
  return false;
}

/**
 * Saves all profiles (no passwords) through the save dialog. `path` is ''
 * when the user cancelled: show no message then. Prefer
 * `exportConnectionProfiles()` (components/connection/connectionTransfer.ts),
 * which also shows the result.
 */
export async function ExportConnections(): Promise<ConnectionExportResult> {
  const svc = getBinding('ConnectionService');
  if (svc?.ExportConnections) return (await svc.ExportConnections()) ?? { path: '', count: 0 };
  return { path: '', count: 0 };
}

const EMPTY_IMPORT: ConnectionImportReport = { cancelled: true, path: '', total: 0, imported: [], duplicates: [], skipped: [], needPassword: [] };

/**
 * Imports profiles through the open dialog and reports imported, duplicate
 * (same host, port, bind DN and base DN) and skipped profiles. Prefer
 * `importConnectionProfiles()` (components/connection/connectionTransfer.ts),
 * which also shows the result and reloads the list.
 */
export async function ImportConnectionsReport(): Promise<ConnectionImportReport> {
  const svc = getBinding('ConnectionService');
  if (!svc?.ImportConnections) return EMPTY_IMPORT;
  const r = (await svc.ImportConnections()) as Partial<ConnectionImportReport> | null;
  return {
    cancelled: !!r?.cancelled,
    path: r?.path ?? '',
    total: r?.total ?? 0,
    imported: r?.imported ?? [],
    duplicates: r?.duplicates ?? [],
    skipped: r?.skipped ?? [],
    needPassword: r?.needPassword ?? [],
    askPassword: r?.askPassword ?? [],
  };
}

/** @deprecated Returns only the number of imported profiles; use ImportConnectionsReport. */
export async function ImportConnections(): Promise<number> {
  return (await ImportConnectionsReport()).imported.length;
}

/** Re-reads connections.json (edited outside LDAPilot) and returns the profiles (passwords masked). */
export async function ReloadConnections(): Promise<ConnectionProfile[]> {
  const svc = getBinding('ConnectionService');
  if (svc?.ReloadConnections) return (await svc.ReloadConnections()) ?? [];
  return GetConnections();
}

/**
 * Connects with a password typed by the user (none is stored). `save` stores
 * it (encrypted) once the connection works; otherwise it is kept in memory
 * until LDAPilot quits.
 */
export async function ConnectWithPassword(profileID: string, password: string, save: boolean): Promise<void> {
  const svc = getBinding('ConnectionService');
  if (svc?.ConnectWithPassword) return svc.ConnectWithPassword(profileID, password, save);
  return Connect(profileID);
}

/** Error text prefix of Go services.ErrPasswordRequired. */
export const PASSWORD_REQUIRED_MESSAGE = 'password required';

/** True if Connect/Reconnect failed because the profile needs a password none is stored for. */
export function isPasswordRequired(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return msg.startsWith(PASSWORD_REQUIRED_MESSAGE);
}

// --- BrowserService ---

export async function GetRootEntries(profileID: string): Promise<TreeNode[]> {
  const svc = getBinding('BrowserService');
  if (svc?.GetRootEntries) return svc.GetRootEntries(profileID);
  return [];
}

export async function GetChildren(profileID: string, parentDN: string): Promise<TreeNode[]> {
  const svc = getBinding('BrowserService');
  if (svc?.GetChildren) return svc.GetChildren(profileID, parentDN);
  return [];
}

export async function GetEntry(profileID: string, dn: string): Promise<LDAPEntry | null> {
  const svc = getBinding('BrowserService');
  if (svc?.GetEntry) return svc.GetEntry(profileID, dn);
  return null;
}

export async function GetRootDSE(profileID: string): Promise<LDAPEntry | null> {
  const svc = getBinding('BrowserService');
  if (svc?.GetRootDSE) return svc.GetRootDSE(profileID);
  return null;
}

export interface ObjectStats {
  baseDN: string;
  totalCount: number;
  byType: Record<string, number>;
  /** LDAP filter per category (tree batch: the statistics categories run a search below the base). */
  filters?: Record<string, string>;
  /** Display order of the categories. */
  order?: string[];
  /** The count stopped at the size limit (50,000 entries): the numbers are a lower bound. */
  truncated?: boolean;
}

export async function GetStatistics(profileID: string, baseDN: string): Promise<ObjectStats | null> {
  const svc = getBinding('BrowserService');
  if (svc?.GetStatistics) return svc.GetStatistics(profileID, baseDN);
  return null;
}

/** RootDSE capabilities (server type, controls, naming contexts), cached per connection. */
export async function GetServerInfo(profileID: string): Promise<ServerInfo | null> {
  const svc = getBinding('BrowserService');
  if (svc?.GetServerInfo) return svc.GetServerInfo(profileID);
  return null;
}

// --- EditorService ---

export async function CreateEntry(profileID: string, dn: string, attributes: LDAPAttribute[]): Promise<void> {
  const svc = getBinding('EditorService');
  if (svc?.CreateEntry) return svc.CreateEntry(profileID, dn, attributes);
}

/** Applies all changes to an entry in one atomic modify request (audited). */
export async function ModifyEntry(profileID: string, dn: string, changes: AttributeChange[]): Promise<void> {
  const svc = getBinding('EditorService');
  if (svc?.ModifyEntry) return svc.ModifyEntry(profileID, dn, changes);
}

export async function ModifyAttribute(profileID: string, dn: string, attrName: string, values: string[]): Promise<void> {
  const svc = getBinding('EditorService');
  if (svc?.ModifyAttribute) return svc.ModifyAttribute(profileID, dn, attrName, values);
}

export async function AddAttribute(profileID: string, dn: string, attrName: string, values: string[]): Promise<void> {
  const svc = getBinding('EditorService');
  if (svc?.AddAttribute) return svc.AddAttribute(profileID, dn, attrName, values);
}

export async function DeleteAttribute(profileID: string, dn: string, attrName: string): Promise<void> {
  const svc = getBinding('EditorService');
  if (svc?.DeleteAttribute) return svc.DeleteAttribute(profileID, dn, attrName);
}

export async function DeleteEntry(profileID: string, dn: string): Promise<void> {
  const svc = getBinding('EditorService');
  if (svc?.DeleteEntry) return svc.DeleteEntry(profileID, dn);
}

export async function RenameEntry(profileID: string, dn: string, newRDN: string, deleteOldRDN: boolean, newSuperior: string): Promise<void> {
  const svc = getBinding('EditorService');
  if (svc?.RenameEntry) return svc.RenameEntry(profileID, dn, newRDN, deleteOldRDN, newSuperior);
}

// --- SearchService ---

export async function SearchLDAP(profileID: string, params: SearchParams): Promise<SearchResult> {
  const svc = getBinding('SearchService');
  if (svc?.Search) return svc.Search(profileID, params);
  return { entries: [], totalCount: 0, truncated: false };
}

/** Cancels all running searches of a profile; returns how many were cancelled. */
export async function CancelSearch(profileID: string): Promise<number> {
  const svc = getBinding('SearchService');
  if (svc?.CancelSearch) return svc.CancelSearch(profileID);
  return 0;
}

/** Error text of the Go sentinel ldap.ErrSearchCancelled. */
export const SEARCH_CANCELLED_MESSAGE = 'search cancelled';

/** True if a rejected SearchLDAP call was cancelled (CancelSearch) rather than failed. */
export function isSearchCancelled(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return msg.includes(SEARCH_CANCELLED_MESSAGE);
}

export async function ValidateFilter(filter: string): Promise<void> {
  const svc = getBinding('SearchService');
  if (svc?.ValidateFilter) return svc.ValidateFilter(filter);
}

// --- ExportService ---

export async function ExportEntries(profileID: string, dns: string[]): Promise<string> {
  const svc = getBinding('ExportService');
  if (svc?.ExportEntries) return svc.ExportEntries(profileID, dns);
  return '';
}

export async function ExportSubtree(profileID: string, baseDN: string): Promise<string> {
  const svc = getBinding('ExportService');
  if (svc?.ExportSubtree) return svc.ExportSubtree(profileID, baseDN);
  return '';
}

export async function ExportCSV(profileID: string, baseDN: string, columns: string[]): Promise<string> {
  const svc = getBinding('ExportService');
  if (svc?.ExportCSV) return svc.ExportCSV(profileID, baseDN, columns);
  return '';
}

/** Saves a CSV export through the save dialog. Returns the path written, '' when the user cancelled. */
export async function ExportCSVToFile(profileID: string, baseDN: string, columns: string[]): Promise<string> {
  const svc = getBinding('ExportService');
  if (svc?.ExportCSVToFile) return (await svc.ExportCSVToFile(profileID, baseDN, columns)) || '';
  return '';
}

/** Saves an LDIF export of dns through the save dialog. Returns the path written, '' when the user cancelled. */
export async function ExportToFile(profileID: string, dns: string[]): Promise<string> {
  const svc = getBinding('ExportService');
  if (svc?.ExportToFile) return (await svc.ExportToFile(profileID, dns)) || '';
  return '';
}

export async function PreviewLDIF(ldifContent: string): Promise<LDAPEntry[]> {
  const svc = getBinding('ExportService');
  if (svc?.PreviewLDIF) return svc.PreviewLDIF(ldifContent);
  return [];
}

// --- SchemaService ---

export async function GetSchema(profileID: string): Promise<SchemaInfo> {
  const svc = getBinding('SchemaService');
  if (svc?.GetSchema) return svc.GetSchema(profileID);
  return { objectClasses: [], attributes: [] };
}

export async function RefreshSchema(profileID: string): Promise<SchemaInfo> {
  const svc = getBinding('SchemaService');
  if (svc?.RefreshSchema) return svc.RefreshSchema(profileID);
  return { objectClasses: [], attributes: [] };
}

export async function GetObjectClass(profileID: string, name: string): Promise<SchemaObjectClass | null> {
  const svc = getBinding('SchemaService');
  if (svc?.GetObjectClass) return svc.GetObjectClass(profileID, name);
  return null;
}

export async function GetObjectClassDetails(profileID: string, name: string): Promise<ObjectClassInfo | null> {
  const svc = getBinding('SchemaService');
  if (svc?.GetObjectClassDetails) return svc.GetObjectClassDetails(profileID, name);
  return null;
}

export async function GetRequiredAttributes(profileID: string, objectClasses: string[]): Promise<string[]> {
  const svc = getBinding('SchemaService');
  if (svc?.GetRequiredAttributes) return svc.GetRequiredAttributes(profileID, objectClasses);
  return [];
}

export async function ValidateEntry(profileID: string, objectClasses: string[], attributes: Record<string, string[]>): Promise<ValidationError[]> {
  const svc = getBinding('SchemaService');
  if (svc?.ValidateEntry) return svc.ValidateEntry(profileID, objectClasses, attributes);
  return [];
}

// --- LogService ---

export interface LogEntry {
  timestamp: string;
  operation: string;
  details: string;
  duration: string;
  error?: string;
  /** The connection the operation ran on (every connected profile streams operation:log). */
  profileId?: string;
  /** Per-profile sequence number (1, 2, …): GetLogs + stream merge without duplicates. */
  seq?: number;
  /** Local date and time, RFC 3339 with milliseconds (exports). */
  at?: string;
}

export async function GetLogs(profileID: string): Promise<LogEntry[]> {
  const svc = getBinding('LogService');
  if (svc?.GetLogs) return svc.GetLogs(profileID);
  return [];
}

export async function ClearLogs(profileID: string): Promise<void> {
  const svc = getBinding('LogService');
  if (svc?.ClearLogs) return svc.ClearLogs(profileID);
}

export async function StartLogStream(profileID: string): Promise<void> {
  const svc = getBinding('LogService');
  if (svc?.StartLogStream) return svc.StartLogStream(profileID);
}

// --- AuditService ---

export interface AuditEntry {
  timestamp: string;
  operation: string;
  dn: string;
  details?: string;
  error?: string;
  user?: string;
}

export async function GetAuditLog(profileID: string, limit: number = 500): Promise<AuditEntry[]> {
  const svc = getBinding('AuditService');
  if (svc?.GetAuditLog) return svc.GetAuditLog(profileID, limit);
  return [];
}

export async function ClearAuditLog(profileID: string): Promise<void> {
  const svc = getBinding('AuditService');
  if (svc?.ClearAuditLog) return svc.ClearAuditLog(profileID);
}

// --- AIService ---

export interface ChatConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages?: ChatMsg[];
}

export interface ChatMsg {
  role: string;
  content: string;
  toolCalls?: string;
  toolCallId?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export async function ListChats(): Promise<ChatConversation[]> {
  const svc = getBinding('AIService');
  if (svc?.ListChats) return svc.ListChats();
  return [];
}

export async function GetChat(id: string): Promise<ChatConversation | null> {
  const svc = getBinding('AIService');
  if (svc?.GetChat) return svc.GetChat(id);
  return null;
}

export async function CreateChat(title: string): Promise<ChatConversation> {
  const svc = getBinding('AIService');
  if (svc?.CreateChat) return svc.CreateChat(title);
  throw new Error('AI service not available');
}

export async function DeleteChat(id: string): Promise<void> {
  const svc = getBinding('AIService');
  if (svc?.DeleteChat) return svc.DeleteChat(id);
}

export async function RenameChat(id: string, title: string): Promise<void> {
  const svc = getBinding('AIService');
  if (svc?.RenameChat) return svc.RenameChat(id, title);
}

export async function AIChat(chatID: string, message: string): Promise<string> {
  const svc = getBinding('AIService');
  if (svc?.Chat) return svc.Chat(chatID, message);
  return 'AI service not available';
}

export interface AIConfig {
  provider: string;
  url: string;
  apiKey: string;
  model: string;
  hasKey: boolean;
}

export async function GetAIConfig(): Promise<AIConfig> {
  const svc = getBinding('AIService');
  if (svc?.GetAIConfig) return svc.GetAIConfig();
  return { provider: '', url: '', apiKey: '', model: '', hasKey: false };
}

export async function SaveAIConfig(config: AIConfig): Promise<void> {
  const svc = getBinding('AIService');
  if (svc?.SaveAIConfig) return svc.SaveAIConfig(config);
}

export async function ListAIModels(): Promise<string[]> {
  const svc = getBinding('AIService');
  if (svc?.ListModels) return svc.ListModels();
  return [];
}

// --- BatchService ---

// Deletes go through recycle's DeleteEntryDialog (EditorService.DeleteSubtree),
// modifies through bulk's BatchPreview/BatchApply (lib/wails-bulk.ts) and LDIF
// imports through PreviewLDIFChanges/ApplyLDIFChanges.

export async function BatchMove(profileID: string, dns: string[], newParentDN: string): Promise<BatchResult> {
  const svc = getBinding('BatchService');
  if (svc?.BatchMove) return svc.BatchMove(profileID, dns, newParentDN);
  return { total: 0, succeeded: 0, failed: 0, errors: [] };
}
