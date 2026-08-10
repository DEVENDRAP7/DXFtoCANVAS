/** Bottom status strip: cursor position, view scale and render statistics. */

import type { Drawing } from '../dxf/loader'
import { unitSuffix } from '../dxf/scene'
import type { Point2 } from '../dxf/types'
import type { RenderResult } from '../render/renderer'
import type { View } from '../render/view'

interface StatusBarProps {
  drawing: Drawing | null
  cursor: Point2 | null
  view: View
  stats: RenderResult | null
  visibleLayerCount: number
  totalLayerCount: number
  isolatedLayer: string | null
}

function formatCoordinate(value: number): string {
  const magnitude = Math.abs(value)
  if (magnitude >= 100_000) return value.toExponential(2)
  const decimals = magnitude >= 100 ? 1 : magnitude >= 1 ? 2 : 3
  return value.toFixed(decimals)
}

export function StatusBar({
  drawing,
  cursor,
  view,
  stats,
  visibleLayerCount,
  totalLayerCount,
  isolatedLayer,
}: StatusBarProps) {
  const suffix = drawing ? unitSuffix(drawing.header.insUnits) : ''

  return (
    <footer className="footer">
      <div className="status-item">
        <span className="status-label">X</span>
        <span className="status-value" style={{ minWidth: 62, display: 'inline-block' }}>
          {cursor ? formatCoordinate(cursor.x) : '—'}
        </span>
        <span className="status-label">Y</span>
        <span className="status-value" style={{ minWidth: 62, display: 'inline-block' }}>
          {cursor ? formatCoordinate(cursor.y) : '—'}
        </span>
        {suffix && <span className="status-label">{suffix}</span>}
      </div>

      <div className="status-item">
        <span className="status-label">Scale</span>
        <span className="status-value">
          {view.scale >= 1 ? `${view.scale.toFixed(2)} px/unit` : `1 px = ${(1 / view.scale).toFixed(2)} u`}
        </span>
      </div>

      {isolatedLayer && (
        <div className="status-item">
          <span className="status-dot" style={{ background: 'var(--accent)' }} />
          <span className="status-label">Isolated</span>
          <span className="status-value">{isolatedLayer}</span>
        </div>
      )}

      <div className="status-spacer" />

      {drawing && (
        <div className="status-item right">
          <span className="status-label">Layers</span>
          <span className="status-value">
            {visibleLayerCount}/{totalLayerCount}
          </span>
        </div>
      )}

      {stats && (
        <div
          className="status-item right compact-hide"
          title="Objects drawn this frame, and objects skipped because they are off-screen"
        >
          <span className="status-label">Drawn</span>
          <span className="status-value">{stats.drawn.toLocaleString()}</span>
          {stats.culled > 0 && <span className="status-label">· {stats.culled.toLocaleString()} culled</span>}
        </div>
      )}

      {stats && (
        <div className="status-item right compact-hide">
          <span
            className="status-dot"
            style={{ background: stats.elapsed > 33 ? 'var(--warn)' : 'var(--ok)' }}
          />
          <span className="status-value">{stats.elapsed.toFixed(1)} ms</span>
        </div>
      )}
    </footer>
  )
}
