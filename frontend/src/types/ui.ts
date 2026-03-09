export type Activity = 'connections' | 'explorer' | 'search' | 'export' | 'schema' | 'bookmarks' | 'ai' | 'reports';

export interface EditorTab {
  id: string;
  profileId: string;
  label: string;
  dn: string;
  dirty: boolean;
}
