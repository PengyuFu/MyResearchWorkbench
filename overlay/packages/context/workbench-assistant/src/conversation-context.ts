/** Exact editor targets for ordinary conversation tools; no document writes occur here. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { isRecord } from './proposal.ts'
import { selectionOf, validateSelection } from './prompt.ts'
import type {
  Config, WorkbenchEditorContext, WorkbenchEditorPublication, WorkbenchSelection, WorkbenchSelectionRequest,
} from './types.ts'

/** Tool arguments distinguish literal anchor replacement from insertion beside that anchor. */
export interface PrepareEditArguments {
  readonly kind: 'edit' | 'figure' | 'table'
  readonly anchor?: string
  readonly placement: 'replace' | 'before' | 'after'
  readonly assetPath?: string
  readonly attachment?: string
}

function validRange(value: unknown, length: number): value is { from: number; to: number } {
  return isRecord(value) && Number.isSafeInteger(value.from) && Number.isSafeInteger(value.to)
    && typeof value.from === 'number' && typeof value.to === 'number'
    && value.from >= 0 && value.to >= value.from && value.to <= length
}

function validateCapturedSelection(value: WorkbenchSelection, frame: WorkbenchEditorContext, limits: Config): void {
  if (!isRecord(value) || typeof value.path !== 'string' || typeof value.selectedText !== 'string'
    || typeof value.contextBefore !== 'string' || typeof value.contextAfter !== 'string'
    || typeof value.bufferVersion !== 'string') throw new Error('Invalid editor selection context.')
  validateSelection({ ...value, requestId: 'editor-context', mode: 'edit', instruction: 'Editor context' }, limits)
  if (value.path !== frame.path || value.bufferVersion !== frame.bufferVersion || value.to > frame.text.length
    || frame.text.slice(value.from, value.to) !== value.selectedText) throw new Error('The editor selection does not match its buffer.')
}

function validTable(value: unknown): boolean {
  if (value === undefined) return true
  return isRecord(value) && typeof value.id === 'string' && value.id.length <= 200
    && (value.autoFit === undefined || value.autoFit === 'content' || value.autoFit === 'window')
    && (value.autoRowHeight === undefined || typeof value.autoRowHeight === 'boolean')
    && ['row', 'column', 'rows', 'columns'].every(key => Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)
}
function validPagination(value: unknown): boolean {
  if (value === undefined) return true
  return isRecord(value) && ['pageBreakBefore', 'keepNext', 'keepLines'].every(key =>
    value[key] === undefined || typeof value[key] === 'boolean')
    && Number.isSafeInteger(value.explicitBreaks) && Number(value.explicitBreaks) >= 0 && typeof value.sectionBreak === 'boolean'
}

/** Validate a complete browser publication before replacing the previous acknowledged frame. */
export function validateEditorPublication(publication: WorkbenchEditorPublication, limits: Config): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(publication.editorId)
    || !Number.isSafeInteger(publication.generation) || publication.generation < 0) throw new Error('Invalid editor publication identity.')
  const frame = publication.context
  if (frame === null) return
  if (!isRecord(frame) || typeof frame.path !== 'string' || !frame.path.trim() || frame.path.length > 4096
    || frame.path.includes('\0') || typeof frame.text !== 'string' || frame.text.length > limits.maxDocumentChars
    || frame.text.includes('\0') || typeof frame.bufferVersion !== 'string' || !frame.bufferVersion
    || frame.bufferVersion.length > 256 || !validRange(frame.selection, frame.text.length)
    || !Array.isArray(frame.graphicsPaths) || frame.graphicsPaths.length > 32
    || frame.graphicsPaths.some(path => typeof path !== 'string' || path.length > 4096 || path.includes('\0'))) {
    throw new Error('Invalid or oversized editor context.')
  }
  if (frame.word !== undefined && (!isRecord(frame.word) || typeof frame.word.id !== 'string'
    || !/^[a-f0-9]{32}$/u.test(frame.word.id) || !Number.isSafeInteger(frame.word.revision) || frame.word.revision < 0
    || !/\.docx$/iu.test(frame.path))) throw new Error('Invalid Word editor identity.')
  if (frame.selected !== null) validateCapturedSelection(frame.selected, frame, limits)
  if (frame.selectionKey !== undefined && (typeof frame.selectionKey !== 'string' || frame.selectionKey.length > 8192)) throw new Error('Invalid native selection identity.')
  if (frame.redoAvailable !== undefined && typeof frame.redoAvailable !== 'boolean') throw new Error('Invalid history state.')
  if (frame.paragraphs !== undefined && (!Array.isArray(frame.paragraphs) || frame.paragraphs.length > 20000
    || frame.paragraphs.some(block => typeof block.id !== 'string' || block.id.length > 200
      || !validTable(block.table)
      || !validPagination(block.pagination)
      || !Number.isInteger(block.level) || block.level < 0 || block.level > 9 || typeof block.style !== 'string' || block.style.length > 200 || !validRange(block, frame.text.length))
    || new Set(frame.paragraphs.map(block => block.id)).size !== frame.paragraphs.length)) throw new Error('Invalid paragraph context.')
  if (frame.insertion !== null) {
    validateCapturedSelection(frame.insertion, frame, limits)
    if (frame.insertion.from !== frame.insertion.to || frame.insertion.objectKind !== 'insertion') {
      throw new Error('The editor insertion target must be an empty body range.')
    }
  }
}

