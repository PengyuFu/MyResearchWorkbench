/** Owns editor buffers, version-checked saves, and cancellable workbench actions. */
import { QuickBatchError } from './docx-controller.ts'
import { WordEdits } from './word-controller.ts'
import { wordBuffer, wordSelection, wordPageSelection } from './word-operations.ts'
import type { WordOperation } from '@deepseek-ai/dsh-workbench-word/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { presentableDiff } from '@codemirror/merge'
import { applyScientificProposal, scientificInsertion, scientificSelection } from './proposal-operations.ts'
import { activeBuffer, activePane, activePath, fileMode } from './editor-state.ts'
import { projectReferences } from './project-references.ts'
import { parseLatexDocument } from './latex-source.ts'
import { WorkbenchAssetStaging, createStagedAssetPreview, stagedAssetPayload } from './asset-staging.ts'
import type { AssetStagingScope, StagedAsset } from './asset-staging.ts'
import { captureWorkbench, diskText, type StoredBuffer } from './buffer-persistence.ts'
import type { WorkbenchPersistence } from './workbench-state.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  WorkbenchConversationView, WorkbenchEditorContext, WorkbenchSelection, WorkbenchSelectionRequest,
} from '@deepseek-ai/dsh-workbench-assistant/types'
import type { WorkbenchKey } from './locales.ts'
import type { AssistantAction, Diagnostic, EditorBuffer, WordEditorBuffer, EditorMode, EditorPane, FileSnapshot, RunRequest, StagedAssetInfo, WorkbenchActions, WorkbenchIO, WorkbenchSnapshot } from './types.ts'

type Translate = (key: WorkbenchKey) => string

const PREFERENCE_KEY = 'mrw.workbench.preferences.v1'
function preferences(): Partial<WorkbenchSnapshot> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PREFERENCE_KEY) ?? '{}')
    if (typeof value !== 'object' || value === null) return {}
    const result: Partial<WorkbenchSnapshot> = {}
    if ('mode' in value && (value.mode === 'chat' || value.mode === 'writing' || value.mode === 'development')) result.mode = value.mode
    if ('chatWidth' in value && typeof value.chatWidth === 'number' && Number.isFinite(value.chatWidth)) result.chatWidth = Math.max(420, Math.min(720, value.chatWidth))
    if ('fontSize' in value && typeof value.fontSize === 'number' && Number.isFinite(value.fontSize)) result.fontSize = Math.max(12, Math.min(28, value.fontSize))
    if ('codeFontSize' in value && typeof value.codeFontSize === 'number' && Number.isFinite(value.codeFontSize)) result.codeFontSize = Math.max(12, Math.min(28, value.codeFontSize))
    if ('wrap' in value && typeof value.wrap === 'boolean') result.wrap = value.wrap
    return result
  } catch (_error) { return {} }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isUnavailableJob(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'workbench/unavailable' || !('details' in error)) return false
  const details = error.details
  return typeof details === 'object' && details !== null && 'reason' in details && details.reason === 'job-unavailable'
}

function operationMessage(error: unknown, t: Translate): string {
  const keys: WorkbenchKey[] = [
    'insertionBodyRequired', 'atomicProposalRequired', 'partialScientificObject',
    'linkedReferencesNeedProjectReview', 'ambiguousLabelChange', 'invalidScientificProposal',
  ]
  const value = message(error)
  const key = keys.find(item => item === value)
  return key === undefined ? value : t(key)
}

function newBuffer(file: FileSnapshot, mode: EditorMode): EditorBuffer {
  const text = file.text.replaceAll('\r\n', '\n')
  return { mode, path: file.path, absolutePath: file.absolutePath, savedRawText: file.text, text, savedText: text, diskVersion: file.version, lineEnding: file.text.includes('\r\n') ? 'crlf' : 'lf', revision: 0,
    selection: { from: 0, to: 0 }, scrollTop: 0, saveState: 'clean' }
}

/** Disk-captured proposals require a clean buffer at the exact source version; browser captures require the same revision. */
function matchesProposalBase(file: EditorBuffer, base: Pick<WorkbenchSelection, 'bufferVersion' | 'from' | 'to' | 'selectedText'>): boolean {
  const versionMatches = base.bufferVersion.startsWith('disk:')
    ? file.text === file.savedText && file.diskVersion !== null && base.bufferVersion === 'disk:' + file.diskVersion
    : String(file.revision) === base.bufferVersion
  return versionMatches && file.unavailable !== true && file.saveState !== 'conflict' && file.text.slice(base.from, base.to) === base.selectedText
}

/** Compute stable UTF-16 source positions without inserting hard line breaks. */
function positionAt(text: string, line: number, column = 1): number {
  let start = 0
  for (let current = 1; current < line; current++) {
    const next = text.indexOf('\n', start)
    if (next < 0) return text.length
    start = next + 1
  }
  const end = text.indexOf('\n', start)
  return Math.min(start + Math.max(0, column - 1), end < 0 ? text.length : end)
}

/** One resident controller per selected Session; mode changes preserve its buffers. */
export class WorkbenchController {
  readonly state = createSnapshotStore<WorkbenchSnapshot>({
    workspaceRoot: null, mode: 'chat', focus: 'editor', chatWidth: 580, fontSize: 17, codeFontSize: 16, wrap: true, mainFile: '',
    browserOpen: false, browserPath: '.', entries: [], filesLoading: false,
    activePaths: { writing: null, development: null }, buffers: {}, selection: null, selectionMode: 'assist', instruction: '', action: null,
    panes: { writing: 'visual', development: 'source' }, job: null, outputOpen: false, pdf: null, pdfSourcePath: null, pdfDirty: false, pdfTarget: null, sourceTarget: null, error: null, restoring: false, recoveryError: null, pdfPositions: {},
    stagedAssets: [], assetRecovery: null,
    ...preferences(),
  })
  private readonly assetUrls = new Map<string, string>()
  private readonly assetStaging = new WorkbenchAssetStaging()
  private restoreGeneration = 0
  private hydration: Promise<void> | undefined
  private initialRestore = true
  private restoredScene = false
  private projectionInitialized = false
  private pendingProjection: WorkbenchConversationView | undefined
  private persistenceBlocked = false
  private interactionRevision = 0
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined
  private readonly wordEdits: WordEdits
  private readonly saves = new Map<string, Promise<void>>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private actionTimer: ReturnType<typeof setTimeout> | undefined
  private jobTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private quickAbort: AbortController | undefined
  private quickReceipt: { requestId: string; acknowledge: () => void } | undefined
  private quickFlight: Promise<unknown> | undefined
  private restoringJob = false
  private selectionGeneration = 0
  private openGeneration = 0
  private listGeneration = 0
  private readonly wordProofFlights = new Map<string, Promise<void>>()
  private pdfGeneration = 0
  private sourceRevision = 0
  private jobSourceRevision = 0
  private locateToken = 0
  private editToken = 0
  private readonly acceptedParts = new Map<string, number>()
  private readonly editorId = randomUUID()
  private contextGeneration = 0
  private contextFlight: Promise<void> = Promise.resolve()
  private lastWordSeq = -1
  private conversationFlight: Promise<void> = Promise.resolve()
  private publishedBuffer: EditorBuffer | undefined
  private publishedPath: string | null = null
  private lastOpenSeq = -1
  private lastPreparedSeq = -1
  private lastAgentOperationSeq = -1

  constructor(
    private readonly sessionId: SessionId | undefined,
    private readonly io: WorkbenchIO,
    private readonly t: Translate,
    private readonly autoSaveMs = 1000,
    private readonly persistence?: WorkbenchPersistence,
  ) { this.initialRestore = persistence !== undefined
    this.wordEdits = new WordEdits({
      io: this.io, session: () => this.session(), get: path => this.snapshot().buffers[path],
      put: (path, file) => {
        const state = this.snapshot()
        const previous = state.buffers[path]
        const buffers = Object.fromEntries(Object.entries(state.buffers).map(([key, value]) =>
          key === path ? [file.path, file] : [key, value]))
        this.patch({ buffers, ...(file.path === path ? {} : { activePaths: { ...state.activePaths,
          writing: state.activePaths.writing === path ? file.path : state.activePaths.writing } }),
        ...(this.snapshot().pdfSourcePath === path ? {
          pdfDirty: String(file.revision) !== this.snapshot().pdf?.sourceVersion || file.pendingWord !== undefined } : {}) })
        if (file.path !== path) {
          const timer = this.timers.get(path)
          if (timer !== undefined) clearTimeout(timer)
          this.timers.delete(path)
        }
        if (this.canAutoSaveWord(file) && (previous?.revision !== file.revision
          || previous.saveState === 'saving' || file.path !== path)) this.scheduleSave(file.path)
      },
      checkpoint: () => this.checkpoint(), error: error => this.report(error), pendingMessage: () => this.t('wordPendingRecovery'),
    })
  }

  private snapshot(): WorkbenchSnapshot { return this.state.getSnapshot() }
  private patch(change: Partial<WorkbenchSnapshot>): void {
    if (this.disposed) return
    this.state.set({ ...this.snapshot(), ...change })
    this.publishEditorContext()
    // Keep a bounded loss window even while typing continuously; do not postpone on every edit.
    if (this.recoveryTimer === undefined) this.recoveryTimer = setTimeout(() => this.checkpoint(), 150)
  }
  /** Activate only the owning board, preserving the other board's current file and view. */
  private activation(file: EditorBuffer, pane?: EditorPane): Partial<WorkbenchSnapshot> {
    const state = this.snapshot()
    return { mode: file.mode, activePaths: { ...state.activePaths, [file.mode]: file.path },
      panes: { ...state.panes, [file.mode]: pane ?? file.pane ?? (state.activePaths[file.mode] === file.path
        ? state.panes[file.mode] : /\.(tex|docx)$/iu.test(file.path) ? 'visual' : 'source') } }
  }
  private pane(pane: EditorPane, mode = this.snapshot().mode): Partial<WorkbenchSnapshot> {
    if (mode === 'chat') return {}
    const state = this.snapshot()
    const path = state.activePaths[mode]
    const file = path === null ? undefined : state.buffers[path]
    return { panes: { ...state.panes, [mode]: pane },
      ...(file === undefined ? {} : { buffers: { ...state.buffers, [file.path]: { ...file, pane } } }) }
  }
  private buffer(path: string, change: Partial<EditorBuffer>): void {
    const current = this.snapshot().buffers[path]
    if (current !== undefined) this.patch({ buffers: { ...this.snapshot().buffers, [path]: { ...current, ...change } as EditorBuffer } })
  }
  private preference(change: Partial<WorkbenchSnapshot>): void {
    this.patch(change)
    if (typeof localStorage === 'undefined') return
    const { mode, chatWidth, fontSize, codeFontSize, wrap } = this.snapshot()
    try { localStorage.setItem(PREFERENCE_KEY, JSON.stringify({ mode, chatWidth, fontSize, codeFontSize, wrap })) }
    catch (_error) { /* Editing remains available when preference storage is unavailable. */ }
  }
  private session(): SessionId {
    if (this.sessionId === undefined) throw new Error(this.t('needWorkspace'))
    return this.sessionId
  }
  private report(error: unknown): void { this.patch({ error: message(error) }) }
  private retireUnavailableJob(id: string, error: unknown): boolean {
    const job = this.snapshot().job
    if (!isUnavailableJob(error) || job?.id !== id) return false
    const failed = { ...job, state: 'failed' as const, error: this.t('jobUnavailable') }
    delete failed.pollError
    this.patch({ job: failed })
    void this.restoreJob()
    return true
  }
  private pdfSource(): string | null { return this.snapshot().mainFile.trim() || this.snapshot().activePaths.writing }
  private sourceChanged(path: string): void {
    if (!/\.(tex|bib|sty|cls)$/i.test(path)) return
    this.sourceRevision++
    this.patch({ pdfDirty: true })
  }
  private canAutoSaveWord(file: WordEditorBuffer): boolean {
    return file.unavailable !== true && file.saveState !== 'error' && file.saveState !== 'conflict'
      && file.wordSync !== 'failed' && file.pendingWord?.recovered !== true && !file.word.projection.readOnly
      && file.word.originalStatus === undefined && this.snapshot().closePrompt !== file.path
      && (file.revision !== file.word.savedRevision || file.pendingWord !== undefined)
  }
  private scheduleSave(path: string): void {
    const old = this.timers.get(path)
    if (old !== undefined) clearTimeout(old)
    this.timers.set(path, setTimeout(() => {
      this.timers.delete(path)
      const file = this.snapshot().buffers[path]
      if (file?.kind === 'word' && !this.canAutoSaveWord(file)) return
      void this.save(path).catch(error => this.report(error))
    }, this.autoSaveMs))
  }

