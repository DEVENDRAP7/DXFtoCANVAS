/**
 * Generates a sample architectural DXF so the viewer has something to show
 * before the user opens a file of their own.
 *
 * It is written as a real ASCII DXF (AC1015) rather than a pre-baked scene, so
 * it exercises the same parsing path as an uploaded drawing: layers, linetypes,
 * blocks, MINSERT-free INSERTs, hatches, splines and block-based dimensions.
 *
 * All coordinates are millimetres, with the origin at the outside south-west
 * corner of the building.
 */

type Value = string | number

class DxfWriter {
  private readonly lines: string[] = []
  private handle = 0x100

  tag(code: number, value: Value): void {
    this.lines.push(String(code), typeof value === 'number' ? formatNumber(value) : value)
  }

  nextHandle(): string {
    this.handle += 1
    return this.handle.toString(16).toUpperCase()
  }

  toString(): string {
    return this.lines.join('\n')
  }
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return Number.isInteger(value) ? value.toFixed(1) : value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0')
}

// ---------------------------------------------------------------------------
// Building dimensions
// ---------------------------------------------------------------------------

const W = 12000
const H = 9000
/** Exterior wall thickness. */
const EXT = 230
/** Interior partition thickness. */
const INT = 115

/** Inner face of each exterior wall. */
const IN_S = EXT
const IN_N = H - EXT
const IN_W = EXT
const IN_E = W - EXT

/** Partition centre lines. */
const P_VERTICAL = 6800
const P_HORIZONTAL = 5000
const P_KITCHEN = 9400

const half = INT / 2

interface Gap {
  at: number
  len: number
}

// ---------------------------------------------------------------------------
// Primitive emitters
// ---------------------------------------------------------------------------

function entityHeader(w: DxfWriter, type: string, layer: string, subclass: string): void {
  w.tag(0, type)
  w.tag(5, w.nextHandle())
  w.tag(100, 'AcDbEntity')
  w.tag(8, layer)
  w.tag(100, subclass)
}

function line(w: DxfWriter, layer: string, x1: number, y1: number, x2: number, y2: number): void {
  entityHeader(w, 'LINE', layer, 'AcDbLine')
  w.tag(10, x1)
  w.tag(20, y1)
  w.tag(30, 0)
  w.tag(11, x2)
  w.tag(21, y2)
  w.tag(31, 0)
}

function polyline(w: DxfWriter, layer: string, points: number[][], closed: boolean): void {
  entityHeader(w, 'LWPOLYLINE', layer, 'AcDbPolyline')
  w.tag(90, points.length)
  w.tag(70, closed ? 1 : 0)
  w.tag(43, 0)
  for (const [x, y, bulge] of points) {
    w.tag(10, x)
    w.tag(20, y)
    if (bulge) w.tag(42, bulge)
  }
}

function rect(w: DxfWriter, layer: string, x1: number, y1: number, x2: number, y2: number): void {
  polyline(
    w,
    layer,
    [
      [x1, y1],
      [x2, y1],
      [x2, y2],
      [x1, y2],
    ],
    true,
  )
}

function circle(w: DxfWriter, layer: string, cx: number, cy: number, radius: number): void {
  entityHeader(w, 'CIRCLE', layer, 'AcDbCircle')
  w.tag(10, cx)
  w.tag(20, cy)
  w.tag(30, 0)
  w.tag(40, radius)
}

function arc(w: DxfWriter, layer: string, cx: number, cy: number, radius: number, start: number, end: number): void {
  entityHeader(w, 'ARC', layer, 'AcDbCircle')
  w.tag(10, cx)
  w.tag(20, cy)
  w.tag(30, 0)
  w.tag(40, radius)
  w.tag(100, 'AcDbArc')
  w.tag(50, start)
  w.tag(51, end)
}

function ellipse(
  w: DxfWriter,
  layer: string,
  cx: number,
  cy: number,
  majorX: number,
  majorY: number,
  ratio: number,
): void {
  entityHeader(w, 'ELLIPSE', layer, 'AcDbEllipse')
  w.tag(10, cx)
  w.tag(20, cy)
  w.tag(30, 0)
  w.tag(11, majorX)
  w.tag(21, majorY)
  w.tag(31, 0)
  w.tag(210, 0)
  w.tag(220, 0)
  w.tag(230, 1)
  w.tag(40, ratio)
  w.tag(41, 0)
  w.tag(42, Math.PI * 2)
}

