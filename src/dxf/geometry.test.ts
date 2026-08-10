import { describe, expect, it } from 'vitest'
import {
  IDENTITY,
  type Mat,
  apply,
  arcSweep,
  bulgeToArc,
  invert,
  meanScale,
  multiply,
  rotation,
  sampleEllipse,
  samplePolyline,
  sampleSpline,
  scaling,
  translation,
} from './geometry'

describe('bulge arcs', () => {
  it('turns a bulge of 1 into a semicircle centred on the chord', () => {
    const arc = bulgeToArc({ x: 0, y: 0 }, { x: 1, y: 0 }, 1)
    expect(arc).not.toBeNull()
    expect(arc!.cx).toBeCloseTo(0.5, 12)
    expect(arc!.cy).toBeCloseTo(0, 12)
    expect(arc!.radius).toBeCloseTo(0.5, 12)
    expect(arc!.counterClockwise).toBe(true)
  })

  it('places the centre on the left of the chord for a shallow positive bulge', () => {
    // Closed form: sweep = 4·atan(0.1), r = chord / (2·sin(sweep/2)),
    // and the centre sits r·cos(sweep/2) along the chord's left normal.
    const sweep = 4 * Math.atan(0.1)
    const radius = 0.5 / Math.sin(sweep / 2)

    const arc = bulgeToArc({ x: 0, y: 0 }, { x: 1, y: 0 }, 0.1)!
    expect(arc.cx).toBeCloseTo(0.5, 9)
    expect(arc.cy).toBeCloseTo(radius * Math.cos(sweep / 2), 9)
    expect(arc.radius).toBeCloseTo(radius, 9)
    // Sanity-check the closed form itself against known magnitudes.
    expect(radius).toBeCloseTo(2.525, 3)
    expect(arc.cy).toBeCloseTo(2.475, 3)
  })

  it('mirrors the centre and reverses the sweep for a negative bulge', () => {
    const positive = bulgeToArc({ x: 0, y: 0 }, { x: 1, y: 0 }, 0.1)!
    const negative = bulgeToArc({ x: 0, y: 0 }, { x: 1, y: 0 }, -0.1)!
    expect(negative.cy).toBeCloseTo(-positive.cy, 9)
    expect(negative.counterClockwise).toBe(false)
  })

  it('returns null for a degenerate segment so callers draw a straight line', () => {
    expect(bulgeToArc({ x: 0, y: 0 }, { x: 1, y: 0 }, 0)).toBeNull()
    expect(bulgeToArc({ x: 0, y: 0 }, { x: 0, y: 0 }, 0.5)).toBeNull()
  })

  it('keeps the arc endpoints on the original vertices', () => {
    const arc = bulgeToArc({ x: 2, y: 3 }, { x: 7, y: -1 }, 0.4)!
    const start = { x: arc.cx + arc.radius * Math.cos(arc.startAngle), y: arc.cy + arc.radius * Math.sin(arc.startAngle) }
    const end = { x: arc.cx + arc.radius * Math.cos(arc.endAngle), y: arc.cy + arc.radius * Math.sin(arc.endAngle) }
    expect(start.x).toBeCloseTo(2, 9)
    expect(start.y).toBeCloseTo(3, 9)
    expect(end.x).toBeCloseTo(7, 9)
    expect(end.y).toBeCloseTo(-1, 9)
  })
})

describe('arcSweep', () => {
  it('always returns a positive sweep counter-clockwise and negative clockwise', () => {
    expect(arcSweep(0, Math.PI / 2, true)).toBeCloseTo(Math.PI / 2, 12)
    expect(arcSweep(0, Math.PI / 2, false)).toBeCloseTo(-3 * Math.PI / 2, 12)
    expect(arcSweep(0, 0, true)).toBeCloseTo(Math.PI * 2, 12)
  })
})

describe('polyline sampling', () => {
  it('walks straight segments without adding points', () => {
    const points = samplePolyline(
      [
        { x: 0, y: 0, bulge: 0 },
        { x: 1, y: 0, bulge: 0 },
        { x: 1, y: 1, bulge: 0 },
      ],
      false,
    )
    expect(points).toHaveLength(3)
  })

  it('closes the loop back to the first vertex', () => {
    const points = samplePolyline(
      [
        { x: 0, y: 0, bulge: 0 },
        { x: 4, y: 0, bulge: 0 },
        { x: 4, y: 4, bulge: 0 },
      ],
      true,
    )
    expect(points[points.length - 1].x).toBeCloseTo(0, 9)
    expect(points[points.length - 1].y).toBeCloseTo(0, 9)
  })

  it('subdivides a bulge into an arc that bows away from the chord', () => {
    const points = samplePolyline(
      [
        { x: 0, y: 0, bulge: 1 },
        { x: 2, y: 0, bulge: 0 },
      ],
      false,
    )
    expect(points.length).toBeGreaterThan(4)
    const lowest = points.reduce((value, point) => Math.min(value, point.y), 0)
    // Positive bulge on a west-to-east chord sweeps counter-clockwise, i.e.
    // below it. The sampled polygon is inscribed, so it approaches the true
    // -1 extreme from above by at most the chord tolerance.
    expect(lowest).toBeLessThan(-0.9)
    expect(lowest).toBeGreaterThanOrEqual(-1)
  })

  it('respects the requested chord tolerance', () => {
    const coarse = samplePolyline([{ x: 0, y: 0, bulge: 1 }, { x: 2, y: 0, bulge: 0 }], false, 0.2)
    const fine = samplePolyline([{ x: 0, y: 0, bulge: 1 }, { x: 2, y: 0, bulge: 0 }], false, 0.001)
    expect(fine.length).toBeGreaterThan(coarse.length)
    const finestLow = fine.reduce((value, point) => Math.min(value, point.y), 0)
    expect(finestLow).toBeCloseTo(-1, 3)
  })
})