  /** Stage all open files and drafts through the application's single writer. */
  checkpoint(): void {
    if (this.recoveryTimer !== undefined) { clearTimeout(this.recoveryTimer); this.recoveryTimer = undefined }
    if (this.initialRestore || this.snapshot().restoring || this.persistenceBlocked
      || this.sessionId === undefined || this.snapshot().workspaceRoot === null || this.persistence === undefined) return
    this.persistence.stage(captureWorkbench(this.sessionId, this.snapshot()))
    void this.persistence.flush().then(() => this.persistenceStatus(null), error => this.persistenceStatus(error))
  }

  /** Surface storage failure while retaining both committed and in-memory work.
   * @param error - storage failure, or null after a successful commit.
   */
  persistenceStatus(error: unknown): void {
    if (error === null && this.persistenceBlocked) return
    const value = error === null ? null : this.t('stateSaveFailed') + ' ' + message(error)
    if (this.snapshot().recoveryError === value || this.disposed) return
    this.state.set({ ...this.snapshot(), recoveryError: value })
  }

  /** Await draft capture; normal quit also publishes ready Word originals. */
  async ready(saveOriginals = false): Promise<void> {
    await this.hydration
    await this.wordEdits.ready(Object.values(this.snapshot().buffers).filter(file => file.kind === 'word').map(file => file.path))
    if (saveOriginals) for (const file of Object.values(this.snapshot().buffers)) {
      if (file.kind === 'word' && this.canAutoSaveWord(file)) {
        try { await this.save(file.path) } catch (error) { this.report(error) }
      }
    }
  }

  private async bindWorkspace(root: string): Promise<void> {
    root = root.replaceAll('\\', '/').replace(/\/+$/u, '')
    const previous = this.snapshot().workspaceRoot
    if (previous === root) { await this.hydration; return }
    this.checkpoint()
    const generation = ++this.restoreGeneration
    this.persistenceBlocked = false
    if (previous !== null) {
      this.openGeneration++; this.listGeneration++; this.pdfGeneration++; this.selectionGeneration++
      for (const timer of this.timers.values()) clearTimeout(timer)
      this.timers.clear()
      this.patch({ buffers: {}, activePaths: { writing: null, development: null }, panes: { writing: 'visual', development: 'source' }, selection: null, action: null, instruction: '',
        entries: [], browserPath: '.', mainFile: '', pdf: null, pdfSourcePath: null, pdfTarget: null, sourceTarget: null, pdfPositions: {} })
    }
    this.patch({ workspaceRoot: root, restoring: this.persistence !== undefined,
      recoveryError: null, stagedAssets: [], assetRecovery: null })
    const hydration = this.restoreScene(root, generation).finally(() => {
      if (generation !== this.restoreGeneration || this.disposed) return
      this.initialRestore = false
      this.patch({ restoring: false })
      if (this.pendingProjection !== undefined) this.observeConversation(this.pendingProjection)
    })
    this.hydration = hydration
    await hydration
    if (generation === this.restoreGeneration && globalThis.indexedDB !== undefined) {
      void this.refreshAssets().catch(error => this.report(error))
    }
  }

  private async bindFile(file: FileSnapshot): Promise<void> {
    const absolute = file.absolutePath.replaceAll('\\', '/')
    const relative = file.path.replaceAll('\\', '/')
    if (absolute.endsWith('/' + relative)) await this.bindWorkspace(absolute.slice(0, -relative.length - 1))
  }

  /** Stop local pollers on plugin disposal; running jobs remain owned by the Host. */
  async dispose(): Promise<void> {
    await this.ready()
    this.quickAbort?.abort()
    await this.quickFlight?.catch(() => undefined)
    this.checkpoint()
    this.wordEdits.dispose()
    this.disposed = true
    this.restoreGeneration++
    if (this.recoveryTimer !== undefined) clearTimeout(this.recoveryTimer)
    for (const url of this.assetUrls.values()) URL.revokeObjectURL(url)
    this.assetUrls.clear()
    for (const timer of this.timers.values()) clearTimeout(timer)
    if (this.actionTimer !== undefined) clearTimeout(this.actionTimer)
    if (this.jobTimer !== undefined) clearTimeout(this.jobTimer)
    await Promise.allSettled([this.contextFlight, this.conversationFlight])
    await this.assetStaging.close()
    if (this.sessionId !== undefined) {
      try { await this.io.publishEditor({ sessionId: this.sessionId, editorId: this.editorId,
        generation: ++this.contextGeneration, context: null }) }
      catch (_error) { /* A disconnected Host owns the remaining ephemeral context until its Agent is disposed. */ }
    }
  }

  /** Republish the resident buffer when the existing Session connection is replaced. */
  synchronizeEditor(): void { this.publishEditorContext(true) }

  /** Flush the active draft and publish its matching context before a local command is admitted. */
  async prepareQuickCommand(): Promise<void> {
    const file = activeBuffer(this.snapshot())
    if (file?.kind === 'word') await this.wordEdits.flush(file.path)
    this.publishEditorContext(true)
    await this.contextFlight
  }

  /**
   * Main-composer entry. An attached reference scopes both quick operations and ordinary assistance.
   * @param instruction - Exact submitted text.
   * @param signal - Composer submission lifetime.
   * @param requestId - Identity shared with the optimistic conversation echo.
   * @param acknowledge - Retires that echo after the durable message is projected.
   * @returns Outcome, or null to continue through ordinary chat.
   */
  async submitText(instruction: string, signal: AbortSignal, requestId: string, acknowledge: () => void): Promise<{ kind: 'success' | 'error'; text?: string } | null> {
    const { selection, selectionMode } = this.snapshot()
    if (selection !== null && selectionMode !== 'ask') {
      const file = activeBuffer(this.snapshot())
      if (!file || file.path !== selection.path || !matchesProposalBase(file, selection)) {
        const rejected = await this.rejectQuick(instruction, requestId, this.t('staleProposal'))
        acknowledge()
        return rejected
      }
      this.buffer(file.path, { selection: { from: selection.from, to: selection.to } })
    }
    const quick = selectionMode === 'ask' && selection !== null ? null
      : await this.quickCommand(instruction, signal, requestId, undefined, acknowledge)
    if (quick !== null) {
      // Durable transcript owns the receipt; do not duplicate it in a gray composer notice.
      return { kind: quick.kind }
    }
    if (selection === null || selectionMode === 'assist') return null
    await this.ask(instruction, true)
    acknowledge()
    const action = this.snapshot().action
    return action?.state === 'failed' ? { kind: 'error', ...(action.error === undefined ? {} : { text: action.error }) } : { kind: 'success' }
  }

  /** Stop only the currently executing fast request; document settlement still reports actual writes. */
  stopQuick(): void { this.quickAbort?.abort() }

  /**
   * Share the same fast path between the main composer and selected-text assistance.
   * @param instruction - Exact submitted text.
   * @param signal - Composer submission lifetime.
   * @param requestId - Idempotency identity of this submission.
   * @param reply - Optional binding to a displayed clarification choice.
   * @param acknowledge - Optional retirement callback for the optimistic echo.
   * @returns Logged outcome, or null when the instruction is delegated.
   */
  async quickCommand(instruction: string, signal: AbortSignal, requestId: string = randomUUID(),
    reply?: import('@deepseek-ai/dsh-workbench-assistant/types').QuickReply, acknowledge?: () => void): Promise<{ kind: 'success' | 'error'; text: string } | null> {
    if (!this.io.quickEdit || !this.io.completeQuickEdit || !activeBuffer(this.snapshot())) return null
    if (this.quickAbort) {
      const rejected = await this.rejectQuick(instruction, requestId, this.t('quickBusy'))
      acknowledge?.()
      return rejected
    }
    const abort = new AbortController(), combined = AbortSignal.any([signal, abort.signal])
    this.quickAbort = abort
    this.quickReceipt = acknowledge ? { requestId, acknowledge } : undefined
    const flight = this.executeQuick(instruction, combined, requestId, reply)
    this.quickFlight = flight
    try { return await flight } finally { this.quickAbort = undefined; this.quickFlight = undefined; this.quickReceipt = undefined }
  }

  private async rejectQuick(instruction: string, requestId: string, reason: string): Promise<{ kind: 'error'; text: string }> {
    const selection = this.snapshot().selection, file = activeBuffer(this.snapshot())
    if (!this.io.rejectQuick) return { kind: 'error', text: reason }
    await this.io.rejectQuick(this.session(), instruction, requestId, selection?.path ?? file?.path ?? '', selection?.selectedText ?? '', reason)
    return { kind: 'error', text: '' }
  }

  private async executeQuick(instruction: string, signal: AbortSignal, requestId: string,
    reply?: import('@deepseek-ai/dsh-workbench-assistant/types').QuickReply): Promise<{ kind: 'success' | 'error'; text: string } | null> {
    if (!this.io.quickEdit || !this.io.completeQuickEdit) return null
    try { await this.prepareQuickCommand() } catch (error) { return this.rejectQuick(instruction, requestId, message(error)) }
    const prepared = await this.io.quickEdit(this.session(), instruction, signal, requestId, reply)
    if (!prepared) return null
    if (prepared.kind === 'result') return prepared.result
    return this.applyPrepared(prepared, signal)
  }