type HAlign = 0 | 1 | 2 | 4

function text(
  w: DxfWriter,
  layer: string,
  x: number,
  y: number,
  height: number,
  content: string,
  options: { rotation?: number; hAlign?: HAlign; vAlign?: 0 | 1 | 2 | 3 } = {},
): void {
  entityHeader(w, 'TEXT', layer, 'AcDbText')
  w.tag(10, x)
  w.tag(20, y)
  w.tag(30, 0)
  w.tag(40, height)
  w.tag(1, content)
  if (options.rotation) w.tag(50, options.rotation)
  w.tag(7, 'STANDARD')
  if (options.hAlign) w.tag(72, options.hAlign)
  if (options.vAlign) {
    w.tag(100, 'AcDbText')
    w.tag(73, options.vAlign)
  }
  if (options.hAlign || options.vAlign) {
    w.tag(11, x)
    w.tag(21, y)
    w.tag(31, 0)
  }
}

function insert(
  w: DxfWriter,
  layer: string,
  blockName: string,
  x: number,
  y: number,
  scaleX: number,
  scaleY: number,
  rotation: number,
): void {
  entityHeader(w, 'INSERT', layer, 'AcDbBlockReference')
  w.tag(2, blockName)
  w.tag(10, x)
  w.tag(20, y)
  w.tag(30, 0)
  w.tag(41, scaleX)
  w.tag(42, scaleY)
  w.tag(43, 1)
  w.tag(50, rotation)
}

/**
 * Filled quadrilateral.
 *
 * DXF stores the last two corners of a SOLID swapped, so they are emitted in
 * that order here rather than in ring order.
 */
function solid(w: DxfWriter, layer: string, x0: number, y0: number, x1: number, y1: number): void {
  entityHeader(w, 'SOLID', layer, 'AcDbTrace')
  w.tag(10, x0)
  w.tag(20, y0)
  w.tag(30, 0)
  w.tag(11, x1)
  w.tag(21, y0)
  w.tag(31, 0)
  w.tag(12, x0)
  w.tag(22, y1)
  w.tag(32, 0)
  w.tag(13, x1)
  w.tag(23, y1)
  w.tag(33, 0)
}

function spline(w: DxfWriter, layer: string, points: number[][]): void {
  entityHeader(w, 'SPLINE', layer, 'AcDbSpline')
  w.tag(70, 8)
  w.tag(71, 3)
  w.tag(72, points.length + 4)
  w.tag(73, points.length)
  w.tag(74, 0)
  // Clamped uniform knot vector for a cubic curve.
  const n = points.length
  const inner = n - 4
  for (let i = 0; i < 4; i++) w.tag(40, 0)
  for (let i = 1; i <= inner; i++) w.tag(40, i)
  for (let i = 0; i < 4; i++) w.tag(40, inner + 1)
  for (const [x, y] of points) {
    w.tag(10, x)
    w.tag(20, y)
    w.tag(30, 0)
  }
}

/** Polyline-bounded hatch, either solid or a named pattern. */
function hatch(
  w: DxfWriter,
  layer: string,
  loop: number[][],
  patternName: string,
  solid: boolean,
  angle: number,
  scale: number,
): void {
  entityHeader(w, 'HATCH', layer, 'AcDbHatch')
  w.tag(10, 0)
  w.tag(20, 0)
  w.tag(30, 0)
  w.tag(210, 0)
  w.tag(220, 0)
  w.tag(230, 1)
  w.tag(2, patternName)
  w.tag(70, solid ? 1 : 0)
  w.tag(71, 0)
  w.tag(91, 1)
  w.tag(92, 7) // external | polyline | derived
  w.tag(72, 0) // no bulges
  w.tag(73, 1) // closed
  w.tag(93, loop.length)
  for (const [x, y] of loop) {
    w.tag(10, x)
    w.tag(20, y)
  }
  w.tag(97, 0)
  w.tag(75, 0)
  w.tag(76, 1)
  w.tag(52, angle)
  w.tag(41, scale)
  w.tag(77, 0)
  w.tag(78, 0)
  w.tag(47, 1)
  w.tag(98, 0)
}

// ---------------------------------------------------------------------------
// Wall construction
// ---------------------------------------------------------------------------

