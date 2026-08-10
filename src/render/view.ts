/**
 * The 2D camera: a uniform scale plus a translation, with the Y axis flipped
 * because DXF measures Y upwards and the canvas measures it downwards.
 */

import type { Mat } from '../dxf/geometry'
import type { BoundingBox, Point2 } from '../dxf/types'

export interface View {
  /** Screen pixels per drawing unit. */
  scale: number
  /** Screen X of world origin, in CSS pixels. */
  tx: number
  /** Screen Y of world origin, in CSS pixels. */
  ty: number
}

export const MIN_SCALE = 1e-6
export const MAX_SCALE = 1e7

export function viewMatrix(view: View): Mat {
  return { a: view.scale, b: 0, c: 0, d: -view.scale, e: view.tx, f: view.ty }
}

export function worldToScreen(view: View, x: number, y: number): Point2 {
  return { x: x * view.scale + view.tx, y: -y * view.scale + view.ty }
}

export function screenToWorld(view: View, x: number, y: number): Point2 {
  return { x: (x - view.tx) / view.scale, y: (view.ty - y) / view.scale }
}

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/** Fits `bounds` inside a viewport, leaving a margin as a fraction of the smaller side. */
export function fitBounds(bounds: BoundingBox, width: number, height: number, margin = 0.06): View {
  const boundsWidth = bounds.maxX - bounds.minX
  const boundsHeight = bounds.maxY - bounds.minY

  if (width <= 0 || height <= 0) return { scale: 1, tx: 0, ty: 0 }

  const padding = Math.min(width, height) * margin
  const usableWidth = Math.max(1, width - padding * 2)
  const usableHeight = Math.max(1, height - padding * 2)

  // A drawing can legitimately be a single point or a perfectly straight line.
  const scale =
    boundsWidth > 1e-9 || boundsHeight > 1e-9
      ? clampScale(
          Math.min(
            boundsWidth > 1e-9 ? usableWidth / boundsWidth : Number.POSITIVE_INFINITY,
            boundsHeight > 1e-9 ? usableHeight / boundsHeight : Number.POSITIVE_INFINITY,
          ),
        )
      : 1

  const centerX = (bounds.minX + bounds.maxX) / 2
  const centerY = (bounds.minY + bounds.maxY) / 2

  return {
    scale,
    tx: width / 2 - centerX * scale,
    ty: height / 2 + centerY * scale,
  }
}

/** Zooms about a fixed screen point, so the geometry under the cursor stays put. */
export function zoomAt(view: View, screenX: number, screenY: number, factor: number): View {
  const scale = clampScale(view.scale * factor)
  const applied = scale / view.scale
  return {
    scale,
    tx: screenX - (screenX - view.tx) * applied,
    ty: screenY - (screenY - view.ty) * applied,
  }
}

export function panBy(view: View, dx: number, dy: number): View {
  return { scale: view.scale, tx: view.tx + dx, ty: view.ty + dy }
}

/** World-space rectangle currently visible, used for culling. */
export function visibleBounds(view: View, width: number, height: number): BoundingBox {
  const topLeft = screenToWorld(view, 0, 0)
  const bottomRight = screenToWorld(view, width, height)
  return {
    minX: Math.min(topLeft.x, bottomRight.x),
    minY: Math.min(topLeft.y, bottomRight.y),
    maxX: Math.max(topLeft.x, bottomRight.x),
    maxY: Math.max(topLeft.y, bottomRight.y),
  }
}

export function boundsIntersect(a: BoundingBox, b: BoundingBox): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
}

/**
 * Picks a round grid spacing (1, 2 or 5 × a power of ten) that lands near
 * `targetPixels` on screen at the current zoom.
 */
export function niceGridStep(view: View, targetPixels: number): number {
  const rawWorldStep = targetPixels / view.scale
  if (!Number.isFinite(rawWorldStep) || rawWorldStep <= 0) return 1
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawWorldStep)))
  const normalized = rawWorldStep / magnitude
  const step = normalized <= 1.5 ? 1 : normalized <= 3.5 ? 2 : normalized <= 7.5 ? 5 : 10
  return step * magnitude
}
