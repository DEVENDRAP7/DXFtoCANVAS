/**
 * The drawing viewport: canvas sizing, pointer interaction and the measure
 * overlay. All camera state lives in the parent so the toolbar and status bar
 * can read it; this component only turns gestures into camera updates.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Scene } from '../dxf/scene'
import type { Point2 } from '../dxf/types'
import { TEXT_FONT_STACK, type RenderOptions, type RenderResult, renderScene } from '../render/renderer'
import { findSnap, type SnapPoint } from '../render/snap'
import type { ViewportTheme } from '../render/theme'
import { type View, panBy, screenToWorld, worldToScreen, zoomAt } from '../render/view'

export interface MeasureState {
  start: Point2 | null
  end: Point2 | null
}

export type ToolId = 'pan' | 'measure'

/** Pixel radius within which the measure tool latches onto geometry. */
const SNAP_RADIUS_PX = 14
/** Pointer travel below this still counts as a click, not a drag. */
const CLICK_SLOP_PX = 4

type RenderFlags = Pick<
  RenderOptions,
  | 'visibleLayers'
  | 'linetypes'
  | 'linetypeScale'
  | 'showGrid'
  | 'showAxes'
  | 'showExtents'
  | 'showLineweights'
  | 'showText'
  | 'showFills'
  | 'isolatedLayer'
>

interface ViewportProps {
  scene: Scene | null
  view: View
  onViewChange: (update: (previous: View) => View) => void
  theme: ViewportTheme
  flags: RenderFlags
  tool: ToolId
  /** Space bar held: pan regardless of the active tool. */
  forcePan: boolean
  snapEnabled: boolean
  measure: MeasureState
  onMeasureChange: (measure: MeasureState) => void
  onCursorMove: (world: Point2 | null) => void
  onRenderStats: (stats: RenderResult) => void
  onResize: (width: number, height: number) => void
  /** Suffix for on-canvas distance labels, e.g. "mm". */
  unitSuffix: string
  children?: React.ReactNode
}

interface PointerRecord {
  x: number
  y: number
}

function formatLength(value: number, suffix: string): string {
  const magnitude = Math.abs(value)
  const decimals = magnitude >= 1000 ? 0 : magnitude >= 10 ? 1 : magnitude >= 1 ? 2 : 4
  return `${value.toFixed(decimals)}${suffix ? ` ${suffix}` : ''}`
}

/** Draws the snap marker, measure rubber band and its readout. */
function drawOverlay(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  theme: ViewportTheme,
  view: View,
  measure: MeasureState,
  hover: Point2 | null,
  snap: SnapPoint | null,
  unitSuffix: string,
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  if (snap) {
    const screen = worldToScreen(view, snap.x, snap.y)
    ctx.strokeStyle = theme.overlay
    ctx.lineWidth = 1.6
    ctx.beginPath()
    const size = 5
    switch (snap.kind) {
      case 'endpoint':
        ctx.rect(screen.x - size, screen.y - size, size * 2, size * 2)
        break
      case 'midpoint':
        ctx.moveTo(screen.x, screen.y - size - 1)
        ctx.lineTo(screen.x + size + 1, screen.y + size)
        ctx.lineTo(screen.x - size - 1, screen.y + size)
        ctx.closePath()
        break
      case 'center':
        ctx.arc(screen.x, screen.y, size + 0.5, 0, Math.PI * 2)
        break
      case 'quadrant':
        ctx.moveTo(screen.x, screen.y - size - 1)
        ctx.lineTo(screen.x + size + 1, screen.y)
        ctx.lineTo(screen.x, screen.y + size + 1)
        ctx.lineTo(screen.x - size - 1, screen.y)
        ctx.closePath()
        break
    }
    ctx.stroke()
  }

  const from = measure.start
  const to = measure.end ?? (measure.start ? hover : null)
  if (!from || !to) return

  const a = worldToScreen(view, from.x, from.y)
  const b = worldToScreen(view, to.x, to.y)

  ctx.strokeStyle = theme.overlay
  ctx.lineWidth = 1.4
  ctx.setLineDash([6, 4])
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.stroke()
  ctx.setLineDash([])

  // End ticks perpendicular to the measured direction.
  const angle = Math.atan2(b.y - a.y, b.x - a.x)
  const nx = -Math.sin(angle) * 6
  const ny = Math.cos(angle) * 6
  ctx.beginPath()
  for (const point of [a, b]) {
    ctx.moveTo(point.x - nx, point.y - ny)
    ctx.lineTo(point.x + nx, point.y + ny)
  }
  ctx.stroke()

  const distance = Math.hypot(to.x - from.x, to.y - from.y)
  const label = formatLength(distance, unitSuffix)
  ctx.font = `600 12px ${TEXT_FONT_STACK}`
  const width = ctx.measureText(label).width
  const midX = (a.x + b.x) / 2
  const midY = (a.y + b.y) / 2

  ctx.fillStyle = 'rgba(12, 16, 22, 0.92)'
  ctx.strokeStyle = theme.overlay
  ctx.lineWidth = 1
  const boxWidth = width + 16
  const boxHeight = 21
  ctx.beginPath()
  ctx.roundRect(midX - boxWidth / 2, midY - boxHeight / 2 - 14, boxWidth, boxHeight, 5)
  ctx.fill()
  ctx.stroke()

  ctx.fillStyle = '#e8edf5'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, midX, midY - 13)
}