/** Splits `from`..`to` into the runs left over once the gaps are removed. */
function segmentsOf(from: number, to: number, gaps: Gap[]): [number, number][] {
  const sorted = [...gaps].sort((a, b) => a.at - b.at)
  const segments: [number, number][] = []
  let cursor = from
  for (const gap of sorted) {
    const start = Math.max(from, gap.at)
    const end = Math.min(to, gap.at + gap.len)
    if (end <= cursor) continue
    if (start > cursor) segments.push([cursor, start])
    cursor = Math.max(cursor, end)
  }
  if (cursor < to) segments.push([cursor, to])
  return segments
}

/** Emits a straight run broken by the given gaps. */
function brokenLine(
  w: DxfWriter,
  layer: string,
  orientation: 'h' | 'v',
  fixed: number,
  from: number,
  to: number,
  gaps: Gap[],
): void {
  for (const [start, end] of segmentsOf(from, to, gaps)) {
    if (orientation === 'h') line(w, layer, start, fixed, end, fixed)
    else line(w, layer, fixed, start, fixed, end)
  }
}

/**
 * Poché: the solid fill inside a wall's two faces, broken at every opening.
 * This is what makes a plan read as walls rather than as pairs of lines.
 */
function wallBand(
  w: DxfWriter,
  orientation: 'h' | 'v',
  near: number,
  far: number,
  from: number,
  to: number,
  gaps: Gap[],
): void {
  for (const [start, end] of segmentsOf(from, to, gaps)) {
    if (orientation === 'h') solid(w, 'A-WALL-PATT', start, near, end, far)
    else solid(w, 'A-WALL-PATT', near, start, far, end)
  }
}

/** Short line across the wall thickness, closing an opening or a wall end. */
function jamb(w: DxfWriter, layer: string, orientation: 'h' | 'v', position: number, a: number, b: number): void {
  if (orientation === 'h') line(w, layer, position, a, position, b)
  else line(w, layer, a, position, b, position)
}

/** Two-line partition with door openings punched through it. */
function partition(
  w: DxfWriter,
  layer: string,
  orientation: 'h' | 'v',
  center: number,
  from: number,
  to: number,
  thickness: number,
  openings: Gap[],
  caps: { start: boolean; end: boolean } = { start: false, end: false },
): void {
  const near = center - thickness / 2
  const far = center + thickness / 2
  wallBand(w, orientation, near, far, from, to, openings)
  brokenLine(w, layer, orientation, near, from, to, openings)
  brokenLine(w, layer, orientation, far, from, to, openings)
  for (const opening of openings) {
    jamb(w, layer, orientation, opening.at, near, far)
    jamb(w, layer, orientation, opening.at + opening.len, near, far)
  }
  if (caps.start) jamb(w, layer, orientation, from, near, far)
  if (caps.end) jamb(w, layer, orientation, to, near, far)
}

/** Sill lines plus glazing across a window opening in an exterior wall. */
function window_(
  w: DxfWriter,
  orientation: 'h' | 'v',
  outer: number,
  inner: number,
  at: number,
  len: number,
): void {
  const mid = (outer + inner) / 2
  const offset = (inner - outer) * 0.18
  jamb(w, 'A-WALL', orientation, at, outer, inner)
  jamb(w, 'A-WALL', orientation, at + len, outer, inner)
  for (const glass of [mid - offset, mid + offset]) {
    if (orientation === 'h') line(w, 'A-GLAZ', at, glass, at + len, glass)
    else line(w, 'A-GLAZ', glass, at, glass, at + len)
  }
}

// ---------------------------------------------------------------------------
// Fixtures and furniture
// ---------------------------------------------------------------------------

function sofa(w: DxfWriter, x: number, y: number, width: number, depth: number): void {
  rect(w, 'A-FURN', x, y, x + width, y + depth)
  rect(w, 'A-FURN', x + 90, y + 90, x + width - 90, y + depth - 140)
  line(w, 'A-FURN', x + 90, y + depth - 140, x + width - 90, y + depth - 140)
}

