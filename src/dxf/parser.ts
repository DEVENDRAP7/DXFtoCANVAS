/**
 * DXF reader.
 *
 * Walks the four sections that matter for drawing — HEADER, TABLES, BLOCKS and
 * ENTITIES — and produces a `DxfDocument`. Anything it cannot interpret is
 * recorded as a warning instead of aborting the load, so a drawing with one
 * exotic entity still opens.
 */

import { Record, TagReader, tokenize } from './tokenizer'
import { sampleArc, sampleEllipse, samplePolyline, sampleSpline } from './geometry'
import type {
  ArcEntity,
  CircleEntity,
  DimensionEntity,
  DxfBlock,
  DxfDocument,
  DxfEntity,
  DxfHeader,
  DxfLayer,
  DxfLinetype,
  EllipseEntity,
  EntityBase,
  FaceEntity,
  HatchEntity,
  HatchLoop,
  InsertEntity,
  LeaderEntity,
  LineEntity,
  MTextEntity,
  Point2,
  Point3,
  PointEntity,
  PolylineEntity,
  PolylineVertex,
  RayEntity,
  SolidEntity,
  SplineEntity,
  Tag,
  TextEntity,
  TextHAlign,
  TextVAlign,
} from './types'

/** Chord tolerance used when a curve has to be flattened at parse time. */
const HATCH_TOLERANCE = 0.02

const H_ALIGN: TextHAlign[] = ['left', 'center', 'right', 'aligned', 'middle', 'fit']
const V_ALIGN: TextVAlign[] = ['baseline', 'bottom', 'middle', 'top']

/** Replaces the `%%` escapes used by single-line TEXT. */
export function decodeTextEscapes(input: string): string {
  return input
    .replace(/%%[dD]/g, '°')
    .replace(/%%[pP]/g, '±')
    .replace(/%%[cC]/g, 'ø')
    .replace(/%%[uUoOkK]/g, '')
    .replace(/%%%/g, '%')
}

/**
 * Strips MTEXT inline formatting down to readable text.
 *
 * MTEXT mixes content with font, colour and stacking directives. The renderer
 * draws plain runs, so the directives are removed and only the paragraph
 * breaks and stacked-fraction contents are kept.
 */
