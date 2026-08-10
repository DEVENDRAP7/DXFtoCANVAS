/**
 * Turns a parsed document into a flat draw list.
 *
 * Block references are expanded (recursively, and including MINSERT grids),
 * BYLAYER / BYBLOCK inheritance is resolved to concrete colours and linetypes,
 * and every item carries the world transform the renderer should draw it under.
 * Curves stay parametric — only bounding boxes sample them.
 */

import { aciToRgb, COLOR_BYBLOCK, COLOR_BYLAYER } from './colors'
import {
  DEG,
  IDENTITY,
  type Mat,
  apply,
  bulgeToArc,
  meanScale,
  multiply,
  rotation,
  scaling,
  translation,
} from './geometry'
import type {
  BoundingBox,
  DxfDocument,
  DxfEntity,
  DxfLayer,
  EntityType,
  Point3,
} from './types'

/** One drawable entity, already placed in world space. */
export interface SceneItem {
  entity: Exclude<DxfEntity, { type: 'INSERT' }>
  /** Local (entity) space to world space. */
  matrix: Mat
  /** Resolved RGB, 0xRRGGBB. */
  rgb: number
  /** Layer whose visibility governs this item. */
  layer: string
  /** Resolved linetype name. */
  linetype: string
  /** Millimetres, or -1 when the drawing did not specify one. */
  lineweight: number
  /** Where the item came from, for the layer/entity breakdown. */
  blockPath: string
  /** World-space extents, filled in by `buildScene` and used to cull draws. */
  bounds: BoundingBox
}

export interface SceneStats {
  entityCounts: Map<EntityType, number>
  layerCounts: Map<string, number>
  totalItems: number
  expandedInserts: number
  /** True when only paper-space content was found and is being shown instead. */
  showingPaperSpace: boolean
}

export interface Scene {
  items: SceneItem[]
  bounds: BoundingBox
  stats: SceneStats
  warnings: string[]
}

/** Guards against blocks that reference themselves, directly or in a cycle. */
const MAX_BLOCK_DEPTH = 16
/** MINSERT grids can be declared absurdly large; keep expansion bounded. */
const MAX_MINSERT_CELLS = 4096

export const EMPTY_BOUNDS: BoundingBox = { minX: 0, minY: 0, maxX: 0, maxY: 0 }

function growBounds(bounds: BoundingBox, x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  if (x < bounds.minX) bounds.minX = x
  if (y < bounds.minY) bounds.minY = y
  if (x > bounds.maxX) bounds.maxX = x
  if (y > bounds.maxY) bounds.maxY = y
}

export function boundsWidth(bounds: BoundingBox): number {
  return bounds.maxX - bounds.minX
}

export function boundsHeight(bounds: BoundingBox): number {
  return bounds.maxY - bounds.minY
}

export function isEmptyBounds(bounds: BoundingBox): boolean {
  return !Number.isFinite(bounds.minX) || bounds.maxX < bounds.minX || bounds.maxY < bounds.minY
}

/**
 * Object Coordinate System to World, via the Arbitrary Axis Algorithm.
 *
 * Entities with an extrusion other than +Z store their points in a local frame.
 * The common case is (0,0,-1) — a mirrored entity — but the general form costs
 * little more and keeps rotated-plane drawings honest in top view.
 */
function ocsMatrix(extrusion: Point3 | undefined, elevation: number): Mat {
  if (!extrusion) return IDENTITY
  const { x: nx, y: ny, z: nz } = extrusion
  const length = Math.hypot(nx, ny, nz)
  if (length < 1e-12) return IDENTITY

  const n = { x: nx / length, y: ny / length, z: nz / length }
  if (Math.abs(n.x) < 1e-9 && Math.abs(n.y) < 1e-9 && n.z > 0) return IDENTITY

  // Pick the reference axis that is not near-parallel to the normal.
  const useY = Math.abs(n.x) < 1 / 64 && Math.abs(n.y) < 1 / 64
  const ref = useY ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 }

  let ax = {
    x: ref.y * n.z - ref.z * n.y,
    y: ref.z * n.x - ref.x * n.z,
    z: ref.x * n.y - ref.y * n.x,
  }
  const axLength = Math.hypot(ax.x, ax.y, ax.z)
  if (axLength < 1e-12) return IDENTITY
  ax = { x: ax.x / axLength, y: ax.y / axLength, z: ax.z / axLength }

  const ay = {
    x: n.y * ax.z - n.z * ax.y,
    y: n.z * ax.x - n.x * ax.z,
    z: n.x * ax.y - n.y * ax.x,
  }

  // Top view: keep the X/Y components and fold the elevation into the offset.
  return {
    a: ax.x,
    b: ax.y,
    c: ay.x,
    d: ay.y,
    e: n.x * elevation,
    f: n.y * elevation,
  }
}

