/**
 * Canvas 2D renderer.
 *
 * Two ideas keep this fast and sharp at any zoom:
 *
 * 1. Curves are never pre-tessellated. Each entity's path is added while the
 *    context transform is world→screen, so `arc`/`ellipse` stay analytic.
 * 2. Because canvas stores path points in device space at the moment they are
 *    added, the transform can be reset to identity before stroking. That gives
 *    constant-width hairlines and pixel-space dash patterns for free, and lets
 *    consecutive entities that share a style be merged into one path.
 */

import { contrastAgainst, rgbToCss } from '../dxf/colors'
import {
  DEG,
  type Mat,
  bulgeToArc,
  meanScale,
  multiply,
  rotation,
  sampleCatmullRom,
  sampleSpline,
  scaling,
  translation,
} from '../dxf/geometry'
import type { Scene, SceneItem } from '../dxf/scene'
import type { BoundingBox, DxfLinetype } from '../dxf/types'
import type { ViewportTheme } from './theme'
import { type View, boundsIntersect, niceGridStep, viewMatrix, visibleBounds, worldToScreen } from './view'

/** Glyph em size used for text; the transform scales it to the drawing height. */
const FONT_EM = 100
/** Text smaller than this many screen pixels is unreadable, so it is skipped. */
const MIN_TEXT_PIXELS = 3.2
/** Dashes shorter than this collapse into a solid line to save fill rate. */
const MIN_DASH_PIXELS = 0.9
/** Subpaths per batched stroke; keeps any single path from growing unbounded. */
const MAX_BATCH_SUBPATHS = 4000
/**
 * Solid fills are nearly opaque, the way a CAD viewer plots them, but stop just
 * short so a wall poché does not completely swallow anything drawn beneath it.
 */
const FILL_ALPHA = 0.88
/** Pattern hatch rules are lighter than solid fills so they read as texture. */
const HATCH_LINE_ALPHA = 0.55

export const TEXT_FONT_STACK =
  '"Helvetica Neue", Helvetica, "Segoe UI", Arial, "Noto Sans", "DejaVu Sans", sans-serif'

export interface RenderOptions {
  theme: ViewportTheme
  /** CSS pixel size of the canvas. */
  width: number
  height: number
  devicePixelRatio: number
  /** Layers absent from this set are hidden. */
  visibleLayers: ReadonlySet<string>
  linetypes: Map<string, DxfLinetype>
  /** Global linetype scale, the equivalent of LTSCALE. */
  linetypeScale: number
  showGrid: boolean
  showAxes: boolean
  showExtents: boolean
  /** Draw real lineweights instead of uniform hairlines. */
  showLineweights: boolean
  /** Draw text entities; turning it off speeds up very text-heavy plans. */
  showText: boolean
  /** Fill hatches and solids. */
  showFills: boolean
  /** When set, everything on other layers is dimmed. */
  isolatedLayer: string | null
}

export interface RenderResult {
  drawn: number
  culled: number
  hidden: number
  /** Milliseconds spent in this frame. */
  elapsed: number
}

function setMatrix(ctx: CanvasRenderingContext2D, dpr: number, m: Mat): void {
  ctx.setTransform(dpr * m.a, dpr * m.b, dpr * m.c, dpr * m.d, dpr * m.e, dpr * m.f)
}

function setScreenSpace(ctx: CanvasRenderingContext2D, dpr: number): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
}

/**
 * Accumulates same-styled subpaths into a single stroke call.
 *
 * Paths are recorded in device space, so items with completely different world
 * transforms can still share one batch.
 */
