/**
 * DXF Studio — application shell.
 *
 * Owns the loaded drawing, the camera and all display state; the viewport and
 * panels are otherwise stateless views over it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Drawing } from './dxf/loader'
import type { ParseRequest, ParseResponse } from './dxf/parse.worker'
import { unitSuffix } from './dxf/scene'
import type { Point2 } from './dxf/types'
import { renderScene, type RenderResult } from './render/renderer'
import { THEMES, type ThemeId } from './render/theme'
import { fitBounds, zoomAt, type View } from './render/view'
import { SAMPLE_FILE_NAME, buildSampleDxf } from './samples/floorPlan'
import { IconClose, IconError, IconFile, IconLogo, IconOpen, IconPanel, IconWarning } from './components/Icons'
import { Sidebar, type DisplayFlags } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { Toolbar } from './components/Toolbar'
import { Viewport, type MeasureState, type ToolId } from './components/Viewport'

/** Files larger than this are almost certainly not a hand-drawn plan. */
const MAX_FILE_BYTES = 220 * 1024 * 1024

/** Matches the `max-width` breakpoint in index.css where the layout stacks. */
const NARROW_BREAKPOINT = 720

const DEFAULT_FLAGS: DisplayFlags = {
  showGrid: true,
  showAxes: false,
  showExtents: false,
  showLineweights: true,
  showText: true,
  showFills: true,
}

interface Notice {
  id: number
  kind: 'warn' | 'error'
  title: string
  text: string
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export default function App() {
  const [drawing, setDrawing] = useState<Drawing | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingLabel, setLoadingLabel] = useState('Reading drawing…')
  const [notices, setNotices] = useState<Notice[]>([])