function bed(w: DxfWriter, x: number, y: number, width: number, length: number): void {
  rect(w, 'A-FURN', x, y, x + width, y + length)
  // Pillow band and turned-down sheet.
  line(w, 'A-FURN', x, y + length - 420, x + width, y + length - 420)
  rect(w, 'A-FURN', x + 110, y + length - 380, x + width / 2 - 60, y + length - 90)
  rect(w, 'A-FURN', x + width / 2 + 60, y + length - 380, x + width - 110, y + length - 90)
  line(w, 'A-FURN', x, y + 620, x + width, y + 620)
}

function kitchenRun(w: DxfWriter): void {
  const depth = 600
  // L-shaped counter along the west and south faces of the kitchen.
  polyline(
    w,
    'A-FURN',
    [
      [P_VERTICAL + half, IN_S + 2600],
      [P_VERTICAL + half + depth, IN_S + 2600],
      [P_VERTICAL + half + depth, IN_S + depth],
      [P_KITCHEN - half, IN_S + depth],
      [P_KITCHEN - half, IN_S],
      [P_VERTICAL + half, IN_S],
    ],
    true,
  )
  // Sink bowl and drainer.
  rect(w, 'A-FIXT', P_VERTICAL + half + 120, IN_S + 1500, P_VERTICAL + half + 480, IN_S + 2200)
  circle(w, 'A-FIXT', P_VERTICAL + half + 300, IN_S + 1850, 55)
  // Hob with four burners.
  rect(w, 'A-FIXT', P_VERTICAL + 900, IN_S + 90, P_VERTICAL + 1500, IN_S + 510)
  for (const [dx, dy] of [
    [150, 120],
    [150, 300],
    [420, 120],
    [420, 300],
  ]) {
    circle(w, 'A-FIXT', P_VERTICAL + 900 + dx, IN_S + dy, 75)
  }
}

function bathroom(w: DxfWriter): void {
  const x0 = P_KITCHEN + half
  const y0 = IN_S
  const x1 = IN_E
  const y1 = P_HORIZONTAL - half

  // Tiled floor.
  hatch(
    w,
    'A-FLOR-PATT',
    [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ],
    'ANSI31',
    false,
    45,
    12,
  )

  // Shower tray in the far corner.
  rect(w, 'A-FIXT', x1 - 1100, y1 - 1100, x1, y1)
  line(w, 'A-FIXT', x1 - 1100, y1 - 1100, x1, y1)
  line(w, 'A-FIXT', x1 - 1100, y1, x1, y1 - 1100)

  // Basin.
  rect(w, 'A-FIXT', x0 + 250, y1 - 550, x0 + 1050, y1)
  ellipse(w, 'A-FIXT', x0 + 650, y1 - 270, 300, 0, 0.62)

  // WC.
  rect(w, 'A-FIXT', x0 + 200, y0 + 300, x0 + 420, y0 + 950)
  ellipse(w, 'A-FIXT', x0 + 310, y0 + 1200, 0, 260, 0.68)
}

function livingRoom(w: DxfWriter): void {
  sofa(w, IN_W + 500, IN_S + 400, 2400, 900)
  rect(w, 'A-FURN', IN_W + 500, IN_S + 1700, IN_W + 2000, IN_S + 2500)
  ellipse(w, 'A-FURN', IN_W + 1700, IN_S + 1500, 700, 0, 0.55)

  // Dining table and four chairs.
  const tableX = 4700
  const tableY = 3400
  circle(w, 'A-FURN', tableX, tableY, 750)
  for (let i = 0; i < 4; i++) {
    const angle = (i * Math.PI) / 2 + Math.PI / 4
    const cx = tableX + Math.cos(angle) * 1120
    const cy = tableY + Math.sin(angle) * 1120
    insert(w, 'A-FURN', 'CHAIR', cx, cy, 1, 1, (angle * 180) / Math.PI - 90)
  }

  // Media unit against the south wall.
  rect(w, 'A-FURN', 3400, IN_S + 60, 5200, IN_S + 460)
}

// ---------------------------------------------------------------------------
// Annotation
// ---------------------------------------------------------------------------

function roomLabel(w: DxfWriter, cx: number, cy: number, name: string, area: string): void {
  text(w, 'A-ANNO-TEXT', cx, cy, 260, name, { hAlign: 1, vAlign: 2 })
  text(w, 'A-ANNO-TEXT', cx, cy - 420, 180, area, { hAlign: 1, vAlign: 2 })
}