  private async applyPrepared(prepared: Extract<import('@deepseek-ai/dsh-workbench-assistant/types').QuickPrepared, { kind: 'prepared' }>,
    signal: AbortSignal): Promise<{ kind: 'success' | 'error'; text: string }> {
    let error: string | null = null
    const reference = this.snapshot().selection
    let refreshReference = false
    try {
      signal.throwIfAborted()
      const file = activeBuffer(this.snapshot())
      if (!file || file.path !== prepared.path || String(file.revision) !== prepared.bufferVersion
        || file.selection.from !== prepared.selection.from || file.selection.to !== prepared.selection.to
        || file.unavailable || file.saveState === 'conflict') throw new Error(this.t('quickChanged'))
      refreshReference = reference !== null && reference.path === file.path && matchesProposalBase(file, reference)
      const execution = prepared.execution
      if (execution.kind === 'word') {
        if (file.kind !== 'word') throw new Error(this.t('quickChanged'))
        await this.wordEdits.batch(file.path, execution.operations, prepared.selectionKey, signal)
        await this.save(file.path)
      } else if (execution.kind === 'source') {
        if (file.kind === 'word') throw new Error(this.t('quickChanged'))
        let text = file.text
        for (const edit of execution.edits) {
          if (text.slice(edit.from, edit.to) !== edit.before) throw new Error(this.t('quickChanged'))
          text = text.slice(0, edit.from) + edit.text + text.slice(edit.to)
        }
        this.buffer(file.path, { text, revision: file.revision + 1, saveState: 'dirty',
          edit: { id: ++this.editToken, from: 0, to: file.text.length, insert: text } })
        this.sourceChanged(file.path)
        await this.save(file.path)
      } else if (execution.action === 'save') await this.save(file.path)
      else if (execution.action === 'run') await this.run({ kind: /\.tex$/iu.test(file.path) ? 'latex' : 'python', path: file.path }, true)
      else {
        const job = this.snapshot().job
        if (!job || job.state !== 'running') throw new Error(this.t('quickNoJob'))
        this.patch({ job: await this.io.stop(this.session(), job.id) })
      }
      await this.prepareQuickCommand()
    } catch (failure) { error = failure instanceof QuickBatchError ? this.t('quickPartial').replace('{completed}', String(failure.completed)).replace('{total}', String(failure.total)) + ' ' + failure.message : message(failure) }
    // Always settle the receipt, including cancellation after an actual mutation.
    if (!this.io.completeQuickEdit) throw new Error(this.t('quickChanged'))
    const applied = this.snapshot().buffers[prepared.path]
    const result = await this.io.completeQuickEdit(this.session(), prepared.requestId, error)
    // Continue assistance from this committed operation, without rebinding a stale or newer attachment.
    const current = this.snapshot()
    if (error === null && result.kind === 'success' && refreshReference && current.selection === reference
      && applied !== undefined && current.buffers[prepared.path]?.revision === applied.revision
      && activePath(current) === prepared.path) {
      this.patch({ selection: applied.kind === 'word' ? wordSelection(applied)
        : scientificSelection(applied, activePane(current) === 'visual' ? 'visual' : 'source') })
    }
    return result
  }

  private publishEditorContext(force = false): void {
    if (this.sessionId === undefined || this.disposed || this.initialRestore || this.snapshot().restoring) return
    const state = this.snapshot()
    const file = activeBuffer(state)
    const old = this.publishedBuffer
    if (!force && activePath(state) === this.publishedPath && (file === old || file !== undefined && old !== undefined
      && file.unavailable === old.unavailable && file.text === old.text && file.revision === old.revision
      && file.wordSync === old.wordSync && file.pendingWord === old.pendingWord
      && file.selection.from === old.selection.from && file.selection.to === old.selection.to)) return
    this.publishedPath = activePath(state)
    this.publishedBuffer = file
    let context: WorkbenchEditorContext | null = null
    if (file !== undefined && file.unavailable !== true && (file.kind !== 'word' || file.pendingWord === undefined && file.wordSync === 'idle')) {
      const captured = file.kind === 'word' ? wordSelection(file) : scientificSelection(file, activePane(state) === 'visual' ? 'visual' : 'source')
      const selected = captured !== null && captured.selectedText.length <= 65536 ? captured : null
      let insertion: WorkbenchSelection | null = null
      const latex = /\.tex$/iu.test(file.path)
      if (file.kind === 'word') insertion = wordSelection(file, true)
      if (latex) {
        try { insertion = scientificInsertion(file, 'figure') }
        catch (_error) { /* A caret in the preamble or unsupported syntax is intentionally not an insertion target. */ }
      }
      context = { ...(file.kind === 'word' ? { word: { id: file.word.id, revision: file.word.revision } } : {}), path: file.path, text: file.text, bufferVersion: String(file.revision),
        selection: { ...file.selection }, selected, insertion,
        graphicsPaths: latex ? parseLatexDocument(file.text, file.path).graphicsPaths : [] }
      if (file.kind === 'word') context = { ...context, selectionKey: this.wordEdits.selectionKey(file.path),
        redoAvailable: file.word.projection.canRedo,
        paragraphs: file.word.projection.blocks.map(({ id, from, to, level, style, table, pagination }) => ({ id, from,
          to, level, style, table, pagination })) }
    }
    const publication = { sessionId: this.sessionId, editorId: this.editorId, generation: ++this.contextGeneration, context }
    // Report background failures while preserving rejection for the submitter.
    // A later explicit publication can restore a disconnected context.
    this.contextFlight = this.contextFlight.catch(() => undefined).then(() => this.io.publishEditor(publication))
    void this.contextFlight.catch((error: unknown) => { this.report(error) })
  }

  /**
   * Follow successful ordinary-chat tool results through the existing Session projection.
   * @param view - durable latest file and preparation events; repeats never apply an edit or reopen a reviewed proposal.
   */
  observeConversation(view: WorkbenchConversationView | undefined): void {
    if (this.disposed || view === undefined) return
    if (view.quick?.requestId === this.quickReceipt?.requestId) this.quickReceipt?.acknowledge()
    if (this.initialRestore || this.snapshot().restoring) { this.pendingProjection = view; return }
    // A log notice is never executable authority. The Host admits one live claim
    // by the same editor generation, and stale/replayed notices return null.
    if (view.agentOperation && view.agentOperation.seq > this.lastAgentOperationSeq && this.io.claimAgentOperation) {
      this.lastAgentOperationSeq = view.agentOperation.seq
      const requestId = view.agentOperation.requestId
      this.conversationFlight = this.conversationFlight.then(async () => {
        if (this.disposed) return
        const prepared = await this.io.claimAgentOperation?.(this.session(), requestId, this.editorId)
        if (prepared?.kind === 'prepared') await this.applyPrepared(prepared, new AbortController().signal)
      }).catch(error => this.report(error))
    }
    if (!this.projectionInitialized) {
      this.projectionInitialized = true
      if (this.restoredScene || this.persistenceBlocked) {
        this.lastOpenSeq = view.open?.seq ?? -1
        this.lastPreparedSeq = view.prepared?.seq ?? -1
        this.lastWordSeq = view.wordUpdated?.seq ?? -1
        return
      }
    }
    const opened = view.open !== null && view.open.seq > this.lastOpenSeq ? view.open : null
    const prepared = view.prepared !== null && view.prepared.seq > this.lastPreparedSeq ? view.prepared : null
    const wordUpdated = view.wordUpdated != null && view.wordUpdated.seq > this.lastWordSeq ? view.wordUpdated : null
    if (opened === null && prepared === null && wordUpdated === null) return
    if (wordUpdated !== null) this.lastWordSeq = wordUpdated.seq
    if (opened !== null) this.lastOpenSeq = opened.seq
    if (prepared !== null) this.lastPreparedSeq = prepared.seq
    this.conversationFlight = this.conversationFlight.then(async () => {
      if (this.disposed) return
      if (wordUpdated !== null) await this.wordEdits.refresh(wordUpdated.path, wordUpdated.documentId, wordUpdated.revision)
      if (opened !== null && (prepared === null || opened.seq < prepared.seq)) {
        await this.open(opened.path, opened.mode)
        await this.checkExternal()
        this.preference({ focus: 'editor' })
      }
      if (prepared !== null) await this.receiveConversationRequest(prepared.request)
      if (opened !== null && prepared !== null && opened.seq > prepared.seq) {
        await this.open(opened.path, opened.mode)
        await this.checkExternal()
        this.preference({ focus: 'editor' })
      }
    }).catch(error => this.report(error))
  }

  /**
   * Apply worker-queued commands before their tool or local-command result returns.
   * @param notice - Authenticated live request for an already open document.
   * @returns Completion of the canonical editor and its durable acknowledgement.
   */
  receiveWordOperation(notice: { path: string; documentId: string; revision: number }): Promise<void> {
    this.conversationFlight = this.conversationFlight.then(async () => {
      if (!this.disposed) await this.wordEdits.refresh(notice.path, notice.documentId, notice.revision)
    }).catch(error => this.report(error))
    return this.conversationFlight
  }

  private async receiveConversationRequest(request: WorkbenchSelectionRequest): Promise<void> {
    if (request.sessionId !== this.sessionId) throw new Error(this.t('recoveryWorkspaceChanged'))
    const action = await this.io.getAction(this.session(), request.requestId)
    if (this.disposed || action.reviewed !== undefined) return
    const existing = this.snapshot().action
    if (existing !== null && existing.actionId !== request.requestId
      && (existing.state === 'queued' || existing.state === 'generating' || existing.proposal !== undefined)) {
      throw new Error(this.t('actionBusy'))
    }
    const path = await this.open(request.path)
    if (path === undefined || this.disposed) return
    const file = this.snapshot().buffers[path]
    if (file === undefined) return
    const generation = ++this.selectionGeneration
    for (const asset of request.attachmentAssets ?? []) {
      const value = await this.io.attachment(this.session(), request.requestId, asset.path)
      if (this.disposed || generation !== this.selectionGeneration) return
      const staged = await this.actions.importAsset(value.name, new Blob([new Uint8Array(value.data)], { type: value.mimeType }))
      if (staged.path !== asset.path || staged.id !== asset.sha256 || value.sha256 !== asset.sha256) {
        throw new Error(this.t('invalidScientificProposal'))
      }
    }
    if (this.disposed || generation !== this.selectionGeneration) return
    const current = this.snapshot().buffers[path]
    if (current === undefined) return
    const visual = /\.(tex|docx)$/iu.test(path)
    this.patch({ ...this.activation(current, visual ? 'visual' : 'source'), focus: 'editor',
      selection: { ...request, origin: visual ? 'visual' : 'source',
        lineFrom: file.text.slice(0, request.from).split('\n').length,
        lineTo: file.text.slice(0, request.to).split('\n').length },
      selectionMode: 'edit', instruction: request.instruction, action,
      error: matchesProposalBase(current, request) ? null : this.t('staleProposal') })
    this.pollAction(action, generation)
  }

  /** Whether a real close could discard text that has not reached disk. */
  get hasUnsaved(): boolean {
    return this.saves.size > 0 || Object.values(this.snapshot().buffers).some(file => file.saveState === 'conflict' || (file.kind === 'word'
      ? file.revision !== file.word.savedRevision || file.pendingWord !== undefined
      : file.text !== file.savedText))
  }

  /** In-memory suggestions and active selection requests need an explicit close decision. */
  get hasPendingAction(): boolean {
    const action = this.snapshot().action
    return action?.state === 'queued' || action?.state === 'generating' || action?.proposal !== undefined
  }

