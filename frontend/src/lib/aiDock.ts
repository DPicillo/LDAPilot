/**
 * Width of the AI chat docked right of the editor (uiStore.aiDock 'right').
 * Pure (no imports), so tests/ai/dock.test.mjs loads it directly.
 *
 * N2: at 1100 × 700 with the chat docked right (380 px) next to the side
 * bar (280 px) the editor column kept 400 px and the attribute table's value
 * column wrapped one character per line. The editor column now keeps
 * EDITOR_MIN_DOCKED: the AI pane gives way first (down to its minimum), then
 * the side bar. The saved widths stay the user's preference: a wider window
 * gets them back, and only a drag saves new ones.
 */

/** The width the editor column keeps while the chat is docked right (when the panes can give way). */
export const EDITOR_MIN_DOCKED = 560;

export interface DockFitInput {
  /** width of the split view: side bar + editor column + AI pane */
  total: number;
  /** preferred (saved) side bar width; 0 = the side bar is hidden */
  sidebar: number;
  sidebarMin: number;
  /** preferred (saved) AI pane width */
  ai: number;
  aiMin: number;
  editorMin: number;
}

export interface DockFit {
  sidebar: number;
  editor: number;
  ai: number;
}

/**
 * The pane widths for the docked chat: the preferred ones while the editor
 * column keeps `editorMin`, else the AI pane shrinks (to `aiMin`), then the
 * side bar (to `sidebarMin`); below that the editor gets what is left.
 */
export function fitDockedPanes(i: DockFitInput): DockFit {
  let sidebar = i.sidebar > 0 ? Math.max(i.sidebar, i.sidebarMin) : 0;
  let ai = Math.max(i.ai, i.aiMin);
  let need = i.editorMin - (i.total - sidebar - ai);
  if (need > 0) {
    const fromAI = Math.min(need, Math.max(0, ai - i.aiMin));
    ai -= fromAI;
    need -= fromAI;
  }
  if (need > 0 && sidebar > 0) {
    const fromSidebar = Math.min(need, Math.max(0, sidebar - i.sidebarMin));
    sidebar -= fromSidebar;
    need -= fromSidebar;
  }
  return { sidebar, ai, editor: Math.max(0, i.total - sidebar - ai) };
}

/** True when the panes differ from the fit by more than a pixel (then they are resized). */
export function needsRefit(now: { sidebar: number; ai: number }, fit: DockFit): boolean {
  return Math.abs(now.sidebar - fit.sidebar) > 1 || Math.abs(now.ai - fit.ai) > 1;
}