/** Column grid line with its bubble and reference letter. */
function gridLine(w: DxfWriter, orientation: 'h' | 'v', position: number, label: string, extend = 1400): void {
  if (orientation === 'v') {
    line(w, 'A-GRID', position, -extend, position, H + extend)
    circle(w, 'A-GRID', position, H + extend - 40, 340)
    text(w, 'A-GRID', position, H + extend - 40, 240, label, { hAlign: 1, vAlign: 2 })
  } else {
    line(w, 'A-GRID', -extend, position, W + extend, position)
    circle(w, 'A-GRID', -extend + 40, position, 340)
    text(w, 'A-GRID', -extend + 40, position, 240, label, { hAlign: 1, vAlign: 2 })
  }
}

/**
 * A real DIMENSION entity plus the anonymous block that holds its graphics,
 * which is how AutoCAD stores dimensions and how this viewer draws them.
 */
function dimensionBlock(
  w: DxfWriter,
  blockName: string,
  orientation: 'h' | 'v',
  start: number,
  end: number,
  offset: number,
  from: number,
): void {
  const value = Math.round(Math.abs(end - start))
  const tick = 90

  w.tag(0, 'BLOCK')
  w.tag(5, w.nextHandle())
  w.tag(100, 'AcDbEntity')
  w.tag(8, 'A-ANNO-DIMS')
  w.tag(100, 'AcDbBlockBegin')
  w.tag(2, blockName)
  w.tag(70, 1)
  w.tag(10, 0)
  w.tag(20, 0)
  w.tag(30, 0)
  w.tag(3, blockName)
  w.tag(1, '')

  if (orientation === 'h') {
    line(w, 'A-ANNO-DIMS', start, from, start, offset + 160)
    line(w, 'A-ANNO-DIMS', end, from, end, offset + 160)
    line(w, 'A-ANNO-DIMS', start, offset, end, offset)
    line(w, 'A-ANNO-DIMS', start - tick, offset - tick, start + tick, offset + tick)
    line(w, 'A-ANNO-DIMS', end - tick, offset - tick, end + tick, offset + tick)
    text(w, 'A-ANNO-DIMS', (start + end) / 2, offset + 90, 200, String(value), { hAlign: 1 })
  } else {
    line(w, 'A-ANNO-DIMS', from, start, offset - 160, start)
    line(w, 'A-ANNO-DIMS', from, end, offset - 160, end)
    line(w, 'A-ANNO-DIMS', offset, start, offset, end)
    line(w, 'A-ANNO-DIMS', offset - tick, start - tick, offset + tick, start + tick)
    line(w, 'A-ANNO-DIMS', offset - tick, end - tick, offset + tick, end + tick)
    text(w, 'A-ANNO-DIMS', offset - 90, (start + end) / 2, 200, String(value), { hAlign: 1, rotation: 90 })
  }

  w.tag(0, 'ENDBLK')
  w.tag(5, w.nextHandle())
  w.tag(100, 'AcDbEntity')
  w.tag(8, 'A-ANNO-DIMS')
  w.tag(100, 'AcDbBlockEnd')
}

function dimensionEntity(w: DxfWriter, blockName: string, midX: number, midY: number): void {
  entityHeader(w, 'DIMENSION', 'A-ANNO-DIMS', 'AcDbDimension')
  w.tag(2, blockName)
  w.tag(10, 0)
  w.tag(20, 0)
  w.tag(30, 0)
  w.tag(11, midX)
  w.tag(21, midY)
  w.tag(31, 0)
  w.tag(70, 0)
}

// ---------------------------------------------------------------------------
// Document assembly
// ---------------------------------------------------------------------------

interface LayerSpec {
  name: string
  color: number
  linetype: string
  lineweight: number
}