interface InheritContext {
  /** Colour an entity marked BYBLOCK should take. */
  color: number
  /** Linetype an entity marked BYBLOCK should take. */
  linetype: string
  /** Layer a block's layer-0 entities should be promoted to. */
  layer: string
  lineweight: number
}

function resolveLayer(layers: Map<string, DxfLayer>, name: string): DxfLayer | undefined {
  return layers.get(name)
}

function resolveColor(entity: DxfEntity, layer: DxfLayer | undefined, context: InheritContext): number {
  if (entity.trueColor !== undefined) return entity.trueColor
  if (entity.color === COLOR_BYBLOCK) return context.color
  if (entity.color === COLOR_BYLAYER || entity.color === 0) {
    if (layer?.trueColor !== undefined) return layer.trueColor
    return aciToRgb(layer?.color ?? 7)
  }
  return aciToRgb(entity.color)
}

function resolveLinetype(entity: DxfEntity, layer: DxfLayer | undefined, context: InheritContext): string {
  const name = (entity.linetype || 'BYLAYER').toUpperCase()
  if (name === 'BYBLOCK') return context.linetype
  if (name === 'BYLAYER') return layer?.linetype ?? 'CONTINUOUS'
  return entity.linetype
}

function resolveLineweight(entity: DxfEntity, layer: DxfLayer | undefined, context: InheritContext): number {
  // -1 BYLAYER, -2 BYBLOCK, -3 default.
  if (entity.lineweight >= 0) return entity.lineweight / 100
  if (entity.lineweight === -2) return context.lineweight
  const fromLayer = layer?.lineweight ?? -3
  return fromLayer >= 0 ? fromLayer / 100 : -1
}

/**
 * Mean glyph advance as a fraction of the text height.
 *
 * Only used to estimate text extents, which never needs to be exact — it just
 * has to keep zoom-to-fit from clipping a label or leaving a huge empty margin.
 */
const AVERAGE_GLYPH_WIDTH = 0.62

/** Adds the four corners of a text box that is rotated about its origin. */
function addRotatedBox(
  add: (x: number, y: number) => void,
  origin: Point3,
  left: number,
  bottom: number,
  width: number,
  height: number,
  angle: number,
): void {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const corners: [number, number][] = [
    [left, bottom],
    [left + width, bottom],
    [left + width, bottom + height],
    [left, bottom + height],
  ]
  for (const [x, y] of corners) {
    add(origin.x + x * cos - y * sin, origin.y + x * sin + y * cos)
  }
}

