/**
 * One-call pipeline from DXF text to something the viewport can draw, plus the
 * summary figures the sidebar reports.
 */

import { parseDxf } from './parser'
import { buildScene, type Scene } from './scene'
import type { DxfHeader, DxfLayer, DxfLinetype } from './types'

/** Top-level entities beyond this are dropped to keep the viewer usable. */
export const MAX_ENTITIES = 300_000

export interface Drawing {
  fileName: string
  fileSize: number
  header: DxfHeader
  /** Layer table in file order, with the ones actually used flagged. */
  layers: DxfLayer[]
  /** Keyed by upper-case name for case-insensitive lookup while rendering. */
  linetypes: Map<string, DxfLinetype>
  blockCount: number
  entityCount: number
  scene: Scene
  warnings: string[]
  parseMs: number
}

export function loadDrawing(text: string, fileName: string, fileSize: number): Drawing {
  const started = performance.now()

  const document = parseDxf(text, { maxEntities: MAX_ENTITIES })
  const scene = buildScene(document)

  const linetypes = new Map<string, DxfLinetype>()
  for (const linetype of document.linetypes.values()) {
    linetypes.set(linetype.name.toUpperCase(), linetype)
  }

  // Some writers reference layers they never declare; synthesise them so the
  // layer panel can still show and toggle their contents.
  const layers = [...document.layers.values()]
  const declared = new Set(layers.map((layer) => layer.name))
  for (const name of scene.stats.layerCounts.keys()) {
    if (declared.has(name)) continue
    layers.push({
      name,
      color: 7,
      linetype: 'CONTINUOUS',
      lineweight: -3,
      off: false,
      frozen: false,
      locked: false,
    })
  }

  return {
    fileName,
    fileSize,
    header: document.header,
    layers,
    linetypes,
    blockCount: document.blocks.size,
    entityCount: document.entities.length,
    scene,
    warnings: [...document.warnings, ...scene.warnings],
    parseMs: performance.now() - started,
  }
}
