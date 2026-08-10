import { describe, expect, it } from 'vitest'
import { MAX_SCALE, MIN_SCALE, fitBounds, niceGridStep, panBy, screenToWorld, worldToScreen, zoomAt } from './view'

describe('world / screen mapping', () => {
  const view = { scale: 2, tx: 100, ty: 300 }

  it('flips Y so drawings are not upside down', () => {
    expect(worldToScreen(view, 0, 0)).toEqual({ x: 100, y: 300 })
    // A point 10 units up the page is 20 pixels higher on screen.
    expect(worldToScreen(view, 0, 10)).toEqual({ x: 100, y: 280 })
  })

  it('round-trips back to world coordinates', () => {
    const screen = worldToScreen(view, -37.5, 12.25)
    const world = screenToWorld(view, screen.x, screen.y)
    expect(world.x).toBeCloseTo(-37.5, 9)
    expect(world.y).toBeCloseTo(12.25, 9)
  })
})

describe('fitBounds', () => {
  const bounds = { minX: 0, minY: 0, maxX: 200, maxY: 100 }

  it('centres the drawing in the viewport', () => {
    const view = fitBounds(bounds, 800, 600)
    const center = worldToScreen(view, 100, 50)
    expect(center.x).toBeCloseTo(400, 6)
    expect(center.y).toBeCloseTo(300, 6)
  })

  it('fits the constraining axis with a margin to spare', () => {
    const view = fitBounds(bounds, 800, 600, 0.05)
    const left = worldToScreen(view, 0, 0).x
    const right = worldToScreen(view, 200, 0).x
    expect(right - left).toBeLessThanOrEqual(800)
    expect(right - left).toBeGreaterThan(600)
  })

  it('does not divide by zero on a single point or a straight line', () => {
    const point = fitBounds({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, 800, 600)
    expect(Number.isFinite(point.scale)).toBe(true)
    expect(Number.isFinite(point.tx)).toBe(true)

    const line = fitBounds({ minX: 0, minY: 5, maxX: 100, maxY: 5 }, 800, 600)
    expect(Number.isFinite(line.scale)).toBe(true)
    expect(line.scale).toBeGreaterThan(0)
  })

  it('returns a usable view for a zero-sized viewport', () => {
    expect(fitBounds(bounds, 0, 0)).toEqual({ scale: 1, tx: 0, ty: 0 })
  })
})

describe('zoomAt', () => {
  it('keeps the point under the cursor fixed', () => {
    const view = { scale: 3, tx: 40, ty: 90 }
    const anchorX = 250
    const anchorY = 175
    const before = screenToWorld(view, anchorX, anchorY)
    const after = screenToWorld(zoomAt(view, anchorX, anchorY, 1.75), anchorX, anchorY)
    expect(after.x).toBeCloseTo(before.x, 9)
    expect(after.y).toBeCloseTo(before.y, 9)
  })

  it('clamps runaway zoom in both directions', () => {
    expect(zoomAt({ scale: 1, tx: 0, ty: 0 }, 0, 0, 1e30).scale).toBe(MAX_SCALE)
    expect(zoomAt({ scale: 1, tx: 0, ty: 0 }, 0, 0, 1e-30).scale).toBe(MIN_SCALE)
  })
})

describe('panBy', () => {
  it('shifts the view without changing the scale', () => {
    const panned = panBy({ scale: 4, tx: 10, ty: 20 }, -5, 7)
    expect(panned).toEqual({ scale: 4, tx: 5, ty: 27 })
  })
})

describe('niceGridStep', () => {
  it('only ever returns 1, 2 or 5 times a power of ten', () => {
    for (let exponent = -4; exponent <= 6; exponent++) {
      const step = niceGridStep({ scale: Math.pow(10, exponent), tx: 0, ty: 0 }, 14)
      const mantissa = step / Math.pow(10, Math.floor(Math.log10(step)))
      expect([1, 2, 5, 10]).toContain(Math.round(mantissa))
    }
  })

  it('lands within a factor of ~3 of the requested pixel spacing', () => {
    const view = { scale: 7.3, tx: 0, ty: 0 }
    const pixels = niceGridStep(view, 14) * view.scale
    expect(pixels).toBeGreaterThan(14 / 3)
    expect(pixels).toBeLessThan(14 * 3)
  })
})