const LAYERS: LayerSpec[] = [
  { name: '0', color: 7, linetype: 'CONTINUOUS', lineweight: 25 },
  { name: 'A-WALL', color: 7, linetype: 'CONTINUOUS', lineweight: 50 },
  // Mid greys: dark enough to read as poché, light enough that neither the
  // dark nor the paper theme has to flip them for contrast.
  { name: 'A-WALL-PATT', color: 9, linetype: 'CONTINUOUS', lineweight: 9 },
  { name: 'A-DOOR', color: 3, linetype: 'CONTINUOUS', lineweight: 18 },
  { name: 'A-GLAZ', color: 4, linetype: 'CONTINUOUS', lineweight: 13 },
  { name: 'A-FURN', color: 5, linetype: 'CONTINUOUS', lineweight: 13 },
  { name: 'A-FIXT', color: 6, linetype: 'CONTINUOUS', lineweight: 13 },
  { name: 'A-FLOR-PATT', color: 253, linetype: 'CONTINUOUS', lineweight: 9 },
  { name: 'A-ANNO-TEXT', color: 2, linetype: 'CONTINUOUS', lineweight: 18 },
  { name: 'A-ANNO-DIMS', color: 2, linetype: 'CONTINUOUS', lineweight: 13 },
  { name: 'A-GRID', color: 1, linetype: 'CENTER', lineweight: 13 },
  { name: 'L-SITE', color: 92, linetype: 'DASHED', lineweight: 13 },
]

function writeLinetypes(w: DxfWriter): void {
  const define = (name: string, description: string, pattern: number[]) => {
    w.tag(0, 'LTYPE')
    w.tag(5, w.nextHandle())
    w.tag(100, 'AcDbSymbolTableRecord')
    w.tag(100, 'AcDbLinetypeTableRecord')
    w.tag(2, name)
    w.tag(70, 0)
    w.tag(3, description)
    w.tag(72, 65)
    w.tag(73, pattern.length)
    w.tag(40, pattern.reduce((sum, value) => sum + Math.abs(value), 0))
    for (const value of pattern) {
      w.tag(49, value)
      w.tag(74, 0)
    }
  }

  w.tag(0, 'TABLE')
  w.tag(2, 'LTYPE')
  w.tag(70, 3)
  define('CONTINUOUS', 'Solid line', [])
  define('DASHED', 'Dashed __ __ __ __ __', [180, -90])
  define('CENTER', 'Center ____ _ ____ _ ____', [500, -110, 110, -110])
  w.tag(0, 'ENDTAB')
}

function writeLayers(w: DxfWriter): void {
  w.tag(0, 'TABLE')
  w.tag(2, 'LAYER')
  w.tag(70, LAYERS.length)
  for (const layer of LAYERS) {
    w.tag(0, 'LAYER')
    w.tag(5, w.nextHandle())
    w.tag(100, 'AcDbSymbolTableRecord')
    w.tag(100, 'AcDbLayerTableRecord')
    w.tag(2, layer.name)
    w.tag(70, 0)
    w.tag(62, layer.color)
    w.tag(6, layer.linetype)
    w.tag(370, layer.lineweight)
  }
  w.tag(0, 'ENDTAB')
}

function writeBlocks(w: DxfWriter): void {
  const beginBlock = (name: string, layer: string) => {
    w.tag(0, 'BLOCK')
    w.tag(5, w.nextHandle())
    w.tag(100, 'AcDbEntity')
    w.tag(8, layer)
    w.tag(100, 'AcDbBlockBegin')
    w.tag(2, name)
    w.tag(70, 0)
    w.tag(10, 0)
    w.tag(20, 0)
    w.tag(30, 0)
    w.tag(3, name)
    w.tag(1, '')
  }
  const endBlock = (layer: string) => {
    w.tag(0, 'ENDBLK')
    w.tag(5, w.nextHandle())
    w.tag(100, 'AcDbEntity')
    w.tag(8, layer)
    w.tag(100, 'AcDbBlockEnd')
  }

  // Unit door: hinge at the origin, leaf along +Y, swing arc of radius 1.
  beginBlock('DOOR', 'A-DOOR')
  line(w, '0', 0, 0, 0, 1)
  arc(w, '0', 0, 0, 1, 0, 90)
  endBlock('A-DOOR')

  // Dining chair, 450 × 480, seat centred on the origin.
  beginBlock('CHAIR', 'A-FURN')
  polyline(
    w,
    '0',
    [
      [-225, -240],
      [225, -240],
      [225, 240],
      [-225, 240],
    ],
    true,
  )
  line(w, '0', -225, 160, 225, 160)
  endBlock('A-FURN')

  // North arrow.
  beginBlock('NORTH', 'A-ANNO-TEXT')
  circle(w, '0', 0, 0, 700)
  polyline(
    w,
    '0',
    [
      [0, 620],
      [260, -430],
      [0, -180],
      [-260, -430],
    ],
    true,
  )
  text(w, '0', 0, 820, 260, 'N', { hAlign: 1 })
  endBlock('A-ANNO-TEXT')

  dimensionBlock(w, '*D1', 'h', 0, W, -1300, -300)
  dimensionBlock(w, '*D2', 'v', 0, H, -1300, -300)
  dimensionBlock(w, '*D3', 'h', 0, P_VERTICAL, -600, -300)
}