  /** Reattach to a still-running Host job after this client view is recreated. */
  async restoreJob(): Promise<void> {
    if (this.disposed || this.sessionId === undefined || this.restoringJob || this.snapshot().job?.state === 'running') return
    this.restoringJob = true
    try {
      const job = await this.io.current(this.sessionId)
      if (this.disposed || this.snapshot().job?.state === 'running' || job?.state !== 'running') return
      this.jobSourceRevision = this.sourceRevision
      this.patch({ job, outputOpen: job.kind !== 'latex', ...(job.kind === 'latex' && this.snapshot().mainFile.trim() === '' ? { mainFile: job.path } : {}) })
      this.pollJob(job.id)
    } catch (error) { this.report(error) }
    finally { this.restoringJob = false }
  }

  /** A single callback identity is shared by the work view and composer entries. */
  readonly actions: WorkbenchActions = {
    learning: async (action) => {
      if (!this.io.quickLearning) throw new Error(this.t('quickUnavailable'))
      return this.io.quickLearning(this.session(), action)
    },
    setMode: (mode) => { this.interactionRevision++; this.preference({ mode }); if (mode !== 'chat' && this.snapshot().entries.length === 0 && this.sessionId !== undefined) void this.actions.list('.') },
    setFocus: (focus) => { this.interactionRevision++; this.patch({ focus }) },
    setChatWidth: chatWidth => this.preference({ chatWidth: Math.max(420, Math.min(720, chatWidth)) }),
    setProposalHeight: proposalHeight => this.patch({ proposalHeight: Math.max(18, Math.min(65, proposalHeight)) }),
    wordNavigate: (path, from, to) => { try { this.wordEdits.navigate(path, from, to) } catch (error) { this.report(error) } },
    wordMount: (path, element) => this.wordEdits.mount(path, element),
    wordEdit: (path, text, document, selection, scrollTop, view, composing) =>
      this.wordEdits.edit(path, text, document, selection, scrollTop, view, composing),
    wordMutate: async (path, operation) => {
      try {
        if (operation.kind === 'image') {
          const scope = this.assetScope(), assetPath = operation.path
          const staged = scope === null ? undefined : (await this.assetStaging.list(scope)).find(asset => asset.path === assetPath)
          if (staged !== undefined) operation = await this.wordEdits.image(operation, (await stagedAssetPayload(staged)).data, staged.id)
        }
        await this.wordEdits.mutate(path, operation)
      } catch (error) { this.report(error) }
    },
    wordResume: async (path) => { try { await this.wordEdits.resume(path) } catch (error) { this.report(error) } },
    setFontSize: fontSize => this.preference({ [this.snapshot().mode === 'development' ? 'codeFontSize' : 'fontSize']: Math.max(12, Math.min(28, fontSize)) }),
    setWrap: wrap => this.preference({ wrap }),
    setMainFile: (mainFile) => { this.pdfGeneration++; this.patch({ mainFile, pdf: null, pdfSourcePath: null, pdfTarget: null }) },
    setBrowserOpen: (browserOpen) => {
      this.patch({ browserOpen })
      if (browserOpen && this.sessionId !== undefined) void this.actions.list(this.snapshot().browserPath)
    },
    list: async (path) => {
      const generation = ++this.listGeneration
      this.patch({ filesLoading: true })
      try {
        const files = await this.io.list(this.session(), path)
        if (generation !== this.listGeneration) return
        await this.bindWorkspace(files.workspaceRoot)
        this.patch({ browserPath: files.path || '.', entries: files.entries, filesLoading: false })
      } catch (error) { if (generation === this.listGeneration) { this.patch({ filesLoading: false }); this.report(error) } }
    },
    open: async (path) => { this.interactionRevision++; await this.open(path) },
    create: async (path) => {
      this.interactionRevision++
      if (/\.docx$/iu.test(path)) { await this.openWord(path, true); return }
      try {
        const file = await this.io.save(this.session(), { path, text: '', version: null })
        await this.bindFile(file)
        const buffer = newBuffer(file, fileMode(file.path, this.snapshot().mode))
        this.patch({ buffers: { ...this.snapshot().buffers, [file.path]: buffer },
          ...this.activation(buffer), browserOpen: false, error: null })
        await this.actions.list(this.snapshot().browserPath)
      } catch (error) { this.report(error) }
    },
    close: async (path, decision) => {
      if (this.snapshot().closeBusy) return
      if (decision === 'cancel') {
        this.patch({ closePrompt: null })
        const file = this.snapshot().buffers[path]
        if (file && (file.kind === 'word' ? this.canAutoSaveWord(file)
          : file.text !== file.savedText && file.saveState !== 'conflict')) this.scheduleSave(path)
        return
      }
      this.interactionRevision++
      this.openGeneration++
      let file = this.snapshot().buffers[path]
      if (file === undefined) return
      const dirty = (value: EditorBuffer) => value.kind === 'word'
        ? value.revision !== value.word.savedRevision || value.pendingWord !== undefined
        : value.text !== value.savedText
      if (decision === undefined && file.kind === 'word' && this.canAutoSaveWord(file)) {
        this.patch({ closeBusy: true })
        try { await this.save(path) } catch (error) { this.report(error) }
        finally { this.patch({ closeBusy: false }) }
        file = this.snapshot().buffers[path]
        if (file === undefined) return
      }
      if (this.saves.has(path)) { this.report(new Error(this.t('closeSaving'))); return }
      if (decision === undefined && (dirty(file) || file.saveState === 'conflict' || file.saveState === 'error')) {
        const timer = this.timers.get(path)
        if (timer !== undefined) clearTimeout(timer)
        this.timers.delete(path)
        this.patch({ closePrompt: path })
        return
      }
      if (this.saves.has(path)) { this.report(new Error(this.t('closeSaving'))); return }
      if (this.snapshot().selection?.path === path) {
        const action = this.snapshot().action
        if (action?.state === 'queued' || action?.state === 'generating') { this.report(new Error(this.t('actionBusy'))); return }
        if (action?.proposal !== undefined) { this.report(new Error(this.t('closePendingProposal'))); return }
      }
      this.patch({ closeBusy: true, error: null })
      try {
        if (decision === 'save') {
          await this.save(path)
          file = this.snapshot().buffers[path]
          if (file === undefined) return
          if (dirty(file) || file.saveState === 'error' || file.saveState === 'conflict') return
        }
        if (this.persistenceBlocked) throw new Error(this.t('stateSaveFailed'))
        const timer = this.timers.get(path)
        if (timer !== undefined) clearTimeout(timer)
        this.timers.delete(path)
        if (file.kind === 'word') await this.wordEdits.settleClose(path)
        file = this.snapshot().buffers[path]
        if (file === undefined) return
        const previous = this.snapshot()
        const buffers = Object.fromEntries(Object.entries(previous.buffers).filter(([key]) => key !== path))
        const closingMode = file.mode
        const next = Object.values(buffers).filter(buffer => buffer.mode === closingMode).at(-1)
        const closingCurrent = previous.activePaths[file.mode] === path
        this.patch({
          buffers,
          ...(closingCurrent ? { panes: { ...previous.panes,
            [file.mode]: next?.pane ?? (next !== undefined && /\.(tex|docx)$/iu.test(next.path) ? 'visual' : 'source') } } : {}),
          activePaths: { ...previous.activePaths, [file.mode]: closingCurrent ? next?.path ?? null : previous.activePaths[file.mode] },
          ...(previous.selection?.path === path ? { selection: null, action: null, instruction: '' } : {}),
        })
        try {
          // Commit removal before acknowledging close, so discarded drafts cannot resurrect.
          this.checkpoint()
          await this.persistence?.flush()
        } catch (error) {
          this.patch({ buffers: { ...this.snapshot().buffers, [path]: file }, activePaths: previous.activePaths,
            panes: previous.panes, selection: previous.selection, action: previous.action, instruction: previous.instruction })
          this.checkpoint()
          throw error
        }
        if (file.kind === 'word') {
          if (this.io.word === undefined) throw new Error(this.t('wordUnavailable'))
          try { await this.io.word.close(this.session(), file.word.id, decision === 'discard') }
          catch (error) {
            this.patch({ buffers: { ...this.snapshot().buffers, [path]: { ...file, unavailable: true } },
              activePaths: previous.activePaths, panes: previous.panes,
              selection: previous.selection, action: previous.action, instruction: previous.instruction })
            this.checkpoint()
            await this.persistence?.flush()
            throw error
          }
        }
        if (previous.selection?.path === path) this.selectionGeneration++
        this.patch({ closePrompt: null })
      } catch (error) { this.report(error) }
      finally { this.wordEdits.releaseClose(path); this.patch({ closeBusy: false }) }
    },
    edit: (path, text, selection, editorState, scrollTop, surface = 'source') => {
      const old = this.snapshot().buffers[path]
      if (old === undefined) return
      if (old.unavailable === true || old.kind === 'word') return
      const changed = old.text !== text
      if (changed) this.interactionRevision++
      this.buffer(path, { text, selection, ...(surface === 'visual' ? { visualState: editorState, visualScrollTop: scrollTop } : { editorState, scrollTop }),
        revision: old.revision + (changed ? 1 : 0),
        saveState: changed ? old.saveState === 'conflict' ? 'conflict' : this.saves.has(path) ? 'saving' : text === old.savedText ? 'clean' : 'dirty' : old.saveState,
      })
      if (changed) this.sourceChanged(path)
      if (changed && old.saveState !== 'conflict') this.scheduleSave(path)
    },
    save: path => this.save(path ?? activePath(this.snapshot()) ?? ''),
    saveAs: async (path) => {
      const current = this.snapshot()
      const file = activeBuffer(current)
      if (file === undefined) return
      if (file.kind === 'word') {
        try {
          const saved = await this.wordEdits.save(file.path, path)
          const current = this.snapshot()
          const next = current.buffers[saved.path]
          const buffers = Object.fromEntries(Object.entries(current.buffers).filter(([key]) => key !== file.path))
          // The DOCX owner has already renamed the buffer and retained any typing during the save.
          if (next?.kind !== 'word') throw new Error(this.t('wordUnavailable'))
          const buffer = next
          this.patch({ buffers: { ...buffers, [saved.path]: buffer }, ...this.activation(buffer),
            selection: null, action: null, error: null })
        } catch (error) { this.report(error) }
        return
      }
      try {
        const pendingAssets = await this.stagedForSave(path, file.text)
        const saved = await this.io.save(this.session(), { path, text: diskText(file), version: null,
          ...(pendingAssets.payloads.length === 0 ? {} : { assets: pendingAssets.payloads }) })
        await this.finishAssetSave(pendingAssets).catch(error => this.report(error))
        const buffer = newBuffer(saved, fileMode(saved.path, file.mode))
        this.patch({ buffers: { ...this.snapshot().buffers, [saved.path]: buffer }, ...this.activation(buffer), error: null })
      } catch (error) { this.report(error) }
    },
    checkExternal: () => this.checkExternal(),
    reloadExternal: () => {
      const path = activePath(this.snapshot())
      const file = path === null ? undefined : this.snapshot().buffers[path]
      if (file?.external === undefined) return
      const replacement = { ...newBuffer(file.external, file.mode), revision: file.revision + 1 }
      this.sourceChanged(file.path)
      this.patch({ buffers: { ...this.snapshot().buffers, [replacement.path]: replacement }, error: null })
    },
    select: (mode) => {
      const current = this.snapshot()
      const file = activeBuffer(current)
      if (file === undefined) return
      const selection = file.kind === 'word' ? wordSelection(file) : scientificSelection(file, activePane(current) === 'visual' ? 'visual' : 'source')
      if (selection === null) { this.report(new Error(this.t('selectFirst'))); return }
      if (current.action?.state === 'queued' || current.action?.state === 'generating') {
        this.report(new Error(this.t('actionBusy'))); return
      }
      this.reviewRemaining()
      this.selectionGeneration++
      this.patch({ selectionMode: mode, instruction: '', action: null, error: null, selection })
    },
    prepareInsertion: (kind, assetPath, target) => {
      const current = this.snapshot()
      const file = activeBuffer(current)
      if (file === undefined || !/\.(tex|docx)$/iu.test(file.path)) return
      if (current.action?.state === 'queued' || current.action?.state === 'generating') {
        this.report(new Error(this.t('actionBusy'))); return
      }
      try {
        if (target !== undefined && (target.path !== file.path || target.workspaceRoot !== current.workspaceRoot
          || target.revision !== file.revision || !Number.isInteger(target.selection.from)
          || !Number.isInteger(target.selection.to) || target.selection.from < 0
          || target.selection.to < target.selection.from || target.selection.to > file.text.length)) {
          throw new Error(this.t('insertionTargetChanged'))
        }
        const captured = target === undefined ? file : { ...file, selection: target.selection }
        const selection = captured.kind === 'word' ? wordSelection(captured, true) : scientificInsertion(captured, kind, assetPath)
        if (selection === null) throw new Error(this.t('wordWait'))
        if (captured.kind === 'word' && assetPath !== undefined) selection.assetPaths = [assetPath]
        selection.insertionKind = kind
        this.reviewRemaining()
        this.selectionGeneration++
        this.patch({ selectionMode: 'edit', selection, action: null, error: null,
          instruction: this.t(kind === 'figure' ? 'figureInstruction' : 'tableInstruction') })
      } catch (error) { this.report(new Error(operationMessage(error, this.t))) }
    },
    queryReferences: async (kind, sourcePath) => {
      const root = this.snapshot().workspaceRoot
      const mainFile = this.snapshot().mainFile
      const result = await projectReferences(sourcePath, mainFile, kind, async (path) => {
        const file = this.snapshot().buffers[path]
        return file === undefined ? this.io.read(this.session(), path) : { path: file.path, text: file.text }
      })
      if (root !== this.snapshot().workspaceRoot || this.disposed) throw new Error(this.t('recoveryWorkspaceChanged'))
      return result
    },
    selectPdf: (text, page) => {
      const current = this.snapshot()
      if (current.pdf === null || text.trim() === '') return
      if (current.action?.state === 'queued' || current.action?.state === 'generating') { this.report(new Error(this.t('actionBusy'))); return }
      const file = current.buffers[current.pdf.sourcePath]
      if (file?.kind === 'word') {
        if (current.pdf.sourcePath !== current.activePaths.writing || current.pdf.stale || current.pdfDirty
          || current.pdf.sourceVersion !== String(file.revision) || file.pendingWord !== undefined) {
          this.report(new Error(this.t('wordPageStale'))); return
        }
        const selection = wordPageSelection(file, text)
        if (selection !== null) {
          this.reviewRemaining(); this.selectionGeneration++
          this.buffer(file.path, { selection: { from: selection.from, to: selection.to } })
          this.patch({ selectionMode: 'assist', instruction: '', action: null, error: null, selection })
          return
        }
      }
      this.reviewRemaining()
      this.selectionGeneration++
      this.patch({ selectionMode: 'ask', instruction: '', action: null,
        selection: { path: current.pdf.path, from: 0, to: text.length, selectedText: text, contextBefore: '', contextAfter: '',
          bufferVersion: current.pdf.version, lineFrom: page, lineTo: page, origin: 'pdf', page },
      })
    },
    clearSelection: () => {
      if (this.snapshot().action?.state === 'queued' || this.snapshot().action?.state === 'generating') return
      this.reviewRemaining()
      this.selectionGeneration++
      this.patch({ selection: null, action: null, instruction: '' })
    },
    setInstruction: instruction => this.patch({ instruction }),
    ask: () => this.ask(),
    cancel: async () => {
      if (this.quickAbort) { this.quickAbort.abort(); this.patch({ action: { actionId: '', state: 'cancelled' } }); return }
      const action = this.snapshot().action
      if (action === null) return
      if (this.actionTimer !== undefined) clearTimeout(this.actionTimer)
      const generation = ++this.selectionGeneration
      try {
        const next = await this.io.cancelAction(this.session(), action.actionId)
        if (generation !== this.selectionGeneration) return
        this.patch({ action: next })
        this.pollAction(next, generation)
      } catch (error) {
        if (generation !== this.selectionGeneration) return
        this.patch({ action: { ...action, pollError: message(error) } })
        this.pollAction(action, generation, 1)
      }
    },
    accept: index => this.accept(index),
    discard: () => { this.reviewRemaining(); this.patch({ action: null, selection: null, instruction: '' }) },
    refine: () => { this.reviewRemaining(); this.patch({ action: null }) },
    locateSelection: () => {
      const selection = this.snapshot().selection
      if (selection?.origin === 'pdf') { this.patch({ mode: 'writing', ...this.pane('pdf', 'writing'), focus: 'editor' }); return }
      const file = selection === null ? undefined : this.snapshot().buffers[selection.path]
      if (selection !== null && file !== undefined) this.patch({ ...this.activation(file, selection.origin === 'visual' ? 'visual' : 'source'), focus: 'editor', sourceTarget: { path: selection.path, from: selection.from, to: selection.to, token: ++this.locateToken } })
    },
    setPane: (pane) => {
      this.interactionRevision++
      const file = activeBuffer(this.snapshot())
      if (file?.kind === 'word' && pane !== 'pdf' && file.word.projection.readOnly) return
      this.patch(this.pane(pane))
      if (pane === 'pdf' && file?.kind !== 'word') void this.actions.refreshPdf()
    },
    setOutputOpen: outputOpen => this.patch({ outputOpen }),
    run: request => this.run(request),
    stop: async () => {
      const path = this.snapshot().wordProofBusy
      const file = path == null ? undefined : this.snapshot().buffers[path]
      if (file?.kind === 'word') {
        try {
          if (this.io.word === undefined) throw new Error(this.t('wordUnavailable'))
          await this.io.word.stop(this.session(), file.word.id)
        } catch (error) { this.report(error) }
        return
      }
      const job = this.snapshot().job
      if (job === null || job.state !== 'running') return
      try { this.patch({ job: await this.io.stop(this.session(), job.id) }) }
      catch (error) { if (!this.retireUnavailableJob(job.id, error)) this.report(error) }
    },
    refreshPdf: async (reuseWordPage = false) => {
      const active = activeBuffer(this.snapshot())
      if (active?.kind === 'word') { await this.wordProof(active.path, false, reuseWordPage); return }
      const path = this.pdfSource()
      if (path === null) return
      const generation = ++this.pdfGeneration
      if (this.snapshot().pdfSourcePath !== path) this.patch({ pdf: null, pdfSourcePath: null, pdfTarget: null })
      try {
        const pdf = await this.io.pdf(this.session(), path)
        if (generation === this.pdfGeneration && this.pdfSource() === path) this.patch({ pdf, pdfSourcePath: pdf === null ? null : path })
      }
      catch (error) { this.report(error) }
    },
    locatePdf: async () => {
      if (activeBuffer(this.snapshot())?.kind === 'word') { this.patch(this.pane('pdf')); await this.actions.refreshPdf(); return }
      const current = this.snapshot()
      const sourceRevision = this.sourceRevision
      if (current.pdfDirty || current.pdf?.stale || this.hasUnsaved) { this.report(new Error(this.t('pdfNeedsCompile'))); return }
      const file = activeBuffer(current)
      if (file === undefined) return
      const prefix = file.text.slice(0, file.selection.from)
      const line = prefix.split('\n').length
      const column = prefix.length - prefix.lastIndexOf('\n')
      try {
        const target = await this.io.synctexForward(this.session(), file.path, line, column, current.mainFile.trim() || undefined)
        await this.actions.refreshPdf()
        if (sourceRevision !== this.sourceRevision || current.workspaceRoot !== this.snapshot().workspaceRoot || this.snapshot().pdf?.stale || this.hasUnsaved) { this.report(new Error(this.t('pdfNeedsCompile'))); return }
        this.patch({ ...this.pane('pdf', 'writing'), pdfTarget: { ...target, token: ++this.locateToken } })
      } catch (error) { this.report(error) }
    },
    locateSource: async (page, x, y) => {
      if (activeBuffer(this.snapshot())?.kind === 'word') { this.actions.setPane('visual'); return }
      const sourceRevision = this.sourceRevision
      const workspaceRoot = this.snapshot().workspaceRoot
      if (this.snapshot().pdfDirty || this.snapshot().pdf?.stale || this.hasUnsaved) { this.report(new Error(this.t('pdfNeedsCompile'))); return }
      const pdfPath = this.snapshot().pdfSourcePath ?? this.pdfSource()
      if (pdfPath === null) return
      try {
        const target = await this.io.synctexReverse(this.session(), pdfPath, page, x, y)
        if (sourceRevision !== this.sourceRevision || workspaceRoot !== this.snapshot().workspaceRoot || this.snapshot().pdf?.stale || this.hasUnsaved) { this.report(new Error(this.t('pdfNeedsCompile'))); return }
        const sourcePath = await this.open(target.path)
        const file = sourcePath === undefined ? undefined : this.snapshot().buffers[sourcePath]
        if (file === undefined) return
        const inputVersion = this.snapshot().pdf?.inputs.find(input => input.path === file.path)?.version
        if (sourceRevision !== this.sourceRevision || this.hasUnsaved || (inputVersion !== undefined && file.diskVersion !== inputVersion)) { this.report(new Error(this.t('pdfNeedsCompile'))); return }
        const from = positionAt(file.text, target.line, target.column)
        this.patch({ ...this.activation(file, /\.tex$/iu.test(file.path) ? 'visual' : 'source'), sourceTarget: { path: file.path, from, to: from, token: ++this.locateToken } })
      } catch (error) { this.report(error) }
    },
    locateDiagnostic: diagnostic => this.locateDiagnostic(diagnostic),
    environments: () => this.io.environments(this.session()),
    resolveAsset: async (path, sourcePath, graphicsPaths) => {
      const scope = this.assetScope()
      if (scope !== null && globalThis.indexedDB !== undefined) {
        const graphics = graphicsPaths.map(directory => '{' + directory + '}').join('')
        const fragment = '\\graphicspath{' + graphics + '}\\includegraphics{' + path + '}'
        const staged = (await this.assetStaging.matching(scope, fragment, sourcePath))[0]
        if (staged !== undefined) {
          const preview = this.assetInfo(staged)
          if (preview.url === '') throw new Error(this.t('assetPreviewRequired'))
          return { url: preview.url, mimeType: preview.mimeType }
        }
      }
      const asset = await this.io.asset(this.session(), path, sourcePath, graphicsPaths)
      if (this.disposed) throw new Error('Workbench is closed')
      const key = asset.path + ':' + asset.version
      let url = this.assetUrls.get(key)
      if (url === undefined) {
        url = URL.createObjectURL(new Blob([new Uint8Array(asset.data)], { type: asset.mimeType }))
        this.assetUrls.set(key, url)
      }
      return { url, mimeType: asset.mimeType }
    },
    importAsset: async (name, blob) => {
      const scope = this.assetScope()
      if (scope === null) throw new Error(this.t('needWorkspace'))
      if (!/\.(png|jpe?g|pdf)$/iu.test(name)) throw new Error(this.t('assetPreviewRequired'))
      const asset = await this.assetStaging.stage(scope, { name, blob })
      if (this.disposed || this.assetScope()?.workspaceRoot !== scope.workspaceRoot) throw new Error(this.t('recoveryWorkspaceChanged'))
      await this.refreshAssets()
      return this.assetInfo(asset)
    },
    discardStagedAsset: async (id) => {
      try {
        const scope = this.assetScope()
        if (scope === null) return
        const asset = await this.assetStaging.read(scope, id)
        if (asset === undefined) return
        if (this.assetReferenced(asset.path)) throw new Error(this.t('assetStillReferenced'))
        await this.assetStaging.discard(scope, id)
        const key = 'staged:' + asset.id
        const url = this.assetUrls.get(key)
        if (url !== undefined) { URL.revokeObjectURL(url); this.assetUrls.delete(key) }
        await this.refreshAssets()
      } catch (error) { this.report(error) }
    },
    refreshAssets: () => this.refreshAssets(),
    inspectAssetRecovery: async () => {
      const root = this.snapshot().workspaceRoot
      try {
        const assetRecovery = await this.io.assetRecovery(this.session())
        if (root === this.snapshot().workspaceRoot) this.patch({ assetRecovery })
      } catch (error) { this.report(error) }
    },
    clearError: () => this.patch({ error: null }),
    retryRecovery: async () => {
      const root = this.snapshot().workspaceRoot
      if (root !== null && this.persistenceBlocked) {
        this.persistenceBlocked = false
        this.patch({ restoring: true })
        const generation = ++this.restoreGeneration
        this.hydration = this.restoreScene(root, generation).finally(() => {
          if (generation === this.restoreGeneration) this.patch({ restoring: false })
        })
        await this.hydration
      }
      const unavailable = Object.values(this.snapshot().buffers).filter(file => file.unavailable)
      for (const file of unavailable) await this.retryFile(file)
      this.checkpoint()
      try { await this.persistence?.flush(); this.persistenceStatus(null) }
      catch (error) { this.persistenceStatus(error) }
    },
    setPdfPosition: (position) => {
      const path = this.snapshot().pdfSourcePath
      if (path !== null) this.patch({ pdfPositions: { ...this.snapshot().pdfPositions, [path]: position } })
    },
  }

