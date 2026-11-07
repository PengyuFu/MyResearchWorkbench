/** JSON-compatible editor state shared by the work view and composer seats. */
import type { WordBinaryCommit, WordResources, WordCheckpoint, WordMutation, WordOperation, WordProof, WordPageRegion, WordProofReference, WordSnapshot } from '@deepseek-ai/dsh-workbench-word/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ReferenceCatalog } from './project-references.ts'
import type { WorkbenchAssetRecovery } from '@deepseek-ai/dsh-workbench-workspace/types'
import type { StagedAssetPayload } from './asset-staging.ts'
import type {
  WorkbenchAttachmentAsset, WorkbenchAttachmentValue, WorkbenchEditorPublication,
  QuickPrepared, QuickLearningStatus,
} from '@deepseek-ai/dsh-workbench-assistant/types'

export type WorkView = 'chat' | 'writing' | 'development'
export type EditorMode = Exclude<WorkView, 'chat'>
export type EditorFocus = 'chat' | 'editor'
export type EditorPane = 'visual' | 'source' | 'pdf'

export interface FileSnapshot {
  path: string
  absolutePath: string
  text: string
  version: string
  bytes: number
}

export interface FileEntry {
  name: string
  type: 'file' | 'directory' | 'other'
  size?: number
}

export interface SelectionSnapshot {
  path: string
  from: number
  to: number
  selectedText: string
  contextBefore: string
  contextAfter: string
  bufferVersion: string
  lineFrom: number
  lineTo: number
  origin?: 'source' | 'visual' | 'pdf'
  objectKind?: 'text' | 'formula' | 'figure' | 'table' | 'code' | 'insertion'
  nodeId?: string
  assetPaths?: readonly string[]
  attachmentAssets?: readonly WorkbenchAttachmentAsset[]
  insertionKind?: 'figure' | 'table'
  page?: number
}

export interface EditProposal {
  replacement: string
  explanation: string
  base: Pick<SelectionSnapshot, 'path' | 'from' | 'to' | 'selectedText' | 'bufferVersion'>
    & Partial<Pick<SelectionSnapshot, 'objectKind' | 'nodeId' | 'assetPaths' | 'attachmentAssets'>>
  structured?: { kind: 'figure'; assetPath: string; caption: string; label?: string }
    | { kind: 'table'; headers: readonly string[]; rows: readonly (readonly string[])[]; caption?: string; label?: string; alignment?: readonly ('l' | 'c' | 'r')[] }
  labelChanges?: readonly { from: string; to: string }[]
}

export interface AssistantAction {
  actionId: string
  state: 'queued' | 'generating' | 'proposed' | 'completed' | 'cancelled' | 'failed'
  proposal?: EditProposal
  error?: string
  errorCode?: 'setup-failed' | 'model-failed' | 'no-answer' | 'no-proposal'
  pollError?: string
  reviewed?: 'accepted' | 'rejected' | 'partial'
  reviewBaseVersion?: string
  acceptedParts?: number
}

export interface Diagnostic {
  path: string
  line: number
  column?: number
  severity: 'error' | 'warning'
  message: string
}

export interface JobSnapshot {
  id: string
  state: 'running' | 'succeeded' | 'failed' | 'cancelled'
  kind: string
  path: string
  output: string
  error?: string
  pollError?: string
  exitCode?: number | null
  diagnostics: Diagnostic[]
  artifacts?: { path: string; version: string }[]
  pdf?: { path: string; sourcePath: string; version: string; builtAt: string; sourceVersion: string }
}

export interface PdfSnapshot {
  wordRegions?: WordPageRegion[] | undefined
  data: Uint8Array
  path: string
  sourcePath: string
  version: string
  sourceVersion: string
  builtAt: string
  inputs: { path: string; version: string }[]
  stale: boolean
}

export interface RunRequest {
  kind: 'latex' | 'python' | 'command'
  path: string
  recipe?: 'auto' | 'latexmk' | 'pdflatex' | 'xelatex' | 'lualatex'
  command?: string
  args?: string[]
  cwd?: string
}

