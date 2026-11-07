/** Word-specific wire data. Text is an editing projection, never a DOCX serialization. */
export interface WordRun {
  from: number
  to: number
  bold?: boolean | undefined
  italic?: boolean | undefined
  underline?: boolean | undefined
  font?: string | undefined
  size?: number | undefined
}
export interface WordBlock {
  id: string
  kind: 'paragraph' | 'protected' | 'image'
  from: number
  to: number
  text: string
  style: string
  level: number
  alignment: number
  spaceBefore: number
  spaceAfter: number
  lineSpacing?: number | undefined
  pagination?: {
    pageBreakBefore?: boolean | undefined
    keepNext?: boolean | undefined
    keepLines?: boolean | undefined
    explicitBreaks: number
    sectionBreak: boolean
  } | undefined
  list?: string | undefined
  runs: WordRun[]
  reason?: string | undefined
  image?: { width: number; height: number; data?: string | undefined } | undefined
  table?: { id: string; row: number; column: number; rows: number; columns: number; autoFit?: 'content' | 'window' | undefined; autoRowHeight?: boolean | undefined } | undefined
}
export interface WordProjection {
  blocks: WordBlock[]
  text: string
  styles: string[]
  canUndo: boolean
  canRedo: boolean
  readOnly?: string | null | undefined
}
export interface WordCheckpoint {
  id: string
  checkpoint: string
  checkpointHash: string
  revision: number
}
export interface WordSnapshot extends WordCheckpoint {
  /** Native OOXML bytes in transit only; durable scenes keep the checkpoint reference. */
  data?: string | undefined
  engine?: 'ooxml' | undefined
  pendingOperations?: WordMutation[] | undefined
  path: string
  absolutePath: string
  workspaceRoot: string
  revision: number
  savedRevision: number
  checkpointTime: number
  diskVersion: string | null
  /** Original-file check performed when restoring; absence means the baseline matched. */
  originalStatus?: 'conflict' | 'unavailable' | undefined
  projection: WordProjection
}
export interface WordRange { from: number; to: number; before?: string }
/** Bounded native commands exposed to the live editor; no script execution or arbitrary member lookup. */
export type WordNativeCommand =
  | { type: 'autoFitTable'; mode: 'content' | 'window'; resetRowHeights?: boolean | undefined }
  | { type: 'clearFormatting' | 'deleteRow' | 'deleteColumn' | 'deleteTable' | 'mergeCells' | 'insertToc' | 'removeHyperlink' | 'copyFormatting' | 'pasteFormatting' }
  | { type: 'insertBreak'; kind: 'page' | 'line' | 'section' | 'sectionContinuous' }
  | { type: 'insertTable' | 'splitCell'; rows: number; cols: number }
  | { type: 'insertRow'; where: 'above' | 'below' }
  | { type: 'insertColumn'; where: 'left' | 'right' }
  | { type: 'selectTableRegion'; region: 'table' | 'row' | 'column' }
  | { type: 'setTableCellVerticalAlignment'; alignment: 'top' | 'center' | 'bottom' }
  | { type: 'setTableProperties'; styleId?: string | undefined; headerRowCount?: number | undefined; columnWidthsTwips?: number[] | undefined }
  | { type: 'setParagraphPagination'; pageBreakBefore?: boolean | undefined; keepNext?: boolean | undefined; keepLines?: boolean | undefined }
  | { type: 'setIndent'; left?: number | undefined; right?: number | undefined; firstLine?: number | undefined }
  | { type: 'setPageSetup'; pageWidth?: number | undefined; pageHeight?: number | undefined; marginTop?: number | undefined; marginRight?: number | undefined; marginBottom?: number | undefined; marginLeft?: number | undefined; orientation?: 'portrait' | 'landscape' | undefined; scope?: 'document' | 'section' | undefined }
  | { type: 'replaceAllMatches'; query: string; text: string; matchCase?: boolean | undefined; wholeWord?: boolean | undefined }
  | { type: 'insertHyperlink'; href: string; text?: string | undefined }
  | { type: 'insertBookmark' | 'deleteBookmark' | 'goToBookmark'; name: string }
  | { type: 'refreshToc'; mode: 'entire' | 'pageNumbers' }
  | { type: 'setImageWrapType'; target: 'inline' | 'square' | 'squareLeft' | 'squareRight' | 'tight' | 'through' | 'topAndBottom' | 'behind' | 'inFront'; drawingNodeId?: string | undefined }
  | { type: 'transformImage'; action: 'rotateCW' | 'rotateCCW' | 'flipH' | 'flipV'; drawingNodeId?: string | undefined }
  | { type: 'deleteImage'; drawingNodeId?: string | undefined }