export function Viewport({
  scene,
  view,
  onViewChange,
  theme,
  flags,
  tool,
  forcePan,
  snapEnabled,
  measure,
  onMeasureChange,
  onCursorMove,
  onRenderStats,
  onResize,
  unitSuffix,
  children,
}: ViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef(0)

  const [size, setSize] = useState({ width: 0, height: 0 })
  const [dpr, setDpr] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1))
  const [hover, setHover] = useState<Point2 | null>(null)
  const [snap, setSnap] = useState<SnapPoint | null>(null)
  const [panning, setPanning] = useState(false)

  const pointers = useRef(new Map<number, PointerRecord>())
  const dragOrigin = useRef<{ x: number; y: number; moved: number } | null>(null)
  const pinchRef = useRef<{ distance: number; centerX: number; centerY: number } | null>(null)

  // --- Sizing -------------------------------------------------------------

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const measureSize = () => {
      const rect = container.getBoundingClientRect()
      const width = Math.max(1, Math.round(rect.width))
      const height = Math.max(1, Math.round(rect.height))
      setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }))
      onResize(width, height)
    }

    measureSize()
    const observer = new ResizeObserver(measureSize)
    observer.observe(container)
    return () => observer.disconnect()
  }, [onResize])

  useEffect(() => {
    // devicePixelRatio changes when the window moves between displays or the
    // browser zoom level changes.
    const update = () => setDpr(window.devicePixelRatio || 1)
    const media = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [dpr])

  // --- Rendering ----------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.width === 0) return

    cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(() => {
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) return

      const deviceWidth = Math.round(size.width * dpr)
      const deviceHeight = Math.round(size.height * dpr)
      if (canvas.width !== deviceWidth || canvas.height !== deviceHeight) {
        canvas.width = deviceWidth
        canvas.height = deviceHeight
      }

      if (!scene) {
        context.setTransform(dpr, 0, 0, dpr, 0, 0)
        context.fillStyle = theme.background
        context.fillRect(0, 0, size.width, size.height)
        return
      }

      const stats = renderScene(context, scene, view, {
        ...flags,
        theme,
        width: size.width,
        height: size.height,
        devicePixelRatio: dpr,
      })

      drawOverlay(context, dpr, theme, view, measure, hover, snap, unitSuffix)
      onRenderStats(stats)
    })

    return () => cancelAnimationFrame(frameRef.current)
  }, [scene, view, theme, flags, size, dpr, measure, hover, snap, unitSuffix, onRenderStats])

  // --- Interaction --------------------------------------------------------

  const localPoint = useCallback((event: React.PointerEvent | React.MouseEvent | React.WheelEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }, [])

  const updateSnap = useCallback(
    (world: Point2) => {
      if (!scene || !snapEnabled || tool !== 'measure') {
        setSnap(null)
        return world
      }
      const found = findSnap(scene, world, SNAP_RADIUS_PX / view.scale, flags.visibleLayers)
      setSnap(found)
      return found ? { x: found.x, y: found.y } : world
    },
    [scene, snapEnabled, tool, view.scale, flags.visibleLayers],
  )

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const point = localPoint(event)
      pointers.current.set(event.pointerId, point)
      event.currentTarget.setPointerCapture(event.pointerId)

      if (pointers.current.size === 2) {
        const [first, second] = [...pointers.current.values()]
        pinchRef.current = {
          distance: Math.hypot(second.x - first.x, second.y - first.y),
          centerX: (first.x + second.x) / 2,
          centerY: (first.y + second.y) / 2,
        }
        setPanning(false)
        dragOrigin.current = null
        return
      }

      dragOrigin.current = { x: point.x, y: point.y, moved: 0 }
      const wantsPan = event.button === 1 || forcePan || tool === 'pan'
      if (wantsPan) setPanning(true)
    },
    [forcePan, localPoint, tool],
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const point = localPoint(event)
      const previous = pointers.current.get(event.pointerId)
      pointers.current.set(event.pointerId, point)

      // Two-finger pinch: zoom about the gesture centre and follow its drift.
      if (pointers.current.size === 2 && pinchRef.current) {
        const [first, second] = [...pointers.current.values()]
        const distance = Math.hypot(second.x - first.x, second.y - first.y)
        const centerX = (first.x + second.x) / 2
        const centerY = (first.y + second.y) / 2
        const previousPinch = pinchRef.current
        if (previousPinch.distance > 0 && distance > 0) {
          const factor = distance / previousPinch.distance
          onViewChange((current) =>
            panBy(
              zoomAt(current, centerX, centerY, factor),
              centerX - previousPinch.centerX,
              centerY - previousPinch.centerY,
            ),
          )
        }
        pinchRef.current = { distance, centerX, centerY }
        return
      }

      if (panning && previous) {
        const dx = point.x - previous.x
        const dy = point.y - previous.y
        if (dragOrigin.current) dragOrigin.current.moved += Math.abs(dx) + Math.abs(dy)
        onViewChange((current) => panBy(current, dx, dy))
        return
      }

      if (dragOrigin.current) {
        dragOrigin.current.moved += Math.hypot(point.x - (previous?.x ?? point.x), point.y - (previous?.y ?? point.y))
      }

      const world = screenToWorld(view, point.x, point.y)
      const snapped = updateSnap(world)
      setHover(snapped)
      onCursorMove(world)
    },
    [localPoint, onCursorMove, onViewChange, panning, updateSnap, view],
  )

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const point = localPoint(event)
      pointers.current.delete(event.pointerId)
      if (pointers.current.size < 2) pinchRef.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }

      const origin = dragOrigin.current
      dragOrigin.current = null
      const wasPanning = panning
      setPanning(false)

      const isClick = origin !== null && origin.moved <= CLICK_SLOP_PX && event.button === 0
      if (!isClick || wasPanning || tool !== 'measure') return

      const world = screenToWorld(view, point.x, point.y)
      const snapped = updateSnap(world)

      if (!measure.start || (measure.start && measure.end)) {
        onMeasureChange({ start: snapped, end: null })
      } else {
        onMeasureChange({ start: measure.start, end: snapped })
      }
    },
    [localPoint, measure, onMeasureChange, panning, tool, updateSnap, view],
  )

  const handlePointerLeave = useCallback(() => {
    setHover(null)
    setSnap(null)
    onCursorMove(null)
  }, [onCursorMove])

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLCanvasElement>) => {
      const point = localPoint(event)
      // Trackpad pinch arrives as a ctrl-modified wheel with finer deltas.
      const intensity = event.ctrlKey ? 0.01 : 0.0022
      const factor = Math.exp(-event.deltaY * intensity)
      onViewChange((current) => zoomAt(current, point.x, point.y, factor))
    },
    [localPoint, onViewChange],
  )

  useEffect(() => {
    // React attaches wheel listeners passively, which blocks preventDefault, so
    // the browser would zoom the whole page on a trackpad pinch.
    const canvas = canvasRef.current
    if (!canvas) return
    const block = (event: WheelEvent) => event.preventDefault()
    canvas.addEventListener('wheel', block, { passive: false })
    return () => canvas.removeEventListener('wheel', block)
  }, [])

  const cursorClass = panning || forcePan ? 'grabbing' : tool === 'measure' ? 'crosshair' : 'grab'

  return (
    <div className="stage" ref={containerRef}>
      <canvas
        ref={canvasRef}
        className={`viewport-canvas ${cursorClass}`}
        style={{ width: size.width, height: size.height }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onWheel={handleWheel}
        onContextMenu={(event) => event.preventDefault()}
      />
      {children}
    </div>
  )
}
