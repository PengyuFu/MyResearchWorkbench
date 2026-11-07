/** Writing-pane PDF viewer, reusing the sidebar's worker, fonts and text layers. */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { WorkbenchPdfProps } from './workbench-contract.ts'
import { openPdf } from './runtime.ts'
import { renderPdfPage, type PdfDocument, type PdfPageSize } from './document.ts'
import { pdfTextRenderer } from './text.ts'
import pdfCss from './PdfBody.module.css'
import css from './WorkbenchPdf.module.css'

const CSS_PIXELS_PER_POINT = 96 / 72

/** Own one loaded PDF and its page-rendering lifetimes. */
export function WorkbenchPdf(props: WorkbenchPdfProps) {
  const { data, version, labels, target, onSource, onSelection } = props
  const [loaded, setLoaded] = useState<{ version: string; document: PdfDocument; signal: AbortSignal; geometry: Record<number, PdfPageSize>; position: WorkbenchPdfProps['position'] }>()
  const current = useRef(props)
  current.current = props
  const restored = useRef(false)
  const canRestore = useCallback(() => !restored.current, [])
  const didRestore = useCallback(() => { restored.current = true }, [])
  const [error, setError] = useState<string>()
  const [width, setWidth] = useState(800)
  const [pageWidth, setPageWidth] = useState<number>()
  const [preference, setPreference] = useState<'fit' | number>(props.position?.zoom ?? 'fit')
  const [selected, setSelected] = useState<{ text: string; page: number } | null>(null)
  const observer = useRef<ResizeObserver | null>(null)
  const scrollport = useRef<HTMLDivElement | null>(null)
  const setScrollport = useCallback((element: HTMLDivElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    scrollport.current = element
    if (element === null) return
    const measure = () => setWidth(Math.max(100, element.clientWidth - 24))
    measure()
    observer.current = new ResizeObserver(measure)
    observer.current.observe(element)
  }, [])
  const zoom = preference === 'fit' ? pageWidth === undefined ? 1 : width / pageWidth : preference
  useEffect(() => {
    const lifetime = new AbortController()
    setError(undefined)
    setPageWidth(undefined)
    const savedPosition = current.current.position
    restored.current = savedPosition === undefined
    setPreference(savedPosition?.zoom ?? 'fit')
    const session = openPdf(data.slice(), lifetime.signal, (failure) => {
      if (!lifetime.signal.aborted) setError(String(failure))
    })
    void session.document.then(async (document) => {
      const geometry: Record<number, PdfPageSize> = {}
      const position = savedPosition === undefined ? undefined : { ...savedPosition, page: Math.min(document.numPages, savedPosition.page) }
      // Preceding page geometry establishes the saved page's offset without rasterizing those pages.
      for (let page = 1; position !== undefined && page <= position.page; page++) {
        lifetime.signal.throwIfAborted()
        const source = await document.getPage(page)
        const viewport = source.getViewport({ scale: CSS_PIXELS_PER_POINT })
        geometry[page] = { width: viewport.width, height: viewport.height }
        source.cleanup()
      }
      if (!lifetime.signal.aborted) {
        if (geometry[1] !== undefined) setPageWidth(geometry[1].width)
        setLoaded({ version, document, signal: lifetime.signal, geometry, position })
      }
    }).catch((failure: unknown) => { if (!lifetime.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)) })
    return () => { lifetime.abort(); void session.dispose() }
  }, [data, version])
  const capture = useCallback(() => {
    const viewport = scrollport.current
    if (viewport === null || !restored.current) return
    const top = viewport.getBoundingClientRect().top + viewport.clientTop
    const pages = Array.from(viewport.querySelectorAll<HTMLElement>('[data-workbench-pdf-page]'))
    const page = pages.find(element => element.getBoundingClientRect().bottom > top + 1)
    if (page === undefined) return
    const bounds = page.getBoundingClientRect()
    current.current.onPosition?.({ page: Number(page.dataset.workbenchPdfPage),
      offset: Math.max(0, (top - bounds.top) / Math.max(1, bounds.height)), left: viewport.scrollLeft, zoom: preference })
  }, [preference])
  useEffect(() => {
    window.addEventListener('mrw:checkpoint-editors', capture)
    return () => { capture(); window.removeEventListener('mrw:checkpoint-editors', capture) }
  }, [capture])
  return <div className={css.viewer}>
    <div className={css.toolbar}>
      <button type="button" onClick={() => setPreference('fit')} aria-pressed={preference === 'fit'}>{labels.fitWidth}</button>
      <button type="button" aria-label={`${labels.zoom} −`} onClick={() => setPreference(Math.max(.25, zoom - .1))}>−</button>
      <span>{Math.round(zoom * 100)}%</span>
      <button type="button" aria-label={`${labels.zoom} +`} onClick={() => setPreference(Math.min(4, zoom + .1))}>+</button>
      <span className={css.hint}>{labels.sourceHint}</span>
      {selected !== null && <button type="button" onClick={() => {
        onSelection(selected.text, selected.page); setSelected(null)
      }}>{labels.askSelection}</button>}
    </div>
    {error !== undefined && <div className={pdfCss.status} role="alert">{labels.failed}: {error}</div>}
    <div ref={setScrollport} className={css.pages} data-workbench-pdf="" onScroll={capture} onWheel={() => { restored.current = true }} onPointerDown={() => { restored.current = true }} onMouseUp={() => {
      const selection = window.getSelection()
      if (selection === null || selection.isCollapsed || !scrollport.current?.contains(selection.anchorNode)) { setSelected(null); return }
      const element = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement
      const page = Number(element?.closest('[data-workbench-pdf-page]')?.getAttribute('data-workbench-pdf-page'))
      const text = selection.toString()
      if (page > 0 && text.trim() !== '') setSelected({ text, page })
    }}>
      {loaded?.version !== version
        ? <div className={pdfCss.status} role="status">{labels.loading}</div>
        : Array.from({ length: loaded.document.numPages }, (_, index) => <PdfPage
          key={`${version}:${index}`} document={loaded.document} signal={loaded.signal} page={index + 1} zoom={zoom}
          target={target?.page === index + 1 ? target : null} onSource={onSource} editing={props.editing}
          initialSize={loaded.geometry[index + 1]} position={loaded.position?.page === index + 1 ? loaded.position : undefined}
          canRestore={canRestore} didRestore={didRestore}
          scrollport={scrollport} layoutReady={preference !== 'fit' || pageWidth !== undefined}
          {...index === 0 ? { onWidth: setPageWidth } : {}} labels={labels} />)}
    </div>
  </div>
}

