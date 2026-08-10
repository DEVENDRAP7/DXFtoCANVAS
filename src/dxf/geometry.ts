/**
 * Geometry helpers shared by the parser and the renderer: 2D affine matrices,
 * bulge-arc reconstruction, ellipse sampling and NURBS evaluation.
 */

import type { Point2, Point3, PolylineVertex } from './types'

/** Affine transform: x' = a·x + c·y + e, y' = b·x + d·y + f (same order as canvas). */
export interface Mat {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

export const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

/** Applies `first` and then `second`. */
export function multiply(second: Mat, first: Mat): Mat {
  return {
    a: second.a * first.a + second.c * first.b,
    b: second.b * first.a + second.d * first.b,
    c: second.a * first.c + second.c * first.d,
    d: second.b * first.c + second.d * first.d,
    e: second.a * first.e + second.c * first.f + second.e,
    f: second.b * first.e + second.d * first.f + second.f,
  }
}

export function translation(tx: number, ty: number): Mat {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty }
}

export function scaling(sx: number, sy: number): Mat {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 }
}

/** `radians` measured counter-clockwise. */
export function rotation(radians: number): Mat {
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 }
}

export function apply(m: Mat, x: number, y: number): Point2 {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f }
}

export function invert(m: Mat): Mat {
  const det = m.a * m.d - m.b * m.c
  if (Math.abs(det) < 1e-12) return IDENTITY
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  }
}

/** Geometric mean of the axis scale factors — a single "how big is this now" number. */
export function meanScale(m: Mat): number {
  const sx = Math.hypot(m.a, m.b)
  const sy = Math.hypot(m.c, m.d)
  const s = Math.sqrt(sx * sy)
  return Number.isFinite(s) && s > 0 ? s : 1
}

/** True when the transform flips handedness, which mirrors arc sweep direction. */
export function isMirrored(m: Mat): boolean {
  return m.a * m.d - m.b * m.c < 0
}

export const DEG = Math.PI / 180

export function normalizeAngle(radians: number): number {
  const twoPi = Math.PI * 2
  let a = radians % twoPi
  if (a < 0) a += twoPi
  return a
}

export interface ArcGeometry {
  cx: number
  cy: number
  radius: number
  /** Radians. */
  startAngle: number
  endAngle: number
  counterClockwise: boolean
}

/**
 * Rebuilds the arc that a polyline bulge encodes.
 *
 * `bulge` is tan(sweep / 4); its sign gives the sweep direction. Returns null
 * for a degenerate (zero-length or straight) segment so callers fall back to a
 * plain line.
 */
export function bulgeToArc(p1: Point2, p2: Point2, bulge: number): ArcGeometry | null {
  if (!bulge || !Number.isFinite(bulge)) return null
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const chord = Math.hypot(dx, dy)
  if (chord < 1e-12) return null

  const sweep = 4 * Math.atan(bulge)
  const halfSweep = sweep / 2
  const sinHalf = Math.sin(halfSweep)
  if (Math.abs(sinHalf) < 1e-12) return null

  const signedRadius = chord / 2 / sinHalf
  // Offset from the chord midpoint towards the centre, along the chord's left normal.
  const offset = signedRadius * Math.cos(halfSweep)
  const cx = (p1.x + p2.x) / 2 + (-dy / chord) * offset
  const cy = (p1.y + p2.y) / 2 + (dx / chord) * offset

  return {
    cx,
    cy,
    radius: Math.abs(signedRadius),
    startAngle: Math.atan2(p1.y - cy, p1.x - cx),
    endAngle: Math.atan2(p2.y - cy, p2.x - cx),
    counterClockwise: bulge > 0,
  }
}

/** Signed sweep from `start` to `end` in the given direction. */
export function arcSweep(start: number, end: number, counterClockwise: boolean): number {
  const twoPi = Math.PI * 2
  let delta = end - start
  if (counterClockwise) {
    while (delta <= 0) delta += twoPi
    while (delta > twoPi) delta -= twoPi
  } else {
    while (delta >= 0) delta -= twoPi
    while (delta < -twoPi) delta += twoPi
  }
  return delta
}

/** Segment count that keeps the chord error under `tolerance` drawing units. */
export function arcSegmentCount(radius: number, sweep: number, tolerance = 0.05): number {
  const absSweep = Math.abs(sweep)
  if (radius <= tolerance) return 8
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - tolerance / radius)))
  if (!Number.isFinite(step) || step <= 1e-6) return 256
  return Math.max(2, Math.min(512, Math.ceil(absSweep / step)))
}

export function sampleArc(arc: ArcGeometry, tolerance = 0.05): Point2[] {
  const sweep = arcSweep(arc.startAngle, arc.endAngle, arc.counterClockwise)
  const count = arcSegmentCount(arc.radius, sweep, tolerance)
  const points: Point2[] = []
  for (let i = 0; i <= count; i++) {
    const angle = arc.startAngle + (sweep * i) / count
    points.push({ x: arc.cx + arc.radius * Math.cos(angle), y: arc.cy + arc.radius * Math.sin(angle) })
  }
  return points
}

/** Walks a bulge polyline and returns a flat point loop. */
export function samplePolyline(vertices: PolylineVertex[], closed: boolean, tolerance = 0.05): Point2[] {
  if (vertices.length === 0) return []
  const points: Point2[] = [{ x: vertices[0].x, y: vertices[0].y }]
  const last = closed ? vertices.length : vertices.length - 1
  for (let i = 0; i < last; i++) {
    const from = vertices[i]
    const to = vertices[(i + 1) % vertices.length]
    const arc = from.bulge ? bulgeToArc(from, to, from.bulge) : null
    if (arc) {
      const sampled = sampleArc(arc, tolerance)
      for (let j = 1; j < sampled.length; j++) points.push(sampled[j])
    } else {
      points.push({ x: to.x, y: to.y })
    }
  }
  return points
}

