import { create } from 'zustand'

interface Bookmark {
  dn: string;
  label: string;
  profileId: string;
  timestamp: number;
}

interface BookmarkState {
  bookmarks: Bookmark[];
  addBookmark: (profileId: string, dn: string) => void;
  removeBookmark: (profileId: string, dn: string) => void;
  isBookmarked: (profileId: string, dn: string) => boolean;
  getBookmarks: (profileId: string) => Bookmark[];
  clearBookmarks: (profileId: string) => void;
}

// Persist bookmarks to localStorage
function loadBookmarks(): Bookmark[] {
  try {
    const raw = localStorage.getItem('ldapilot-bookmarks');
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveBookmarks(bookmarks: Bookmark[]) {
  localStorage.setItem('ldapilot-bookmarks', JSON.stringify(bookmarks));
}

export const useBookmarkStore = create<BookmarkState>((set, get) => ({
  bookmarks: loadBookmarks(),

  addBookmark: (profileId: string, dn: string) => {
    const state = get();
    if (state.bookmarks.some(b => b.profileId === profileId && b.dn === dn)) return;
    const label = dn.split(',')[0] || dn;
    const next = [...state.bookmarks, { dn, label, profileId, timestamp: Date.now() }];
    saveBookmarks(next);
    set({ bookmarks: next });
  },

  removeBookmark: (profileId: string, dn: string) => {
    const next = get().bookmarks.filter(b => !(b.profileId === profileId && b.dn === dn));
    saveBookmarks(next);
    set({ bookmarks: next });
  },

  isBookmarked: (profileId: string, dn: string) => {
    return get().bookmarks.some(b => b.profileId === profileId && b.dn === dn);
  },

  getBookmarks: (profileId: string) => {
    return get().bookmarks
      .filter(b => b.profileId === profileId)
      .sort((a, b) => a.label.localeCompare(b.label));
  },

  clearBookmarks: (profileId: string) => {
    const next = get().bookmarks.filter(b => b.profileId !== profileId);
    saveBookmarks(next);
    set({ bookmarks: next });
  },
}));