class StrokeBatch {
  private styleKey = ''
  private strokeStyle = '#fff'
  private lineWidth = 1
  private dash: number[] = []
  private subpaths = 0
  private open = false

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly dpr: number,
  ) {}

  use(strokeStyle: string, lineWidth: number, dash: number[]): void {
    const key = `${strokeStyle}|${lineWidth.toFixed(2)}|${dash.join(',')}`
    if (key !== this.styleKey || this.subpaths >= MAX_BATCH_SUBPATHS) {
      this.flush()
      this.styleKey = key
      this.strokeStyle = strokeStyle
      this.lineWidth = lineWidth
      this.dash = dash
    }
    if (!this.open) {
      this.ctx.beginPath()
      this.open = true
      this.subpaths = 0
    }
    this.subpaths++
  }

  flush(): void {
    if (!this.open) return
    setScreenSpace(this.ctx, this.dpr)
    this.ctx.strokeStyle = this.strokeStyle
    this.ctx.lineWidth = this.lineWidth
    this.ctx.setLineDash(this.dash)
    this.ctx.stroke()
    this.ctx.setLineDash([])
    this.open = false
    this.subpaths = 0
  }
}

/** Converts a linetype definition into a pixel dash array at the current zoom. */
function dashPattern(
  linetype: DxfLinetype | undefined,
  pixelsPerUnit: number,
  globalScale: number,
  lineWidth: number,
): number[] {
  if (!linetype || linetype.pattern.length === 0) return []

  const dash: number[] = []
  let total = 0
  for (const segment of linetype.pattern) {
    // A zero-length element is a dot: render it as a square cap's worth of ink.
    const length = Math.abs(segment) * pixelsPerUnit * globalScale
    const value = segment === 0 ? lineWidth : length
    dash.push(value)
    total += value
  }
  if (dash.length % 2 === 1) dash.push(dash[dash.length - 1])
  if (total < MIN_DASH_PIXELS * dash.length) return []
  // Dashes finer than the pen are indistinguishable from a solid line.
  if (total / dash.length < MIN_DASH_PIXELS) return []
  return dash
}

function strokeWidthFor(item: SceneItem, options: RenderOptions): number {
  if (!options.showLineweights || item.lineweight <= 0) return 1
  // Lineweights are a plotted-millimetre property and stay constant on screen,
  // the same way AutoCAD shows them in model space.
  const pixels = item.lineweight * (96 / 25.4)
  return Math.max(1, Math.min(10, pixels))
}

function colorFor(item: SceneItem, options: RenderOptions): string {
  if (options.theme.monochrome) return options.theme.monochrome
  return rgbToCss(contrastAgainst(item.rgb, options.theme.backgroundLuminance))
}

