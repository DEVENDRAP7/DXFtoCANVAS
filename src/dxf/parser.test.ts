import { describe, expect, it } from 'vitest'
import { decodeMText, decodeTextEscapes, parseDxf } from './parser'
import { buildScene } from './scene'

/** Builds DXF text from a flat list of code/value pairs. */
function dxf(...tags: (string | number)[]): string {
  return tags.map(String).join('\r\n')
}

/**
 * An R12-era drawing: legacy POLYLINE with VERTEX/SEQEND, an INSERT carrying an
 * ATTRIB, a mirrored extrusion and a construction line. Modern writers emit
 * none of these, so they are the parts most likely to silently break.
 */
const LEGACY_DRAWING = dxf(
  0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 9, '$INSUNITS', 70, 1, 0, 'ENDSEC',
  0, 'SECTION', 2, 'TABLES',
  0, 'TABLE', 2, 'LAYER', 70, 2,
  0, 'LAYER', 2, 'WALLS', 70, 0, 62, 5, 6, 'CONTINUOUS',
  0, 'LAYER', 2, 'HIDDEN', 70, 1, 62, -3, 6, 'DASHED',
  0, 'ENDTAB', 0, 'ENDSEC',
  0, 'SECTION', 2, 'BLOCKS',
  0, 'BLOCK', 2, 'TAG', 70, 2, 10, 0, 20, 0, 30, 0, 3, 'TAG',
  0, 'CIRCLE', 8, '0', 10, 0, 20, 0, 40, 5,
  0, 'ATTDEF', 8, '0', 10, 0, 20, 0, 40, 2, 1, 'DEFAULT', 2, 'ID', 70, 0,
  0, 'ENDBLK',
  0, 'ENDSEC',
  0, 'SECTION', 2, 'ENTITIES',
  0, 'POLYLINE', 8, 'WALLS', 66, 1, 70, 1,
  0, 'VERTEX', 8, 'WALLS', 10, 0, 20, 0,
  0, 'VERTEX', 8, 'WALLS', 10, 10, 20, 0, 42, 1,
  0, 'VERTEX', 8, 'WALLS', 10, 10, 20, 10,
  0, 'VERTEX', 8, 'WALLS', 10, 0, 20, 10,
  0, 'SEQEND',
  0, 'INSERT', 8, 'WALLS', 66, 1, 2, 'TAG', 10, 50, 20, 50, 41, 2, 42, 2, 50, 45,
  0, 'ATTRIB', 8, 'WALLS', 10, 50, 20, 50, 40, 3, 1, 'P-01', 2, 'ID', 70, 0,
  0, 'SEQEND',
  0, 'CIRCLE', 8, 'WALLS', 10, 20, 20, 0, 40, 4, 210, 0, 220, 0, 230, -1,
  0, 'XLINE', 8, 'HIDDEN', 10, 0, 20, 0, 11, 1, 21, 1,
  0, 'SPLINE', 8, 'WALLS', 70, 8, 71, 3, 74, 4, 11, 0, 21, 40, 11, 5, 21, 45, 11, 10, 21, 40, 11, 15, 21, 48,
  0, 'ENDSEC', 0, 'EOF',
)

describe('header and tables', () => {
  const document = parseDxf(LEGACY_DRAWING)

  it('reads the version and unit variables', () => {
    expect(document.header.version).toBe('AC1009')
    expect(document.header.insUnits).toBe(1)
  })

  it('reads the layer table and adds the implicit layer 0', () => {
    expect([...document.layers.keys()].sort()).toEqual(['0', 'HIDDEN', 'WALLS'])
  })

  it('treats a negative layer colour as "off" and flag 1 as frozen', () => {
    const hidden = document.layers.get('HIDDEN')
    expect(hidden?.off).toBe(true)
    expect(hidden?.frozen).toBe(true)
    // The colour itself is still index 3; only the sign carried the off state.
    expect(hidden?.color).toBe(3)
  })
})

describe('legacy composite entities', () => {
  const document = parseDxf(LEGACY_DRAWING)

  it('assembles POLYLINE from its VERTEX records', () => {
    const polyline = document.entities.find((entity) => entity.type === 'POLYLINE')
    expect(polyline?.type).toBe('POLYLINE')
    if (polyline?.type !== 'POLYLINE') return
    expect(polyline.vertices).toHaveLength(4)
    expect(polyline.closed).toBe(true)
    expect(polyline.vertices[1].bulge).toBe(1)
  })

  it('attaches ATTRIB records to the INSERT that owns them', () => {
    const insert = document.entities.find((entity) => entity.type === 'INSERT')
    expect(insert?.type).toBe('INSERT')
    if (insert?.type !== 'INSERT') return
    expect(insert.attributes.map((attribute) => attribute.text)).toEqual(['P-01'])
  })

  it('reads XLINE as a bidirectional construction line', () => {
    const ray = document.entities.find((entity) => entity.type === 'RAY')
    expect(ray?.type === 'RAY' && ray.bidirectional).toBe(true)
  })

  it('keeps a SPLINE that only has fit points', () => {
    const spline = document.entities.find((entity) => entity.type === 'SPLINE')
    expect(spline?.type === 'SPLINE' && spline.fitPoints).toHaveLength(4)
    expect(spline?.type === 'SPLINE' && spline.controlPoints).toHaveLength(0)
  })

  it('does not report ATTDEF as an unsupported entity', () => {
    expect(document.warnings.join(' ')).not.toContain('ATTDEF')
  })
})

