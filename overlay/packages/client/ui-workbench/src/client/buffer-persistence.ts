/** Durable workbench scenes and exact disk serialization. */
import { diff } from '@codemirror/merge'
import type { WordProofReference, WordSnapshot } from '@deepseek-ai/dsh-workbench-word/types'
import type { PendingWordInput } from './types.ts'
import type { AssistantAction, EditorBuffer, SelectionSnapshot, WorkbenchSnapshot } from './types.ts'

/** Apply only changed UTF-16 ranges to the previous disk text, retaining untouched line endings and BOM. */
export function diskText(file: Pick<EditorBuffer, 'text' | 'savedText' | 'savedRawText' | 'lineEnding'>): string {
  if ('kind' in file && file.kind === 'word') throw new Error('Word projections cannot be serialized as text files')
  if (file.text === file.savedText) return file.savedRawText
  const offsets: number[] = [0]
  for (let raw = 0; raw < file.savedRawText.length;) {
    raw += file.savedRawText[raw] === '\r' && file.savedRawText[raw + 1] === '\n' ? 2 : 1
    offsets.push(raw)
  }
  let output = file.savedRawText
  for (const change of [...diff(file.savedText, file.text)].reverse()) {
    const insert = file.text.slice(change.fromB, change.toB)
    output = output.slice(0, offsets[change.fromA]) + (file.lineEnding === 'crlf' ? insert.replaceAll('\n', '\r\n') : insert) + output.slice(offsets[change.toA])
  }
  return output
}


/** A clean file is re-read through Host; only outstanding text is stored as a draft. */
export interface StoredBuffer {
  mode: EditorBuffer['mode']
  word?: { snapshot: WordSnapshot; pending?: PendingWordInput | undefined; proof?: WordProofReference | undefined }
  path: string
  absolutePath: string
  diskVersion: string | null
  lineEnding: EditorBuffer['lineEnding']
  revision: number
  selection: EditorBuffer['selection']
  scrollTop: number
  visualScrollTop: number
  pane: EditorBuffer['pane']
  visualState?: string
  draft?: Pick<EditorBuffer, 'text' | 'savedText' | 'savedRawText'>
}

/** One original Session and Workspace's complete editing scene. */
export interface WorkbenchRecord {
  version: 1 | 2
  sessionId: string
  workspaceRoot: string
  updatedAt: number
  mode: WorkbenchSnapshot['mode']
  focus: WorkbenchSnapshot['focus']
  buffers: StoredBuffer[]
  activePaths: WorkbenchSnapshot['activePaths']
  panes: WorkbenchSnapshot['panes']
  mainFile: string
  proposalHeight?: number
  selection: SelectionSnapshot | null
  instruction: string
  selectionMode: WorkbenchSnapshot['selectionMode']
  action: AssistantAction | null
  pdfPositions: WorkbenchSnapshot['pdfPositions']
}

/** Capture a complete scene without editor engines, undo history or credentials.
 * @param sessionId - original Session identity.
 * @param state - the owning controller's immutable snapshot.
 * @returns a JSON-compatible record; no file-count or expiry truncation.
 */
export function captureWorkbench(sessionId: string, state: WorkbenchSnapshot): WorkbenchRecord {
  if (state.workspaceRoot === null) throw new Error('Cannot persist an unbound workspace')
  return {
    version: 2, sessionId, workspaceRoot: state.workspaceRoot, updatedAt: Date.now(),
    mode: state.mode, focus: state.focus, activePaths: state.activePaths, panes: state.panes,
    proposalHeight: state.proposalHeight ?? 32,
    mainFile: state.mainFile, selection: state.selection, instruction: state.instruction,
    selectionMode: state.selectionMode, action: state.action, pdfPositions: state.pdfPositions,
    buffers: Object.values(state.buffers).map(file => ({
      ...(file.kind === 'word' ? { word: { snapshot: { ...file.word, data: undefined }, pending: file.pendingWord, proof: file.wordProof } } : {}),
      mode: file.mode, path: file.path, absolutePath: file.absolutePath, diskVersion: file.diskVersion,
      lineEnding: file.lineEnding, revision: file.revision, selection: file.selection,
      scrollTop: file.scrollTop, visualScrollTop: file.visualScrollTop ?? 0, pane: file.pane,
      ...(file.visualState === undefined ? {} : { visualState: file.visualState }),
      ...(file.kind === 'word' || file.text === file.savedText && file.saveState !== 'conflict' && file.restoredDraft !== true ? {} : {
        draft: { text: file.text, savedText: file.savedText, savedRawText: file.savedRawText },
      }),
    })),
  }
}