  private assetScope(): AssetStagingScope | null {
    const root = this.snapshot().workspaceRoot
    return this.sessionId === undefined || root === null ? null : { sessionId: this.sessionId, workspaceRoot: root }
  }

  private assetInfo(asset: StagedAsset): StagedAssetInfo {
    const key = 'staged:' + asset.id
    let url = this.assetUrls.get(key)
    if (url === undefined) {
      const preview = createStagedAssetPreview(asset)
      url = preview.url ?? ''
      if (url) this.assetUrls.set(key, url)
    }
    return { id: asset.id, name: asset.name, path: asset.path, size: asset.size, mimeType: asset.mime, url }
  }

  private async refreshAssets(): Promise<void> {
    const scope = this.assetScope()
    if (scope === null || globalThis.indexedDB === undefined) return
    const assets = await this.assetStaging.list(scope)
    if (this.disposed || this.assetScope()?.workspaceRoot !== scope.workspaceRoot) return
    this.patch({ stagedAssets: assets.map(asset => this.assetInfo(asset)) })
  }

  private async stagedForSave(path: string, text: string) {
    const scope = this.assetScope()
    if (scope === null || globalThis.indexedDB === undefined || !/\.tex$/iu.test(path)) return { scope, assets: [], payloads: [] }
    const assets = await this.assetStaging.matching(scope, text, path)
    return { scope, assets, payloads: await Promise.all(assets.map(stagedAssetPayload)) }
  }