/** All I/O is supplied by the authenticated Harness remote composition. */
export interface WorkbenchIO {
  rejectQuick?: (sessionId: SessionId, instruction: string, requestId: string, path: string, selectedText: string, reason: string) => Promise<import('@deepseek-ai/dsh-workbench-assistant/types').QuickPrepared>
  quickEdit?(sessionId: SessionId, instruction: string, signal: AbortSignal, requestId: string, reply?: import('@deepseek-ai/dsh-workbench-assistant/types').QuickReply): Promise<QuickPrepared | null>
  completeQuickEdit?(sessionId: SessionId, requestId: string, error: string | null): Promise<{ kind: 'success' | 'error'; text: string }>
  claimAgentOperation?(sessionId: SessionId, requestId: string, editorId: string): Promise<QuickPrepared | null>
  quickLearning?(sessionId: SessionId, action: 'inspect' | 'pause' | 'resume' | 'clear'): Promise<QuickLearningStatus>
  word?: {
    commit?(sessionId: SessionId, request: WordBinaryCommit): Promise<WordSnapshot>
    resolveOperation?(sessionId: SessionId, id: string, requestId: string, error: string | null): Promise<void>
    resources?(sessionId: SessionId, families: string[]): Promise<WordResources>
    open(sessionId: SessionId, path: string, create: boolean, recovery: WordCheckpoint | null): Promise<WordSnapshot>
    mutate(sessionId: SessionId, request: WordMutation): Promise<WordSnapshot>
    save(sessionId: SessionId, id: string, revision: number, requestId: string, path: string | null): Promise<WordSnapshot>
    proof(sessionId: SessionId, id: string, revision: number, cached: boolean,
      reference: WordProofReference | null): Promise<WordProof | null>
    stop(sessionId: SessionId, id: string): Promise<void>
    checkpoint?(sessionId: SessionId, id: string): Promise<WordSnapshot>
    close(sessionId: SessionId, id: string, discard?: boolean): Promise<void>
  }
  publishEditor(publication: WorkbenchEditorPublication): Promise<void>
  attachment(sessionId: SessionId, actionId: string, path: string): Promise<WorkbenchAttachmentValue>
  read(sessionId: SessionId, path: string): Promise<FileSnapshot>
  preview(sessionId: SessionId, path: string): void
  environments(sessionId: SessionId): Promise<{ python: string[]; cpp: string[]; cuda: string[]; matlab: string[] }>
  asset(sessionId: SessionId, path: string, sourcePath: string, graphicsPaths: string[]): Promise<{
    path: string
    version: string
    mimeType: string
    data: Uint8Array
  }>
  stat(sessionId: SessionId, path: string): Promise<{ path: string; absolutePath: string; version: string; bytes?: number }>
  save(sessionId: SessionId, request: {
    path: string
    text: string
    version: string | null
    expectedPath?: string
    assets?: readonly StagedAssetPayload[]
  }): Promise<FileSnapshot>
  assetRecovery(sessionId: SessionId): Promise<WorkbenchAssetRecovery>
  list(sessionId: SessionId, path: string): Promise<{ workspaceRoot: string; path: string; entries: FileEntry[]; truncated: boolean }>
  start(sessionId: SessionId, request: RunRequest): Promise<JobSnapshot>
  current(sessionId: SessionId): Promise<JobSnapshot | null>
  status(sessionId: SessionId, jobId: string): Promise<JobSnapshot>
  stop(sessionId: SessionId, jobId: string): Promise<JobSnapshot>
  pdf(sessionId: SessionId, path: string): Promise<PdfSnapshot | null>
  synctexForward(sessionId: SessionId, path: string, line: number, column: number, rootPath?: string): Promise<{
    page: number
    x: number
    y: number
    width: number
    height: number
  }>
  synctexReverse(sessionId: SessionId, path: string, page: number, x: number, y: number): Promise<{
    path: string
    line: number
    column: number
  }>
  request(request: { sessionId: SessionId; requestId: string; mode: 'ask' | 'edit' | 'assist'; instruction: string }
    & Pick<SelectionSnapshot, 'path' | 'from' | 'to' | 'selectedText' | 'contextBefore' | 'contextAfter' | 'bufferVersion'>
    & Partial<Pick<SelectionSnapshot, 'objectKind' | 'nodeId' | 'assetPaths'>>): Promise<AssistantAction>
  getAction(sessionId: SessionId, actionId: string): Promise<AssistantAction>
  cancelAction(sessionId: SessionId, actionId: string): Promise<AssistantAction>
  review(sessionId: SessionId, actionId: string, decision: 'accepted' | 'rejected' | 'partial', appliedText?: string, baseVersion?: string): Promise<void>
}

export interface PendingWordInput {
  text: string
  document: string
  request?: WordMutation | undefined
  recovered?: boolean | undefined
}

/** Word text fields describe the editing projection, never serialized DOCX bytes. */
export type EditorBuffer = EditorBufferBase & (
  | { kind?: 'text'; word?: never; pendingWord?: never; wordSync?: never }
  | { kind: 'word'; word: WordSnapshot; wordProof?: WordProofReference | undefined; pendingWord?: PendingWordInput | undefined; wordSync: 'idle' | 'pending' | 'syncing' | 'failed' }
)
export type WordEditorBuffer = Extract<EditorBuffer, { kind: 'word' }>
interface EditorBufferBase {
  mode: EditorMode
  path: string
  absolutePath: string
  savedRawText: string
  text: string
  savedText: string
  diskVersion: string | null
  lineEnding: 'lf' | 'crlf'
  revision: number
  selection: { from: number; to: number }
  editorState?: string
  visualState?: string
  scrollTop: number
  visualScrollTop?: number | undefined
  pane?: EditorPane | undefined
  /** Unreadable restoration placeholders cannot save or publish model context. */
  unavailable?: boolean
  restoredDraft?: boolean
  saveState: 'clean' | 'dirty' | 'saving' | 'error' | 'conflict'
  error?: string | undefined
  external?: FileSnapshot | undefined
  edit?: { id: number; from: number; to: number; insert: string }
}

