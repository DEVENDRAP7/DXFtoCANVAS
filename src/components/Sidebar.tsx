/** Left-hand inspector: drawing properties, layers, entity mix and display options. */

import { useMemo, useState } from 'react'
import { aciToRgb, rgbToCss } from '../dxf/colors'
import type { Drawing } from '../dxf/loader'
import { unitName } from '../dxf/scene'
import { THEME_ORDER, THEMES, type ThemeId } from '../render/theme'
import { IconChevron, IconEye, IconEyeOff, IconIsolate } from './Icons'

export interface DisplayFlags {
  showGrid: boolean
  showAxes: boolean
  showExtents: boolean
  showLineweights: boolean
  showText: boolean
  showFills: boolean
}

interface SectionProps {
  title: string
  count?: string | number
  defaultOpen?: boolean
  children: React.ReactNode
}

function Section({ title, count, defaultOpen = true, children }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="panel-section">
      <button
        type="button"
        className={`panel-header ${open ? '' : 'collapsed'}`}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span>{title}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          {count !== undefined && <span className="panel-count">{count}</span>}
          <IconChevron className="chevron" />
        </span>
      </button>
      {open && children}
    </div>
  )
}

function Row({ label, value, title }: { label: string; value: React.ReactNode; title?: string }) {
  return (
    <div className="kv">
      <span className="kv-key">{label}</span>
      <span className="kv-value" title={title}>
        {value}
      </span>
    </div>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input
        type="checkbox"
        className="visually-hidden"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className={`switch ${checked ? 'on' : ''}`} aria-hidden="true" />
    </label>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

const ACAD_VERSIONS: Record<string, string> = {
  AC1006: 'R10',
  AC1009: 'R11/R12',
  AC1012: 'R13',
  AC1014: 'R14',
  AC1015: 'AutoCAD 2000',
  AC1018: 'AutoCAD 2004',
  AC1021: 'AutoCAD 2007',
  AC1024: 'AutoCAD 2010',
  AC1027: 'AutoCAD 2013',
  AC1032: 'AutoCAD 2018',
}

interface SidebarProps {
  drawing: Drawing | null
  hiddenLayers: ReadonlySet<string>
  onToggleLayer: (name: string) => void
  onShowAllLayers: () => void
  onHideAllLayers: () => void
  isolatedLayer: string | null
  onIsolateLayer: (name: string | null) => void
  flags: DisplayFlags
  onFlagsChange: (flags: DisplayFlags) => void
  theme: ThemeId
  onThemeChange: (theme: ThemeId) => void
  linetypeScale: number
  onLinetypeScaleChange: (value: number) => void
}

export function Sidebar({
  drawing,
  hiddenLayers,
  onToggleLayer,
  onShowAllLayers,
  onHideAllLayers,
  isolatedLayer,
  onIsolateLayer,
  flags,
  onFlagsChange,
  theme,
  onThemeChange,
  linetypeScale,
  onLinetypeScaleChange,
}: SidebarProps) {
  const [layerFilter, setLayerFilter] = useState('')

  const layers = useMemo(() => {
    if (!drawing) return []
    const counts = drawing.scene.stats.layerCounts
    const query = layerFilter.trim().toLowerCase()
    return drawing.layers
      .map((layer) => ({ layer, count: counts.get(layer.name) ?? 0 }))
      .filter(({ layer }) => !query || layer.name.toLowerCase().includes(query))
      .sort((a, b) => b.count - a.count || a.layer.name.localeCompare(b.layer.name))
  }, [drawing, layerFilter])

  const entityStats = useMemo(() => {
    if (!drawing) return []
    const entries = [...drawing.scene.stats.entityCounts.entries()].sort((a, b) => b[1] - a[1])
    const max = entries.reduce((value, [, count]) => Math.max(value, count), 1)
    return entries.map(([type, count]) => ({ type, count, ratio: count / max }))
  }, [drawing])

  const update = (patch: Partial<DisplayFlags>) => onFlagsChange({ ...flags, ...patch })

  return (
    <aside className="sidebar">
      <div className="sidebar-scroll">
        {drawing && (
          <Section title="Drawing">
            <div className="panel-body">
              <Row label="File" value={drawing.fileName} title={drawing.fileName} />
              <Row label="Size" value={<span className="numeric">{formatBytes(drawing.fileSize)}</span>} />
              <Row
                label="Format"
                value={ACAD_VERSIONS[drawing.header.version] ?? drawing.header.version ?? 'Unknown'}
              />
              <Row label="Units" value={unitName(drawing.header.insUnits)} />
              <Row
                label="Extents"
                value={
                  <span className="numeric">
                    {Math.round(drawing.scene.bounds.maxX - drawing.scene.bounds.minX).toLocaleString()} ×{' '}
                    {Math.round(drawing.scene.bounds.maxY - drawing.scene.bounds.minY).toLocaleString()}
                  </span>
                }
              />
              <Row label="Entities" value={<span className="numeric">{drawing.entityCount.toLocaleString()}</span>} />
              <Row
                label="Drawn"
                value={<span className="numeric">{drawing.scene.stats.totalItems.toLocaleString()}</span>}
                title="Entities after block references are expanded"
              />
              <Row label="Blocks" value={<span className="numeric">{drawing.blockCount.toLocaleString()}</span>} />
              <Row label="Read in" value={<span className="numeric">{drawing.parseMs.toFixed(0)} ms</span>} />
              {drawing.scene.stats.showingPaperSpace && (
                <Row label="Space" value="Paper" title="Model space was empty, so the layout sheet is shown" />
              )}
            </div>
          </Section>
        )}

        {drawing && (
          <Section title="Layers" count={layers.length}>
            <div className="layer-tools">
              <input
                className="layer-search"
                placeholder="Filter layers…"
                value={layerFilter}
                onChange={(event) => setLayerFilter(event.target.value)}
                spellCheck={false}
              />
              <button type="button" className="btn" onClick={onShowAllLayers} title="Show every layer">
                All
              </button>
              <button type="button" className="btn" onClick={onHideAllLayers} title="Hide every layer">
                None
              </button>
            </div>
            <div className="layer-list">
              {layers.map(({ layer, count }) => {
                const hidden = hiddenLayers.has(layer.name)
                const isolated = isolatedLayer === layer.name
                const color = layer.trueColor ?? aciToRgb(layer.color)
                return (
                  <div
                    key={layer.name}
                    className={`layer-row ${hidden ? 'hidden' : ''} ${isolated ? 'isolated' : ''}`}
                    onClick={() => onToggleLayer(layer.name)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onToggleLayer(layer.name)
                      }
                    }}
                    title={`${layer.name} · ${count} object${count === 1 ? '' : 's'} · ${layer.linetype}`}
                  >
                    <span className="layer-swatch" style={{ background: rgbToCss(color) }} />
                    <span className="layer-name">{layer.name}</span>
                    <span className="layer-count">{count.toLocaleString()}</span>
                    <button
                      type="button"
                      className={`layer-action ${isolated ? 'on always' : ''}`}
                      title={isolated ? 'Stop isolating' : 'Isolate this layer'}
                      onClick={(event) => {
                        event.stopPropagation()
                        onIsolateLayer(isolated ? null : layer.name)
                      }}
                    >
                      <IconIsolate />
                    </button>
                    <button
                      type="button"
                      className={`layer-action ${hidden ? 'always' : ''}`}
                      title={hidden ? 'Show layer' : 'Hide layer'}
                      onClick={(event) => {
                        event.stopPropagation()
                        onToggleLayer(layer.name)
                      }}
                    >
                      {hidden ? <IconEyeOff /> : <IconEye />}
                    </button>
                  </div>
                )
              })}
              {layers.length === 0 && (
                <div style={{ padding: '8px 6px', color: 'var(--text-dim)', fontSize: 12 }}>No layers match.</div>
              )}
            </div>
          </Section>
        )}

        {drawing && entityStats.length > 0 && (
          <Section title="Entities" count={drawing.scene.stats.totalItems.toLocaleString()} defaultOpen={false}>
            <div className="panel-body">
              {entityStats.map(({ type, count, ratio }) => (
                <div className="stat-row" key={type}>
                  <span className="stat-label">
                    <span style={{ width: 74, flexShrink: 0 }}>{type}</span>
                    <span className="stat-bar" style={{ width: `${Math.max(4, ratio * 100)}%` }} />
                  </span>
                  <span className="stat-value">{count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </Section>
        )}

        <Section title="Display" defaultOpen={!drawing}>
          <div className="panel-body">
            <div className="kv" style={{ paddingBottom: 8 }}>
              <span className="kv-key">Theme</span>
              <span className="segmented">
                {THEME_ORDER.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={theme === id ? 'active' : ''}
                    onClick={() => onThemeChange(id)}
                  >
                    {THEMES[id].label}
                  </button>
                ))}
              </span>
            </div>
            <Toggle label="Grid" checked={flags.showGrid} onChange={(value) => update({ showGrid: value })} />
            <Toggle label="Origin axes" checked={flags.showAxes} onChange={(value) => update({ showAxes: value })} />
            <Toggle
              label="Extents box"
              checked={flags.showExtents}
              onChange={(value) => update({ showExtents: value })}
            />
            <Toggle
              label="Lineweights"
              checked={flags.showLineweights}
              onChange={(value) => update({ showLineweights: value })}
            />
            <Toggle label="Text" checked={flags.showText} onChange={(value) => update({ showText: value })} />
            <Toggle label="Hatches & fills" checked={flags.showFills} onChange={(value) => update({ showFills: value })} />
            <div className="range-row">
              <span style={{ width: 74 }}>Linetype</span>
              <input
                type="range"
                min={-2}
                max={2}
                step={0.05}
                value={Math.log10(linetypeScale)}
                onChange={(event) => onLinetypeScaleChange(Math.pow(10, Number(event.target.value)))}
                title="Global linetype scale (LTSCALE)"
              />
              <span className="range-value">{linetypeScale < 10 ? linetypeScale.toFixed(2) : linetypeScale.toFixed(0)}</span>
            </div>
          </div>
        </Section>

        <Section title="Shortcuts" defaultOpen={false}>
          <div className="panel-body">
            <div className="shortcut-grid">
              <kbd>Drag</kbd>
              <span>Pan the view</span>
              <kbd>Wheel</kbd>
              <span>Zoom at cursor</span>
              <kbd>Space</kbd>
              <span>Hold to pan in any tool</span>
              <kbd>F</kbd>
              <span>Zoom to extents</span>
              <kbd>M</kbd>
              <span>Measure tool</span>
              <kbd>G</kbd>
              <span>Toggle grid</span>
              <kbd>L</kbd>
              <span>Toggle lineweights</span>
              <kbd>Esc</kbd>
              <span>Clear measurement / isolation</span>
              <kbd>O</kbd>
              <span>Open a DXF file</span>
            </div>
          </div>
        </Section>
      </div>
    </aside>
  )
}
