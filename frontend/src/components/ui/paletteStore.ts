import { create } from 'zustand'

export type PaletteScope = 'all' | 'entries' | 'actions' | 'dn'

interface PaletteState {
  open: boolean
  scope: PaletteScope
  query: string
  /** Opens the palette (Ctrl+K: all; Ctrl+Shift+P: actions; post-integration Ctrl+G: dn). */
  openPalette: (opts?: { scope?: PaletteScope; query?: string }) => void
  closePalette: () => void
}

export const usePaletteStore = create<PaletteState>((set) => ({
  open: false,
  scope: 'all',
  query: '',
  openPalette: (opts) => set({ open: true, scope: opts?.scope ?? 'all', query: opts?.query ?? '' }),
  closePalette: () => set({ open: false }),
}))