  const [view, setView] = useState<View>({ scale: 1, tx: 0, ty: 0 })
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 })
  const [cursor, setCursor] = useState<Point2 | null>(null)
  const [renderStats, setRenderStats] = useState<RenderResult | null>(null)

  const [hiddenLayers, setHiddenLayers] = useState<ReadonlySet<string>>(new Set())
  const [isolatedLayer, setIsolatedLayer] = useState<string | null>(null)

  const [theme, setTheme] = useState<ThemeId>('dark')
  const [flags, setFlags] = useState<DisplayFlags>(DEFAULT_FLAGS)
  const [linetypeScale, setLinetypeScale] = useState(1)

  const [tool, setTool] = useState<ToolId>('pan')
  const [measure, setMeasure] = useState<MeasureState>({ start: null, end: null })
  const [snapEnabled] = useState(true)
  const [spaceHeld, setSpaceHeld] = useState(false)
  // On a phone the inspector is an overlay drawer, so it starts out of the way.
  const [sidebarVisible, setSidebarVisible] = useState(
    () => typeof window === 'undefined' || window.innerWidth > NARROW_BREAKPOINT,
  )
  const [dragActive, setDragActive] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const workerRef = useRef<Worker | null>(null)
  const requestIdRef = useRef(0)
  const pendingFitRef = useRef(false)
  const dragDepthRef = useRef(0)
  /** Mirrors `stageSize` so the resize handler can read it without re-binding. */
  const stageSizeRef = useRef({ width: 0, height: 0 })

  const pushNotice = useCallback((kind: Notice['kind'], title: string, text: string) => {
    setNotices((current) => [...current.slice(-3), { id: Date.now() + Math.random(), kind, title, text }])
  }, [])

  const dismissNotice = useCallback((id: number) => {
    setNotices((current) => current.filter((notice) => notice.id !== id))
  }, [])

  // --- Loading ------------------------------------------------------------

  useEffect(() => {
    const worker = new Worker(new URL('./dxf/parse.worker.ts', import.meta.url), { type: 'module' })
    workerRef.current = worker

    worker.onmessage = (event: MessageEvent<ParseResponse>) => {
      const message = event.data
      // A newer file was dropped while this one was parsing.
      if (message.id !== requestIdRef.current) return

      setLoading(false)
      if (!message.ok) {
        pushNotice('error', 'Could not open this file', message.error)
        return
      }

      const loaded = message.drawing
      setDrawing(loaded)
      setMeasure({ start: null, end: null })
      setIsolatedLayer(null)
      // Honour layers the drawing itself marks as off or frozen.
      setHiddenLayers(new Set(loaded.layers.filter((layer) => layer.off || layer.frozen).map((layer) => layer.name)))
      pendingFitRef.current = true

      for (const warning of loaded.warnings.slice(0, 3)) {
        pushNotice('warn', 'Heads up', warning)
      }
    }

    worker.onerror = () => {
      setLoading(false)
      pushNotice('error', 'Reader crashed', 'The DXF reader stopped unexpectedly. Try reloading the page.')
    }

    return () => {
      worker.terminate()
      workerRef.current = null
    }
  }, [pushNotice])

  const parseText = useCallback((text: string, fileName: string, fileSize: number) => {
    const worker = workerRef.current
    if (!worker) return
    requestIdRef.current += 1
    setLoading(true)
    setLoadingLabel(`Reading ${fileName}…`)
    const request: ParseRequest = { id: requestIdRef.current, text, fileName, fileSize }
    worker.postMessage(request)
  }, [])

  const openFile = useCallback(
    async (file: File) => {
      if (file.size > MAX_FILE_BYTES) {
        pushNotice(
          'error',
          'File is too large',
          `${file.name} is ${formatBytes(file.size)}. The viewer handles files up to ${formatBytes(MAX_FILE_BYTES)}.`,
        )
        return
      }
      if (!/\.dxf$/i.test(file.name)) {
        pushNotice(
          'error',
          'Not a DXF file',
          `${file.name} does not have a .dxf extension. Export the drawing as ASCII DXF and try again.`,
        )
        return
      }

      setLoading(true)
      setLoadingLabel(`Reading ${file.name}…`)
      try {
        const text = await file.text()
        parseText(text, file.name, file.size)
      } catch {
        setLoading(false)
        pushNotice('error', 'Could not read the file', 'The browser refused to read this file from disk.')
      }
    },
    [parseText, pushNotice],
  )

  const loadSample = useCallback(() => {
    const text = buildSampleDxf()
    parseText(text, SAMPLE_FILE_NAME, new Blob([text]).size)
  }, [parseText])

  // Start with the sample so the viewport is never an empty void.
  useEffect(() => {
    loadSample()
  }, [loadSample])

  // --- Camera -------------------------------------------------------------

  const zoomFit = useCallback(() => {
    if (!drawing || stageSize.width === 0) return
    setView(fitBounds(drawing.scene.bounds, stageSize.width, stageSize.height))
  }, [drawing, stageSize])

  useEffect(() => {
    if (!pendingFitRef.current || !drawing || stageSize.width === 0) return
    pendingFitRef.current = false
    setView(fitBounds(drawing.scene.bounds, stageSize.width, stageSize.height))
  }, [drawing, stageSize])

  const zoomStep = useCallback(
    (factor: number) => {
      setView((current) => zoomAt(current, stageSize.width / 2, stageSize.height / 2, factor))
    },
    [stageSize],
  )

  const handleResize = useCallback((width: number, height: number) => {
    const previous = stageSizeRef.current
    if (previous.width === width && previous.height === height) return

    // Keep whatever is in the middle of the viewport in the middle of it.
    // Without this, collapsing the sidebar or narrowing the window pushes the
    // drawing off-screen, since the camera is anchored to the top-left corner.
    if (previous.width > 0 && previous.height > 0) {
      const dx = (width - previous.width) / 2
      const dy = (height - previous.height) / 2
      setView((current) => ({ scale: current.scale, tx: current.tx + dx, ty: current.ty + dy }))
    }

    stageSizeRef.current = { width, height }
    setStageSize({ width, height })
  }, [])

  // --- Layers -------------------------------------------------------------

  const allLayerNames = useMemo(() => drawing?.layers.map((layer) => layer.name) ?? [], [drawing])

  const visibleLayers = useMemo(() => {
    const set = new Set<string>()
    for (const name of allLayerNames) if (!hiddenLayers.has(name)) set.add(name)
    return set
  }, [allLayerNames, hiddenLayers])

  const toggleLayer = useCallback((name: string) => {
    setHiddenLayers((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  const showAllLayers = useCallback(() => setHiddenLayers(new Set()), [])
  const hideAllLayers = useCallback(() => setHiddenLayers(new Set(allLayerNames)), [allLayerNames])

  // --- Rendering options --------------------------------------------------

  const renderFlags = useMemo(
    () => ({
      visibleLayers,
      linetypes: drawing?.linetypes ?? new Map(),
      linetypeScale,
      showGrid: flags.showGrid,
      showAxes: flags.showAxes,
      showExtents: flags.showExtents,
      showLineweights: flags.showLineweights,
      showText: flags.showText,
      showFills: flags.showFills,
      isolatedLayer,
    }),
    [visibleLayers, drawing, linetypeScale, flags, isolatedLayer],
  )

  const activeTheme = THEMES[theme]

  // --- Export -------------------------------------------------------------

  const exportPng = useCallback(() => {
    if (!drawing || stageSize.width === 0) return
    const scaleFactor = 2
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(stageSize.width * scaleFactor)
    canvas.height = Math.round(stageSize.height * scaleFactor)
    const context = canvas.getContext('2d')
    if (!context) return

    renderScene(context, drawing.scene, view, {
      ...renderFlags,
      theme: activeTheme,
      width: stageSize.width,
      height: stageSize.height,
      devicePixelRatio: scaleFactor,
    })

    canvas.toBlob((blob) => {
      if (!blob) {
        pushNotice('error', 'Export failed', 'The browser could not encode the image.')
        return
      }
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `${drawing.fileName.replace(/\.dxf$/i, '')}.png`
      link.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }, [activeTheme, drawing, pushNotice, renderFlags, stageSize, view])

  // --- Keyboard -----------------------------------------------------------

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) =>
      target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return

      if (event.code === 'Space' && !event.repeat) {
        event.preventDefault()
        setSpaceHeld(true)
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return

      switch (event.key.toLowerCase()) {
        case 'f':
          event.preventDefault()
          zoomFit()
          break
        case 'm':
          setTool('measure')
          break
        case 'v':
          setTool('pan')
          break
        case 'g':
          setFlags((current) => ({ ...current, showGrid: !current.showGrid }))
          break
        case 'l':
          setFlags((current) => ({ ...current, showLineweights: !current.showLineweights }))
          break
        case 't':
          setFlags((current) => ({ ...current, showText: !current.showText }))
          break
        case 'o':
          event.preventDefault()
          fileInputRef.current?.click()
          break
        case 'escape':
          setMeasure({ start: null, end: null })
          setIsolatedLayer(null)
          break
        case '=':
        case '+':
          zoomStep(1.25)
          break
        case '-':
        case '_':
          zoomStep(0.8)
          break
        default:
          break
      }
    }

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(false)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [zoomFit, zoomStep])

  // --- Drag & drop --------------------------------------------------------

  useEffect(() => {
    const onDragEnter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      dragDepthRef.current += 1
      setDragActive(true)
    }
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = () => {
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) setDragActive(false)
    }
    const onDrop = (event: DragEvent) => {
      event.preventDefault()
      dragDepthRef.current = 0
      setDragActive(false)
      const file = event.dataTransfer?.files?.[0]
      if (file) void openFile(file)
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [openFile])

  // --- Derived ------------------------------------------------------------

  const measureResult = useMemo(() => {
    const { start, end } = measure
    if (!start || !end) return null
    const dx = end.x - start.x
    const dy = end.y - start.y
    const distance = Math.hypot(dx, dy)
    let angle = (Math.atan2(dy, dx) * 180) / Math.PI
    if (angle < 0) angle += 360
    return { distance, dx, dy, angle }
  }, [measure])

  const suffix = drawing ? unitSuffix(drawing.header.insUnits) : ''

  return (
    <div className={`app ${sidebarVisible ? '' : 'sidebar-hidden'}`}>
      <header className="header">
        <div className="brand">
          <span className="brand-mark">
            <IconLogo size={15} />
          </span>
          <span className="brand-text">
            <span className="brand-name">DXF Studio</span>
            <span className="brand-sub">Drawing viewer</span>
          </span>
        </div>

        <button
          type="button"
          className="btn icon-only"
          title={sidebarVisible ? 'Hide the inspector' : 'Show the inspector'}
          aria-label={sidebarVisible ? 'Hide the inspector' : 'Show the inspector'}
          onClick={() => setSidebarVisible((value) => !value)}
        >
          <IconPanel />
        </button>

        <div className="header-file">
          {drawing && (
            <>
              <span className="header-file-name">{drawing.fileName}</span>
              <span className="header-file-meta">
                {formatBytes(drawing.fileSize)} · {drawing.entityCount.toLocaleString()} entities ·{' '}
                {drawing.layers.length} layers
              </span>
            </>
          )}
        </div>

        <div className="header-actions">
          <button
            type="button"
            className="btn compact-hide"
            onClick={loadSample}
            title="Load the built-in sample plan"
          >
            Sample
          </button>
          <button type="button" className="btn primary" onClick={() => fileInputRef.current?.click()}>
            <IconOpen size={15} />
            Open DXF
          </button>
        </div>
      </header>

      {sidebarVisible && (
        <Sidebar
          drawing={drawing}
          hiddenLayers={hiddenLayers}
          onToggleLayer={toggleLayer}
          onShowAllLayers={showAllLayers}
          onHideAllLayers={hideAllLayers}
          isolatedLayer={isolatedLayer}
          onIsolateLayer={setIsolatedLayer}
          flags={flags}
          onFlagsChange={setFlags}
          theme={theme}
          onThemeChange={setTheme}
          linetypeScale={linetypeScale}
          onLinetypeScaleChange={setLinetypeScale}
        />
      )}

      <Viewport
        scene={drawing?.scene ?? null}
        view={view}
        onViewChange={setView}
        theme={activeTheme}
        flags={renderFlags}
        tool={tool}
        forcePan={spaceHeld}
        snapEnabled={snapEnabled}
        measure={measure}
        onMeasureChange={setMeasure}
        onCursorMove={setCursor}
        onRenderStats={setRenderStats}
        onResize={handleResize}
        unitSuffix={suffix}
      >
        <Toolbar
          tool={tool}
          onToolChange={setTool}
          zoomPercent={view.scale * 100}
          onZoomIn={() => zoomStep(1.3)}
          onZoomOut={() => zoomStep(1 / 1.3)}
          onZoomFit={zoomFit}
          showGrid={flags.showGrid}
          onToggleGrid={() => setFlags((current) => ({ ...current, showGrid: !current.showGrid }))}
          showExtents={flags.showExtents}
          onToggleExtents={() => setFlags((current) => ({ ...current, showExtents: !current.showExtents }))}
          showLineweights={flags.showLineweights}
          onToggleLineweights={() => setFlags((current) => ({ ...current, showLineweights: !current.showLineweights }))}
          onExport={exportPng}
          disabled={!drawing}
        />

        {!drawing && !loading && (
          <div className="empty-state">
            <div className="empty-card">
              <div className="empty-icon">
                <IconFile size={28} />
              </div>
              <div className="empty-title">Drop a DXF drawing here</div>
              <p className="empty-text">
                Plans, sections, details — anything saved as ASCII DXF. Everything is read in your browser; nothing is
                uploaded anywhere.
              </p>
              <div className="empty-actions">
                <button type="button" className="btn primary" onClick={() => fileInputRef.current?.click()}>
                  <IconOpen size={15} />
                  Choose a file
                </button>
                <button type="button" className="btn" onClick={loadSample}>
                  Open the sample plan
                </button>
              </div>
              <div className="empty-hint">
                Supports lines, polylines, arcs, circles, ellipses, splines, text, hatches, dimensions and nested blocks.
              </div>
            </div>
          </div>
        )}

        {measure.start && (
          <div className="measure-card">
            <div className="measure-title">Measurement</div>
            {measureResult ? (
              <>
                <div className="measure-value">
                  {measureResult.distance.toFixed(measureResult.distance >= 100 ? 1 : 3)}
                  {suffix && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}> {suffix}</span>}
                </div>
                <div className="measure-detail">
                  <span>ΔX {measureResult.dx.toFixed(1)}</span>
                  <span>ΔY {measureResult.dy.toFixed(1)}</span>
                  <span>{measureResult.angle.toFixed(2)}°</span>
                </div>
                <div className="measure-hint">Click to start a new measurement · Esc to clear</div>
              </>
            ) : (
              <div className="measure-hint" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
                Click a second point. Snaps to endpoints, midpoints and centres.
              </div>
            )}
          </div>
        )}

        {notices.length > 0 && (
          <div className="notice-stack">
            {notices.map((notice) => (
              <div key={notice.id} className={`notice ${notice.kind}`}>
                <span className="notice-icon">{notice.kind === 'error' ? <IconError /> : <IconWarning />}</span>
                <div className="notice-body">
                  <div className="notice-title">{notice.title}</div>
                  <div className="notice-text">{notice.text}</div>
                </div>
                <button
                  type="button"
                  className="notice-close"
                  onClick={() => dismissNotice(notice.id)}
                  aria-label="Dismiss"
                >
                  <IconClose />
                </button>
              </div>
            ))}
          </div>
        )}

        {loading && (
          <div className="loading-overlay">
            <div className="loading-card">
              <div className="spinner" />
              <span>{loadingLabel}</span>
            </div>
          </div>
        )}

        {dragActive && (
          <div className="drop-overlay">
            <div className="drop-overlay-inner">
              <IconFile size={34} />
              <span>Drop to open</span>
            </div>
          </div>
        )}
      </Viewport>

      <StatusBar
        drawing={drawing}
        cursor={cursor}
        view={view}
        stats={renderStats}
        visibleLayerCount={visibleLayers.size}
        totalLayerCount={allLayerNames.length}
        isolatedLayer={isolatedLayer}
      />

      <input
        ref={fileInputRef}
        type="file"
        accept=".dxf,application/dxf,image/vnd.dxf"
        className="visually-hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void openFile(file)
          event.target.value = ''
        }}
      />
    </div>
  )
}