export interface StagedAssetInfo {
  /** Content SHA-256 assigned by the existing browser asset staging store. */
  id: string
  name: string
  path: string
  size: number
  mimeType: string
  url: string
}

export interface WorkbenchSnapshot {
  closePrompt?: string | null
  closeBusy?: boolean
  workspaceRoot: string | null
  mode: WorkView
  focus: EditorFocus
  chatWidth: number
  proposalHeight?: number
  wordProofBusy?: string | null
  fontSize: number
  codeFontSize: number
  wrap: boolean
  mainFile: string
  browserOpen: boolean
  browserPath: string
  entries: FileEntry[]
  filesLoading: boolean
  activePaths: Record<EditorMode, string | null>
  buffers: Readonly<Record<string, EditorBuffer>>
  selection: SelectionSnapshot | null
  selectionMode: 'ask' | 'edit' | 'assist'
  instruction: string
  action: AssistantAction | null
  panes: Record<EditorMode, EditorPane>
  job: JobSnapshot | null
  outputOpen: boolean
  pdf: PdfSnapshot | null
  pdfSourcePath: string | null
  pdfDirty: boolean
  pdfTarget: { page: number; x: number; y: number; width: number; height: number; token: number } | null
  sourceTarget: { path: string; from: number; to: number; token: number } | null
  error: string | null
  restoring: boolean
  recoveryError: string | null
  pdfPositions: Record<string, { page: number; offset: number; left: number; zoom: 'fit' | number }>
  stagedAssets: readonly StagedAssetInfo[]
  assetRecovery: WorkbenchAssetRecovery | null
}

/** Captured before a picker takes focus; changes to the document or workspace invalidate it. */
export interface InsertionTarget {
  path: string
  workspaceRoot: string | null
  revision: number
  selection: { from: number; to: number }
}

/** Plain operation callbacks used by each workbench slot. */
export interface WorkbenchActions {
  learning(action: 'inspect' | 'pause' | 'resume' | 'clear'): Promise<QuickLearningStatus>
  setMode(mode: WorkView): void
  setFocus(focus: EditorFocus): void
  setChatWidth(width: number): void
  setProposalHeight(height: number): void
  wordNavigate(path: string, from: number, to: number): void
  wordMount(path: string, element: HTMLElement): () => void
  wordEdit(path: string, text: string, document: string, selection: { from: number; to: number },
    scrollTop: number, view: string, composing?: boolean): void
  wordMutate(path: string, operation: WordOperation): Promise<void>
  wordResume(path: string): Promise<void>
  setFontSize(size: number): void
  setWrap(wrap: boolean): void
  setMainFile(path: string): void
  setBrowserOpen(open: boolean): void
  list(path: string): Promise<void>
  open(path: string): Promise<void>
  create(path: string): Promise<void>
  close(path: string, decision?: 'save' | 'discard' | 'cancel'): void
  edit(path: string, text: string, selection: { from: number; to: number }, editorState: string, scrollTop: number, surface?: 'source' | 'visual'): void
  save(path?: string): Promise<void>
  saveAs(path: string): Promise<void>
  checkExternal(): Promise<void>
  reloadExternal(): void
  select(mode: 'ask' | 'edit' | 'assist'): void
  /** Without a target use the current caret; a supplied target must still match its captured document and workspace. */
  prepareInsertion(kind: 'figure' | 'table', assetPath?: string, target?: InsertionTarget): void
  queryReferences(kind: 'citation' | 'label', sourcePath: string): Promise<ReferenceCatalog>
  selectPdf(text: string, page: number): void
  clearSelection(): void
  setInstruction(text: string): void
  ask(): Promise<void>
  cancel(): Promise<void>
  accept(index?: number): void
  discard(): void
  refine(): void
  locateSelection(): void
  setPane(pane: EditorPane): void
  setOutputOpen(open: boolean): void
  run(request: RunRequest): Promise<void>
  stop(): Promise<void>
  /** Reuse the current Word page or its saved proof before paginating when requested. */
  refreshPdf(reuseWordPage?: boolean): Promise<void>
  locatePdf(): Promise<void>
  locateSource(page: number, x: number, y: number): Promise<void>
  locateDiagnostic(diagnostic: Diagnostic): Promise<void>
  environments(): Promise<{ python: string[]; cpp: string[]; cuda: string[]; matlab: string[] }>
  resolveAsset(path: string, sourcePath: string, graphicsPaths: string[]): Promise<{ url: string; mimeType: string }>
  importAsset(name: string, blob: Blob): Promise<StagedAssetInfo>
  discardStagedAsset(id: string): Promise<void>
  refreshAssets(): Promise<void>
  inspectAssetRecovery(): Promise<void>
  clearError(): void
  retryRecovery(): Promise<void>
  setPdfPosition(position: { page: number; offset: number; left: number; zoom: 'fit' | number }): void
}

/** Injected values stay plain; the framework creates the observing hook. */
export interface WorkbenchInjected extends WorkbenchActions {
  hooks: { workbench: ObservableSnapshot<WorkbenchSnapshot> }
}