describe('ellipse sampling', () => {
  // The sampler inscribes a polygon, so extremes are approached from inside;
  // a tight tolerance keeps that error well under the assertions below.
  const TIGHT = 1e-4

  it('follows the major and minor axes', () => {
    const points = sampleEllipse({ cx: 0, cy: 0, majorX: 10, majorY: 0, ratio: 0.5, startParam: 0, endParam: 0 }, TIGHT)
    const maxX = points.reduce((value, point) => Math.max(value, point.x), -Infinity)
    const maxY = points.reduce((value, point) => Math.max(value, point.y), -Infinity)
    expect(maxX).toBeCloseTo(10, 3)
    expect(maxY).toBeCloseTo(5, 3)
  })

  it('honours a rotated major axis', () => {
    const points = sampleEllipse({ cx: 0, cy: 0, majorX: 0, majorY: 8, ratio: 0.25, startParam: 0, endParam: 0 }, TIGHT)
    const maxY = points.reduce((value, point) => Math.max(value, point.y), -Infinity)
    const maxX = points.reduce((value, point) => Math.max(value, point.x), -Infinity)
    expect(maxY).toBeCloseTo(8, 3)
    expect(maxX).toBeCloseTo(2, 3)
  })

  it('every sampled point satisfies the ellipse equation', () => {
    const points = sampleEllipse({ cx: 3, cy: -2, majorX: 6, majorY: 0, ratio: 0.5, startParam: 0, endParam: 0 })
    for (const point of points) {
      const normalized = ((point.x - 3) / 6) ** 2 + ((point.y + 2) / 3) ** 2
      expect(normalized).toBeCloseTo(1, 9)
    }
  })
})

describe('spline evaluation', () => {
  const control = [
    { x: 0, y: 0 },
    { x: 1, y: 4 },
    { x: 5, y: 4 },
    { x: 6, y: 0 },
  ]

  it('interpolates a clamped curve between the first and last control points', () => {
    const points = sampleSpline(control, 3, [], [], 40)
    expect(points[0].x).toBeCloseTo(0, 9)
    expect(points[0].y).toBeCloseTo(0, 9)
    expect(points[points.length - 1].x).toBeCloseTo(6, 9)
    expect(points[points.length - 1].y).toBeCloseTo(0, 9)
  })

  it('stays inside the control polygon bounding box', () => {
    const points = sampleSpline(control, 3, [], [], 60)
    for (const point of points) {
      expect(point.x).toBeGreaterThanOrEqual(-1e-9)
      expect(point.x).toBeLessThanOrEqual(6 + 1e-9)
      expect(point.y).toBeGreaterThanOrEqual(-1e-9)
      expect(point.y).toBeLessThanOrEqual(4 + 1e-9)
    }
  })

  it('reproduces a quarter circle from its rational NURBS form', () => {
    // The standard weighted representation of a 90° arc of radius 1.
    const weight = Math.SQRT1_2
    const points = sampleSpline(
      [
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      2,
      [0, 0, 0, 1, 1, 1],
      [1, weight, 1],
      24,
    )
    for (const point of points) {
      expect(Math.hypot(point.x, point.y)).toBeCloseTo(1, 9)
    }
  })

  it('falls back to the control polygon when there are too few points', () => {
    expect(sampleSpline([{ x: 0, y: 0 }], 3, [], [], 10)).toHaveLength(1)
  })
})

describe('affine transforms', () => {
  it('applies the inner transform first', () => {
    // Translate then rotate: the translation should be rotated too.
    const m = multiply(rotation(Math.PI / 2), translation(1, 0))
    const point = apply(m, 0, 0)
    expect(point.x).toBeCloseTo(0, 9)
    expect(point.y).toBeCloseTo(1, 9)
  })

  it('round-trips through its inverse', () => {
    const m: Mat = multiply(multiply(translation(12, -3), rotation(0.7)), scaling(2, 3))
    const forward = apply(m, 4, 9)
    const back = apply(invert(m), forward.x, forward.y)
    expect(back.x).toBeCloseTo(4, 9)
    expect(back.y).toBeCloseTo(9, 9)
  })

  it('returns identity when inverting a degenerate transform', () => {
    expect(invert(scaling(0, 0))).toEqual(IDENTITY)
  })

  it('reports the geometric mean of the axis scales', () => {
    expect(meanScale(scaling(2, 8))).toBeCloseTo(4, 9)
    expect(meanScale(rotation(1.1))).toBeCloseTo(1, 9)
  })
})