/** Bounded page-region inspection of the last confirmed checkpoint. */
export interface WordPageInfo {
  revision: number
  savedRevision: number
  sectionCount: number
  sectionsTruncated: boolean
  sections: {
    sectionIndex: number
    firstPageDifferent: boolean
    oddEvenDifferent: boolean
    headerDistancePt: number
    footerDistancePt: number
    regions: {
      position: 'header' | 'footer'
      variant: 'default' | 'first' | 'even'
      text: string
      truncated: boolean
      fields: string[]
      inherited: boolean
      complex: boolean
    }[]
  }[]
  pendingRequestIds: string[]
  completed: { requestId: string; revision: number; error: string | null }[]
}

/** Built-in paragraph policy, persisted in the DOCX styles rather than a UI preference. */
export interface WordStyleFormat {
  level: number
  font?: string | undefined
  size?: number | undefined
  bold?: boolean | undefined
  alignment?: number | undefined
  spaceBefore?: number | undefined
  spaceAfter?: number | undefined
  lineSpacing?: number | undefined
}
export type WordOperation =
  | ({ kind: 'native'; command: WordNativeCommand; preserveSelection?: boolean | undefined } & WordRange)
  | { kind: 'header-footer'; sectionIndex: number; position: 'header' | 'footer'; variant: 'default' | 'first' | 'even'; content: string; expectedText: string; alignment?: 'left' | 'center' | 'right' | undefined; font?: string | undefined; size?: number | undefined }
  | { kind: 'page-options'; sectionIndex: number; firstPageDifferent?: boolean | undefined; oddEvenDifferent?: boolean | undefined; headerDistancePt?: number | undefined; footerDistancePt?: number | undefined }
  | { kind: 'configure-styles'; styles: WordStyleFormat[] }
  | ({ kind: 'replace'; text: string } & WordRange)
  | ({
    kind: 'format'
    preserveSelection?: boolean | undefined
    bold?: boolean | undefined
    italic?: boolean | undefined
    underline?: boolean | undefined
    strike?: boolean | undefined
    script?: 'baseline' | 'superscript' | 'subscript' | undefined
    color?: string | undefined
    highlight?: string | undefined
    font?: string | undefined
    size?: number | undefined
    style?: string | undefined
    headingLevel?: number | undefined
    lineSpacing?: number | undefined
    alignment?: number | undefined
    spaceBefore?: number | undefined
    spaceAfter?: number | undefined
    list?: 'bullet' | 'number' | 'none' | undefined
  } & WordRange)
  | ({
    kind: 'image'
    path: string
    caption: string
    width?: number | undefined
    data?: string | undefined
    sha256?: string
  } & WordRange)
  | ({ kind: 'table'; rows: string[][]; caption?: string } & WordRange)
  | { kind: 'resize-image'; nodeId: string; width: number }
  | { kind: 'undo' | 'redo' }
export interface WordMutation {
  documentId: string
  requestId: string
  revision: number
  operation: WordOperation
}
/** Live notification of a worker-owned queued operation; carries no document bytes. */
export type WordOperationNotice = { kind: 'ready' } | { kind: 'queued' | 'saved'; path: string; documentId: string; revision: number }
/** Durable proof identity; bytes stay outside scene JSON. */
export interface WordProofReference { revision: number; version: string }
/** Complete persisted references for one authenticated Session and Workspace. */
export interface WordRetention {
  workspaceRoot: string
  documents: { id: string; checkpoints: WordCheckpoint[]; proofs: WordProofReference[] }[]
}
export interface WordRetentionResult { deleted: number; failures: string[] }
/** Editable paragraph locations in native Word page points; regenerated for the current revision. */
export interface WordPageRegion {
  id: string
  page: number
  x: number
  y: number
  width: number
  height: number
  font: string
  size: number
  alignment: number
}
export interface WordProof {
  regions: WordPageRegion[]
  revision: number
  data: Uint8Array
  version: string
  builtAt: string
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'word/failure': { reason: string; diagnostic?: string }
  }
}

/** Serialized output of the sole client editor, committed against an acknowledged revision. */
export interface WordBinaryCommit {
  nextRevision: number
  documentId: string
  requestId: string
  revision: number
  data: string
  sha256: string
  projection: WordProjection
  queuedRequestId?: string | undefined
}
export interface WordResources {
  wasm: string
  fonts: { family: string; weight: number; style: 'normal' | 'italic'; data: string; sha256: string; faceIndex: number }[]
  missing: string[]
}
