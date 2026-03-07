/**
 * Wails binding wrappers.
 * These functions wrap the auto-generated Wails bindings.
 * During development without wails dev, they fall back to stubs.
 */
import type { ConnectionProfile, SearchParams, SearchResult, TreeNode, LDAPEntry, LDAPAttribute, SchemaInfo, SchemaObjectClass, ImportResult } from '../types/ldap';

// Dynamic import helpers - the wailsjs directory is auto-generated
// We use dynamic access to avoid build errors when bindings aren't generated yet

function getBinding(serviceName: string): any {
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

// --- EditorService ---

export async function CreateEntry(profileID: string, dn: string, attributes: LDAPAttribute[]): Promise<void> {
  const svc = getBinding('EditorService');
  if (svc?.CreateEntry) return svc.CreateEntry(profileID, dn, attributes);
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

export async function ExportCSVToFile(profileID: string, baseDN: string, columns: string[]): Promise<void> {
  const svc = getBinding('ExportService');
  if (svc?.ExportCSVToFile) return svc.ExportCSVToFile(profileID, baseDN, columns);
}

export async function ExportToFile(profileID: string, dns: string[]): Promise<void> {
  const svc = getBinding('ExportService');
  if (svc?.ExportToFile) return svc.ExportToFile(profileID, dns);
}

export async function ImportLDIF(profileID: string, ldifContent: string): Promise<ImportResult> {
  const svc = getBinding('ExportService');
  if (svc?.ImportLDIF) return svc.ImportLDIF(profileID, ldifContent);
  return { entries: [], total: 0, succeeded: 0, failed: 0, errors: [] };
}

export async function ImportLDIFFromFile(profileID: string): Promise<ImportResult | null> {
  const svc = getBinding('ExportService');
  if (svc?.ImportLDIFFromFile) return svc.ImportLDIFFromFile(profileID);
  return null;
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

// --- LogService ---

export interface LogEntry {
  timestamp: string;
  operation: string;
  details: string;
  duration: string;
  error?: string;
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