/** Adds one entity's outline to the current path, in the item's local space. */
function addEntityPath(
  ctx: CanvasRenderingContext2D,
  item: SceneItem,
  worldTolerance: number,
  visible: BoundingBox,
): void {
  const entity = item.entity

  switch (entity.type) {
    case 'LINE':
      ctx.moveTo(entity.start.x, entity.start.y)
      ctx.lineTo(entity.end.x, entity.end.y)
      break

    case 'CIRCLE':
      ctx.moveTo(entity.center.x + entity.radius, entity.center.y)
      ctx.arc(entity.center.x, entity.center.y, entity.radius, 0, Math.PI * 2)
      break

    case 'ARC': {
      const start = entity.startAngle * DEG
      const end = entity.endAngle * DEG
      ctx.moveTo(entity.center.x + entity.radius * Math.cos(start), entity.center.y + entity.radius * Math.sin(start))
      ctx.arc(entity.center.x, entity.center.y, entity.radius, start, end, false)
      break
    }

    case 'ELLIPSE': {
      const majorLength = Math.hypot(entity.majorAxis.x, entity.majorAxis.y)
      if (majorLength < 1e-12) break
      const tilt = Math.atan2(entity.majorAxis.y, entity.majorAxis.x)
      let sweep = entity.endParam - entity.startParam
      if (sweep <= 1e-9) sweep += Math.PI * 2
      const isFull = Math.abs(sweep - Math.PI * 2) < 1e-6
      if (!isFull) {
        // Move to the true start so the arc is not joined to the previous subpath.
        const cos = Math.cos(entity.startParam)
        const sin = Math.sin(entity.startParam)
        const minorX = -entity.majorAxis.y * entity.ratio
        const minorY = entity.majorAxis.x * entity.ratio
        ctx.moveTo(
          entity.center.x + entity.majorAxis.x * cos + minorX * sin,
          entity.center.y + entity.majorAxis.y * cos + minorY * sin,
        )
      }
      ctx.ellipse(
        entity.center.x,
        entity.center.y,
        majorLength,
        majorLength * entity.ratio,
        tilt,
        entity.startParam,
        entity.startParam + sweep,
        false,
      )
      break
    }

    case 'POLYLINE': {
      const vertices = entity.vertices
      if (vertices.length === 0) break
      ctx.moveTo(vertices[0].x, vertices[0].y)
      const segments = entity.closed ? vertices.length : vertices.length - 1
      for (let i = 0; i < segments; i++) {
        const from = vertices[i]
        const to = vertices[(i + 1) % vertices.length]
        const arc = from.bulge ? bulgeToArc(from, to, from.bulge) : null
        if (arc) {
          ctx.arc(arc.cx, arc.cy, arc.radius, arc.startAngle, arc.endAngle, !arc.counterClockwise)
        } else {
          ctx.lineTo(to.x, to.y)
        }
      }
      if (entity.closed) ctx.closePath()
      break
    }

    case 'SPLINE': {
      const control = entity.controlPoints
      const points =
        control.length >= 2
          ? sampleSpline(
              control,
              entity.degree,
              entity.knots,
              entity.weights,
              Math.max(24, Math.min(600, control.length * 16)),
            )
          : sampleCatmullRom(entity.fitPoints)
      if (points.length < 2) break
      ctx.moveTo(points[0].x, points[0].y)
      for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y)
      if (entity.closed) ctx.closePath()
      break
    }

    case 'SOLID':
    case '3DFACE': {
      const corners = entity.corners
      if (corners.length < 3) break
      ctx.moveTo(corners[0].x, corners[0].y)
      for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i].x, corners[i].y)
      ctx.closePath()
      break
    }

    case 'LEADER': {
      const vertices = entity.vertices
      if (vertices.length < 2) break
      ctx.moveTo(vertices[0].x, vertices[0].y)
      for (let i = 1; i < vertices.length; i++) ctx.lineTo(vertices[i].x, vertices[i].y)
      break
    }

    case 'HATCH': {
      for (const loop of entity.loops) {
        if (loop.points.length < 2) continue
        ctx.moveTo(loop.points[0].x, loop.points[0].y)
        for (let i = 1; i < loop.points.length; i++) ctx.lineTo(loop.points[i].x, loop.points[i].y)
        ctx.closePath()
      }
      break
    }

    case 'POINT': {
      // A visible tick rather than a mathematical point; sized in world units
      // so it batches with everything else.
      const size = worldTolerance * 3
      ctx.moveTo(entity.position.x - size, entity.position.y)
      ctx.lineTo(entity.position.x + size, entity.position.y)
      ctx.moveTo(entity.position.x, entity.position.y - size)
      ctx.lineTo(entity.position.x, entity.position.y + size)
      break
    }

    case 'RAY': {
      const dx = entity.direction.x
      const dy = entity.direction.y
      const length = Math.hypot(dx, dy)
      if (length < 1e-12) break
      // Construction lines are infinite: extend well past the visible window.
      const reach =
        (Math.hypot(visible.maxX - visible.minX, visible.maxY - visible.minY) +
          Math.hypot(entity.position.x, entity.position.y)) *
        4
      const ux = (dx / length) * reach
      const uy = (dy / length) * reach
      const startX = entity.bidirectional ? entity.position.x - ux : entity.position.x
      const startY = entity.bidirectional ? entity.position.y - uy : entity.position.y
      ctx.moveTo(startX, startY)
      ctx.lineTo(entity.position.x + ux, entity.position.y + uy)
      break
    }

    default:
      break
  }
}

interface TextDraw {
  item: SceneItem
  color: string
  alpha: number
}