  private async finishAssetSave(pending: Awaited<ReturnType<WorkbenchController['stagedForSave']>>): Promise<void> {
    if (pending.scope === null || pending.assets.length === 0) return
    // Committed project assets survive undo. Only the redundant staging bytes are released.
    for (const asset of pending.assets) await this.assetStaging.discard(pending.scope, asset.id)
    await this.refreshAssets()
  }


  private async openWord(path: string, create: boolean): Promise<string | undefined> {
    try {
      if (this.io.word === undefined) throw new Error(this.t('wordUnavailable'))
      if (!create) {
        const metadata = await this.io.stat(this.session(), path)
        const existing = Object.values(this.snapshot().buffers).find(file => file.kind === 'word' && file.absolutePath.toLowerCase() === metadata.absolutePath.toLowerCase())
        if (existing !== undefined) { this.patch({ ...this.activation(existing), browserOpen: false }); return existing.path }
      }
      const snapshot = await this.io.word.open(this.session(), path, create, null)
      await this.bindWorkspace(snapshot.workspaceRoot)
      const buffer = wordBuffer(snapshot)
      this.patch({ buffers: { ...this.snapshot().buffers, [snapshot.path]: buffer },
        ...this.activation(buffer), browserOpen: false, error: null })
      if (this.canAutoSaveWord(buffer)) this.scheduleSave(snapshot.path)
      return snapshot.path
    } catch (error) { this.report(error); return undefined }
  }

  private async wordProof(path: string, cached: boolean, reuse = false): Promise<void> {
    const initial = this.snapshot().buffers[path]
    const api = this.io.word
    if (initial?.kind !== 'word' || api === undefined || initial.unavailable || initial.word.engine === 'ooxml') return
    const shown = this.snapshot().pdf
    if (reuse && shown?.sourcePath === path && shown.sourceVersion === String(initial.revision)
      && initial.pendingWord === undefined && !shown.stale) return
    const existing = this.wordProofFlights.get(path)
    if (existing !== undefined) {
      await existing
      const current = this.snapshot().buffers[path]
      if (reuse && current?.kind === 'word' && current.wordSync === 'idle'
        && this.snapshot().activePaths.writing === path
        && (this.snapshot().pdf?.sourcePath !== path || this.snapshot().pdf?.sourceVersion !== String(current.revision))) {
        await this.wordProof(path, false, true)
      }
      return
    }
    const generation = ++this.pdfGeneration
    if (this.snapshot().pdfSourcePath !== path) this.patch({ pdf: null, pdfSourcePath: path, pdfTarget: null })
    if (!cached) this.patch({ wordProofBusy: path })
    const operation = (async () => {
      let generated = false
      try {
        if (!cached) await this.wordEdits.ready([path])
        const file = this.snapshot().buffers[path]
        if (file?.kind !== 'word') return
        let proof = cached || reuse
          ? await api.proof(this.session(), file.word.id, file.word.revision, true, file.wordProof ?? null) : null
        const currentPage = proof?.revision === file.revision
        if (!cached && (!reuse || !currentPage) && file.wordSync !== 'failed' && file.pendingWord === undefined) {
          generated = true
          proof = await api.proof(this.session(), file.word.id, file.word.revision, false, null)
        }
        const current = this.snapshot().buffers[path]
        if (current?.kind !== 'word' || current.word.id !== file.word.id) return
        if (proof !== null) this.buffer(path, { wordProof: { revision: proof.revision, version: proof.version } })
        if (generation !== this.pdfGeneration || this.snapshot().activePaths.writing !== path) return
        this.patch({ pdf: proof === null ? null : { data: proof.data, path: path + '.pdf', sourcePath: path,
          version: proof.version, sourceVersion: String(proof.revision), builtAt: proof.builtAt, inputs: [], wordRegions: proof.regions,
          stale: proof.revision !== current.revision },
        pdfSourcePath: path, pdfDirty: proof !== null && (proof.revision !== current.revision || current.pendingWord !== undefined) })
      } catch (error) {
        // A cancelled native export can recycle the owned worker; confirmed drafts remain recoverable.
        if (generated) this.patch({ buffers: Object.fromEntries(Object.entries(this.snapshot().buffers).map(([key, value]) =>
          [key, value.kind === 'word' ? { ...value, wordSync: 'failed', error: this.t('wordPendingRecovery') } : value])) })
        this.report(error)
      } finally {
        if (this.snapshot().wordProofBusy === path) this.patch({ wordProofBusy: null })
      }
    })()
    this.wordProofFlights.set(path, operation)
    try { await operation } finally { this.wordProofFlights.delete(path) }
  }

  private async acceptWord(path: string, action: AssistantAction, index?: number): Promise<void> {
    const file = this.snapshot().buffers[path], proposal = action.proposal
    if (file?.kind !== 'word' || proposal === undefined || file.pendingWord !== undefined || file.wordSync !== 'idle'
      || !matchesProposalBase(file, proposal.base)) throw new Error(this.t('staleProposal'))
    const part = index === undefined ? undefined : presentableDiff(proposal.base.selectedText, proposal.replacement)[index]
    if (index !== undefined && (part === undefined || proposal.structured !== undefined)) throw new Error(this.t('atomicProposalRequired'))
    const from = proposal.base.from + (part?.fromA ?? 0), to = proposal.base.from + (part?.toA ?? proposal.base.selectedText.length)
    const insert = part === undefined ? proposal.replacement : proposal.replacement.slice(part.fromB, part.toB)
    const before = file.text.slice(from, to)
    let operation: WordOperation = { kind: 'replace', from, to, before, text: insert }
    if (proposal.structured?.kind === 'table') operation = { kind: 'table', from, to, before,
      rows: [Array.from(proposal.structured.headers), ...proposal.structured.rows.map(row => Array.from(row))],
      ...(proposal.structured.caption === undefined ? {} : { caption: proposal.structured.caption }) }
    if (proposal.structured?.kind === 'figure') {
      const image = proposal.structured
      operation = { kind: 'image', from, to, before, path: image.assetPath, caption: image.caption }
      const scope = this.assetScope()
      const staged = scope === null ? undefined : (await this.assetStaging.list(scope)).find(asset => asset.path === image.assetPath)
      if (staged !== undefined) {
        const payload = await stagedAssetPayload(staged)
        operation = await this.wordEdits.image(operation, payload.data, staged.id)
      }
    }
    await this.wordEdits.mutate(path, operation)
    const next = this.snapshot().buffers[path]
    if (next?.kind !== 'word') return
    this.patch({ ...this.activation(next, 'visual'), focus: 'editor' })
    if (part === undefined) {
      await this.io.review(this.session(), action.actionId, 'accepted', proposal.replacement, action.reviewBaseVersion ?? proposal.base.bufferVersion)
      this.patch({ action: null, selection: null, instruction: '' })
    } else {
      const selectedText = proposal.base.selectedText.slice(0, part.fromA) + insert + proposal.base.selectedText.slice(part.toA)
      const base = { ...proposal.base, selectedText, to: proposal.base.from + selectedText.length, bufferVersion: String(next.revision) }
      const selection = this.snapshot().selection
      this.patch({ action: { ...action, proposal: { ...proposal, base }, acceptedParts: (action.acceptedParts ?? 0) + 1,
        reviewBaseVersion: action.reviewBaseVersion ?? proposal.base.bufferVersion },
      selection: selection === null ? null : { ...selection, ...base } })
    }
  }

