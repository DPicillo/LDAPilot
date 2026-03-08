export type Activity = 'connections' | 'explorer' | 'search' | 'export' | 'schema' | 'bookmarks';

export interface EditorTab {
  id: string;
  profileId: string;
  label: string;
  dn: string;
  dirty: boolean;
}