/** Sample points used only to size the drawing; never drawn. */
function collectBoundsPoints(item: SceneItem, bounds: BoundingBox): void {
  const { entity, matrix } = item
  const add = (x: number, y: number) => {
    const world = apply(matrix, x, y)
    growBounds(bounds, world.x, world.y)
  }

  switch (entity.type) {
    case 'LINE':
      add(entity.start.x, entity.start.y)
      add(entity.end.x, entity.end.y)
      break

    case 'POINT':
      add(entity.position.x, entity.position.y)
      break

    case 'CIRCLE':
    case 'ARC': {
      // Sampling the sweep beats the naive centre±radius box for small arcs.
      const start = entity.type === 'ARC' ? entity.startAngle * DEG : 0
      const end = entity.type === 'ARC' ? entity.endAngle * DEG : Math.PI * 2
      let sweep = end - start
      if (sweep <= 0) sweep += Math.PI * 2
      const steps = 24
      for (let i = 0; i <= steps; i++) {
        const angle = start + (sweep * i) / steps
        add(entity.center.x + entity.radius * Math.cos(angle), entity.center.y + entity.radius * Math.sin(angle))
      }
      break
    }

    case 'ELLIPSE': {
      const minorX = -entity.majorAxis.y * entity.ratio
      const minorY = entity.majorAxis.x * entity.ratio
      let sweep = entity.endParam - entity.startParam
      if (sweep <= 1e-9) sweep += Math.PI * 2
      const steps = 32
      for (let i = 0; i <= steps; i++) {
        const t = entity.startParam + (sweep * i) / steps
        add(
          entity.center.x + entity.majorAxis.x * Math.cos(t) + minorX * Math.sin(t),
          entity.center.y + entity.majorAxis.y * Math.cos(t) + minorY * Math.sin(t),
        )
      }
      break
    }

    case 'POLYLINE': {
      const vertices = entity.vertices
      for (let i = 0; i < vertices.length; i++) {
        add(vertices[i].x, vertices[i].y)
        const next = vertices[(i + 1) % vertices.length]
        if (!vertices[i].bulge) continue
        if (i === vertices.length - 1 && !entity.closed) continue
        const arc = bulgeToArc(vertices[i], next, vertices[i].bulge)
        if (!arc) continue
        // The arc can bow outside the chord endpoints; sample it.
        for (let s = 1; s < 8; s++) {
          const a = arc.startAngle + ((arc.counterClockwise ? 1 : -1) * s * Math.PI) / 16
          add(arc.cx + arc.radius * Math.cos(a), arc.cy + arc.radius * Math.sin(a))
        }
      }
      break
    }

    case 'SPLINE':
      for (const point of entity.controlPoints) add(point.x, point.y)
      for (const point of entity.fitPoints) add(point.x, point.y)
      break

    case 'SOLID':
    case '3DFACE':
      for (const corner of entity.corners) add(corner.x, corner.y)
      break

    case 'LEADER':
      for (const vertex of entity.vertices) add(vertex.x, vertex.y)
      break

    case 'HATCH':
      for (const loop of entity.loops) for (const point of loop.points) add(point.x, point.y)
      break

    case 'TEXT': {
      const useAlignPoint = entity.alignPoint && (entity.hAlign !== 'left' || entity.vAlign !== 'baseline')
      const origin = useAlignPoint ? entity.alignPoint! : entity.position
      const width = entity.text.length * entity.height * AVERAGE_GLYPH_WIDTH * entity.widthFactor

      let left = 0
      if (entity.hAlign === 'center' || entity.hAlign === 'middle' || entity.hAlign === 'fit') left = -width / 2
      else if (entity.hAlign === 'right') left = -width

      let bottom = -entity.height * 0.25
      if (entity.vAlign === 'bottom') bottom = 0
      else if (entity.vAlign === 'middle') bottom = -entity.height / 2
      else if (entity.vAlign === 'top') bottom = -entity.height

      addRotatedBox(add, origin, left, bottom, width, entity.height, entity.rotation * DEG)
      break
    }

    case 'MTEXT': {
      const lines = entity.text.split('\n')
      const longest = lines.reduce((max, line) => Math.max(max, line.length), 0)
      const width = entity.referenceWidth || longest * entity.height * AVERAGE_GLYPH_WIDTH
      const height = Math.max(1, lines.length) * entity.height * 1.6

      // Attachment point: 1..3 top row, 4..6 middle row, 7..9 bottom row.
      const column = (entity.attachment - 1) % 3
      const row = Math.floor((entity.attachment - 1) / 3)
      const left = column === 0 ? 0 : column === 1 ? -width / 2 : -width
      const bottom = row === 0 ? -height : row === 1 ? -height / 2 : 0

      addRotatedBox(add, entity.position, left, bottom, width, height, entity.rotation * DEG)
      break
    }

    case 'DIMENSION':
      add(entity.textMidPoint.x, entity.textMidPoint.y)
      break

    case 'RAY':
      // Infinite construction lines must not drive the extents.
      add(entity.position.x, entity.position.y)
      break
  }
}

interface BuildState {
  document: DxfDocument
  items: SceneItem[]
  warnings: string[]
  expandedInserts: number
  truncated: boolean
}