export interface EllipseGeometry {
  cx: number
  cy: number
  majorX: number
  majorY: number
  ratio: number
  startParam: number
  endParam: number
}

export function ellipsePoint(e: EllipseGeometry, param: number): Point2 {
  const cos = Math.cos(param)
  const sin = Math.sin(param)
  // Minor axis is the major axis rotated a quarter turn and shortened by `ratio`.
  const minorX = -e.majorY * e.ratio
  const minorY = e.majorX * e.ratio
  return {
    x: e.cx + e.majorX * cos + minorX * sin,
    y: e.cy + e.majorY * cos + minorY * sin,
  }
}

export function sampleEllipse(e: EllipseGeometry, tolerance = 0.05): Point2[] {
  let sweep = e.endParam - e.startParam
  if (sweep <= 1e-9) sweep += Math.PI * 2
  const majorLength = Math.hypot(e.majorX, e.majorY)
  const count = arcSegmentCount(majorLength, sweep, tolerance)
  const points: Point2[] = []
  for (let i = 0; i <= count; i++) {
    points.push(ellipsePoint(e, e.startParam + (sweep * i) / count))
  }
  return points
}

/** Clamped uniform knot vector for when a SPLINE omits or mis-sizes its knots. */
function uniformKnots(controlCount: number, degree: number): number[] {
  const knots: number[] = []
  const inner = controlCount - degree - 1
  for (let i = 0; i <= degree; i++) knots.push(0)
  for (let i = 1; i <= inner; i++) knots.push(i / (inner + 1))
  for (let i = 0; i <= degree; i++) knots.push(1)
  return knots
}

function findSpan(knots: number[], degree: number, controlCount: number, t: number): number {
  if (t >= knots[controlCount]) return controlCount - 1
  if (t <= knots[degree]) return degree
  let low = degree
  let high = controlCount
  let mid = Math.floor((low + high) / 2)
  while (t < knots[mid] || t >= knots[mid + 1]) {
    if (t < knots[mid]) high = mid
    else low = mid
    mid = Math.floor((low + high) / 2)
  }
  return mid
}

/**
 * Evaluates a (rational) B-spline with de Boor's algorithm.
 *
 * Handles the plain non-uniform case as well as weighted control points, which
 * is how DXF stores exact conics converted from arcs.
 */
export function sampleSpline(
  controlPoints: Point2[],
  degreeInput: number,
  knotsInput: number[],
  weightsInput: number[],
  segments: number,
): Point2[] {
  const n = controlPoints.length
  if (n === 0) return []
  const degree = Math.max(1, Math.min(degreeInput || 3, n - 1))
  if (n <= degree) return controlPoints.map((p) => ({ x: p.x, y: p.y }))

  const knots = knotsInput.length === n + degree + 1 ? knotsInput : uniformKnots(n, degree)
  const weights = weightsInput.length === n ? weightsInput : new Array<number>(n).fill(1)

  const tStart = knots[degree]
  const tEnd = knots[n]
  if (!(tEnd > tStart)) return controlPoints.map((p) => ({ x: p.x, y: p.y }))

  const points: Point2[] = []
  for (let step = 0; step <= segments; step++) {
    const t = tStart + ((tEnd - tStart) * step) / segments
    const span = findSpan(knots, degree, n, t)

    // Working set of homogeneous control points for this span.
    const dx: number[] = []
    const dy: number[] = []
    const dw: number[] = []
    for (let i = 0; i <= degree; i++) {
      const index = span - degree + i
      const w = weights[index] ?? 1
      dx.push(controlPoints[index].x * w)
      dy.push(controlPoints[index].y * w)
      dw.push(w)
    }

    for (let r = 1; r <= degree; r++) {
      for (let i = degree; i >= r; i--) {
        const index = span - degree + i
        const denominator = knots[index + degree - r + 1] - knots[index]
        const alpha = Math.abs(denominator) < 1e-12 ? 0 : (t - knots[index]) / denominator
        dx[i] = (1 - alpha) * dx[i - 1] + alpha * dx[i]
        dy[i] = (1 - alpha) * dy[i - 1] + alpha * dy[i]
        dw[i] = (1 - alpha) * dw[i - 1] + alpha * dw[i]
      }
    }

    const w = dw[degree] || 1
    points.push({ x: dx[degree] / w, y: dy[degree] / w })
  }
  return points
}

/** Smooth curve through fit points, used when a SPLINE ships no control points. */
export function sampleCatmullRom(points: Point2[], segmentsPerSpan = 12): Point2[] {
  if (points.length < 3) return points.map((p) => ({ x: p.x, y: p.y }))
  const result: Point2[] = []
  const at = (i: number) => points[Math.max(0, Math.min(points.length - 1, i))]
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = at(i - 1)
    const p1 = at(i)
    const p2 = at(i + 1)
    const p3 = at(i + 2)
    for (let s = 0; s < segmentsPerSpan; s++) {
      const t = s / segmentsPerSpan
      const t2 = t * t
      const t3 = t2 * t
      result.push({
        x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      })
    }
  }
  result.push({ ...points[points.length - 1] })
  return result
}

export function point3(x = 0, y = 0, z = 0): Point3 {
  return { x, y, z }
}
