/**
 * Parses DXF text off the main thread.
 *
 * A large plan can take a second or more to read; doing it here keeps the
 * viewport interactive and the loading spinner actually spinning. The result is
 * structured-cloneable (plain objects and Maps), so no serialisation step is
 * needed.
 */

import { loadDrawing, type Drawing } from './loader'

export interface ParseRequest {
  id: number
  text: string
  fileName: string
  fileSize: number
}

export type ParseResponse =
  | { id: number; ok: true; drawing: Drawing }
  | { id: number; ok: false; error: string }

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  const { id, text, fileName, fileSize } = event.data
  try {
    const drawing = loadDrawing(text, fileName, fileSize)
    const response: ParseResponse = { id, ok: true, drawing }
    self.postMessage(response)
  } catch (error) {
    const response: ParseResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : 'Could not read this DXF file.',
    }
    self.postMessage(response)
  }
}
