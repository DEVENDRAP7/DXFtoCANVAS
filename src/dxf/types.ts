/**
 * Data model for a parsed DXF document.
 *
 * Entities keep their native parameters (centres, radii, angles, bulges) rather
 * than being tessellated at parse time. Curves are only turned into pixels by
 * the renderer, so a circle stays perfectly round no matter how far you zoom in.
 */

export interface Point2 {
  x: number
  y: number
}

export interface Point3 extends Point2 {
  z: number
}

/** A group code / value pair, the atom of a DXF file. */
export interface Tag {
  code: number
  value: string
}

export interface DxfLayer {
  name: string
  /** AutoCAD Color Index. */
  color: number
  /** 0xRRGGBB when the layer carries a true colour, else undefined. */
  trueColor?: number
  linetype: string
  lineweight: number
  /** Layers are stored off as a negative colour index. */
  off: boolean
  frozen: boolean
  locked: boolean
}

export interface DxfLinetype {
  name: string
  description: string
  /** Positive = dash, negative = gap, zero = dot. Drawing units. */
  pattern: number[]
  patternLength: number
}

export interface DxfBlock {
  name: string
  basePoint: Point3
  entities: DxfEntity[]
}

/** Fields every entity carries. */
export interface EntityBase {
  handle: string
  layer: string
  linetype: string
  /** 256 = BYLAYER, 0 = BYBLOCK. */
  color: number
  trueColor?: number
  lineweight: number
  /** Paper-space entities live on a different sheet from the model. */
  paperSpace: boolean
  /** Object Coordinate System normal, used to detect mirrored extrusions. */
  extrusion?: Point3
}

export interface LineEntity extends EntityBase {
  type: 'LINE'
  start: Point3
  end: Point3
}

export interface PointEntity extends EntityBase {
  type: 'POINT'
  position: Point3
}

export interface CircleEntity extends EntityBase {
  type: 'CIRCLE'
  center: Point3
  radius: number
}

export interface ArcEntity extends EntityBase {
  type: 'ARC'
  center: Point3
  radius: number
  /** Degrees, counter-clockwise from +X. */
  startAngle: number
  endAngle: number
}

export interface EllipseEntity extends EntityBase {
  type: 'ELLIPSE'
  center: Point3
  /** Major axis endpoint relative to the centre. */
  majorAxis: Point3
  /** Minor / major axis length ratio. */
  ratio: number
  /** Parametric start / end angle in radians. */
  startParam: number
  endParam: number
}

export interface PolylineVertex extends Point2 {
  /** tan(theta / 4) of the arc that leaves this vertex. 0 = straight. */
  bulge: number
}

export interface PolylineEntity extends EntityBase {
  type: 'POLYLINE'
  vertices: PolylineVertex[]
  closed: boolean
  /** Uniform width when the polyline was given one; drives outline thickness. */
  width: number
  elevation: number
}

export interface SplineEntity extends EntityBase {
  type: 'SPLINE'
  degree: number
  controlPoints: Point3[]
  knots: number[]
  weights: number[]
  fitPoints: Point3[]
  closed: boolean
}

export type TextHAlign = 'left' | 'center' | 'right' | 'aligned' | 'middle' | 'fit'
export type TextVAlign = 'baseline' | 'bottom' | 'middle' | 'top'

export interface TextEntity extends EntityBase {
  type: 'TEXT'
  position: Point3
  /** Present for aligned / fitted / centred text. */
  alignPoint?: Point3
  text: string
  height: number
  /** Degrees. */
  rotation: number
  widthFactor: number
  /** Degrees of italic slant. */
  oblique: number
  style: string
  hAlign: TextHAlign
  vAlign: TextVAlign
  mirrorX: boolean
  mirrorY: boolean
}

export interface MTextEntity extends EntityBase {
  type: 'MTEXT'
  position: Point3
  text: string
  height: number
  /** Wrap width in drawing units; 0 = no wrapping. */
  referenceWidth: number
  rotation: number
  /** 1..9, top-left through bottom-right. */
  attachment: number
  lineSpacing: number
  style: string
}

export interface InsertEntity extends EntityBase {
  type: 'INSERT'
  blockName: string
  position: Point3
  scaleX: number
  scaleY: number
  scaleZ: number
  rotation: number
  columnCount: number
  rowCount: number
  columnSpacing: number
  rowSpacing: number
  /** Attribute text carried by this reference. */
  attributes: TextEntity[]
}

export interface SolidEntity extends EntityBase {
  type: 'SOLID'
  /** Three or four corners, already untangled from the DXF bow-tie order. */
  corners: Point3[]
}

export interface FaceEntity extends EntityBase {
  type: '3DFACE'
  corners: Point3[]
}

export interface LeaderEntity extends EntityBase {
  type: 'LEADER'
  vertices: Point3[]
  arrowHeadSize: number
}

export interface DimensionEntity extends EntityBase {
  type: 'DIMENSION'
  /** Anonymous block holding the already-composed dimension graphics. */
  blockName: string
  textMidPoint: Point3
  text: string
}

/** One connected boundary of a hatch, flattened to a point loop. */
export interface HatchLoop {
  points: Point2[]
  closed: boolean
}

export interface HatchEntity extends EntityBase {
  type: 'HATCH'
  patternName: string
  solid: boolean
  /** Degrees. */
  patternAngle: number
  patternScale: number
  loops: HatchLoop[]
}

export interface RayEntity extends EntityBase {
  type: 'RAY'
  position: Point3
  direction: Point3
  /** XLINE runs both ways from the base point, RAY only forwards. */
  bidirectional: boolean
}

export type DxfEntity =
  | LineEntity
  | PointEntity
  | CircleEntity
  | ArcEntity
  | EllipseEntity
  | PolylineEntity
  | SplineEntity
  | TextEntity
  | MTextEntity
  | InsertEntity
  | SolidEntity
  | FaceEntity
  | LeaderEntity
  | DimensionEntity
  | HatchEntity
  | RayEntity

export type EntityType = DxfEntity['type']

export interface BoundingBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface DxfHeader {
  /** $INSUNITS, 0 = unitless. */
  insUnits: number
  extMin?: Point3
  extMax?: Point3
  /** $ACADVER, e.g. "AC1027". */
  version: string
}

export interface DxfDocument {
  header: DxfHeader
  layers: Map<string, DxfLayer>
  linetypes: Map<string, DxfLinetype>
  blocks: Map<string, DxfBlock>
  entities: DxfEntity[]
  /** Non-fatal problems collected while reading, surfaced in the UI. */
  warnings: string[]
}
