/**
 * Turns raw DXF text into a flat stream of group-code / value pairs, and
 * provides a small cursor over that stream for the parser to walk.
 */

import type { Tag } from './types'

const BINARY_SENTINEL = 'AutoCAD Binary DXF'

export class DxfFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DxfFormatError'
  }
}

export function isBinaryDxf(text: string): boolean {
  return text.slice(0, BINARY_SENTINEL.length) === BINARY_SENTINEL
}

/**
 * Splits the file into tags.
 *
 * DXF writes one value per line as `code\nvalue`, with the line ending varying
 * between writers. Malformed trailing lines are dropped rather than thrown on,
 * since plenty of exporters leave a stray newline at the end.
 */
export function tokenize(text: string): Tag[] {
  if (isBinaryDxf(text)) {
    throw new DxfFormatError(
      'This is a binary DXF. Re-save it as ASCII DXF (in AutoCAD: SAVEAS → "AutoCAD DXF", not "Binary DXF").',
    )
  }

  // Strip a UTF-8 BOM, which otherwise poisons the very first group code.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = body.split(/\r\n|\r|\n/)
  const tags: Tag[] = []

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number.parseInt(lines[i].trim(), 10)
    if (Number.isNaN(code)) {
      // Resynchronise: a single stray line would otherwise swap every
      // code/value pair after it. Step forward by one instead of two.
      i -= 1
      continue
    }
    tags.push({ code, value: lines[i + 1] })
  }

  if (tags.length === 0) {
    throw new DxfFormatError('No DXF group codes found — the file does not look like a DXF drawing.')
  }
  return tags
}

/** Forward-only cursor with one-tag lookahead. */
export class TagReader {
  private index = 0

  constructor(private readonly tags: Tag[]) {}

  get position(): number {
    return this.index
  }

  atEnd(): boolean {
    return this.index >= this.tags.length
  }

  peek(): Tag | undefined {
    return this.tags[this.index]
  }

  next(): Tag | undefined {
    return this.tags[this.index++]
  }

  skip(): void {
    this.index++
  }

  /** Advances past every tag up to (but not including) the next `0` group. */
  collectUntilNextEntity(): Tag[] {
    const collected: Tag[] = []
    while (!this.atEnd() && this.tags[this.index].code !== 0) {
      collected.push(this.tags[this.index++])
    }
    return collected
  }

  /** Advances to just past the next `0/<name>` tag; used to recover from junk. */
  seekEntity(name: string): boolean {
    while (!this.atEnd()) {
      const tag = this.tags[this.index++]
      if (tag.code === 0 && tag.value.trim() === name) return true
    }
    return false
  }
}

/** Ordered accessor over the tags of a single entity or table record. */
export class Record {
  constructor(
    readonly type: string,
    readonly tags: Tag[],
  ) {}

  has(code: number): boolean {
    return this.tags.some((tag) => tag.code === code)
  }

  str(code: number, fallback = ''): string {
    for (const tag of this.tags) if (tag.code === code) return tag.value
    return fallback
  }

  num(code: number, fallback = 0): number {
    for (const tag of this.tags) {
      if (tag.code === code) {
        const value = Number.parseFloat(tag.value)
        if (Number.isFinite(value)) return value
      }
    }
    return fallback
  }

  int(code: number, fallback = 0): number {
    for (const tag of this.tags) {
      if (tag.code === code) {
        const value = Number.parseInt(tag.value.trim(), 10)
        if (Number.isFinite(value)) return value
      }
    }
    return fallback
  }

  /** All values for a repeated code, in file order. */
  allNums(code: number): number[] {
    const values: number[] = []
    for (const tag of this.tags) {
      if (tag.code === code) {
        const value = Number.parseFloat(tag.value)
        if (Number.isFinite(value)) values.push(value)
      }
    }
    return values
  }

  allStrs(code: number): string[] {
    const values: string[] = []
    for (const tag of this.tags) if (tag.code === code) values.push(tag.value)
    return values
  }

  /** Reads the point whose X uses `baseCode` (Y is +10, Z is +20). */
  point(baseCode: number, fallbackZ = 0) {
    return {
      x: this.num(baseCode, 0),
      y: this.num(baseCode + 10, 0),
      z: this.num(baseCode + 20, fallbackZ),
    }
  }

  /** True when at least the X component of a point group is present. */
  hasPoint(baseCode: number): boolean {
    return this.has(baseCode)
  }

  /** Collects every repetition of a point group, keeping file order. */
  points(baseCode: number) {
    const result: { x: number; y: number; z: number }[] = []
    let current: { x: number; y: number; z: number } | null = null
    for (const tag of this.tags) {
      const value = Number.parseFloat(tag.value)
      if (tag.code === baseCode) {
        current = { x: Number.isFinite(value) ? value : 0, y: 0, z: 0 }
        result.push(current)
      } else if (current && tag.code === baseCode + 10) {
        current.y = Number.isFinite(value) ? value : 0
      } else if (current && tag.code === baseCode + 20) {
        current.z = Number.isFinite(value) ? value : 0
      }
    }
    return result
  }
}
