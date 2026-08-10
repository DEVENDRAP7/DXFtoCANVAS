import { describe, expect, it } from 'vitest'
import { loadDrawing } from '../dxf/loader'
import { SAMPLE_FILE_NAME, buildSampleDxf } from './floorPlan'

/**
 * The sample plan is written as real DXF text and read back through the normal
 * pipeline, so these assertions double as an end-to-end check of the writer and
 * the parser against each other.
 */
describe('sample floor plan', () => {
  const text = buildSampleDxf()
  const drawing = loadDrawing(text, SAMPLE_FILE_NAME, text.length)

  it('parses without warnings', () => {
    expect(drawing.warnings).toEqual([])
  })

  it('declares the layers the plan draws on', () => {
    const names = drawing.layers.map((layer) => layer.name)
    expect(names).toContain('A-WALL')
    expect(names).toContain('A-DOOR')
    expect(names).toContain('A-ANNO-DIMS')
    // Every declared layer should actually carry geometry.
    for (const layer of drawing.layers) {
      expect(drawing.scene.stats.layerCounts.get(layer.name) ?? 0).toBeGreaterThan(0)
    }
  })

  it('reads the dashed and centre linetype patterns', () => {
    expect(drawing.linetypes.get('DASHED')?.pattern).toEqual([180, -90])
    expect(drawing.linetypes.get('CENTER')?.pattern).toEqual([500, -110, 110, -110])
    expect(drawing.linetypes.get('CONTINUOUS')?.pattern).toEqual([])
  })

  it('expands every block reference, including the dimension blocks', () => {
    // 5 doors + 4 chairs + 1 north arrow.
    expect(drawing.scene.stats.expandedInserts).toBe(10)
    // Door blocks contribute one swing arc each.
    expect(drawing.scene.stats.entityCounts.get('ARC')).toBe(5)
    // The three DIMENSION entities are replaced by their block geometry.
    expect(drawing.scene.stats.entityCounts.has('DIMENSION')).toBe(false)
    expect(drawing.scene.stats.layerCounts.get('A-ANNO-DIMS')).toBeGreaterThan(3)
  })

  it('reads the hatch boundary as a closed loop', () => {
    const hatch = drawing.scene.items.find((item) => item.entity.type === 'HATCH')
    expect(hatch).toBeDefined()
    if (hatch?.entity.type !== 'HATCH') return
    expect(hatch.entity.solid).toBe(false)
    expect(hatch.entity.patternName).toBe('ANSI31')
    expect(hatch.entity.loops).toHaveLength(1)
    expect(hatch.entity.loops[0].points.length).toBeGreaterThanOrEqual(4)
  })

  it('reads the site spline with a valid knot vector', () => {
    const spline = drawing.scene.items.find((item) => item.entity.type === 'SPLINE')
    expect(spline).toBeDefined()
    if (spline?.entity.type !== 'SPLINE') return
    // A clamped cubic needs controlCount + degree + 1 knots.
    expect(spline.entity.knots).toHaveLength(spline.entity.controlPoints.length + spline.entity.degree + 1)
  })

  it('surrounds the 12 m × 9 m building with its annotation', () => {
    const bounds = drawing.scene.bounds
    // The building sits at the origin; grid bubbles, dimensions, the title
    // block and the site line all extend past it.
    expect(bounds.minX).toBeLessThan(0)
    expect(bounds.minY).toBeLessThan(0)
    expect(bounds.maxX).toBeGreaterThan(12000)
    expect(bounds.maxY).toBeGreaterThan(9000)
    // Extents stay in a sane range: no runaway text box or infinite line.
    expect(bounds.maxX - bounds.minX).toBeLessThan(40000)
    expect(bounds.maxY - bounds.minY).toBeLessThan(40000)
  })

  it('records millimetres as the drawing unit', () => {
    expect(drawing.header.insUnits).toBe(4)
    expect(drawing.header.version).toBe('AC1015')
  })

  it('gives every draw item finite bounds so culling cannot drop geometry', () => {
    for (const item of drawing.scene.items) {
      expect(Number.isFinite(item.bounds.minX)).toBe(true)
      expect(Number.isFinite(item.bounds.maxY)).toBe(true)
    }
  })
})