function pushItem(
  state: BuildState,
  entity: SceneItem['entity'],
  matrix: Mat,
  context: InheritContext,
  blockPath: string,
): void {
  const layers = state.document.layers
  // Block content drawn on layer "0" adopts the layer of the reference.
  const layerName = entity.layer === '0' && context.layer !== '0' ? context.layer : entity.layer
  const layer = resolveLayer(layers, layerName)

  state.items.push({
    entity,
    matrix,
    rgb: resolveColor(entity, layer, context),
    layer: layerName,
    linetype: resolveLinetype(entity, layer, context),
    lineweight: resolveLineweight(entity, layer, context),
    blockPath,
    bounds: {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  })
}

function expandEntities(
  state: BuildState,
  entities: DxfEntity[],
  parentMatrix: Mat,
  context: InheritContext,
  depth: number,
  blockPath: string,
  blockStack: string[],
): void {
  for (const entity of entities) {
    if (state.items.length > 400_000) {
      state.truncated = true
      return
    }

    if (entity.type === 'INSERT') {
      expandInsert(state, entity, parentMatrix, context, depth, blockPath, blockStack)
      continue
    }

    if (entity.type === 'DIMENSION') {
      const block = entity.blockName ? state.document.blocks.get(entity.blockName) : undefined
      if (block && depth < MAX_BLOCK_DEPTH) {
        // Dimension blocks are already composed in world coordinates.
        const layers = state.document.layers
        const layerName = entity.layer === '0' && context.layer !== '0' ? context.layer : entity.layer
        const layer = resolveLayer(layers, layerName)
        const childContext: InheritContext = {
          color: resolveColor(entity, layer, context),
          linetype: resolveLinetype(entity, layer, context),
          layer: layerName,
          lineweight: resolveLineweight(entity, layer, context),
        }
        expandEntities(
          state,
          block.entities,
          parentMatrix,
          childContext,
          depth + 1,
          blockPath ? `${blockPath} › ${entity.blockName}` : entity.blockName,
          [...blockStack, entity.blockName],
        )
        continue
      }
      // No block to draw: fall through and let the renderer show the text.
    }

    const usesOcs =
      entity.type === 'CIRCLE' ||
      entity.type === 'ARC' ||
      entity.type === 'POLYLINE' ||
      entity.type === 'SOLID' ||
      entity.type === 'TEXT' ||
      entity.type === 'MTEXT' ||
      entity.type === 'POINT' ||
      entity.type === 'HATCH'

    const elevation = entity.type === 'POLYLINE' ? entity.elevation : 0
    const local = usesOcs ? ocsMatrix(entity.extrusion, elevation) : IDENTITY
    const matrix = local === IDENTITY ? parentMatrix : multiply(parentMatrix, local)

    pushItem(state, entity, matrix, context, blockPath)
  }
}

function expandInsert(
  state: BuildState,
  insert: Extract<DxfEntity, { type: 'INSERT' }>,
  parentMatrix: Mat,
  context: InheritContext,
  depth: number,
  blockPath: string,
  blockStack: string[],
): void {
  const block = state.document.blocks.get(insert.blockName)

  const layers = state.document.layers
  const layerName = insert.layer === '0' && context.layer !== '0' ? context.layer : insert.layer
  const layer = resolveLayer(layers, layerName)
  const childContext: InheritContext = {
    color: resolveColor(insert, layer, context),
    linetype: resolveLinetype(insert, layer, context),
    layer: layerName,
    lineweight: resolveLineweight(insert, layer, context),
  }

  // Attributes belong to the reference, not the block body, and are already
  // positioned in world space.
  const insertOcs = ocsMatrix(insert.extrusion, 0)
  const attributeMatrix = insertOcs === IDENTITY ? parentMatrix : multiply(parentMatrix, insertOcs)
  for (const attribute of insert.attributes) {
    pushItem(state, attribute, attributeMatrix, childContext, blockPath)
  }

  if (!block) {
    if (insert.blockName) state.warnings.push(`Block "${insert.blockName}" is referenced but not defined.`)
    return
  }
  if (depth >= MAX_BLOCK_DEPTH || blockStack.includes(insert.blockName)) {
    state.warnings.push(`Block "${insert.blockName}" nests into itself; stopped expanding it.`)
    return
  }

  const columns = Math.min(insert.columnCount, MAX_MINSERT_CELLS)
  const rows = Math.min(insert.rowCount, MAX_MINSERT_CELLS)
  const cells = Math.min(columns * rows, MAX_MINSERT_CELLS)
  let drawn = 0

  const scaleX = insert.scaleX || 1
  const scaleY = insert.scaleY || 1

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      if (drawn++ >= cells) break

      // Place, rotate, scale, then shift the block's base point to the origin.
      let matrix = multiply(
        parentMatrix,
        translation(insert.position.x + column * insert.columnSpacing, insert.position.y + row * insert.rowSpacing),
      )
      if (insert.extrusion) matrix = multiply(matrix, ocsMatrix(insert.extrusion, insert.position.z))
      if (insert.rotation) matrix = multiply(matrix, rotation(insert.rotation * DEG))
      if (scaleX !== 1 || scaleY !== 1) matrix = multiply(matrix, scaling(scaleX, scaleY))
      matrix = multiply(matrix, translation(-block.basePoint.x, -block.basePoint.y))

      state.expandedInserts++
      expandEntities(
        state,
        block.entities,
        matrix,
        childContext,
        depth + 1,
        blockPath ? `${blockPath} › ${insert.blockName}` : insert.blockName,
        [...blockStack, insert.blockName],
      )
    }
  }
}