/** Wraps a paragraph to `maxWidth`, measured in the current font. */
function wrapLine(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (maxWidth <= 0 || ctx.measureText(text).width <= maxWidth) return [text]
  const words = text.split(/(\s+)/)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current + word
    if (current && ctx.measureText(candidate).width > maxWidth) {
      lines.push(current.trimEnd())
      current = word.trimStart()
    } else {
      current = candidate
    }
  }
  if (current.trim()) lines.push(current.trimEnd())
  return lines.length > 0 ? lines : ['']
}

function drawTextEntity(
  ctx: CanvasRenderingContext2D,
  draw: TextDraw,
  view: View,
  options: RenderOptions,
): void {
  const { item } = draw
  const entity = item.entity
  const dpr = options.devicePixelRatio
  const world = multiply(viewMatrix(view), item.matrix)

  ctx.globalAlpha = draw.alpha
  ctx.fillStyle = draw.color

  if (entity.type === 'TEXT') {
    const screenHeight = entity.height * meanScale(world)
    if (screenHeight < MIN_TEXT_PIXELS) return

    const useAlignPoint = entity.alignPoint && (entity.hAlign !== 'left' || entity.vAlign !== 'baseline')
    const origin = useAlignPoint ? entity.alignPoint! : entity.position

    let transform = multiply(world, translation(origin.x, origin.y))
    if (entity.rotation) transform = multiply(transform, rotation(entity.rotation * DEG))
    if (entity.mirrorX) transform = multiply(transform, scaling(-1, 1))
    if (entity.mirrorY) transform = multiply(transform, scaling(1, -1))
    if (entity.oblique) {
      const skew = Math.tan(Math.max(-60, Math.min(60, entity.oblique)) * DEG)
      transform = multiply(transform, { a: 1, b: 0, c: skew, d: 1, e: 0, f: 0 })
    }
    const unit = entity.height / FONT_EM
    transform = multiply(transform, scaling(unit * entity.widthFactor, unit))
    // Canvas grows glyphs downwards; DXF text grows upwards.
    transform = multiply(transform, scaling(1, -1))

    setMatrix(ctx, dpr, transform)
    ctx.font = `${FONT_EM}px ${TEXT_FONT_STACK}`
    ctx.textAlign = entity.hAlign === 'center' || entity.hAlign === 'middle' ? 'center' : entity.hAlign === 'right' ? 'right' : 'left'
    ctx.textBaseline =
      entity.vAlign === 'middle' ? 'middle' : entity.vAlign === 'top' ? 'top' : entity.vAlign === 'bottom' ? 'bottom' : 'alphabetic'

    // "Fit" and "aligned" text stretches between the two alignment points.
    if ((entity.hAlign === 'fit' || entity.hAlign === 'aligned') && entity.alignPoint) {
      const span = Math.hypot(entity.alignPoint.x - entity.position.x, entity.alignPoint.y - entity.position.y)
      const natural = ctx.measureText(entity.text).width * unit
      if (natural > 1e-9 && span > 1e-9) {
        setMatrix(ctx, dpr, multiply(transform, scaling(span / natural, 1)))
      }
      ctx.textAlign = 'left'
    }

    ctx.fillText(entity.text, 0, 0)
    return
  }

  if (entity.type === 'MTEXT') {
    const screenHeight = entity.height * meanScale(world)
    if (screenHeight < MIN_TEXT_PIXELS) return

    let transform = multiply(world, translation(entity.position.x, entity.position.y))
    if (entity.rotation) transform = multiply(transform, rotation(entity.rotation * DEG))
    const unit = entity.height / FONT_EM
    transform = multiply(transform, scaling(unit, unit))
    transform = multiply(transform, scaling(1, -1))

    setMatrix(ctx, dpr, transform)
    ctx.font = `${FONT_EM}px ${TEXT_FONT_STACK}`

    const maxWidth = entity.referenceWidth > 0 ? entity.referenceWidth / unit : 0
    const lines: string[] = []
    for (const paragraph of entity.text.split('\n')) {
      for (const line of wrapLine(ctx, paragraph, maxWidth)) lines.push(line)
    }

    const lineHeight = FONT_EM * 1.6 * (entity.lineSpacing || 1)
    const column = ((entity.attachment - 1) % 3) as 0 | 1 | 2
    const row = Math.floor((entity.attachment - 1) / 3) as 0 | 1 | 2

    ctx.textAlign = column === 0 ? 'left' : column === 1 ? 'center' : 'right'
    ctx.textBaseline = 'alphabetic'

    // Attachment rows: 0 top, 1 middle, 2 bottom of the whole text block.
    const blockHeight = lineHeight * lines.length
    const firstBaseline =
      row === 0 ? FONT_EM * 0.8 : row === 1 ? blockHeight / 2 - lineHeight + FONT_EM * 0.8 : blockHeight - lineHeight + FONT_EM * 0.8

    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], 0, firstBaseline + i * lineHeight)
    }
    return
  }

  if (entity.type === 'DIMENSION' && entity.text) {
    // Only reached when the dimension's geometry block is missing.
    const screen = worldToScreen(view, entity.textMidPoint.x, entity.textMidPoint.y)
    setScreenSpace(ctx, dpr)
    ctx.font = `12px ${TEXT_FONT_STACK}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(entity.text, screen.x, screen.y)
  }
}

/** Fills hatches and solids, including a simple line pattern for non-solid hatches. */
function drawFill(ctx: CanvasRenderingContext2D, item: SceneItem, view: View, options: RenderOptions, alpha: number): void {
  const entity = item.entity
  const dpr = options.devicePixelRatio
  const world = multiply(viewMatrix(view), item.matrix)
  const color = colorFor(item, options)

  if (entity.type === 'SOLID' || entity.type === '3DFACE') {
    if (entity.corners.length < 3) return
    setMatrix(ctx, dpr, world)
    ctx.beginPath()
    ctx.moveTo(entity.corners[0].x, entity.corners[0].y)
    for (let i = 1; i < entity.corners.length; i++) ctx.lineTo(entity.corners[i].x, entity.corners[i].y)
    ctx.closePath()
    setScreenSpace(ctx, dpr)
    ctx.globalAlpha = alpha
    ctx.fillStyle = color
    ctx.fill()
    return
  }

  if (entity.type !== 'HATCH' || entity.loops.length === 0) return

  setMatrix(ctx, dpr, world)
  ctx.beginPath()
  for (const loop of entity.loops) {
    if (loop.points.length < 2) continue
    ctx.moveTo(loop.points[0].x, loop.points[0].y)
    for (let i = 1; i < loop.points.length; i++) ctx.lineTo(loop.points[i].x, loop.points[i].y)
    ctx.closePath()
  }
  setScreenSpace(ctx, dpr)

  if (entity.solid) {
    ctx.globalAlpha = alpha
    ctx.fillStyle = color
    ctx.fill('evenodd')
    return
  }

  // Pattern hatches: the .pat definitions are not in the DXF, so draw evenly
  // spaced rules inside the boundary. It reads as hatching without pretending
  // to be the exact pattern.
  ctx.save()
  ctx.clip('evenodd')

  const screenBounds = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  }
  for (const loop of entity.loops) {
    for (const point of loop.points) {
      const screen = { x: world.a * point.x + world.c * point.y + world.e, y: world.b * point.x + world.d * point.y + world.f }
      screenBounds.minX = Math.min(screenBounds.minX, screen.x)
      screenBounds.minY = Math.min(screenBounds.minY, screen.y)
      screenBounds.maxX = Math.max(screenBounds.maxX, screen.x)
      screenBounds.maxY = Math.max(screenBounds.maxY, screen.y)
    }
  }

  const spacing = Math.max(4, Math.min(48, entity.patternScale * 0.125 * view.scale * meanScale(item.matrix)))
  const diagonal = Math.hypot(screenBounds.maxX - screenBounds.minX, screenBounds.maxY - screenBounds.minY)

  if (Number.isFinite(diagonal) && diagonal > 0 && diagonal / spacing < 4000) {
    const centerX = (screenBounds.minX + screenBounds.maxX) / 2
    const centerY = (screenBounds.minY + screenBounds.maxY) / 2
    const upper = entity.patternName.toUpperCase()
    const crossed = /NET|CROSS|ANSI3[2-8]|GRATE|BRICK|SQUARE/.test(upper)
    // Screen Y is flipped relative to the drawing, hence the negated angle.
    const angles = crossed ? [-entity.patternAngle, -entity.patternAngle + 90] : [-entity.patternAngle]

    ctx.globalAlpha = alpha * HATCH_LINE_ALPHA
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const angleDegrees of angles) {
      const angle = angleDegrees * DEG
      const dirX = Math.cos(angle)
      const dirY = Math.sin(angle)
      const normalX = -dirX
      const normalY = -dirY
      const count = Math.ceil(diagonal / spacing) + 1
      for (let i = -count; i <= count; i++) {
        const offsetX = centerX + normalY * i * spacing
        const offsetY = centerY - normalX * i * spacing
        ctx.moveTo(offsetX - dirX * diagonal, offsetY - dirY * diagonal)
        ctx.lineTo(offsetX + dirX * diagonal, offsetY + dirY * diagonal)
      }
    }
    ctx.stroke()
  }

  ctx.restore()
}

function drawGrid(ctx: CanvasRenderingContext2D, view: View, options: RenderOptions): void {
  const { width, height, theme, devicePixelRatio: dpr } = options
  setScreenSpace(ctx, dpr)

  const minorStep = niceGridStep(view, 14)
  const majorStep = minorStep * 5
  const world = visibleBounds(view, width, height)

  const drawLines = (step: number, style: string) => {
    const count = (world.maxX - world.minX) / step + (world.maxY - world.minY) / step
    if (!Number.isFinite(count) || count > 1200) return

    ctx.beginPath()
    const startX = Math.floor(world.minX / step) * step
    for (let x = startX; x <= world.maxX; x += step) {
      const screenX = Math.round(x * view.scale + view.tx) + 0.5
      ctx.moveTo(screenX, 0)
      ctx.lineTo(screenX, height)
    }
    const startY = Math.floor(world.minY / step) * step
    for (let y = startY; y <= world.maxY; y += step) {
      const screenY = Math.round(-y * view.scale + view.ty) + 0.5
      ctx.moveTo(0, screenY)
      ctx.lineTo(width, screenY)
    }
    ctx.strokeStyle = style
    ctx.lineWidth = 1
    ctx.stroke()
  }

  drawLines(minorStep, theme.gridMinor)
  drawLines(majorStep, theme.gridMajor)
}

function drawAxes(ctx: CanvasRenderingContext2D, view: View, options: RenderOptions): void {
  const { width, height, theme, devicePixelRatio: dpr } = options
  setScreenSpace(ctx, dpr)
  const origin = worldToScreen(view, 0, 0)

  ctx.lineWidth = 1.25
  if (origin.y >= -1 && origin.y <= height + 1) {
    ctx.beginPath()
    ctx.moveTo(0, Math.round(origin.y) + 0.5)
    ctx.lineTo(width, Math.round(origin.y) + 0.5)
    ctx.strokeStyle = theme.axisX
    ctx.stroke()
  }
  if (origin.x >= -1 && origin.x <= width + 1) {
    ctx.beginPath()
    ctx.moveTo(Math.round(origin.x) + 0.5, 0)
    ctx.lineTo(Math.round(origin.x) + 0.5, height)
    ctx.strokeStyle = theme.axisY
    ctx.stroke()
  }
}

function drawExtents(ctx: CanvasRenderingContext2D, bounds: BoundingBox, view: View, options: RenderOptions): void {
  setScreenSpace(ctx, options.devicePixelRatio)
  const topLeft = worldToScreen(view, bounds.minX, bounds.maxY)
  const bottomRight = worldToScreen(view, bounds.maxX, bounds.minY)
  ctx.strokeStyle = options.theme.extents
  ctx.lineWidth = 1
  ctx.setLineDash([6, 5])
  ctx.strokeRect(
    Math.round(topLeft.x) + 0.5,
    Math.round(topLeft.y) + 0.5,
    Math.round(bottomRight.x - topLeft.x),
    Math.round(bottomRight.y - topLeft.y),
  )
  ctx.setLineDash([])
}

export function renderScene(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  view: View,
  options: RenderOptions,
): RenderResult {
  const started = performance.now()
  const dpr = options.devicePixelRatio

  setScreenSpace(ctx, dpr)
  ctx.globalAlpha = 1
  ctx.fillStyle = options.theme.background
  ctx.fillRect(0, 0, options.width, options.height)
  ctx.lineCap = 'butt'
  ctx.lineJoin = 'round'

  if (options.showGrid) drawGrid(ctx, view, options)
  if (options.showAxes) drawAxes(ctx, view, options)
  if (options.showExtents && scene.items.length > 0) drawExtents(ctx, scene.bounds, view, options)

  const visible = visibleBounds(view, options.width, options.height)
  // A generous margin keeps wide strokes and text from popping at the edges.
  const marginX = (visible.maxX - visible.minX) * 0.08
  const marginY = (visible.maxY - visible.minY) * 0.08
  const cullBounds: BoundingBox = {
    minX: visible.minX - marginX,
    minY: visible.minY - marginY,
    maxX: visible.maxX + marginX,
    maxY: visible.maxY + marginY,
  }

  const worldPerPixel = 1 / view.scale
  const batch = new StrokeBatch(ctx, dpr)
  const deferredText: TextDraw[] = []

  let drawn = 0
  let culled = 0
  let hidden = 0

  // Fills first so outlines and text sit on top of them.
  if (options.showFills) {
    for (const item of scene.items) {
      const type = item.entity.type
      if (type !== 'HATCH' && type !== 'SOLID' && type !== '3DFACE') continue
      if (!options.visibleLayers.has(item.layer)) continue
      if (!boundsIntersect(item.bounds, cullBounds)) continue
      const alpha = options.isolatedLayer && item.layer !== options.isolatedLayer ? 0.12 : FILL_ALPHA
      drawFill(ctx, item, view, options, alpha)
    }
    ctx.globalAlpha = 1
  }

  for (const item of scene.items) {
    if (!options.visibleLayers.has(item.layer)) {
      hidden++
      continue
    }
    if (item.entity.type !== 'RAY' && !boundsIntersect(item.bounds, cullBounds)) {
      culled++
      continue
    }

    const dimmed = options.isolatedLayer !== null && item.layer !== options.isolatedLayer
    const type = item.entity.type

    if (type === 'TEXT' || type === 'MTEXT' || (type === 'DIMENSION' && item.entity.text)) {
      if (options.showText) {
        deferredText.push({ item, color: colorFor(item, options), alpha: dimmed ? 0.15 : 1 })
        drawn++
      }
      continue
    }

    let stroke = colorFor(item, options)
    if (dimmed) {
      const rgb = contrastAgainst(item.rgb, options.theme.backgroundLuminance)
      stroke = `rgba(${(rgb >> 16) & 0xff}, ${(rgb >> 8) & 0xff}, ${rgb & 0xff}, 0.13)`
    }

    const width = strokeWidthFor(item, options)
    const linetype = options.linetypes.get(item.linetype.toUpperCase()) ?? options.linetypes.get(item.linetype)
    const dash = dashPattern(linetype, view.scale * meanScale(item.matrix), options.linetypeScale, width)

    batch.use(stroke, width, dash)
    setMatrix(ctx, dpr, multiply(viewMatrix(view), item.matrix))
    addEntityPath(ctx, item, worldPerPixel / meanScale(item.matrix), visible)
    drawn++
  }

  batch.flush()

  for (const draw of deferredText) drawTextEntity(ctx, draw, view, options)

  ctx.globalAlpha = 1
  setScreenSpace(ctx, dpr)

  return { drawn, culled, hidden, elapsed: performance.now() - started }
}