function PdfPage({ document, signal, page, zoom, target, onSource, onWidth, labels, editing,
  scrollport, layoutReady, initialSize, position, canRestore, didRestore }: {
  document: PdfDocument
  signal: AbortSignal
  page: number
  zoom: number
  target: WorkbenchPdfProps['target']
  onSource: WorkbenchPdfProps['onSource']
  editing: WorkbenchPdfProps['editing']
  onWidth?: (width: number) => void
  labels: WorkbenchPdfProps['labels']
  scrollport: RefObject<HTMLDivElement | null>
  layoutReady: boolean
  initialSize?: PdfPageSize | undefined
  position: WorkbenchPdfProps['position']
  canRestore(): boolean
  didRestore(): void
}) {
  const input = useRef(editing?.active)
  input.current = editing?.active
  const mountInput = useCallback((element: HTMLTextAreaElement | null) => {
    if (element === null || !input.current) return
    element.focus({ preventScroll: true })
    element.setSelectionRange(input.current.selection.from, input.current.selection.to)
  }, [])
  const composing = useRef(false)
  const host = useRef<HTMLDivElement>(null)
  const targetHost = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const textHost = useRef<HTMLDivElement>(null)
  const [requested, setRequested] = useState(page === 1 || target !== null || position !== undefined)
  const [size, setSize] = useState<PdfPageSize | undefined>(initialSize)
  const [error, setError] = useState<string>()
  const renderQueue = useRef(Promise.resolve())
  const textTask = useRef<ReturnType<ReturnType<typeof pdfTextRenderer>>>()
  const lastLocation = useRef<number | null>(null)
  useEffect(() => {
    if (position === undefined || size === undefined || !layoutReady || !canRestore()) return
    const frame = window.requestAnimationFrame(() => {
      const pageElement = host.current
      const viewport = scrollport.current
      if (pageElement === null || viewport === null || !canRestore() || viewport.clientHeight === 0) return
      const pageBounds = pageElement.getBoundingClientRect()
      const bounds = viewport.getBoundingClientRect()
      viewport.scrollTo({ top: viewport.scrollTop + pageBounds.top - bounds.top - viewport.clientTop + position.offset * pageBounds.height,
        left: position.left, behavior: 'instant' })
      didRestore()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [position, size, layoutReady, zoom, scrollport, canRestore, didRestore])
  useEffect(() => {
    const element = host.current
    if (element === null) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) setRequested(true)
    }, { rootMargin: '100% 0px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (target !== null) setRequested(true)
  }, [target])
  useEffect(() => () => { textTask.current?.cancel() }, [])
  useEffect(() => {
    const element = canvas.current
    const text = textHost.current
    if (!requested || element === null || text === null) return
    const lifetime = new AbortController()
    const renderSignal = AbortSignal.any([lifetime.signal, signal])
    let newText: ReturnType<ReturnType<typeof pdfTextRenderer>> | undefined
    renderQueue.current = renderQueue.current.then(async () => {
      renderSignal.throwIfAborted()
      const dimensions = await renderPdfPage(document, page, element, renderSignal, window.devicePixelRatio * zoom,
        textTask.current === undefined ? (pdfPage, viewport) => {
          newText = pdfTextRenderer(text)(pdfPage, viewport)
          return newText
        } : undefined)
      renderSignal.throwIfAborted()
      if (newText !== undefined) { textTask.current = newText; newText = undefined }
      setSize(dimensions)
      onWidth?.(dimensions.width)
    }).catch((failure) => { if (!renderSignal.aborted) setError(failure instanceof Error ? failure.message : String(failure)) })
      .finally(() => { newText?.cancel() })
    return () => { lifetime.abort(); newText?.cancel() }
  }, [document, signal, page, requested, zoom, onWidth])
  useEffect(() => {
    if (target === null || size === undefined || !layoutReady || target.token === lastLocation.current) return
    // Wait for this target's fit-width layout, then reveal its marker rather
    // than the centre of a potentially much taller page. Only move this PDF
    // scrollport; subsequent zooms, renders and user scrolling keep their place.
    const frame = window.requestAnimationFrame(() => {
      const marker = targetHost.current
      const viewport = scrollport.current
      if (marker === null || viewport === null || !viewport.contains(marker)
        || viewport.clientHeight === 0 || viewport.clientWidth === 0 || target.token === lastLocation.current) return
      const markBounds = marker.getBoundingClientRect()
      const viewBounds = viewport.getBoundingClientRect()
      viewport.scrollTo({
        top: Math.max(0, viewport.scrollTop + markBounds.top - viewBounds.top - viewport.clientTop
          - (viewport.clientHeight - markBounds.height) / 2),
        left: Math.max(0, viewport.scrollLeft + markBounds.left - viewBounds.left - viewport.clientLeft
          - (viewport.clientWidth - markBounds.width) / 2),
        behavior: 'auto',
      })
      lastLocation.current = target.token
    })
    return () => window.cancelAnimationFrame(frame)
  }, [target, size, layoutReady, zoom, scrollport])
  return <div ref={host} className={css.page} data-workbench-pdf-page={page}
    style={size === undefined ? undefined : { width: size.width * zoom, height: size.height * zoom }}
    onClick={(event) => {
      if (!event.ctrlKey && !event.metaKey) return
      const bounds = event.currentTarget.getBoundingClientRect()
      void onSource(page,
        (event.clientX - bounds.left) / zoom / CSS_PIXELS_PER_POINT,
        (event.clientY - bounds.top) / zoom / CSS_PIXELS_PER_POINT)
    }}>
    {size === undefined && <div className={pdfCss.placeholder} role="status" aria-label={labels.loading} />}
    {error !== undefined && <div className={pdfCss.status} role="alert">{labels.failed}: {error}</div>}
    <canvas ref={canvas} className={pdfCss.canvas} role="img" aria-label={`${labels.page} ${page}`} hidden={size === undefined} />
    <div ref={textHost} className={pdfCss.text} data-pdf-text="" />
    {editing !== undefined && size !== undefined && editing.regions.filter(region => region.page === page).map((region) => {
      const active = editing.active?.id === region.id && editing.active.page === page ? editing.active : null
      const scale = CSS_PIXELS_PER_POINT * zoom
      const bounds = { left: region.x * scale, top: region.y * scale, width: region.width * scale,
        minHeight: region.height * scale }
      return active === null
        ? <button key={region.id} type="button" className={css.editRegion} data-pdf-edit-region={region.id}
          style={{ ...bounds, height: region.height * scale }} aria-label={editing.label}
          disabled={editing.disabled || editing.active !== null} onClick={() => editing.onActivate(region.id, page)} />
        : <div key={region.id} className={css.textEdit} style={bounds} data-pdf-text-editor="">
          <textarea ref={mountInput} aria-label={editing.label} value={active.value} disabled={editing.disabled}
            style={{ fontFamily: active.font, fontSize: active.size * scale,
              textAlign: (['left', 'center', 'right', 'justify'] as const)[active.alignment] ?? 'left',
              minHeight: Math.min(region.height * scale, 400) }}
            onChange={event => editing.onChange(event.target.value, event.target.selectionStart, event.target.selectionEnd,
              composing.current || Boolean((event.nativeEvent as InputEvent).isComposing))}
            onSelect={(event) => {
              const field = event.currentTarget
              editing.onChange(field.value, field.selectionStart, field.selectionEnd, composing.current)
            }}
            onCompositionStart={() => { composing.current = true }}
            onCompositionEnd={(event) => {
              composing.current = false
              const field = event.currentTarget
              editing.onChange(field.value, field.selectionStart, field.selectionEnd, false)
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
              if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); editing.onFinish() }
              if ((event.ctrlKey || event.metaKey) && ['s','z','y'].includes(event.key.toLowerCase())) {
                event.preventDefault()
                editing.onCommand(event.key.toLowerCase() === 's' ? 'save' : event.key.toLowerCase() === 'y' || event.shiftKey ? 'redo' : 'undo')
              }
            }} />
          <button type="button" onClick={editing.onFinish}>{editing.done}</button>
        </div>
    })}
    {target !== null && size !== undefined && <div ref={targetHost} className={css.target} data-workbench-pdf-target="" style={{
      left: target.x * CSS_PIXELS_PER_POINT * zoom,
      top: Math.max(0, target.y - target.height) * CSS_PIXELS_PER_POINT * zoom,
      width: Math.max(8, target.width) * CSS_PIXELS_PER_POINT * zoom,
      height: Math.max(10, target.height) * CSS_PIXELS_PER_POINT * zoom,
    }} />}
  </div>
}
