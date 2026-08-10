/**
 * Object snapping for the measure tool.
 *
 * Rather than maintaining a spatial index, this scans only the items whose
 * bounding box already contains the cursor. At a useful snap radius that is a
 * handful of entities even in a busy drawing.
 */

import { apply } from '../dxf/geometry'
import type { Scene, SceneItem } from '../dxf/scene'
import type { Point2 } from '../dxf/types'

export type SnapKind = 'endpoint' | 'midpoint' | 'center' | 'quadrant'

export interface SnapPoint extends Point2 {
  kind: SnapKind
}

/** Snap kinds in priority order when two candidates are equally close. */
const PRIORITY: Record<SnapKind, number> = {
  endpoint: 0,
  center: 1,
  quadrant: 2,
  midpoint: 3,
}

/** Upper bound on entities examined per query, so a dense area cannot stall panning. */
const MAX_SCANNED = 600

function collectFrom(item: SceneItem, out: SnapPoint[]): void {
  const entity = item.entity
  const push = (x: number, y: number, kind: SnapKind) => {
    const world = apply(item.matrix, x, y)
    out.push({ x: world.x, y: world.y, kind })
  }

  switch (entity.type) {
    case 'LINE':
      push(entity.start.x, entity.start.y, 'endpoint')
      push(entity.end.x, entity.end.y, 'endpoint')
      push((entity.start.x + entity.end.x) / 2, (entity.start.y + entity.end.y) / 2, 'midpoint')
      break

    case 'POINT':
      push(entity.position.x, entity.position.y, 'endpoint')
      break

    case 'CIRCLE':
    case 'ARC': {
      push(entity.center.x, entity.center.y, 'center')
      const r = entity.radius
      for (const [dx, dy] of [
        [r, 0],
        [-r, 0],
        [0, r],
        [0, -r],
      ]) {
        push(entity.center.x + dx, entity.center.y + dy, 'quadrant')
      }
      if (entity.type === 'ARC') {
        const start = (entity.startAngle * Math.PI) / 180
        const end = (entity.endAngle * Math.PI) / 180
        push(entity.center.x + r * Math.cos(start), entity.center.y + r * Math.sin(start), 'endpoint')
        push(entity.center.x + r * Math.cos(end), entity.center.y + r * Math.sin(end), 'endpoint')
      }
      break
    }

    case 'ELLIPSE':
      push(entity.center.x, entity.center.y, 'center')
      break

    case 'POLYLINE': {
      const vertices = entity.vertices
      for (let i = 0; i < vertices.length; i++) {
        push(vertices[i].x, vertices[i].y, 'endpoint')
        const next = vertices[(i + 1) % vertices.length]
        if (i === vertices.length - 1 && !entity.closed) break
        // Midpoints are only meaningful for the straight segments.
        if (!vertices[i].bulge) {
          push((vertices[i].x + next.x) / 2, (vertices[i].y + next.y) / 2, 'midpoint')
        }
      }
      break
    }

    case 'SOLID':
    case '3DFACE':
      for (const corner of entity.corners) push(corner.x, corner.y, 'endpoint')
      break

    case 'LEADER':
      for (const vertex of entity.vertices) push(vertex.x, vertex.y, 'endpoint')
      break

    case 'SPLINE':
      for (const point of entity.fitPoints) push(point.x, point.y, 'endpoint')
      break

    default:
      break
  }
}

/**
 * Finds the best snap point near `world`, or null when nothing is close enough.
 * `tolerance` is in drawing units (convert from a pixel radius at the caller).
 */
export function findSnap(
  scene: Scene,
  world: Point2,
  tolerance: number,
  visibleLayers: ReadonlySet<string>,
): SnapPoint | null {
  const candidates: SnapPoint[] = []
  let scanned = 0

  for (const item of scene.items) {
    if (scanned >= MAX_SCANNED) break
    if (!visibleLayers.has(item.layer)) continue
    const bounds = item.bounds
    if (
      world.x < bounds.minX - tolerance ||
      world.x > bounds.maxX + tolerance ||
      world.y < bounds.minY - tolerance ||
      world.y > bounds.maxY + tolerance
    ) {
      continue
    }
    scanned++
    collectFrom(item, candidates)
  }

  let best: SnapPoint | null = null
  let bestScore = Number.POSITIVE_INFINITY

  for (const candidate of candidates) {
    const distance = Math.hypot(candidate.x - world.x, candidate.y - world.y)
    if (distance > tolerance) continue
    // Break ties toward the more useful snap kind.
    const score = distance + PRIORITY[candidate.kind] * tolerance * 0.02
    if (score < bestScore) {
      bestScore = score
      best = candidate
    }
  }

  return best
}
