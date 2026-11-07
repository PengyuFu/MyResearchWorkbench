/** Half-open UTF-16 offsets into one unchanged TeX source string. */
export interface LatexRange {
  from: number
  to: number
  raw: string
}

/** A source-backed field; braces and surrounding commands lie outside its content range. */
export interface LatexField extends LatexRange {
  contentFrom: number
  contentTo: number
  text: string
  inline: LatexInline[]
}

/** Inline editing units retain their exact source until explicitly changed. */
export interface LatexInline extends LatexRange {
  kind: 'text' | 'math' | 'citation' | 'reference' | 'linebreak' | 'opaque'
  contentFrom: number
  contentTo: number
  text: string
  latex?: string
  key?: string
  command?: string
  marks?: ('bold' | 'italic' | 'code' | 'superscript' | 'subscript')[]
  children?: LatexInline[]
  textMap?: number[]
}

/** One physical tabular cell, including empty slots covered by an earlier span. */
export interface LatexTableCell extends LatexField {
  row: number
  col: number
  rowspan: number
  colspan: number
  covered: boolean
  alignment: string
  spanArguments?: { row?: LatexRange; col?: LatexRange }
}

/** A tabular row with its original separators and terminator retained. */
export interface LatexTableRow extends LatexRange {
  cells: LatexTableCell[]
  terminatorFrom: number
  terminatorTo: number
}

/** The exact tabular region inside the original table and layout wrappers. */
export interface LatexTable extends LatexRange {
  contentFrom: number
  contentTo: number
  columns: number
  columnSpec: LatexRange
  rows: LatexTableRow[]
}

/** Image path and options are independent editable source ranges. */
export interface LatexImage extends LatexRange {
  path: string
  contentFrom: number
  contentTo: number
  options?: LatexRange
}

/** One editable block projected from the source; unknown syntax remains explicit. */
export interface LatexNode extends LatexRange {
  id: string
  file: string
  kind: 'text' | 'heading' | 'field' | 'math' | 'figure' | 'table' | 'include' | 'opaque'
  contentFrom: number
  contentTo: number
  inline: LatexInline[]
  field?: string
  level?: number
  ordered?: boolean
  math?: string
  mathEmbeddedLabels?: LatexField[]
  environment?: string
  caption?: LatexField
  label?: LatexField
  images?: LatexImage[]
  table?: LatexTable
  rows?: LatexTableRow[]
  notes?: LatexField[]
  path?: string
  editable: boolean
}

/** A syntax or reference issue tied to a specific original source range. */
export interface LatexDiagnostic extends LatexRange {
  code: string
  message: string
  severity: 'warning' | 'error'
}

/** An immutable projection; the TeX source remains the document authority. */
export interface LatexDocument {
  file: string
  source: string
  nodes: LatexNode[]
  labels: { key: string; nodeId: string; from: number; to: number }[]
  includes: { path: string; command: string; from: number; to: number }[]
  graphicsPaths: string[]
  bibliography: string[]
  diagnostics: LatexDiagnostic[]
}

/** Replaces only the named range; expected rejects coordinates from an old source. */
export interface LatexPatch {
  from: number
  to: number
  insert: string
  expected?: string
}