describe('scene building', () => {
  const scene = buildScene(parseDxf(LEGACY_DRAWING))

  it('expands block references', () => {
    // One circle in model space, one from the expanded TAG block.
    expect(scene.stats.entityCounts.get('CIRCLE')).toBe(2)
    expect(scene.stats.expandedInserts).toBe(1)
  })

  it('applies the block reference rotation and scale', () => {
    const fromBlock = scene.items.find((item) => item.blockPath === 'TAG')
    expect(fromBlock).toBeDefined()
    expect(Math.hypot(fromBlock!.matrix.a, fromBlock!.matrix.b)).toBeCloseTo(2, 9)
  })

  it('promotes layer-0 block content onto the layer of the reference', () => {
    const fromBlock = scene.items.find((item) => item.blockPath === 'TAG')
    expect(fromBlock?.layer).toBe('WALLS')
  })

  it('mirrors entities drawn on a -Z extrusion', () => {
    const mirrored = scene.items.find((item) => item.entity.type === 'CIRCLE' && item.entity.center.x === 20)
    expect(mirrored?.matrix.a).toBe(-1)
    expect(mirrored?.matrix.d).toBe(1)
  })

  it('produces finite extents', () => {
    expect(Number.isFinite(scene.bounds.minX)).toBe(true)
    expect(Number.isFinite(scene.bounds.maxY)).toBe(true)
  })
})

describe('text decoding', () => {
  it('replaces the %% escapes used by single-line TEXT', () => {
    expect(decodeTextEscapes('45%%d %%p0.5 %%c20')).toBe('45° ±0.5 ø20')
  })

  it('turns \\P into a line break', () => {
    expect(decodeMText('a\\Pb')).toBe('a\nb')
  })

  it('keeps a paragraph break when the line later contains a semicolon', () => {
    // Regression: the directive pattern used to swallow "\Pline two;".
    expect(decodeMText('line one\\Pline two; more')).toBe('line one\nline two; more')
  })

  it('keeps braces and backslashes that were escaped on purpose', () => {
    expect(decodeMText('\\{x\\}')).toBe('{x}')
    expect(decodeMText('a\\\\b')).toBe('a\\b')
  })

  it('strips formatting directives but keeps their content', () => {
    expect(decodeMText('{\\fArial|b0|i0;text}')).toBe('text')
    expect(decodeMText('\\H2.5x;hello')).toBe('hello')
    expect(decodeMText('{\\C1;Room }\\P\\S1/2;m')).toBe('Room \n1/2m')
  })

  it('decodes \\~ as a non-breaking space', () => {
    expect(decodeMText('a\\~b')).toBe('a\u00a0b')
  })

  it('flattens stacked fractions', () => {
    expect(decodeMText('\\S1#2;')).toBe('1/2')
    expect(decodeMText('\\S3^4;')).toBe('3/4')
  })
})

describe('malformed input', () => {
  it('explains how to fix a binary DXF instead of failing opaquely', () => {
    expect(() => parseDxf('AutoCAD Binary DXF\r\n\u001a\u0000')).toThrow(/binary DXF/i)
  })

  it('rejects a file with no group codes', () => {
    expect(() => parseDxf('this is not a dxf at all')).toThrow()
  })

  it('resynchronises after a stray line rather than mis-pairing everything after it', () => {
    const document = parseDxf(
      dxf(0, 'SECTION', 2, 'ENTITIES', 'STRAY', 0, 'LINE', 8, '0', 10, 1, 20, 2, 11, 3, 21, 4, 0, 'ENDSEC', 0, 'EOF'),
    )
    expect(document.entities.map((entity) => entity.type)).toEqual(['LINE'])
  })

  it('warns about an empty drawing instead of throwing', () => {
    const document = parseDxf(dxf(0, 'SECTION', 2, 'ENTITIES', 0, 'ENDSEC', 0, 'EOF'))
    expect(document.entities).toHaveLength(0)
    expect(document.warnings.length).toBeGreaterThan(0)
    expect(buildScene(document).bounds).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 })
  })

  it('reports unknown entity types but keeps reading the rest', () => {
    const document = parseDxf(
      dxf(0, 'SECTION', 2, 'ENTITIES', 0, 'MESH', 8, '0', 0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 1, 21, 1, 0, 'ENDSEC', 0, 'EOF'),
    )
    expect(document.warnings.join(' ')).toContain('MESH')
    expect(document.entities).toHaveLength(1)
  })

  it('stops expanding a block that references itself', () => {
    const scene = buildScene(
      parseDxf(
        dxf(
          0, 'SECTION', 2, 'BLOCKS',
          0, 'BLOCK', 2, 'LOOP', 10, 0, 20, 0, 3, 'LOOP',
          0, 'INSERT', 8, '0', 2, 'LOOP', 10, 1, 20, 1,
          0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 1, 21, 1,
          0, 'ENDBLK', 0, 'ENDSEC',
          0, 'SECTION', 2, 'ENTITIES', 0, 'INSERT', 8, '0', 2, 'LOOP', 10, 0, 20, 0, 0, 'ENDSEC', 0, 'EOF',
        ),
      ),
    )
    expect(scene.warnings.join(' ')).toContain('nests into itself')
    // The non-recursive part of the block still gets drawn.
    expect(scene.items.length).toBeGreaterThan(0)
  })

  it('warns when a referenced block was never defined', () => {
    const scene = buildScene(
      parseDxf(dxf(0, 'SECTION', 2, 'ENTITIES', 0, 'INSERT', 8, '0', 2, 'GHOST', 10, 0, 20, 0, 0, 'ENDSEC', 0, 'EOF')),
    )
    expect(scene.warnings.join(' ')).toContain('GHOST')
  })
})