function writeEntities(w: DxfWriter): void {
  // --- Exterior shell -----------------------------------------------------
  const southWindows: Gap[] = [
    { at: 3400, len: 1800 },
    { at: 9800, len: 1500 },
  ]
  const northWindows: Gap[] = [
    { at: 1800, len: 2000 },
    { at: 8600, len: 2200 },
  ]
  const westWindows: Gap[] = [{ at: 2400, len: 1600 }]
  const eastWindows: Gap[] = [{ at: 6200, len: 1600 }]
  const entryDoor: Gap = { at: 1200, len: 1000 }

  // Poché first: a ring of four bands, opened at every door and window. The
  // north and south bands own the corners so the ring tiles without overlap.
  wallBand(w, 'h', 0, IN_S, 0, W, [entryDoor, ...southWindows])
  wallBand(w, 'h', IN_N, H, 0, W, northWindows)
  wallBand(w, 'v', 0, IN_W, IN_S, IN_N, westWindows)
  wallBand(w, 'v', IN_E, W, IN_S, IN_N, eastWindows)

  // Outer and inner faces, broken only where the entry door sits.
  brokenLine(w, 'A-WALL', 'h', 0, 0, W, [entryDoor])
  brokenLine(w, 'A-WALL', 'h', IN_S, IN_W, IN_E, [entryDoor])
  brokenLine(w, 'A-WALL', 'h', H, 0, W, [])
  brokenLine(w, 'A-WALL', 'h', IN_N, IN_W, IN_E, [])
  brokenLine(w, 'A-WALL', 'v', 0, 0, H, [])
  brokenLine(w, 'A-WALL', 'v', IN_W, IN_S, IN_N, [])
  brokenLine(w, 'A-WALL', 'v', W, 0, H, [])
  brokenLine(w, 'A-WALL', 'v', IN_E, IN_S, IN_N, [])

  jamb(w, 'A-WALL', 'h', entryDoor.at, 0, IN_S)
  jamb(w, 'A-WALL', 'h', entryDoor.at + entryDoor.len, 0, IN_S)
  insert(w, 'A-DOOR', 'DOOR', entryDoor.at + entryDoor.len, IN_S, entryDoor.len, entryDoor.len, 90)

  for (const gap of southWindows) window_(w, 'h', 0, IN_S, gap.at, gap.len)
  for (const gap of northWindows) window_(w, 'h', H, IN_N, gap.at, gap.len)
  for (const gap of westWindows) window_(w, 'v', 0, IN_W, gap.at, gap.len)
  for (const gap of eastWindows) window_(w, 'v', W, IN_E, gap.at, gap.len)

  // --- Internal partitions ------------------------------------------------
  const doorA: Gap = { at: 2100, len: 900 } // living <-> bedroom 02
  const doorB: Gap = { at: 2300, len: 900 } // living <-> kitchen
  const doorC: Gap = { at: 8000, len: 900 } // kitchen <-> bedroom 01
  const doorD: Gap = { at: 900, len: 800 } // kitchen <-> bath

  partition(w, 'A-WALL', 'h', P_HORIZONTAL, IN_W, IN_E, INT, [doorA, doorC])
  partition(w, 'A-WALL', 'v', P_VERTICAL, IN_S, IN_N, INT, [doorB])
  partition(w, 'A-WALL', 'v', P_KITCHEN, IN_S, P_HORIZONTAL - half, INT, [doorD], { start: false, end: true })

  insert(w, 'A-DOOR', 'DOOR', doorA.at, P_HORIZONTAL + half, doorA.len, doorA.len, 0)
  insert(w, 'A-DOOR', 'DOOR', doorC.at + doorC.len, P_HORIZONTAL + half, doorC.len, doorC.len, 90)
  insert(w, 'A-DOOR', 'DOOR', P_VERTICAL - half, doorB.at, doorB.len, doorB.len, -90)
  insert(w, 'A-DOOR', 'DOOR', P_KITCHEN - half, doorD.at + doorD.len, doorD.len, doorD.len, 180)

  // --- Furniture and fixtures --------------------------------------------
  livingRoom(w)
  bed(w, IN_W + 700, IN_N - 2400, 1600, 2000)
  rect(w, 'A-FURN', IN_W + 3200, IN_N - 620, IN_W + 5000, IN_N)
  bed(w, P_VERTICAL + 1400, IN_N - 2300, 1800, 2000)
  rect(w, 'A-FURN', IN_E - 640, P_HORIZONTAL + 400, IN_E, P_HORIZONTAL + 2600)
  kitchenRun(w)
  bathroom(w)

  // --- Room labels --------------------------------------------------------
  roomLabel(w, 3400, 2200, 'LIVING / DINING', '30.6 m²')
  roomLabel(w, 3400, 7000, 'BEDROOM 02', '24.1 m²')
  roomLabel(w, 9300, 7000, 'BEDROOM 01', '18.2 m²')
  roomLabel(w, 8100, 3300, 'KITCHEN', '11.7 m²')
  roomLabel(w, 10600, 3300, 'BATH', '10.9 m²')

  // --- Column grid, dimensions, north point -------------------------------
  gridLine(w, 'v', 0, 'A')
  gridLine(w, 'v', P_VERTICAL, 'B')
  gridLine(w, 'v', W, 'C')
  gridLine(w, 'h', 0, '1')
  gridLine(w, 'h', P_HORIZONTAL, '2')
  gridLine(w, 'h', H, '3')

  dimensionEntity(w, '*D1', W / 2, -1300)
  dimensionEntity(w, '*D2', -1300, H / 2)
  dimensionEntity(w, '*D3', P_VERTICAL / 2, -600)

  insert(w, 'A-ANNO-TEXT', 'NORTH', W + 2600, H - 900, 1, 1, 0)

  // --- Site edge, drawn as a spline on a dashed layer ---------------------
  spline(w, 'L-SITE', [
    [-2600, -2600],
    [1200, -3400],
    [5600, -2200],
    [9800, -3600],
    [14600, -2400],
    [15400, 2600],
  ])

  // --- Title block --------------------------------------------------------
  const titleY = -4600
  rect(w, '0', 0, titleY, W, titleY + 1500)
  line(w, '0', 0, titleY + 900, W, titleY + 900)
  line(w, '0', 8200, titleY, 8200, titleY + 900)
  text(w, 'A-ANNO-TEXT', 300, titleY + 1080, 340, 'APARTMENT TYPE A — GROUND FLOOR PLAN')
  text(w, 'A-ANNO-TEXT', 300, titleY + 480, 220, 'SAMPLE DRAWING · ALL DIMENSIONS IN MILLIMETRES')
  text(w, 'A-ANNO-TEXT', 8400, titleY + 480, 260, 'SCALE 1:100')
}