  private async open(path: string, requested = this.snapshot().mode): Promise<string | undefined> {
    const generation = ++this.openGeneration
    const opened = this.snapshot().buffers[path]
    if (opened !== undefined) {
      this.patch({ ...this.activation(opened), browserOpen: false })
      if (opened.unavailable === true) await this.retryFile(opened)
      if (activePane(this.snapshot()) === 'pdf') void this.actions.refreshPdf(opened.kind === 'word')
      return path
    }
    try {
      if (/\.docx$/iu.test(path)) return this.openWord(path, false)
      if (/\.(pdf|png|jpe?g|gif|webp|svg|doc|docm|xlsx?|pptx?|odt|ods)$/iu.test(path)) {
        const metadata = await this.io.stat(this.session(), path)
        if (generation !== this.openGeneration) return
        this.io.preview(this.session(), metadata.path)
        this.patch({ browserOpen: false, error: null })
        return
      }
      if (/\.(zip|7z|rar|exe|dll|bin|iso|tar|gz)$/iu.test(path)) { await this.io.stat(this.session(), path); throw new Error(this.t('unsupportedFile')) }
      const file = await this.io.read(this.session(), path)
      if (generation !== this.openGeneration) return
      await this.bindFile(file)
      if (generation !== this.openGeneration || this.disposed) return
      const existing = this.snapshot().buffers[file.path]
      const buffer = existing ?? newBuffer(file, fileMode(file.path, requested))
      this.patch({ buffers: { ...this.snapshot().buffers, [file.path]: buffer },
        ...this.activation(buffer), browserOpen: false, mainFile: this.snapshot().mainFile || (/\\documentclass(?:\[[^\]]*\])?\s*\{/u.test(file.text) ? file.path : ''), error: null })
      if (existing !== undefined && existing.diskVersion !== file.version) await this.checkExternal()
      return file.path
    } catch (error) { this.report(error) }
  }

