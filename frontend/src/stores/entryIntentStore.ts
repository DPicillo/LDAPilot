import { create } from 'zustand'
import { useEditorStore } from './editorStore'

export type EntrySubTab = 'attributes' | 'contents' | 'members' | 'ldif' | 'account'

/**
 * What a command wants the entry editor to show once the entry is open:
 * a sub-tab and, for the Membership sub-tab, the view (members / memberOf),
 * the Direct/Effective mode and whether the add picker opens.
 */
export interface EntryIntent {
  seq: number
  subTab: EntrySubTab
  membership?: {
    direction: 'members' | 'memberOf'
    mode?: 'direct' | 'effective'
    /** Open the "add members" / "add to groups" picker. */
    add?: boolean
  }
}

interface EntryIntentState {
  /** Pending intent per editor tab id (`${profileId}:${dn}`). */
  intents: Record<string, EntryIntent>
  /** Removes the intent of tabId if it is still the one with seq (consumed). */
  consume: (tabId: string, seq: number) => void
}

let seq = 0

export const useEntryIntentStore = create<EntryIntentState>((set) => ({
  intents: {},
  consume: (tabId, s) =>
    set((state) => {
      if (state.intents[tabId]?.seq !== s) return state
      const next = { ...state.intents }
      delete next[tabId]
      return { intents: next }
    }),
}))

/**
 * Opens dn in an editor tab (or activates its tab) and asks the editor to
 * show a sub-tab: used by commands such as "Show Effective Members" or
 * "Add to Group…" from the palette and the Entry menu. EntryEditor applies
 * the sub-tab, MembershipPanel the view/mode/picker, then the intent is
 * consumed.
 */
export function openEntryWithIntent(profileId: string, dn: string, intent: Omit<EntryIntent, 'seq'>): void {
  const tabId = `${profileId}:${dn}`
  seq++
  useEntryIntentStore.setState((s) => ({ intents: { ...s.intents, [tabId]: { ...intent, seq } } }))
  useEditorStore.getState().openEntry(profileId, dn)
}

/**
 * Asks the editor of an OPEN tab to show a sub-tab / membership view without
 * opening (or pinning) anything: the summary header's "Member of N groups"
 * link and the status chips (ED-11).
 */
export function setEntryIntent(tabId: string, intent: Omit<EntryIntent, 'seq'>): void {
  seq++
  useEntryIntentStore.setState((s) => ({ intents: { ...s.intents, [tabId]: { ...intent, seq } } }))
}