/** Builds the sample drawing as ASCII DXF text. */
export function buildSampleDxf(): string {
  const w = new DxfWriter()

  w.tag(0, 'SECTION')
  w.tag(2, 'HEADER')
  w.tag(9, '$ACADVER')
  w.tag(1, 'AC1015')
  w.tag(9, '$INSUNITS')
  w.tag(70, 4)
  w.tag(9, '$LTSCALE')
  w.tag(40, 1)
  w.tag(9, '$EXTMIN')
  w.tag(10, -4000)
  w.tag(20, -6200)
  w.tag(30, 0)
  w.tag(9, '$EXTMAX')
  w.tag(10, 16000)
  w.tag(20, 11000)
  w.tag(30, 0)
  w.tag(0, 'ENDSEC')

  w.tag(0, 'SECTION')
  w.tag(2, 'TABLES')
  writeLinetypes(w)
  writeLayers(w)
  w.tag(0, 'ENDSEC')

  w.tag(0, 'SECTION')
  w.tag(2, 'BLOCKS')
  writeBlocks(w)
  w.tag(0, 'ENDSEC')

  w.tag(0, 'SECTION')
  w.tag(2, 'ENTITIES')
  writeEntities(w)
  w.tag(0, 'ENDSEC')

  w.tag(0, 'EOF')
  return w.toString()
}

export const SAMPLE_FILE_NAME = 'apartment-type-a.dxf'