/** Parse model JSON without accepting arbitrary source coordinates. */
export function prepareEditArguments(value: unknown, limits: Config): PrepareEditArguments {
  if (!isRecord(value) || (value.kind !== 'edit' && value.kind !== 'figure' && value.kind !== 'table')
    || (value.anchor !== undefined && (typeof value.anchor !== 'string' || !value.anchor || value.anchor.length > limits.maxSelectionChars))
    || (value.placement !== undefined && value.placement !== 'replace' && value.placement !== 'before' && value.placement !== 'after')
    || (value.assetPath !== undefined && (typeof value.assetPath !== 'string' || !value.assetPath || value.assetPath.length > 4096))
    || (value.attachment !== undefined && (typeof value.attachment !== 'string' || !value.attachment || value.attachment.length > 1024))
    || (value.assetPath !== undefined && value.attachment !== undefined)) throw new Error('Invalid edit target or figure asset.')
  if (value.kind !== 'figure' && (value.assetPath !== undefined || value.attachment !== undefined)) {
    throw new Error('Only a figure accepts an image asset.')
  }
  return {
    kind: value.kind,
    placement: value.placement ?? 'replace',
    ...(typeof value.anchor === 'string' ? { anchor: value.anchor } : {}),
    ...(typeof value.assetPath === 'string' ? { assetPath: value.assetPath } : {}),
    ...(typeof value.attachment === 'string' ? { attachment: value.attachment } : {}),
  }
}

/** Find an exact, unique literal; repeated text never silently chooses a paragraph. */
export function uniqueAnchor(text: string, anchor: string): number {
  const from = text.indexOf(anchor)
  if (from < 0) {
    throw new Error('The requested text is absent from the current buffer. Read the current context and choose an exact anchor.')
  }
  if (text.indexOf(anchor, from + 1) >= 0) {
    throw new Error('The requested text occurs more than once. Include enough surrounding text to identify one location.')
  }
  return from
}

/** Capture the selected object, the focused body anchor, or an exact instruction typed into the manuscript. */
export function conversationSelection(frame: WorkbenchEditorContext, args: PrepareEditArguments, limits: Config): WorkbenchSelection {
  const scientific = args.kind === 'figure' || args.kind === 'table'
  if (scientific && !/\.(tex|docx)$/iu.test(frame.path)) throw new Error('Open a Word or LaTeX manuscript before proposing a scientific figure or table.')
  let selection: WorkbenchSelection
  if (args.anchor !== undefined) {
    const found = uniqueAnchor(frame.text, args.anchor)
    const from = args.placement === 'after' ? found + args.anchor.length : found
    const to = args.placement === 'replace' ? found + args.anchor.length : from
    selection = {
      path: frame.path, from, to, selectedText: frame.text.slice(from, to),
      contextBefore: frame.text.slice(Math.max(0, from - limits.maxContextChars), from),
      contextAfter: frame.text.slice(to, to + limits.maxContextChars), bufferVersion: frame.bufferVersion,
      objectKind: scientific ? 'insertion' : /\.(tex|docx)$/iu.test(frame.path) ? 'text' : 'code',
    }
  } else {
    const captured = frame.selected ?? (scientific ? frame.insertion : null)
    if (captured === null) throw new Error('Select the passage or provide an exact manuscript instruction as the anchor.')
    selection = selectionOf(captured)
    if (scientific) selection = { ...selection, objectKind: 'insertion' }
  }
  if (scientific && /\.tex$/iu.test(frame.path)) {
    const begin = /\\begin\s*\{document\}/u.exec(frame.text)
    const end = /\\end\s*\{document\}/u.exec(frame.text)
    if (begin !== null && selection.from < begin.index + begin[0].length
      || end !== null && selection.to > end.index) throw new Error('Choose an insertion instruction or anchor inside the manuscript body.')
  }
  return selection
}

/** A captured request becomes durable in the successful preparation tool result. */
export function conversationRequest(
  sessionId: SessionId, requestId: string, frame: WorkbenchEditorContext, args: PrepareEditArguments,
  instruction: string, limits: Config,
): WorkbenchSelectionRequest {
  const request: WorkbenchSelectionRequest = {
    ...conversationSelection(frame, args, limits), sessionId, requestId, mode: 'edit', instruction,
  }
  validateSelection(request, limits)
  return request
}
