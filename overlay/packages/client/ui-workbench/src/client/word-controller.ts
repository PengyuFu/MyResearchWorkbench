/** Compatibility facade for the workbench; all edits use the one retained OOXML model. */
import { bytesToBase64 } from '@deepseek-ai/dsh-util-crypto'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WordOperation, WordSnapshot } from '@deepseek-ai/dsh-workbench-word/types'
import type { EditorBuffer, WorkbenchIO, WordEditorBuffer } from './types.ts'
import { wordBuffer } from './word-operations.ts'
import { DocxDocuments } from './docx-controller.ts'
/** Workbench-owned state and IO callbacks for a document controller. */
export interface WordPorts {
  io: WorkbenchIO
  session(): SessionId
  get(path: string): EditorBuffer | undefined
  put(path: string, file: WordEditorBuffer): void
  checkpoint(): void
  error(error: unknown): void
  pendingMessage(): string
}
/** Workbench command facade backed by retained OOXML documents. */
export class WordEdits {
  private readonly docx: DocxDocuments
  constructor(private readonly ports: WordPorts) { this.docx = new DocxDocuments(ports) }
  /**
   * Select a document range.
   * @param path - Open document path.
   * @param from - Start offset.
   * @param to - End offset.
   */
  navigate(path: string, from: number, to: number): void { this.docx.navigate(path, from, to) }
  /**
   * Attach a view to the retained model.
   * @param path - Open document path.
   * @param element - Canvas element.
   * @returns Detachment callback.
   */
  mount(path: string, element: HTMLElement): () => void { return this.docx.attach(path, element) }
  /**
   * Reject retired projection-editor callbacks for open DOCX documents.
   * @param _path - Document path.
   * @param _text - Legacy projected text.
   * @param _document - Legacy projected serialization.
   * @param _selection - Legacy selection.
   * @param _scrollTop - Legacy viewport position.
   * @param _view - Legacy view state.
   * @param _composing - Legacy composition state.
   */
  edit(_path: string, _text: string, _document: string, _selection: { from: number; to: number },
    _scrollTop: number, _view: string, _composing = false): void {
    if (this.ports.get(_path) === undefined) return
    throw new Error('Reopen this document in the continuous DOCX writing board.')
  }
  /**
   * Await durable pending revisions.
   * @param path - Open document path.
   */
  flush(path: string): Promise<void> { return this.docx.flush(path) }
  /**
   * Apply a reviewed command.
   * @param path - Open document path.
   * @param operation - Requested model edit.
   */
  mutate(path: string, operation: WordOperation): Promise<void> { return this.docx.mutate(path, operation) }
  /** Native selection identity including a rectangular table selection. */
  selectionKey(path: string): string { return this.docx.selectionKey(path) }
  /**
   * Apply the current instruction through the same retained native document.
   * @param path - Open document path.
   * @param operations - Validated commands in execution order.
   * @param selectionKey - Frozen native selection identity.
   * @param signal - Optional cancellation checked between commands.
   * @returns Completion after settling any applied edits.
   */
  batch(path: string, operations: readonly WordOperation[], selectionKey: string, signal?: AbortSignal): Promise<void> {
    return this.docx.batch(path, operations, selectionKey, signal)
  }
  /**
   * Save the confirmed draft.
   * @param path - Open document path.
   * @param destination - Save As path or null.
   * @returns Saved checkpoint.
   */
  save(path: string, destination: string | null = null): Promise<WordSnapshot> { return this.docx.save(path, destination) }
  /**
   * Apply queued operations for this model.
   * @param path - Open document path.
   * @param documentId - Expected identity.
   * @param _revision - Event revision; durable request revisions are authoritative.
   */
  refresh(path: string, documentId: string, _revision: number): Promise<void> { return this.docx.refresh(path, documentId) }
  /**
   * Settle an active checkpoint before closing.
   * @param path - Closing document.
   */
  settleClose(path: string): Promise<void> { return this.docx.settleClose(path) }
  /**
   * Complete or cancel model teardown.
   * @param path - Closing document.
   */
  releaseClose(path: string): void { this.docx.releaseClose(path) }
  /**
   * Reopen the durable checkpoint and retain unconfirmed binary input.
   * @param file - Persisted scene buffer.
   * @returns Restored buffer with any pending recovery surfaced.
   */
  async restore(file: WordEditorBuffer): Promise<WordEditorBuffer> {
    const api = this.ports.io.word
    if (api === undefined) throw new Error('The DOCX service is unavailable.')
    const snapshot = await api.open(this.ports.session(), file.path, false, file.word)
    const restored = wordBuffer(snapshot, file)
    if (file.pendingWord !== undefined) return { ...restored, text: file.pendingWord.text,
      revision: Math.max(snapshot.revision + 1, file.revision),
      pendingWord: { ...file.pendingWord, recovered: true, request: undefined }, wordSync: 'failed',
      saveState: 'error', error: this.ports.pendingMessage() }
    return restored
  }
  /**
   * Reconcile pending input against the saved checkpoint.
   * @param path - Open document path.
   */
  resume(path: string): Promise<void> { return this.docx.resume(path) }
  /**
   * Flush ready documents before a coordinated action.
   * @param paths - Open document paths.
   */
  async ready(paths: string[]): Promise<void> {
    for (const path of paths) {
      const file = this.ports.get(path)
      if (file?.kind === 'word' && file.wordSync !== 'failed' && file.pendingWord?.recovered !== true) await this.flush(path)
    }
  }
  /**
   * Attach verified staged bytes to an image command.
   * @param operation - Insertion request.
   * @param data - Staged image bytes.
   * @param sha256 - Verified content digest.
   * @returns Command carrying the same staged bytes.
   */
  // oxlint-disable-next-line typescript/require-await -- Encoding errors must remain promise rejections.
  async image(operation: Extract<WordOperation, { kind: 'image' }>, data: Uint8Array, sha256: string): Promise<WordOperation> {
    return { ...operation, data: bytesToBase64(data), sha256 }
  }
  /**
   * Release all retained document models.
   */
  dispose(): void { this.docx.dispose() }
}
