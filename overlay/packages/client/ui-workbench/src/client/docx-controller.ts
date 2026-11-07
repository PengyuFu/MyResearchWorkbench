/** One OOXML editor per document, retained across views; Host stores only confirmed byte snapshots. */
import { createDocxEditor, type DocxEditorInstance } from '@docx-editor.dev/core/editor'
import { setHarfBuzzWasmUrl } from '@docx-editor.dev/core/layout'
import { randomUUID, bytesToBase64 } from '@deepseek-ai/dsh-util-crypto'
import type { WordOperation, WordSnapshot } from '@deepseek-ai/dsh-workbench-word/types'
import type { WordEditorBuffer } from './types.ts'
import type { WordPorts } from './word-controller.ts'
import { wordBuffer } from './word-operations.ts'
import { docxProjection, docxPosition, docxSelection } from './docx-projection.ts'
import { applyDocxOperation } from './docx-operations.ts'

const decode = (text: string) => Uint8Array.from(atob(text), character => character.charCodeAt(0))
/** A failed native batch may have applied earlier commands; never report it as untouched. */
export class QuickBatchError extends Error {
  constructor(readonly completed: number, readonly total: number, reason: string) { super(reason) }
}
interface Entry {
  path: string
  editor: DocxEditorInstance
  revision: number
  timer?: ReturnType<typeof setTimeout> | undefined
  flight?: Promise<void> | undefined
  mounted?: HTMLElement | undefined
  restoreView?: { from: number; to: number; scrollTop: number; center?: boolean } | undefined
  closing: boolean
}
/** Retains each document model and serializes its durable checkpoints. */
export class DocxDocuments {
  private readonly entries = new Map<string, Entry>()
  private readonly saves = new Map<string, Promise<WordSnapshot>>()
  constructor(private readonly ports: WordPorts) {}
  private api() {
    const api = this.ports.io.word
    if (api?.commit === undefined || api.resources === undefined) throw new Error('The DOCX service is unavailable.')
    return { ...api, commit: api.commit.bind(api), resources: api.resources.bind(api) }
  }
  private file(path: string): WordEditorBuffer {
    const file = this.ports.get(path)
    if (file?.kind !== 'word') throw new Error('The DOCX document is no longer open.')
    return file
  }
  private entry(file: WordEditorBuffer): Entry {
    const kept = this.entries.get(file.word.id)
    if (kept !== undefined) { kept.path = file.path; return kept }
    const encoded = file.pendingWord?.document.startsWith('docx:') === true
      ? file.pendingWord.document.slice(5) : file.word.data
    if (encoded === undefined) throw new Error('The DOCX checkpoint bytes are unavailable.')
    const editor = createDocxEditor({
      document: decode(encoded), mode: 'edit', locale: 'zh-CN',
      fontShaping: { maxFontBytes: 32 * 1024 * 1024 },
      fonts: async (request) => {
        const resources = await this.api().resources(this.ports.session(), [...new Set([...request.families, request.defaultFamily])])
        request.signal?.throwIfAborted()
        setHarfBuzzWasmUrl('data:application/wasm;base64,' + resources.wasm)
        return { epoch: 1, maxFontBytes: 32 * 1024 * 1024,
          defaultFont: { family: request.defaultFamily, sizeHalfPoints: 22 },
          sources: resources.fonts.map(font => ({ id: font.family + ':' + String(font.weight) + ':' + font.style,
            request: { family: font.family, weight: font.weight, style: font.style },
            bytes: decode(font.data), hash: 'sha256:' + font.sha256, faceIndex: font.faceIndex })) }
      },
      onFontError: (error) => { this.ports.error(error) },
    })
    const entry: Entry = { path: file.path, editor, revision: file.revision, closing: false }
    this.entries.set(file.word.id, entry)
    editor.on('change', (change) => {
      if (entry.closing) return
      if (change.source !== undefined) { this.publish(entry, false); return }
      entry.revision++
      this.publish(entry, true)
      if (entry.timer === undefined) entry.timer = setTimeout(() => {
        entry.timer = undefined
        void this.flush(entry.path).catch((error: unknown) => { this.ports.error(error) })
      }, 220)
    })
    editor.on('selectionChange', () => { this.publish(entry, false) })
    editor.on('error', (error) => { this.ports.error(new Error(error.message)) })
    return entry
  }
  private publish(entry: Entry, changed: boolean): void {
    const file = this.ports.get(entry.path)
    if (entry.closing || file?.kind !== 'word' || entry.editor.surface === null || entry.editor.snapshot().isOpening) return
    const restore = entry.restoreView
    if (restore !== undefined && entry.mounted !== undefined) {
      entry.restoreView = undefined
      const context = docxProjection(entry.editor)
      entry.editor.exec({ type: 'setSelection', range: {
        anchor: docxPosition(context, restore.from), head: docxPosition(context, restore.to) } })
      const mounted = entry.mounted, scroller = mounted.parentElement ?? mounted
      requestAnimationFrame(() => {
        if (entry.mounted !== mounted) return
        if (restore.center) { entry.editor.scrollToBlock(docxPosition(context, restore.from).paragraphId, { block: 'centerIfNeeded' }); entry.editor.focus() }
        else scroller.scrollTop = restore.scrollTop
      })
    }
    const projection = docxProjection(entry.editor)
    const selection = docxSelection(entry.editor, projection)
    this.ports.put(entry.path, { ...file, text: projection.text, revision: entry.revision, selection,
      word: { ...file.word, projection },
      ...(changed ? { pendingWord: { text: projection.text, document: '' },
        wordSync: file.wordSync === 'failed' ? 'failed' : 'pending',
        saveState: file.saveState === 'error' || file.saveState === 'conflict' ? file.saveState : 'dirty' } : {}) })
  }
  /**
   * Attach a view while retaining its document and history.
   * @param path - Open workspace document path.
   * @param element - Canvas inside the scrolling viewport.
   * @returns View detachment callback.
   */
  attach(path: string, element: HTMLElement): () => void {
    const file = this.file(path), entry = this.entry(file)
    entry.mounted = element
    entry.restoreView ??= { ...file.selection, scrollTop: file.visualScrollTop ?? 0 }
    entry.editor.attach(element)
    entry.editor.setZoomMode('auto')
    this.publish(entry, false)
    const scroll = (event: Event) => {
      if (!(event.target instanceof HTMLElement)) return
      const current = this.ports.get(entry.path)
      if (current?.kind === 'word') this.ports.put(entry.path, { ...current, visualScrollTop: event.target.scrollTop })
    }
    const scroller = element.parentElement ?? element
    scroller.addEventListener('scroll', scroll, true)
    // Auto-fit preserves the viewport centre. Keep a reader at the document
    // start there when a wider panel would otherwise scroll its first line away.
    let width = scroller.clientWidth
    let frame: number | undefined
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      const next = scroller.clientWidth
      if (next === width) return
      width = next
      if (scroller.scrollTop > 1) return
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = undefined
        if (entry.mounted === element) scroller.scrollTop = 0
      })
    }) : undefined
    resize?.observe(scroller)
    return () => {
      resize?.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
      scroller.removeEventListener('scroll', scroll, true)
      if (entry.mounted === element) { entry.editor.detach(); entry.mounted = undefined }
    }
  }
  /**
   * Select and reveal a range in the retained model.
   * @param path - Open document path.
   * @param from - Start UTF-16 offset.
   * @param to - End UTF-16 offset.
   */
  navigate(path: string, from: number, to: number): void {
    const file = this.file(path), entry = this.entry(file)
    if (entry.editor.surface === null || entry.editor.snapshot().isOpening) {
      entry.restoreView = { from, to, scrollTop: file.visualScrollTop ?? 0, center: true }
      this.ports.put(path, { ...file, selection: { from, to } })
      return
    }
    const projection = docxProjection(entry.editor)
    const result = entry.editor.exec({ type: 'setSelection', range: { anchor: docxPosition(projection, from), head: docxPosition(projection, to) } })
    if (!result.ok) throw new Error(result.reason)
    entry.editor.scrollToBlock(docxPosition(projection, from).paragraphId, { block: 'centerIfNeeded' })
    entry.editor.focus()
  }
  private async capture(entry: Entry) {
    entry.editor.surface?.flushPendingInput()
    const revision = entry.revision, saving = entry.editor.save(), projection = docxProjection(entry.editor)
    const bytes = new Uint8Array(await saving), data = bytesToBase64(bytes)
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
    const sha256 = Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')
    const file = this.ports.get(entry.path)
    if (file?.kind === 'word' && !entry.closing && entry.revision === revision) {
      this.ports.put(entry.path, { ...file, pendingWord: { text: projection.text, document: 'docx:' + data },
        wordSync: file.wordSync === 'failed' ? 'failed' : 'pending' })
      this.ports.checkpoint()
    }
    return { revision, projection, data, sha256 }
  }
  /**
   * Persist all pending model revisions before returning.
   * @param path - Open document path.
   * @param queuedRequestId - Reviewed operation acknowledged with these bytes.
   */
  async flush(path: string, queuedRequestId?: string): Promise<void> {
    const initial = this.file(path), entry = this.entries.get(initial.word.id)
    if (entry?.flight !== undefined) {
      if (initial.pendingWord !== undefined) await this.capture(entry)
      await entry.flight; return this.flush(entry.path, queuedRequestId)
    }
    if (entry?.timer !== undefined) { clearTimeout(entry.timer); entry.timer = undefined }
    if (initial.wordSync === 'failed' || initial.pendingWord?.recovered) throw new Error(this.ports.pendingMessage())
    if (initial.pendingWord === undefined) return
    if (entry === undefined || entry.closing) throw new Error('The pending DOCX editor is unavailable.')
    const operation = (async () => {
      while (!entry.closing) {
        const file = this.file(entry.path)
        if (file.pendingWord === undefined) break
        const { revision, projection, data, sha256 } = await this.capture(entry)
        const next = await this.api().commit(this.ports.session(), { documentId: file.word.id,
          requestId: randomUUID(), revision: file.word.revision, nextRevision: revision,
          data, sha256, projection, ...(queuedRequestId === undefined ? {} : { queuedRequestId }) })
        const after = this.file(entry.path)
        const failure = after.saveState === 'error' || after.saveState === 'conflict'
          ? { saveState: after.saveState, error: after.error } : {}
        if (entry.revision === revision) this.ports.put(entry.path, { ...wordBuffer(next, after), pane: 'visual', ...failure })
        else this.ports.put(entry.path, { ...after, word: { ...next, projection: after.word.projection },
          wordSync: 'pending', saveState: 'dirty', ...failure })
        this.ports.checkpoint()
      }
    })().catch((error: unknown) => {
      const current = this.ports.get(entry.path)
      if (current?.kind === 'word') this.ports.put(entry.path, { ...current, wordSync: 'failed', saveState: 'error',
        error: error instanceof Error ? error.message : String(error) })
      this.ports.checkpoint()
      throw error
    })
    entry.flight = operation
    try { await operation } finally { entry.flight = undefined }
  }
  /**
   * Apply a reviewed command through the document history.
   * @param path - Open document path.
   * @param operation - Command at the confirmed revision.
   * @param queuedRequestId - Durable operation identifier, when queued.
   */
  async mutate(path: string, operation: WordOperation, queuedRequestId?: string): Promise<void> {
    await this.flush(path)
    const entry = this.entry(this.file(path))
    await applyDocxOperation(entry.editor, operation)
    await this.flush(path, queuedRequestId)
  }
  /** Capture text, rectangular cell and active story selection together. */
  selectionKey(path: string): string {
    const entry = this.entries.get(this.file(path).word.id)
    if (!entry?.mounted || !entry.editor.surface || entry.editor.snapshot().isOpening) return ''
    const editor = entry.editor
    const cells = editor.getTableCellSelection()
    return JSON.stringify({ selection: editor.surface?.state().selection,
      cells: cells && { tableId: cells.tableId, rows: cells.rows, columns: cells.columns }, scope: editor.surface?.activeScope() })
  }
  /**
   * Apply one fully validated instruction with a shared formatting history group and one checkpoint.
   * @param path - Open document path.
   * @param operations - Validated commands in execution order.
   * @param selectionKey - Frozen native selection identity.
   * @param signal - Optional cancellation checked between commands.
   * @returns Completion after settling any applied edits.
   */
  async batch(path: string, operations: readonly WordOperation[], selectionKey: string, signal?: AbortSignal): Promise<void> {
    await this.flush(path)
    const entry = this.entry(this.file(path)), editor = entry.editor
    if (this.selectionKey(path) !== selectionKey) throw new Error('The native selection changed before execution.')
    const original = editor.surface?.state().selection, cells = editor.surface?.state().cellSelection
    // Page-region and structural commands reject formatting history groups in the native editor.
    const group = operations.every(operation => operation.kind === 'format') ? editor.beginHistoryGroup() : undefined
    let completed = 0
    try {
      for (const operation of operations) {
        signal?.throwIfAborted()
        // Every selection-targeted clause refers to the originally submitted selection.
        if ((operation.kind === 'format' || operation.kind === 'native') && operation.preserveSelection && original) {
          const result = editor.exec({ type: 'setSelection', range: original })
          if (!result.ok) throw new Error(result.reason)
          if (cells) editor.surface?.setCellSelection(cells)
        }
        await applyDocxOperation(editor, operation, group)
        completed++
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new QuickBatchError(completed, operations.length, reason)
    } finally { group?.end(); await this.flush(path) }
  }
  /**
   * Save confirmed bytes while retaining any subsequent typing.
   * @param path - Open document path.
   * @param destination - Save As path, or null for the current path.
   * @returns Acknowledged saved checkpoint.
   */
  async save(path: string, destination: string | null): Promise<WordSnapshot> {
    const id = this.file(path).word.id
    const pending = this.saves.get(id)
    if (pending !== undefined) {
      const saved = await pending
      return this.save(saved.path, destination)
    }
    const saving = this.saveConfirmed(path, destination)
    this.saves.set(id, saving)
    try { return await saving } finally { if (this.saves.get(id) === saving) this.saves.delete(id) }
  }
  private async saveConfirmed(path: string, destination: string | null): Promise<WordSnapshot> {
    await this.flush(path)
    const file = this.file(path), entry = this.entries.get(file.word.id)
    if (destination === null && file.revision === file.word.savedRevision) return file.word
    this.ports.put(path, { ...file, saveState: 'saving', error: undefined })
    let result: WordSnapshot | undefined
    const saving = (async () => {
      try {
        const saved = await this.api().save(this.ports.session(), file.word.id, file.word.revision, randomUUID(), destination)
        result = saved
        const current = this.file(path)
        if (entry !== undefined) entry.path = saved.path
        this.ports.put(path, current.pendingWord === undefined ? wordBuffer(saved, current) :
          { ...current, path: saved.path, absolutePath: saved.absolutePath, word: { ...saved, projection: current.word.projection },
            saveState: 'dirty' })
        this.ports.checkpoint()
      } catch (error) {
        const current = this.file(path)
        this.ports.put(path, { ...current, saveState: 'error', error: error instanceof Error ? error.message : String(error) })
        throw error
      }
    })()
    if (entry !== undefined) entry.flight = saving
    try { await saving } finally { if (entry?.flight === saving) entry.flight = undefined }
    if (result === undefined) throw new Error('The DOCX save was not confirmed.')
    return result
  }
  /**
   * Apply queued commands only to their matching revision.
   * @param path - Open document path.
   * @param id - Expected document identity.
   */
  async refresh(path: string, id: string): Promise<void> {
    const current = this.file(path)
    if (current.word.id !== id) return
    const api = this.api()
    if (api.checkpoint === undefined) throw new Error('DOCX checkpoints are unavailable.')
    const snapshot = await api.checkpoint(this.ports.session(), id)
    const latest = this.file(path)
    if ((snapshot.pendingOperations?.length ?? 0) === 0 && latest.pendingWord === undefined
      && latest.word.revision === snapshot.revision && latest.word.savedRevision !== snapshot.savedRevision) {
      this.ports.put(path, wordBuffer(snapshot, latest))
      this.ports.checkpoint()
    }
    for (const request of snapshot.pendingOperations ?? []) {
      let failure: string | null = null
      try {
        const file = this.file(path)
        if (file.pendingWord !== undefined || file.word.revision !== request.revision) {
          throw new Error('The document changed before the formatting request. Read the current draft and try again.')
        }
        await this.mutate(path, request.operation, request.requestId)
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        await this.api().resolveOperation?.(this.ports.session(), id, request.requestId, failure)
      }
    }
  }
  /**
   * Reconcile an unacknowledged binary draft with durable bytes.
   * @param path - Open document path.
   */
  async resume(path: string): Promise<void> {
    const file = this.file(path)
    if (file.pendingWord !== undefined && !file.pendingWord.document.startsWith('docx:')) {
      throw new Error(this.ports.pendingMessage())
    }
    const api = this.api()
    if (api.checkpoint === undefined) throw new Error('DOCX checkpoints are unavailable.')
    const confirmed = await api.checkpoint(this.ports.session(), file.word.id)
    const entry = this.entry(file)
    if (file.pendingWord === undefined || (confirmed.data !== undefined && file.pendingWord.document === 'docx:' + confirmed.data)) {
      entry.revision = confirmed.revision
      this.ports.put(path, wordBuffer(confirmed, file))
      return
    }
    entry.revision = Math.max(entry.revision, confirmed.revision + 1)
    this.ports.put(path, { ...file, revision: entry.revision, word: { ...confirmed, projection: file.word.projection },
      wordSync: 'pending', pendingWord: { ...file.pendingWord, recovered: false }, error: undefined })
    await this.flush(path)
  }
  /**
   * Stop scheduling checkpoints and settle the current write.
   * @param path - Closing document path.
   */
  async settleClose(path: string): Promise<void> {
    const file = this.file(path), entry = this.entries.get(file.word.id)
    if (entry === undefined) return
    entry.closing = true
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    await entry.flight?.catch(() => undefined)
  }
  /**
   * Destroy a removed model or resume a cancelled close.
   * @param path - Document path from the close attempt.
   */
  releaseClose(path: string): void {
    for (const [id, entry] of this.entries) if (entry.path === path) {
      if (this.ports.get(path) === undefined) { entry.editor.destroy(); this.entries.delete(id) }
      else entry.closing = false
    }
  }
  /**
   * Release all owned editors and checkpoint timers.
   */
  dispose(): void {
    for (const entry of this.entries.values()) { if (entry.timer !== undefined) clearTimeout(entry.timer); entry.editor.destroy() }
    this.entries.clear()
  }
}