function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function string(value: unknown): value is string { return typeof value === 'string' }
function number(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function range(value: unknown): boolean {
  return object(value) && Number.isSafeInteger(value.from) && Number.isSafeInteger(value.to)
    && Number(value.from) >= 0 && Number(value.to) >= Number(value.from)
}
function pane(value: unknown): boolean { return value === 'visual' || value === 'source' || value === 'pdf' }
function wordRecovery(value: unknown): boolean {
  if (!object(value) || !object(value.snapshot)) return false
  const s = value.snapshot
  if (!string(s.id) || !/^[a-f0-9]{32}$/u.test(s.id) || !string(s.checkpoint) || !string(s.checkpointHash)
    || !string(s.path) || !string(s.absolutePath) || !string(s.workspaceRoot) || !number(s.revision)
    || typeof s.savedRevision !== 'number' || !number(s.checkpointTime) || !(s.diskVersion === null || string(s.diskVersion))
    || !object(s.projection) || !string(s.projection.text) || !Array.isArray(s.projection.blocks)
    || !Array.isArray(s.projection.styles) || !s.projection.styles.every(string)) return false
  if (!s.projection.blocks.every(b => object(b) && string(b.id) && ['paragraph', 'protected', 'image'].includes(String(b.kind))
    && number(b.from) && number(b.to) && string(b.text) && string(b.style) && number(b.level)
    && typeof b.alignment === 'number' && typeof b.spaceBefore === 'number' && typeof b.spaceAfter === 'number'
    && Array.isArray(b.runs) && b.runs.every(r => object(r) && number(r.from) && number(r.to))
    && (b.table === undefined || object(b.table) && string(b.table.id) && number(b.table.row) && number(b.table.column)
      && number(b.table.rows) && number(b.table.columns))
    && (b.image === undefined || object(b.image) && number(b.image.width) && number(b.image.height)
      && (b.image.data === undefined || string(b.image.data))))) return false
  if (value.proof !== undefined && (!object(value.proof) || !number(value.proof.revision)
    || !string(value.proof.version) || !/^[a-f0-9]{64}$/u.test(value.proof.version))) return false
  return value.pending === undefined || object(value.pending) && string(value.pending.text) && string(value.pending.document)
}
function buffer(value: unknown): boolean {
  return object(value) && (value.mode === 'writing' || value.mode === 'development')
    && string(value.path) && string(value.absolutePath) && (value.diskVersion === null || string(value.diskVersion))
    && (value.lineEnding === 'lf' || value.lineEnding === 'crlf') && number(value.revision)
    && range(value.selection) && number(value.scrollTop) && number(value.visualScrollTop) && (value.pane === undefined || pane(value.pane))
    && (value.word === undefined || wordRecovery(value.word))
    && (value.visualState === undefined || string(value.visualState))
    && (value.draft === undefined || object(value.draft) && string(value.draft.text) && string(value.draft.savedText)
      && string(value.draft.savedRawText))
}
function selection(value: unknown): boolean {
  return value === null || object(value) && string(value.path) && range(value) && string(value.selectedText)
    && string(value.contextBefore) && string(value.contextAfter) && string(value.bufferVersion)
    && number(value.lineFrom) && number(value.lineTo)
}
function action(value: unknown): boolean {
  if (value === null) return true
  if (!object(value) || !string(value.actionId) || !['queued', 'generating', 'proposed', 'completed', 'cancelled', 'failed'].includes(String(value.state))) return false
  if (value.proposal === undefined) return true
  const proposal = value.proposal
  return object(proposal) && string(proposal.replacement) && string(proposal.explanation) && object(proposal.base)
    && string(proposal.base.path) && range(proposal.base) && string(proposal.base.selectedText) && string(proposal.base.bufferVersion)
}

/** Validate persisted browser data without deleting unreadable records.
 * @param value - untrusted durable value.
 * @returns whether the current schema can be read.
 */
export function isWorkbenchRecord(value: unknown): value is WorkbenchRecord {
  return object(value) && (value.version === 1 || value.version === 2) && string(value.sessionId)
    && string(value.workspaceRoot) && number(value.updatedAt)
    && ['chat', 'writing', 'development'].includes(String(value.mode)) && (value.focus === 'chat' || value.focus === 'editor')
    && Array.isArray(value.buffers) && value.buffers.every(buffer)
    && new Set(value.buffers.map(item => (item as StoredBuffer).path)).size === value.buffers.length
    && object(value.activePaths) && (value.activePaths.writing === null || string(value.activePaths.writing))
    && (value.activePaths.development === null || string(value.activePaths.development))
    && object(value.panes) && pane(value.panes.writing) && value.panes.development === 'source'
    && string(value.mainFile) && selection(value.selection) && string(value.instruction)
    && ['ask', 'edit', 'assist'].includes(String(value.selectionMode)) && action(value.action)
    && object(value.pdfPositions) && Object.values(value.pdfPositions).every(position => object(position)
      && number(position.page) && position.page >= 1 && number(position.offset) && number(position.left)
      && (position.zoom === 'fit' || number(position.zoom) && position.zoom > 0))
}
