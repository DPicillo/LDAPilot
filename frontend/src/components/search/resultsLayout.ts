/**
 * The results grid's column layout (hidden columns, display order) for the
 * one column chooser of the results (DEF-15: the toolbar's chooser, the
 * grid header has none). It is DataTable's own persisted layout
 * (`ldapilot-table-search-results`, widths kept); a change bumps `version`
 * and the grids (panel and results tabs) remount with it, because
 * DataTable keeps hidden / order as internal state read at mount.
 */
import { create } from 'zustand'
import { readTableLayout } from './resultsExport'

export const RESULTS_LAYOUT_KEY = 'search-results'
const STORAGE_KEY = `ldapilot-table-${RESULTS_LAYOUT_KEY}`

interface ResultsLayoutState {
  /** Hidden column ids; null = DataTable's default (defaultHidden columns). */
  hidden: string[] | null
  order: string[]
  version: number
}

function read(): Pick<ResultsLayoutState, 'hidden' | 'order'> {
  const l = readTableLayout(RESULTS_LAYOUT_KEY)
  return { hidden: Array.isArray(l.hidden) ? l.hidden : null, order: Array.isArray(l.order) ? l.order : [] }
}

export const useResultsLayout = create<ResultsLayoutState>(() => ({ ...read(), version: 0 }))

/** Writes hidden columns and / or the order (the grids remount with them). */
export function setResultsLayout(next: { hidden?: string[]; order?: string[] }) {
  const cur = useResultsLayout.getState()
  const hidden = next.hidden ?? cur.hidden
  const order = next.order ?? cur.order
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Record<string, unknown>
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...raw, ...(hidden ? { hidden } : {}), order: order.length ? order : undefined }))
  } catch {
    /* blocked storage: the layout holds for this session */
  }
  useResultsLayout.setState({ hidden, order, version: cur.version + 1 })
}
