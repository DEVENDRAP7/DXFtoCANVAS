/** Viewport colour schemes. Drawing colours are adapted per theme for contrast. */

export type ThemeId = 'dark' | 'paper' | 'blueprint'

export interface ViewportTheme {
  id: ThemeId
  label: string
  background: string
  /** 0..1, used to decide whether a drawing colour needs flipping. */
  backgroundLuminance: number
  gridMinor: string
  gridMajor: string
  axisX: string
  axisY: string
  extents: string
  /** Multiplies every entity colour toward the accent for blueprint mode. */
  monochrome?: string
  overlay: string
  overlayText: string
}

export const THEMES: Record<ThemeId, ViewportTheme> = {
  dark: {
    id: 'dark',
    label: 'Dark',
    background: '#10141b',
    backgroundLuminance: 0.07,
    gridMinor: 'rgba(255, 255, 255, 0.035)',
    gridMajor: 'rgba(255, 255, 255, 0.085)',
    axisX: 'rgba(233, 88, 88, 0.55)',
    axisY: 'rgba(112, 204, 130, 0.55)',
    extents: 'rgba(120, 160, 220, 0.28)',
    overlay: 'rgba(88, 166, 255, 0.95)',
    overlayText: '#e8edf5',
  },
  paper: {
    id: 'paper',
    label: 'Paper',
    background: '#f6f4ef',
    backgroundLuminance: 0.94,
    gridMinor: 'rgba(20, 30, 45, 0.05)',
    gridMajor: 'rgba(20, 30, 45, 0.11)',
    axisX: 'rgba(190, 45, 45, 0.5)',
    axisY: 'rgba(30, 130, 60, 0.5)',
    extents: 'rgba(40, 70, 120, 0.3)',
    overlay: 'rgba(20, 90, 190, 0.95)',
    overlayText: '#1b2430',
  },
  blueprint: {
    id: 'blueprint',
    label: 'Blueprint',
    background: '#0b2a4a',
    backgroundLuminance: 0.14,
    gridMinor: 'rgba(160, 205, 255, 0.07)',
    gridMajor: 'rgba(160, 205, 255, 0.16)',
    axisX: 'rgba(255, 150, 150, 0.5)',
    axisY: 'rgba(160, 255, 190, 0.5)',
    extents: 'rgba(200, 225, 255, 0.3)',
    monochrome: '#e8f2ff',
    overlay: 'rgba(255, 214, 122, 0.95)',
    overlayText: '#eaf3ff',
  },
}

export const THEME_ORDER: ThemeId[] = ['dark', 'paper', 'blueprint']