export function decodeMText(input: string): string {
  // Escaped literals are parked on private-use characters first. Without this,
  // the grouping-brace strip further down would also eat the braces an author
  // escaped on purpose.
  const ESCAPED_BACKSLASH = '\uE000'
  const ESCAPED_OPEN = '\uE001'
  const ESCAPED_CLOSE = '\uE002'

  let text = input.replace(/\\([\\{}])/g, (_match, character: string) =>
    character === '\\' ? ESCAPED_BACKSLASH : character === '{' ? ESCAPED_OPEN : ESCAPED_CLOSE,
  )

  // Paragraph breaks come before the argument-carrying directives below: \P has
  // no terminator, so leaving it in place would let the directive pattern
  // swallow it along with the rest of the line up to the next semicolon.
  text = text.replace(/\\P/g, '\n')
  // \~ is a non-breaking space, so it decodes to one rather than to a plain space.
  text = text.replace(/\\~/g, '\u00a0')

  // Stacked fractions: \S1^2; or \S1/2; -> 1/2
  text = text.replace(/\\S([^;]*);/g, (_match, body: string) => body.replace(/[\^#]/g, '/'))
  // Directives carrying a terminated argument: font, colour, height, width,
  // tracking, oblique, alignment and paragraph properties.
  text = text.replace(/\\[fFcCHhWwTtQqAap][^;{}]*;/g, '')
  // Remaining single-letter directives, which take no argument.
  text = text.replace(/\\[LlOoKkNnXx]/g, '')
  // Grouping braces carry no meaning once the formatting they scoped is gone.
  text = text.replace(/[{}]/g, '')

  text = text
    .replaceAll(ESCAPED_BACKSLASH, '\\')
    .replaceAll(ESCAPED_OPEN, '{')
    .replaceAll(ESCAPED_CLOSE, '}')

  return decodeTextEscapes(text)
}

function readBase(record: Record): EntityBase {
  const color = record.int(62, 256)
  return {
    handle: record.str(5),
    layer: record.str(8, '0'),
    linetype: record.str(6, 'BYLAYER'),
    color,
    trueColor: record.has(420) ? record.int(420) & 0xffffff : undefined,
    lineweight: record.int(370, -1),
    paperSpace: record.int(67, 0) === 1,
    extrusion: record.has(210) ? record.point(210, 1) : undefined,
  }
}

function buildText(record: Record, base: EntityBase): TextEntity {
  const generation = record.int(71, 0)
  const hasAlignPoint = record.hasPoint(11)
  return {
    ...base,
    type: 'TEXT',
    position: record.point(10),
    alignPoint: hasAlignPoint ? record.point(11) : undefined,
    text: decodeTextEscapes(record.str(1)),
    height: record.num(40, 1) || 1,
    rotation: record.num(50, 0),
    widthFactor: record.num(41, 1) || 1,
    oblique: record.num(51, 0),
    style: record.str(7, 'STANDARD'),
    hAlign: H_ALIGN[record.int(72, 0)] ?? 'left',
    vAlign: V_ALIGN[record.int(73, 0)] ?? 'baseline',
    mirrorX: (generation & 2) !== 0,
    mirrorY: (generation & 4) !== 0,
  }
}

function buildMText(record: Record, base: EntityBase): MTextEntity {
  // Long strings are split across repeated code 3 chunks with the tail in code 1.
  const body = record.allStrs(3).join('') + record.str(1)
  return {
    ...base,
    type: 'MTEXT',
    position: record.point(10),
    text: decodeMText(body),
    height: record.num(40, 1) || 1,
    referenceWidth: record.num(41, 0),
    rotation: record.num(50, 0),
    attachment: record.int(71, 1),
    lineSpacing: record.num(44, 1) || 1,
    style: record.str(7, 'STANDARD'),
  }
}

function buildLwPolyline(record: Record, base: EntityBase): PolylineEntity {
  const vertices: PolylineVertex[] = []
  let current: PolylineVertex | null = null
  const elevation = record.num(38, 0)

  for (const tag of record.tags) {
    const value = Number.parseFloat(tag.value)
    if (tag.code === 10) {
      current = { x: Number.isFinite(value) ? value : 0, y: 0, bulge: 0 }
      vertices.push(current)
    } else if (current && tag.code === 20) {
      current.y = Number.isFinite(value) ? value : 0
    } else if (current && tag.code === 42) {
      current.bulge = Number.isFinite(value) ? value : 0
    }
  }

  return {
    ...base,
    type: 'POLYLINE',
    vertices,
    closed: (record.int(70, 0) & 1) !== 0,
    width: record.num(43, 0),
    elevation,
  }
}

function buildSpline(record: Record, base: EntityBase): SplineEntity {
  const flags = record.int(70, 0)
  return {
    ...base,
    type: 'SPLINE',
    degree: record.int(71, 3),
    controlPoints: record.points(10),
    knots: record.allNums(40),
    weights: record.allNums(41),
    fitPoints: record.points(11),
    closed: (flags & 1) !== 0,
  }
}

function buildSolid(record: Record, base: EntityBase, type: 'SOLID' | '3DFACE'): SolidEntity | FaceEntity {
  const c0 = record.point(10)
  const c1 = record.point(11)
  const c2 = record.point(12)
  const c3 = record.has(13) ? record.point(13) : c2
  // DXF stores the last two corners in swapped order, which would draw a bow tie.
  const corners = [c0, c1, c3, c2]
  return { ...base, type, corners } as SolidEntity | FaceEntity
}

/**
 * Flattens HATCH boundary paths into point loops.
 *
 * Boundaries come in two shapes: a single polyline with optional bulges, or a
 * list of line / arc / elliptic-arc / spline edges. Both are reduced to point
 * loops here because a fill only needs an outline.
 */
function parseHatchLoops(tags: Tag[]): HatchLoop[] {
  const pathCountIndex = tags.findIndex((tag) => tag.code === 91)
  if (pathCountIndex < 0) return []

  const pathCount = Number.parseInt(tags[pathCountIndex].value, 10) || 0
  const loops: HatchLoop[] = []
  let i = pathCountIndex + 1

  const numAt = (index: number) => {
    const value = Number.parseFloat(tags[index]?.value ?? '')
    return Number.isFinite(value) ? value : 0
  }

  for (let path = 0; path < pathCount && i < tags.length; path++) {
    while (i < tags.length && tags[i].code !== 92) i++
    if (i >= tags.length) break

    const pathFlags = Number.parseInt(tags[i].value, 10) || 0
    i++

    if ((pathFlags & 2) !== 0) {
      // Polyline boundary.
      let hasBulge = false
      let closed = false
      let vertexCount = 0
      while (i < tags.length) {
        const code = tags[i].code
        if (code === 72) {
          hasBulge = numAt(i) !== 0
          i++
        } else if (code === 73) {
          closed = numAt(i) !== 0
          i++
        } else if (code === 93) {
          vertexCount = numAt(i)
          i++
          break
        } else {
          break
        }
      }

      const vertices: PolylineVertex[] = []
      while (i < tags.length && vertices.length < vertexCount && tags[i].code === 10) {
        const x = numAt(i)
        i++
        let y = 0
        if (tags[i]?.code === 20) {
          y = numAt(i)
          i++
        }
        let bulge = 0
        if (hasBulge && tags[i]?.code === 42) {
          bulge = numAt(i)
          i++
        }
        vertices.push({ x, y, bulge })
      }
      if (vertices.length >= 2) {
        loops.push({ points: samplePolyline(vertices, closed, HATCH_TOLERANCE), closed })
      }
      continue
    }

    // Edge-list boundary.
    while (i < tags.length && tags[i].code !== 93) i++
    if (i >= tags.length) break
    const edgeCount = Number.parseInt(tags[i].value, 10) || 0
    i++

    const points: Point2[] = []
    for (let edge = 0; edge < edgeCount && i < tags.length; edge++) {
      while (i < tags.length && tags[i].code !== 72) i++
      if (i >= tags.length) break
      const edgeType = Number.parseInt(tags[i].value, 10) || 0
      i++

      // Gather this edge's parameters, stopping before the next edge or the
      // trailing source-object list.
      const edgeTags: Tag[] = []
      while (i < tags.length && tags[i].code !== 72 && tags[i].code !== 92 && tags[i].code !== 97) {
        edgeTags.push(tags[i])
        i++
      }
      const edgeRecord = new Record('EDGE', edgeTags)
      const appendRun = (run: Point2[]) => {
        for (const point of run) {
          const last = points[points.length - 1]
          if (!last || Math.hypot(last.x - point.x, last.y - point.y) > 1e-9) points.push(point)
        }
      }

      switch (edgeType) {
        case 1: {
          const start = edgeRecord.point(10)
          const end = edgeRecord.point(11)
          appendRun([
            { x: start.x, y: start.y },
            { x: end.x, y: end.y },
          ])
          break
        }
        case 2: {
          const center = edgeRecord.point(10)
          const radius = edgeRecord.num(40, 0)
          const counterClockwise = edgeRecord.int(73, 1) !== 0
          appendRun(
            sampleArc(
              {
                cx: center.x,
                cy: center.y,
                radius,
                startAngle: edgeRecord.num(50, 0) * (Math.PI / 180),
                endAngle: edgeRecord.num(51, 360) * (Math.PI / 180),
                counterClockwise,
              },
              HATCH_TOLERANCE,
            ),
          )
          break
        }
        case 3: {
          const center = edgeRecord.point(10)
          const major = edgeRecord.point(11)
          appendRun(
            sampleEllipse(
              {
                cx: center.x,
                cy: center.y,
                majorX: major.x,
                majorY: major.y,
                ratio: edgeRecord.num(40, 1),
                startParam: edgeRecord.num(50, 0) * (Math.PI / 180),
                endParam: edgeRecord.num(51, 360) * (Math.PI / 180),
              },
              HATCH_TOLERANCE,
            ),
          )
          break
        }
        case 4: {
          const controlPoints = edgeRecord.points(10)
          if (controlPoints.length >= 2) {
            appendRun(
              sampleSpline(
                controlPoints,
                edgeRecord.int(94, 3),
                edgeRecord.allNums(40),
                edgeRecord.allNums(42),
                Math.max(16, controlPoints.length * 8),
              ),
            )
          }
          break
        }
        default:
          break
      }
    }

    if (points.length >= 2) loops.push({ points, closed: true })
  }

  return loops
}

function buildHatch(record: Record, base: EntityBase): HatchEntity {
  return {
    ...base,
    type: 'HATCH',
    patternName: record.str(2, 'SOLID'),
    solid: record.int(70, 1) === 1,
    patternAngle: record.num(52, 0),
    patternScale: record.num(41, 1) || 1,
    loops: parseHatchLoops(record.tags),
  }
}

/**
 * Builds one entity from its group codes.
 *
 * Returns null for entity types this renderer does not draw; the caller turns
 * that into a warning rather than a failure.
 */
function buildEntity(record: Record): DxfEntity | null {
  const base = readBase(record)

  switch (record.type) {
    case 'LINE':
      return { ...base, type: 'LINE', start: record.point(10), end: record.point(11) } satisfies LineEntity

    case 'POINT':
      return { ...base, type: 'POINT', position: record.point(10) } satisfies PointEntity

    case 'CIRCLE':
      return {
        ...base,
        type: 'CIRCLE',
        center: record.point(10),
        radius: record.num(40, 0),
      } satisfies CircleEntity

    case 'ARC':
      return {
        ...base,
        type: 'ARC',
        center: record.point(10),
        radius: record.num(40, 0),
        startAngle: record.num(50, 0),
        endAngle: record.num(51, 360),
      } satisfies ArcEntity

    case 'ELLIPSE':
      return {
        ...base,
        type: 'ELLIPSE',
        center: record.point(10),
        majorAxis: record.point(11),
        ratio: record.num(40, 1) || 1,
        startParam: record.num(41, 0),
        endParam: record.num(42, Math.PI * 2),
      } satisfies EllipseEntity

    case 'LWPOLYLINE':
      return buildLwPolyline(record, base)

    case 'SPLINE':
      return buildSpline(record, base)

    case 'TEXT':
    case 'ATTRIB':
      return buildText(record, base)

    case 'MTEXT':
      return buildMText(record, base)

    case 'SOLID':
    case 'TRACE':
      return buildSolid(record, base, 'SOLID')

    case '3DFACE':
      return buildSolid(record, base, '3DFACE')

    case 'HATCH':
      return buildHatch(record, base)

    case 'LEADER':
      return {
        ...base,
        type: 'LEADER',
        vertices: record.points(10),
        arrowHeadSize: record.num(41, 0),
      } satisfies LeaderEntity

    case 'DIMENSION':
      return {
        ...base,
        type: 'DIMENSION',
        blockName: record.str(2),
        textMidPoint: record.point(11),
        text: decodeTextEscapes(record.str(1)),
      } satisfies DimensionEntity

    case 'XLINE':
    case 'RAY':
      return {
        ...base,
        type: 'RAY',
        position: record.point(10),
        direction: record.point(11),
        bidirectional: record.type === 'XLINE',
      } satisfies RayEntity

    case 'INSERT':
      return {
        ...base,
        type: 'INSERT',
        blockName: record.str(2),
        position: record.point(10),
        scaleX: record.num(41, 1),
        scaleY: record.num(42, 1),
        scaleZ: record.num(43, 1),
        rotation: record.num(50, 0),
        columnCount: Math.max(1, record.int(70, 1)),
        rowCount: Math.max(1, record.int(71, 1)),
        columnSpacing: record.num(44, 0),
        rowSpacing: record.num(45, 0),
        attributes: [],
      } satisfies InsertEntity

    default:
      return null
  }
}

/** Old-style POLYLINE: the shape lives in the VERTEX records that follow it. */
function buildLegacyPolyline(record: Record, base: EntityBase, vertexRecords: Record[]): PolylineEntity | null {
  const flags = record.int(70, 0)
  // Meshes and polyface bodies are surfaces, not outlines; drawing their
  // vertex list as a path would produce nonsense.
  if ((flags & 16) !== 0 || (flags & 64) !== 0) return null

  const vertices: PolylineVertex[] = []
  for (const vertex of vertexRecords) {
    const point = vertex.point(10)
    vertices.push({ x: point.x, y: point.y, bulge: vertex.num(42, 0) })
  }

  return {
    ...base,
    type: 'POLYLINE',
    vertices,
    closed: (flags & 1) !== 0,
    width: record.num(40, 0),
    elevation: record.point(10).z,
  }
}

interface EntityParseResult {
  entities: DxfEntity[]
  unsupported: Set<string>
}

/**
 * Reads a run of entities, stopping (without consuming) at any of `stopAt`.
 *
 * Composite entities are assembled here: POLYLINE swallows its VERTEX records
 * and INSERT swallows its ATTRIB records, both terminated by SEQEND.
 */
function parseEntities(reader: TagReader, stopAt: Set<string>): EntityParseResult {
  const entities: DxfEntity[] = []
  const unsupported = new Set<string>()

  while (!reader.atEnd()) {
    const tag = reader.peek()
    if (!tag) break
    if (tag.code !== 0) {
      reader.skip()
      continue
    }

    const type = tag.value.trim().toUpperCase()
    if (stopAt.has(type)) break

    reader.skip()
    const record = new Record(type, reader.collectUntilNextEntity())
    const base = readBase(record)

    if (type === 'POLYLINE') {
      const vertexRecords: Record[] = []
      while (!reader.atEnd()) {
        const nextTag = reader.peek()
        if (!nextTag || nextTag.code !== 0) break
        const nextType = nextTag.value.trim().toUpperCase()
        if (nextType === 'VERTEX') {
          reader.skip()
          vertexRecords.push(new Record(nextType, reader.collectUntilNextEntity()))
        } else if (nextType === 'SEQEND') {
          reader.skip()
          reader.collectUntilNextEntity()
          break
        } else {
          break
        }
      }
      const polyline = buildLegacyPolyline(record, base, vertexRecords)
      if (polyline) entities.push(polyline)
      else unsupported.add('POLYLINE mesh')
      continue
    }

    const entity = buildEntity(record)

    if (entity && entity.type === 'INSERT') {
      // Attributes are optional and flagged by code 66, but trust the stream
      // over the flag since some writers omit it.
      while (!reader.atEnd()) {
        const nextTag = reader.peek()
        if (!nextTag || nextTag.code !== 0) break
        const nextType = nextTag.value.trim().toUpperCase()
        if (nextType === 'ATTRIB') {
          reader.skip()
          const attribRecord = new Record(nextType, reader.collectUntilNextEntity())
          const attribute = buildText(attribRecord, readBase(attribRecord))
          // Invisible attributes (flag 1) are data, not drawing content.
          if ((attribRecord.int(70, 0) & 1) === 0 && attribute.text) entity.attributes.push(attribute)
        } else if (nextType === 'SEQEND') {
          reader.skip()
          reader.collectUntilNextEntity()
          break
        } else {
          break
        }
      }
    }

    if (entity) entities.push(entity)
    else if (type !== 'SEQEND' && type !== 'ENDBLK' && type !== 'ATTDEF') unsupported.add(type)
  }

  return { entities, unsupported }
}

function parseHeader(reader: TagReader): DxfHeader {
  const header: DxfHeader = { insUnits: 0, version: '' }
  let variable = ''
  const pending = new Map<string, Record>()
  let tags: Tag[] = []

  while (!reader.atEnd()) {
    const tag = reader.peek()
    if (!tag) break
    if (tag.code === 0) break
    reader.skip()

    if (tag.code === 9) {
      if (variable) pending.set(variable, new Record(variable, tags))
      variable = tag.value.trim()
      tags = []
    } else {
      tags.push(tag)
    }
  }
  if (variable) pending.set(variable, new Record(variable, tags))

  header.version = pending.get('$ACADVER')?.str(1) ?? ''
  header.insUnits = pending.get('$INSUNITS')?.int(70, 0) ?? 0

  const extMin = pending.get('$EXTMIN')
  const extMax = pending.get('$EXTMAX')
  if (extMin) header.extMin = extMin.point(10)
  if (extMax) header.extMax = extMax.point(10)

  return header
}

function parseTables(reader: TagReader, document: DxfDocument): void {
  let currentTable = ''

  while (!reader.atEnd()) {
    const tag = reader.peek()
    if (!tag) break
    if (tag.code !== 0) {
      reader.skip()
      continue
    }

    const type = tag.value.trim().toUpperCase()
    if (type === 'ENDSEC') break

    reader.skip()
    const record = new Record(type, reader.collectUntilNextEntity())

    if (type === 'TABLE') {
      currentTable = record.str(2).trim().toUpperCase()
      continue
    }
    if (type === 'ENDTAB') {
      currentTable = ''
      continue
    }

    if (currentTable === 'LAYER' && type === 'LAYER') {
      const rawColor = record.int(62, 7)
      const flags = record.int(70, 0)
      const layer: DxfLayer = {
        name: record.str(2, '0'),
        color: Math.abs(rawColor) || 7,
        trueColor: record.has(420) ? record.int(420) & 0xffffff : undefined,
        linetype: record.str(6, 'CONTINUOUS'),
        lineweight: record.int(370, -3),
        off: rawColor < 0,
        frozen: (flags & 1) !== 0,
        locked: (flags & 4) !== 0,
      }
      document.layers.set(layer.name, layer)
    } else if (currentTable === 'LTYPE' && type === 'LTYPE') {
      const pattern = record.allNums(49)
      const linetype: DxfLinetype = {
        name: record.str(2, 'CONTINUOUS'),
        description: record.str(3, ''),
        pattern,
        patternLength: Math.abs(record.num(40, 0)),
      }
      document.linetypes.set(linetype.name, linetype)
    }
  }
}

function parseBlocks(reader: TagReader, document: DxfDocument, unsupported: Set<string>): void {
  while (!reader.atEnd()) {
    const tag = reader.peek()
    if (!tag) break
    if (tag.code !== 0) {
      reader.skip()
      continue
    }

    const type = tag.value.trim().toUpperCase()
    if (type === 'ENDSEC') break

    reader.skip()
    const record = new Record(type, reader.collectUntilNextEntity())
    if (type !== 'BLOCK') continue

    const basePoint: Point3 = record.point(10)
    const name = record.str(2) || record.str(3)
    const result = parseEntities(reader, new Set(['ENDBLK', 'ENDSEC']))
    for (const item of result.unsupported) unsupported.add(item)

    const block: DxfBlock = { name, basePoint, entities: result.entities }
    document.blocks.set(name, block)

    // Consume the ENDBLK record so the outer loop sees the next BLOCK.
    if (reader.peek()?.code === 0 && reader.peek()?.value.trim().toUpperCase() === 'ENDBLK') {
      reader.skip()
      reader.collectUntilNextEntity()
    }
  }
}

export interface ParseOptions {
  /** Cap on entities read from the ENTITIES section, to keep huge files responsive. */
  maxEntities?: number
}

export function parseDxf(text: string, options: ParseOptions = {}): DxfDocument {
  const tags = tokenize(text)
  const reader = new TagReader(tags)

  const document: DxfDocument = {
    header: { insUnits: 0, version: '' },
    layers: new Map(),
    linetypes: new Map(),
    blocks: new Map(),
    entities: [],
    warnings: [],
  }
  const unsupported = new Set<string>()

  while (!reader.atEnd()) {
    const tag = reader.next()
    if (!tag) break
    if (tag.code !== 0) continue

    const value = tag.value.trim().toUpperCase()
    if (value === 'EOF') break
    if (value !== 'SECTION') continue

    const nameTag = reader.next()
    const section = nameTag?.value.trim().toUpperCase() ?? ''

    switch (section) {
      case 'HEADER':
        document.header = parseHeader(reader)
        break
      case 'TABLES':
        parseTables(reader, document)
        break
      case 'BLOCKS':
        parseBlocks(reader, document, unsupported)
        break
      case 'ENTITIES': {
        const result = parseEntities(reader, new Set(['ENDSEC']))
        document.entities = result.entities
        for (const item of result.unsupported) unsupported.add(item)
        break
      }
      default:
        // CLASSES, OBJECTS, THUMBNAILIMAGE and friends hold no drawable geometry.
        reader.seekEntity('ENDSEC')
        break
    }
  }

  if (options.maxEntities && document.entities.length > options.maxEntities) {
    document.warnings.push(
      `Drawing has ${document.entities.length.toLocaleString()} top-level entities; showing the first ${options.maxEntities.toLocaleString()}.`,
    )
    document.entities = document.entities.slice(0, options.maxEntities)
  }

  // Every drawing has layer "0" even when the table is missing.
  if (!document.layers.has('0')) {
    document.layers.set('0', {
      name: '0',
      color: 7,
      linetype: 'CONTINUOUS',
      lineweight: -3,
      off: false,
      frozen: false,
      locked: false,
    })
  }

  if (unsupported.size > 0) {
    const list = [...unsupported].sort().join(', ')
    document.warnings.push(`Skipped entity types this viewer does not draw: ${list}.`)
  }
  if (document.entities.length === 0) {
    document.warnings.push('The ENTITIES section is empty — there is nothing in model space to draw.')
  }

  return document
}