export function buildScene(document: DxfDocument): Scene {
  const modelEntities = document.entities.filter((entity) => !entity.paperSpace)
  const paperEntities = document.entities.filter((entity) => entity.paperSpace)

  // Model space is what an architect means by "the drawing". Only fall back to
  // the paper-space sheet when model space has nothing in it.
  const showingPaperSpace = modelEntities.length === 0 && paperEntities.length > 0
  const source = showingPaperSpace ? paperEntities : modelEntities

  const state: BuildState = {
    document,
    items: [],
    warnings: [],
    expandedInserts: 0,
    truncated: false,
  }

  const rootContext: InheritContext = {
    color: 0xffffff,
    linetype: 'CONTINUOUS',
    layer: '0',
    lineweight: -1,
  }

  expandEntities(state, source, IDENTITY, rootContext, 0, '', [])

  if (state.truncated) {
    state.warnings.push('Drawing exceeded the draw-item budget; some block content was left out.')
  }

  const bounds: BoundingBox = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  }

  const entityCounts = new Map<EntityType, number>()
  const layerCounts = new Map<string, number>()

  for (const item of state.items) {
    collectBoundsPoints(item, item.bounds)
    if (!isEmptyBounds(item.bounds)) {
      growBounds(bounds, item.bounds.minX, item.bounds.minY)
      growBounds(bounds, item.bounds.maxX, item.bounds.maxY)
    }
    entityCounts.set(item.entity.type, (entityCounts.get(item.entity.type) ?? 0) + 1)
    layerCounts.set(item.layer, (layerCounts.get(item.layer) ?? 0) + 1)
  }

  const finalBounds = isEmptyBounds(bounds) ? { ...EMPTY_BOUNDS } : bounds

  return {
    items: state.items,
    bounds: finalBounds,
    stats: {
      entityCounts,
      layerCounts,
      totalItems: state.items.length,
      expandedInserts: state.expandedInserts,
      showingPaperSpace,
    },
    warnings: [...new Set(state.warnings)],
  }
}

/** Scale factor baked into an item's transform, for lineweight and tolerances. */
export function itemScale(item: SceneItem): number {
  return meanScale(item.matrix)
}

const UNIT_NAMES: Record<number, string> = {
  0: 'Unitless',
  1: 'Inches',
  2: 'Feet',
  3: 'Miles',
  4: 'Millimeters',
  5: 'Centimeters',
  6: 'Meters',
  7: 'Kilometers',
  8: 'Microinches',
  9: 'Mils',
  10: 'Yards',
  11: 'Angstroms',
  12: 'Nanometers',
  13: 'Microns',
  14: 'Decimeters',
  15: 'Decameters',
  16: 'Hectometers',
  17: 'Gigameters',
  18: 'Astronomical units',
  19: 'Light years',
  20: 'Parsecs',
}

export function unitName(insUnits: number): string {
  return UNIT_NAMES[insUnits] ?? 'Unknown'
}

/** Short suffix for on-screen measurements. */
export function unitSuffix(insUnits: number): string {
  switch (insUnits) {
    case 1:
      return 'in'
    case 2:
      return 'ft'
    case 4:
      return 'mm'
    case 5:
      return 'cm'
    case 6:
      return 'm'
    case 7:
      return 'km'
    default:
      return ''
  }
}