  private async save(path: string): Promise<void> {
    const pending = this.saves.get(path)
    if (pending !== undefined) { await pending; return this.save(path) }
    const file = this.snapshot().buffers[path]
    if (file === undefined) return
    if (file.unavailable === true) throw new Error(this.t('stateFileUnavailable'))
    if (file.kind === 'word') {
      const timer = this.timers.get(path)
      if (timer !== undefined) { clearTimeout(timer); this.timers.delete(path) }
      await this.wordEdits.save(path)
      return
    }
    if (file.saveState === 'conflict') throw new Error(this.t('conflict'))
    if (file.text === file.savedText) return
    const timer = this.timers.get(path)
    if (timer !== undefined) { clearTimeout(timer); this.timers.delete(path) }
    this.buffer(path, { saveState: 'saving', error: undefined })
    const operation = (async () => {
      try {
        const pendingAssets = await this.stagedForSave(path, file.text)
        const saved = await this.io.save(this.session(), {
          path, text: diskText(file), version: file.diskVersion, expectedPath: file.absolutePath,
          ...(pendingAssets.payloads.length === 0 ? {} : { assets: pendingAssets.payloads }),
        })
        await this.finishAssetSave(pendingAssets).catch(error => this.report(error))
        const current = this.snapshot().buffers[path]
        if (current === undefined || current.absolutePath !== file.absolutePath) return
        const savedText = saved.text.replaceAll('\r\n', '\n')
        this.buffer(path, { savedText, savedRawText: saved.text, absolutePath: saved.absolutePath, diskVersion: saved.version, restoredDraft: false, saveState: current.text === savedText ? 'clean' : 'dirty', external: undefined })
        if (current.text !== savedText) this.scheduleSave(path)
      } catch (error) {
        this.buffer(path, { saveState: 'error', error: message(error) })
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'workbench/asset-transaction') {
          void this.actions.inspectAssetRecovery()
        }
        try {
          const disk = await this.io.read(this.session(), path)
          if (disk.version !== file.diskVersion) this.buffer(path, { saveState: 'conflict', external: disk })
        } catch (_readError) { /* The original save error remains visible if the file is unreadable. */ }
        throw error
      }
    })()
    this.saves.set(path, operation)
    try { await operation } finally { this.saves.delete(path) }
  }

  private async checkExternal(): Promise<void> {
    for (const file of Object.values(this.snapshot().buffers)) {
      const path = file.path
      if (file.kind === 'word' || this.saves.has(path) || file.diskVersion === null || file.unavailable === true) continue
      try {
        const metadata = await this.io.stat(this.session(), path)
        if (metadata.absolutePath !== file.absolutePath) { await this.actions.list('.'); return }
        if (metadata.version === file.diskVersion) continue
        const disk = await this.io.read(this.session(), path)
        const current = this.snapshot().buffers[path]
        if (current === undefined || this.saves.has(path) || current.diskVersion === disk.version) continue
        this.sourceChanged(path)
        const pending = this.snapshot().action?.proposal?.base.path === path
        if (current.text === current.savedText && !pending) this.patch({ buffers: {
          ...this.snapshot().buffers,
          [path]: { ...newBuffer(disk, current.mode), revision: current.revision + 1, selection: {
            from: Math.min(current.selection.from, disk.text.length), to: Math.min(current.selection.to, disk.text.length),
          }, scrollTop: current.scrollTop },
        } })
        else this.buffer(path, { saveState: 'conflict', external: disk, error: this.t('conflict') })
      } catch (error) { this.report(error) }
    }
  }

  private placeholder(file: StoredBuffer): EditorBuffer {
    if (file.word !== undefined) return { ...wordBuffer(file.word.snapshot), ...file, kind: 'word',
      word: file.word.snapshot, wordProof: file.word.proof, pendingWord: file.word.pending, unavailable: true,
      text: file.word.pending?.text ?? file.word.snapshot.projection.text, wordSync: file.word.pending === undefined ? 'idle' : 'failed',
      saveState: file.word.snapshot.revision === file.word.snapshot.savedRevision && file.word.pending === undefined ? 'clean' : 'dirty',
      restoredDraft: true }
    return { mode: file.mode, path: file.path, absolutePath: file.absolutePath, diskVersion: file.diskVersion,
      text: file.draft?.text ?? '', savedText: file.draft?.savedText ?? '', savedRawText: file.draft?.savedRawText ?? '',
      lineEnding: file.lineEnding, revision: file.revision, selection: file.selection, scrollTop: file.scrollTop,
      visualScrollTop: file.visualScrollTop, pane: file.pane, ...(file.visualState === undefined ? {} : { visualState: file.visualState }),
      saveState: file.draft === undefined ? 'clean' : 'dirty', unavailable: true, restoredDraft: file.draft !== undefined }
  }

  private async retryFile(file: EditorBuffer): Promise<void> {
    if (file.kind === 'word') {
      try {
        const restored = await this.wordEdits.restore(file)
        if (this.snapshot().buffers[file.path] === file) {
          this.buffer(file.path, restored)
          if (this.canAutoSaveWord(restored)) this.scheduleSave(file.path)
          if (restored.word.projection.readOnly && this.snapshot().activePaths.writing === file.path) this.patch(this.pane('pdf', 'writing'))
        }
      } catch (error) { this.buffer(file.path, { unavailable: true, saveState: 'error', error: message(error) }) }
      return
    }
    const generation = this.restoreGeneration
    const workspace = this.snapshot().workspaceRoot
    try {
      const disk = await this.io.read(this.session(), file.path)
      if (generation !== this.restoreGeneration || workspace !== this.snapshot().workspaceRoot
        || this.disposed || this.snapshot().buffers[file.path] !== file) return
      if (disk.absolutePath !== file.absolutePath) throw new Error(this.t('recoveryWorkspaceChanged'))
      const changed = disk.version !== file.diskVersion
      const dirty = file.restoredDraft === true || file.text !== file.savedText || file.saveState === 'conflict'
      const restored = dirty ? { ...file, unavailable: false, restoredDraft: false, saveState: changed ? 'conflict' as const : 'dirty' as const,
        ...(changed ? { external: disk, error: this.t('conflict') } : { error: undefined }) }
        : { ...newBuffer(disk, file.mode), unavailable: false, restoredDraft: false, error: undefined, external: undefined,
          revision: file.revision + (changed ? 1 : 0), pane: file.pane,
          selection: { from: Math.min(file.selection.from, disk.text.replaceAll('\r\n', '\n').length),
            to: Math.min(file.selection.to, disk.text.replaceAll('\r\n', '\n').length) },
          scrollTop: file.scrollTop, visualScrollTop: file.visualScrollTop,
          ...(!changed && file.visualState !== undefined ? { visualState: file.visualState } : {}) }
      this.buffer(file.path, restored)
      if (changed && !dirty) this.patch({ error: this.t('stateDiskChanged') })
    } catch (error) {
      if (generation === this.restoreGeneration && this.snapshot().buffers[file.path] === file) {
        this.buffer(file.path, { unavailable: true, saveState: 'error', error: this.t('stateFileUnavailable') + ' ' + message(error) })
      }
    }
  }

  private async restoreScene(root: string, generation: number): Promise<void> {
    if (this.persistence === undefined || this.sessionId === undefined) return
    const interaction = this.interactionRevision
    let record
    try { record = await this.persistence.load(this.sessionId, root) }
    catch (error) {
      if (generation === this.restoreGeneration) { this.persistenceBlocked = true; this.persistenceStatus(error) }
      return
    }
    if (record === null || generation !== this.restoreGeneration || this.disposed) return
    this.restoredScene = true
    const current = this.snapshot()
    const stored = Object.fromEntries(record.buffers.map(file => [file.path, this.placeholder(file)]))
    const untouched = interaction === this.interactionRevision && this.interactionRevision === 0
    this.patch({ buffers: { ...stored, ...current.buffers }, proposalHeight: record.proposalHeight ?? current.proposalHeight ?? 32,
      pdfPositions: { ...record.pdfPositions, ...current.pdfPositions },
      ...(untouched ? { mode: record.mode, focus: record.focus, activePaths: record.activePaths, panes: record.panes,
        mainFile: record.mainFile, selection: record.selection, instruction: record.instruction,
        selectionMode: record.selectionMode, action: record.action } : {
        activePaths: { writing: current.activePaths.writing ?? record.activePaths.writing,
          development: current.activePaths.development ?? record.activePaths.development },
      }) })
    for (const file of Object.values(stored)) {
      if (generation !== this.restoreGeneration || this.disposed) return
      if (this.snapshot().buffers[file.path] === file) await this.retryFile(file)
    }
    if (generation !== this.restoreGeneration || this.disposed) return
    if (record.action !== null && this.snapshot().action?.actionId === record.action.actionId) {
      try {
        const action = await this.io.getAction(this.session(), record.action.actionId)
        if (generation !== this.restoreGeneration || this.snapshot().action?.actionId !== record.action.actionId) return
        const restored = action.reviewed !== undefined ? null
          : action.state === 'proposed' && (record.action.acceptedParts ?? 0) > 0 ? record.action : action
        this.patch({ action: restored, ...(restored === null ? { selection: null, instruction: '' } : {}) })
        if (restored !== null) this.pollAction(restored, ++this.selectionGeneration)
      } catch (_error) {
        if (generation === this.restoreGeneration && this.snapshot().action?.actionId === record.action.actionId) {
          this.patch({ action: { ...record.action, state: 'failed', error: this.t('recoveryRequestEnded') } })
        }
      }
    }
    if (this.snapshot().panes.writing === 'pdf') {
      const path = this.snapshot().activePaths.writing
      if (path !== null && this.snapshot().buffers[path]?.kind === 'word') await this.wordProof(path, true)
      else await this.actions.refreshPdf()
    }
  }

  private async ask(submittedInstruction?: string, skipQuick = false): Promise<void> {
    const { selection, selectionMode, action: previous } = this.snapshot()
    const instruction = submittedInstruction ?? this.snapshot().instruction
    if (selection === null || instruction.trim() === '') return
    if (previous?.state === 'queued' || previous?.state === 'generating') return
    const file = this.snapshot().buffers[selection.path]
    if (selectionMode !== 'ask' && (file === undefined || !matchesProposalBase(file, selection))) {
      this.patch({ action: { actionId: '', state: 'failed', error: this.t('staleProposal') } })
      return
    }
    const generation = ++this.selectionGeneration
    this.patch({ error: null, action: { actionId: '', state: 'queued' } })
    try {
      if (!skipQuick && selectionMode !== 'ask') {
        const result = await this.quickCommand(instruction.trim(), new AbortController().signal)
        if (result !== null) {
          if (generation === this.selectionGeneration) this.patch({ instruction: '', action: { actionId: '', state: result.kind === 'success' ? 'completed' : 'failed',
            ...(result.kind === 'error' ? { error: result.text } : {}) } })
          return
        }
      }
      if (selection.assetPaths !== undefined) {
        const graphicsPaths = file === undefined ? [] : parseLatexDocument(file.text, file.path).graphicsPaths
        for (const assetPath of selection.assetPaths) {
          await this.actions.resolveAsset(assetPath, selection.path, graphicsPaths)
        }
        if (generation !== this.selectionGeneration) return
      }
      const action = await this.io.request({
        sessionId: this.session(), requestId: randomUUID(), mode: selectionMode, instruction: instruction.trim(),
        path: selection.path, from: selection.from, to: selection.to, selectedText: selection.selectedText,
        contextBefore: selection.contextBefore, contextAfter: selection.contextAfter, bufferVersion: selection.bufferVersion,
        ...(selection.objectKind === undefined ? {} : { objectKind: selection.objectKind }),
        ...(selection.nodeId === undefined ? {} : { nodeId: selection.nodeId }),
        ...(selection.assetPaths === undefined ? {} : { assetPaths: selection.assetPaths }),
      })
      if (generation !== this.selectionGeneration) return
      this.patch({ action, instruction: '' })
      this.pollAction(action, generation)
    } catch (error) { if (generation === this.selectionGeneration) this.patch({ action: { actionId: '', state: 'failed', error: message(error) } }) }
  }

  private pollAction(action: AssistantAction, generation: number, failures = 0): void {
    if (this.disposed || generation !== this.selectionGeneration || (action.state !== 'queued' && action.state !== 'generating')) return
    this.actionTimer = setTimeout(() => {
      if (this.disposed || generation !== this.selectionGeneration) return
      void this.io.getAction(this.session(), action.actionId).then((next) => {
        if (generation !== this.selectionGeneration || this.disposed) return
        this.patch({ action: next })
        this.pollAction(next, generation)
      }).catch((error) => {
        if (this.disposed || generation !== this.selectionGeneration) return
        this.patch({ action: { ...action, pollError: message(error) } })
        this.pollAction(action, generation, failures + 1)
      })
    }, Math.min(8000, 500 * 2 ** failures))
  }

  private accept(index?: number): void {
    const { action } = this.snapshot()
    if (action === null || action.proposal === undefined) return
    const proposal = action.proposal
    const { base } = proposal
    const file = this.snapshot().buffers[base.path]
    if (file === undefined || !matchesProposalBase(file, base)) {
      this.report(new Error(this.t('staleProposal')))
      return
    }
    if (file.kind === 'word') { void this.acceptWord(file.path, action, index).catch(error => this.report(error)); return }
    const diff = index === undefined ? undefined : presentableDiff(base.selectedText, proposal.replacement)[index]
    if (index !== undefined && diff === undefined) return
    const from = base.from + (diff?.fromA ?? 0)
    const to = base.from + (diff?.toA ?? base.selectedText.length)
    const insert = diff === undefined ? proposal.replacement : proposal.replacement.slice(diff.fromB, diff.toB)
    let applied: ReturnType<typeof applyScientificProposal>
    try { applied = applyScientificProposal(file, proposal, from, to, insert, diff !== undefined) }
    catch (error) { this.report(new Error(operationMessage(error, this.t))); return }
    const text = applied.text
    const revision = file.revision + 1
    const pane = this.snapshot().selection?.origin === 'visual' ? 'visual' as const : 'source' as const
    this.patch({ ...this.activation(file, pane), focus: 'editor' })
    this.buffer(base.path, { text, revision, saveState: 'dirty', edit: { id: ++this.editToken, from: applied.from, to: applied.to, insert: applied.insert }, selection: { from, to: from + insert.length } })
    this.sourceChanged(base.path)
    if (diff === undefined) {
      void this.io.review(this.session(), action.actionId, 'accepted', proposal.replacement, action.reviewBaseVersion ?? base.bufferVersion).catch(error => this.report(error))
      this.acceptedParts.delete(action.actionId)
      this.patch({ action: null, selection: null, instruction: '' })
    }
    else {
      const selectedText = base.selectedText.slice(0, diff.fromA) + insert + base.selectedText.slice(diff.toA)
      const nextBase = { ...base, selectedText, to: base.from + selectedText.length, bufferVersion: String(revision) }
      this.acceptedParts.set(action.actionId, (this.acceptedParts.get(action.actionId) ?? 0) + 1)
      const selection = this.snapshot().selection
      this.patch({ action: { ...action, reviewBaseVersion: action.reviewBaseVersion ?? base.bufferVersion,
        acceptedParts: (action.acceptedParts ?? 0) + 1, proposal: { ...proposal, base: nextBase } },
      selection: selection === null ? null : { ...selection, ...nextBase },
      })
      if (selectedText === proposal.replacement) {
        void this.io.review(this.session(), action.actionId, 'accepted', selectedText, action.reviewBaseVersion ?? base.bufferVersion).catch(error => this.report(error))
        this.acceptedParts.delete(action.actionId)
        this.patch({ action: null, selection: null, instruction: '' })
      }
    }
    this.scheduleSave(base.path)
  }

  private reviewRemaining(): void {
    const current = this.snapshot()
    const action = current.action
    const attachments = action?.proposal?.base.attachmentAssets ?? current.selection?.attachmentAssets
    if (attachments?.length) {
      const scope = this.assetScope()
      queueMicrotask(() => {
        if (this.disposed || scope?.workspaceRoot !== this.assetScope()?.workspaceRoot) return
        // Callers clear or replace the selection synchronously. Release only unused
        // browser staging; the original Session attachment and project files remain intact.
        for (const asset of attachments) {
          if (!this.assetReferenced(asset.path)) void this.actions.discardStagedAsset(asset.sha256)
        }
      })
    }
    if (action?.proposal === undefined) return
    const partial = (action.acceptedParts ?? this.acceptedParts.get(action.actionId) ?? 0) > 0
    const { base } = action.proposal
    const file = this.snapshot().buffers[base.path]
    const appliedText = partial && file !== undefined && String(file.revision) === base.bufferVersion
      && file.text.slice(base.from, base.to) === base.selectedText ? base.selectedText : undefined
    void this.io.review(this.session(), action.actionId, partial ? 'partial' : 'rejected', appliedText,
      action.reviewBaseVersion ?? base.bufferVersion).catch(error => this.report(error))
    this.acceptedParts.delete(action.actionId)
  }

  private assetReferenced(path: string): boolean {
    const basename = path.slice(path.lastIndexOf('/') + 1)
    const current = this.snapshot()
    return Object.values(current.buffers).some(file => file.text.includes(basename))
      || current.selection?.assetPaths?.some(asset => asset.includes(basename)) === true
      || current.action?.proposal?.replacement.includes(basename) === true
  }

  private async run(request: RunRequest, strict = false): Promise<void> {
    if (this.snapshot().job?.state === 'running') { const error = new Error(this.t('jobBusy')); if (strict) throw error; this.report(error); return }
    try {
      // Word owns its debounced save lifecycle; compiling another board must not force a write.
      for (const file of Object.values(this.snapshot().buffers)) {
        if (file.kind !== 'word') await this.save(file.path)
      }
      const sourceRevision = this.sourceRevision
      const job = await this.io.start(this.session(), request)
      this.jobSourceRevision = sourceRevision
      this.patch({ job, outputOpen: job.kind !== 'latex', error: null })
      if (job.state === 'succeeded' && job.kind === 'latex') {
        this.patch({ pdfDirty: this.sourceRevision !== this.jobSourceRevision })
        await this.actions.refreshPdf()
      }
      this.pollJob(job.id)
    } catch (error) { if (strict) throw error; this.report(error) }
  }

  private pollJob(id: string, failures = 0): void {
    if (this.disposed || this.snapshot().job?.id !== id || this.snapshot().job?.state !== 'running') return
    this.jobTimer = setTimeout(() => {
      if (this.disposed || this.snapshot().job?.id !== id || this.snapshot().job?.state !== 'running') return
      void this.io.status(this.session(), id).then(async (job) => {
        if (this.disposed || this.snapshot().job?.id !== id || this.snapshot().job?.state !== 'running') return
        this.patch({ job })
        if (job.state === 'succeeded' && job.kind === 'latex') {
          this.patch({ pdfDirty: this.sourceRevision !== this.jobSourceRevision })
          await this.actions.refreshPdf()
        }
        this.pollJob(id)
      }).catch((error) => {
        const job = this.snapshot().job
        if (this.disposed || job?.id !== id || job.state !== 'running') return
        if (this.retireUnavailableJob(id, error)) return
        this.patch({ job: { ...job, pollError: message(error) } })
        this.pollJob(id, failures + 1)
      })
    }, Math.min(8000, 600 * 2 ** failures))
  }

  private async locateDiagnostic(diagnostic: Diagnostic): Promise<void> {
    const path = await this.open(diagnostic.path)
    const file = path === undefined ? undefined : this.snapshot().buffers[path]
    if (file === undefined) return
    const from = positionAt(file.text, diagnostic.line, diagnostic.column)
    this.patch({ sourceTarget: { path: file.path, from, to: from, token: ++this.locateToken }, ...this.activation(file, 'source'), focus: 'editor' })
  }
}
