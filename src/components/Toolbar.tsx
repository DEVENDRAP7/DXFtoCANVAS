/** Floating toolbar over the viewport: tool choice, zoom controls and quick display toggles. */

import type { ToolId } from './Viewport'
import { IconDownload, IconExtents, IconFit, IconGrid, IconHand, IconRuler, IconWeight, IconZoomIn, IconZoomOut } from './Icons'

interface ToolbarProps {
  tool: ToolId
  onToolChange: (tool: ToolId) => void
  zoomPercent: number
  onZoomIn: () => void
  onZoomOut: () => void
  onZoomFit: () => void
  showGrid: boolean
  onToggleGrid: () => void
  showExtents: boolean
  onToggleExtents: () => void
  showLineweights: boolean
  onToggleLineweights: () => void
  onExport: () => void
  disabled: boolean
}

function ToolButton({
  active,
  title,
  onClick,
  children,
  disabled,
}: {
  active?: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={`tool-btn ${active ? 'active' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
      style={disabled ? { opacity: 0.35, cursor: 'not-allowed' } : undefined}
    >
      {children}
    </button>
  )
}

/** Zoom is shown as a percentage on a log scale, the way CAD viewers report it. */
function formatZoom(percent: number): string {
  if (percent >= 1000) return `${Math.round(percent / 100) * 100}%`
  if (percent >= 10) return `${Math.round(percent)}%`
  if (percent >= 1) return `${percent.toFixed(1)}%`
  return `${percent.toFixed(2)}%`
}

export function Toolbar({
  tool,
  onToolChange,
  zoomPercent,
  onZoomIn,
  onZoomOut,
  onZoomFit,
  showGrid,
  onToggleGrid,
  showExtents,
  onToggleExtents,
  showLineweights,
  onToggleLineweights,
  onExport,
  disabled,
}: ToolbarProps) {
  return (
    <div className="toolbar" role="toolbar" aria-label="Viewport tools">
      <ToolButton active={tool === 'pan'} title="Pan tool (V)" onClick={() => onToolChange('pan')}>
        <IconHand />
      </ToolButton>
      <ToolButton active={tool === 'measure'} title="Measure distance (M)" onClick={() => onToolChange('measure')}>
        <IconRuler />
      </ToolButton>

      <span className="toolbar-divider" />

      <ToolButton title="Zoom out" onClick={onZoomOut} disabled={disabled}>
        <IconZoomOut />
      </ToolButton>
      <span className="zoom-readout numeric">{formatZoom(zoomPercent)}</span>
      <ToolButton title="Zoom in" onClick={onZoomIn} disabled={disabled}>
        <IconZoomIn />
      </ToolButton>
      <ToolButton title="Zoom to extents (F)" onClick={onZoomFit} disabled={disabled}>
        <IconFit />
      </ToolButton>

      <span className="toolbar-divider" />

      <ToolButton active={showGrid} title="Grid (G)" onClick={onToggleGrid}>
        <IconGrid />
      </ToolButton>
      <ToolButton active={showExtents} title="Extents box" onClick={onToggleExtents}>
        <IconExtents />
      </ToolButton>
      <ToolButton active={showLineweights} title="Lineweights (L)" onClick={onToggleLineweights}>
        <IconWeight />
      </ToolButton>

      <span className="toolbar-divider" />

      <ToolButton title="Export view as PNG" onClick={onExport} disabled={disabled}>
        <IconDownload />
      </ToolButton>
    </div>
  )
}
