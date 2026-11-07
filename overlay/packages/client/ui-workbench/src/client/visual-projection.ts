/** Pure conversion between the visual editor JSON and bounded TeX source edits. */
import {
  applyLatexPatches, createLatexMathPatch, inlineOffsetToSource, parseLatexDocument,
  parseLatexInline, serializeLatexTable, textToLatex,
} from './latex-source.ts'
import type { LatexDocument, LatexField, LatexImage, LatexInline, LatexNode, LatexPatch, LatexTable, LatexTableCell, LatexTableRow } from './latex-source.types.ts'

/** Editor-owned JSON attributes; source objects are immutable edit bases. */
export interface VisualAttrs {
  base?: LatexDocument
  sourceId?: string | null
  token?: LatexInline | null
  sourceCell?: LatexTableCell | null
  sourceImage?: LatexImage | null
  level?: number
  field?: string
  latex?: string
  label?: string
  environment?: string
  path?: string
  imageIndex?: number
  sourceIndex?: number
  colspan?: number
  rowspan?: number
  colwidth?: number[] | null
  header?: boolean
  key?: string
  kind?: string
  command?: string
  raw?: string
  text?: string
  [name: string]: unknown
}

/** The JSONContent-compatible subset used by the manuscript schema. */
export interface VisualNode {
  type?: string
  attrs?: VisualAttrs
  content?: VisualNode[]
  text?: string
  marks?: { type: string; attrs?: VisualAttrs }[]
}

/** Maps one visual interval to UTF-16 offsets in the compiled source. */
export interface VisualSourceMap {
  from: number
  to: number
  offsets: number[]
  atomic?: boolean
  root?: boolean
}

/** Current source plus exact leaf maps used for selection and diagnostic navigation. */
export interface CompiledVisualDocument {
  source: string
  maps: VisualSourceMap[]
}

interface Serialized { text: string; maps: VisualSourceMap[] }

function textNode(text: string): VisualNode[] { return text ? [{ type: 'text', text }] : [] }

function projectInline(tokens: readonly LatexInline[]): VisualNode[] {
  return tokens.flatMap<VisualNode>((token) => {
    if (token.kind === 'text') {
      if (token.children) return [{ type: 'inlineGroup', attrs: { token }, content: projectInline(token.children) }]
      return token.text ? [{ type: 'text', text: token.text, marks: [{ type: 'sourceMark', attrs: { token } }] }] : []
    }
    if (token.kind === 'math') return [{ type: 'mathInline', attrs: { token, latex: token.latex ?? token.text } }]
    if (token.kind === 'reference' || token.kind === 'citation') return [{ type: 'reference', attrs: { token, key: token.key ?? token.text, kind: token.kind, ...(token.command ? { command: token.command } : {}) } }]
    if (token.kind === 'linebreak') return [{ type: 'hardBreak', attrs: { token, raw: token.raw } }]
    return [{ type: 'opaqueInline', attrs: { token, text: token.text } }]
  })
}

function projectField(type: string, field: LatexField, attrs: VisualAttrs = {}): VisualNode {
  return { type, attrs, content: projectInline(field.inline) }
}

function projectRoot(node: LatexNode): VisualNode {
  const attrs = { sourceId: node.id }
  if (node.kind === 'text') return { type: 'paragraph', attrs, content: projectInline(node.inline) }
  if (node.kind === 'heading') return { type: 'heading', attrs: { ...attrs, level: node.level ?? 1 }, content: projectInline(node.inline) }
  if (node.kind === 'field') return { type: 'field', attrs: { ...attrs, field: node.field ?? 'title' }, content: projectInline(node.inline) }
  if (node.kind === 'math') return { type: 'mathBlock', attrs: { ...attrs, latex: node.math ?? '', label: node.label?.text ?? '', environment: node.environment ?? 'equation' } }
  if (node.kind === 'include') return { type: 'includeBlock', attrs: { ...attrs, path: node.path ?? '' } }
  if (node.kind === 'opaque' || !node.editable) return { type: 'opaqueBlock', attrs: { ...attrs, text: node.raw } }
  const content: VisualNode[] = []
  if (node.kind === 'figure') {
    for (const [imageIndex, image] of (node.images ?? []).entries()) content.push({ type: 'image', attrs: { path: image.path, imageIndex, sourceImage: image } })
  }
  if (node.caption) content.push(projectField('caption', node.caption))
  if (node.table) {
    content.push({ type: 'table', content: node.table.rows.map((row, index) => ({
      type: 'tableRow', content: row.cells.filter(cell => !cell.covered).map(cell => ({
        type: 'tableCell', attrs: { colspan: cell.colspan, rowspan: cell.rowspan, colwidth: null, sourceCell: cell, header: index === 0 },
        content: [{ type: 'paragraph', content: projectInline(cell.inline) }],
      })),
    })) })
  }
  if (node.label) content.push({ type: 'label', content: textNode(node.label.text) })
  for (const [sourceIndex, note] of (node.notes ?? []).entries()) content.push(projectField('note', note, { sourceIndex }))
  if (!content.length) content.push({ type: 'paragraph', content: [] })
  return { type: node.kind === 'figure' ? 'figure' : 'tableObject', attrs, content }
}

/** Creates editor JSON without altering the source or storing a second manuscript.
 * @param document Current immutable TeX projection.
 * @returns A visual document whose original text remains recoverable from source tokens.
 */
export function projectVisualDocument(document: LatexDocument): VisualNode {
  return { type: 'doc', attrs: { base: document }, content: document.nodes.map(projectRoot) }
}

/** Computes ProseMirror nodeSize for the declared manuscript schema. */
export function visualNodeSize(node: VisualNode): number {
  if (node.type === 'text') return node.text?.length ?? 0
  if (['mathInline', 'reference', 'hardBreak', 'opaqueInline', 'mathBlock', 'image', 'opaqueBlock', 'includeBlock'].includes(node.type ?? '')) return 1
  const contents = (node.content ?? []).reduce((sum, child) => sum + visualNodeSize(child), 0)
  return node.type === 'doc' ? contents : contents + 2
}

function shifted(maps: readonly VisualSourceMap[], amount: number): VisualSourceMap[] {
  return maps.map(map => ({ ...map, offsets: map.offsets.map(offset => offset + amount) }))
}

function combine(parts: readonly Serialized[], separator = ''): Serialized {
  const result: Serialized = { text: '', maps: [] }
  for (const [index, part] of parts.entries()) {
    if (index) result.text += separator
    result.maps.push(...shifted(part.maps, result.text.length))
    result.text += part.text
  }
  return result
}

function displayOffsets(latex: string, displayedLength: number): number[] {
  const tokens = parseLatexInline(latex)
  const result: number[] = []
  for (const token of tokens) {
    for (let at = 0; at < token.text.length; at++) result.push(inlineOffsetToSource(token, at))
  }
  const last = tokens.at(-1)
  result.push(last ? inlineOffsetToSource(last, last.text.length) : 0)
  if (result.length !== displayedLength + 1) throw new Error('VISUAL_TEXT_MAPPING')
  return result
}

function markText(value: string, node: VisualNode): string {
  const names: Record<string, string> = { bold: 'textbf', italic: 'emph', code: 'texttt', superscript: 'textsuperscript', subscript: 'textsubscript' }
  let text = value
  for (const mark of node.marks ?? []) if (names[mark.type]) text = `\\${names[mark.type]}{${text}}`
  return text
}

function sourceToken(node: VisualNode): LatexInline | undefined {
  return node.marks?.find(mark => mark.type === 'sourceMark')?.attrs?.token ?? undefined
}

function sameToken(left: LatexInline | undefined, right: LatexInline | undefined): boolean {
  return left === right || (!!left && !!right && left.from === right.from && left.to === right.to && left.kind === right.kind)
}

function serializeTextRun(nodes: readonly VisualNode[], from: number, token: LatexInline | undefined): Serialized {
  const text = nodes.map(node => node.text ?? '').join('')
  const oldText = token?.text ?? ''
  let prefix = 0
  while (prefix < text.length && prefix < oldText.length && text[prefix] === oldText[prefix]) prefix++
  if (prefix > 0 && /[\uDC00-\uDFFF]/.test(text[prefix] ?? '')) prefix--
  let suffix = 0
  while (suffix < text.length - prefix && suffix < oldText.length - prefix
    && text[text.length - suffix - 1] === oldText[oldText.length - suffix - 1]) suffix++
  if (suffix > 0 && /[\uDC00-\uDFFF]/.test(text[text.length - suffix] ?? '')) suffix--
  let visualAt = from
  let displayAt = 0
  const parts: Serialized[] = []
  for (const node of nodes) {
    const value = node.text ?? ''
    const begin = displayAt
    const end = begin + value.length
    let latex = ''
    const oldSlice = (source: LatexInline, start: number, stop: number) => source.raw.slice(
      inlineOffsetToSource(source, start) - source.from, inlineOffsetToSource(source, stop) - source.from)
    if (token && begin < prefix) latex += oldSlice(token, begin, Math.min(end, prefix))
    const changedFrom = Math.max(begin, prefix)
    const changedTo = Math.min(end, text.length - suffix)
    if (changedTo > changedFrom) latex += textToLatex(text.slice(changedFrom, changedTo))
    if (token && end > text.length - suffix) {
      const start = Math.max(begin, text.length - suffix)
      latex += oldSlice(token, start + oldText.length - text.length, end + oldText.length - text.length)
    }
    latex = markText(latex, node)
    parts.push({ text: latex, maps: [{ from: visualAt, to: visualAt + value.length, offsets: displayOffsets(latex, value.length) }] })
    visualAt += value.length
    displayAt = end
  }
  return combine(parts)
}

function serializeInline(nodes: readonly VisualNode[], from: number): Serialized {
  const parts: Serialized[] = []
  let at = from
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]
    if (node === undefined) throw new Error('VISUAL_INLINE_TYPE:undefined')
    if (node.type === 'text') {
      const run = [node]
      const token = sourceToken(node)
      while (index + 1 < nodes.length) {
        const next = nodes[index + 1]
        if (next?.type !== 'text' || !sameToken(token, sourceToken(next))) break
        run.push(next)
        index++
      }
      const part = serializeTextRun(run, at, token)
      parts.push(part)
      at += run.reduce((sum, entry) => sum + (entry.text?.length ?? 0), 0)
      continue
    }
    const token = node.attrs?.token ?? undefined
    let text: string
    let maps: VisualSourceMap[] = []
    if (node.type === 'inlineGroup') {
      const body = serializeInline(node.content ?? [], at + 1)
      const prefix = token ? token.raw.slice(0, token.contentFrom - token.from) : '{'
      const suffix = token ? token.raw.slice(token.contentTo - token.from) : '}'
      text = prefix + body.text + suffix
      maps = shifted(body.maps, prefix.length)
      maps.push({ from: at, to: at + visualNodeSize(node), offsets: [0, text.length], atomic: true })
    } else if (node.type === 'mathInline') {
      const latex = node.attrs?.latex ?? token?.latex ?? ''
      text = token ? token.raw.slice(0, token.contentFrom - token.from) + latex + token.raw.slice(token.contentTo - token.from) : `$${latex}$`
    } else if (node.type === 'reference') {
      const key = node.attrs?.key ?? token?.key ?? ''
      if (/[{}\\\r\n]/.test(key)) throw new Error('VISUAL_REFERENCE_KEY')
      text = token ? token.raw.slice(0, token.contentFrom - token.from) + key + token.raw.slice(token.contentTo - token.from) : `\\${node.attrs?.command ?? (node.attrs?.kind === 'citation' ? 'citep' : 'ref')}{${key}}`
    } else if (node.type === 'hardBreak') text = token?.raw ?? node.attrs?.raw ?? '\\\\'
    else if (node.type === 'opaqueInline') text = token?.raw ?? node.attrs?.raw ?? textToLatex(node.attrs?.text ?? '')
    else throw new Error(`VISUAL_INLINE_TYPE:${node.type}`)
    if (node.type !== 'inlineGroup') maps.push({ from: at, to: at + visualNodeSize(node), offsets: [0, text.length], atomic: true })
    parts.push({ text, maps })
    at += visualNodeSize(node)
  }
  return combine(parts)
}

function childrenWithPositions(node: VisualNode, from: number): { node: VisualNode; from: number }[] {
  let at = from + 1
  return (node.content ?? []).map((child) => { const current = { node: child, from: at }; at += visualNodeSize(child); return current })
}

function literalText(node: VisualNode): string {
  return node.text ?? (node.content ?? []).map(literalText).join('')
}

function fieldPatch(field: LatexField, value: string): LatexPatch {
  return {
    from: field.contentFrom, to: field.contentTo,
    expected: field.raw.slice(field.contentFrom - field.from, field.contentTo - field.from), insert: value,
  }
}

function ownedEnd(node: LatexNode): number { return Math.max(node.to, node.label?.to ?? node.to) }

function patchObject(base: LatexDocument, node: LatexNode, patches: readonly LatexPatch[]): string {
  const raw = base.source.slice(node.from, ownedEnd(node))
  return applyLatexPatches(raw, patches.map(patch => ({ ...patch, from: patch.from - node.from, to: patch.to - node.from })))
}

function validKey(value: string): string {
  if (/[{}\\\r\n]/.test(value)) throw new Error('VISUAL_REFERENCE_KEY')
  return value
}

function validPath(value: string): string {
  if (/[{}\r\n]/.test(value)) throw new Error('VISUAL_ASSET_PATH')
  return value.replace(/\\/g, '/')
}

function serializeCellContent(cell: VisualNode, from: number): Serialized {
  const parts = childrenWithPositions(cell, from).map((child) => {
    if (child.node.type !== 'paragraph') throw new Error('VISUAL_TABLE_CELL_BLOCK')
    return serializeInline(child.node.content ?? [], child.from + 1)
  })
  if (parts.length <= 1) return parts[0] ?? { text: '', maps: [] }
  const body = combine(parts, '\\\\')
  const prefix = '\\shortstack[l]{'
  return { text: prefix + body.text + '}', maps: shifted(body.maps, prefix.length) }
}

function opaqueToken(raw: string): LatexInline {
  return { kind: 'opaque', from: 0, to: raw.length, contentFrom: 0, contentTo: raw.length, raw, text: raw }
}

interface ProjectedRows { rows: LatexTableRow[]; columns: number }

function tableRows(table: VisualNode, original?: LatexTable): ProjectedRows {
  const occupied = new Map<string, true>()
  const rows: LatexTableRow[] = []
  let columns = 0
  for (const [rowIndex, visualRow] of (table.content ?? []).entries()) {
    if (visualRow.type !== 'tableRow') throw new Error('VISUAL_TABLE_ROW')
    const originalIndex = visualRow.content?.find(cell => cell.attrs?.sourceCell)?.attrs?.sourceCell?.row
    const oldRow = originalIndex === undefined ? undefined : original?.rows[originalIndex]
    const cells: LatexTableCell[] = []
    let column = 0
    const coveredCell = (): LatexTableCell => {
      const old = oldRow?.cells.find(cell => cell.col === column && cell.covered)
      return old ? { ...old, row: rowIndex, col: column } : {
        from: -1, to: -1, contentFrom: -1, contentTo: -1, raw: '', text: '', inline: [],
        row: rowIndex, col: column, rowspan: 1, colspan: 1, covered: true, alignment: 'c',
      }
    }
    for (const visualCell of visualRow.content ?? []) {
      if (visualCell.type !== 'tableCell' && visualCell.type !== 'tableHeader') throw new Error('VISUAL_TABLE_CELL')
      while (occupied.has(`${rowIndex}:${column}`)) { cells.push(coveredCell()); column++ }
      const old = visualCell.attrs?.sourceCell ?? undefined
      const colspan = visualCell.attrs?.colspan ?? 1
      const rowspan = visualCell.attrs?.rowspan ?? 1
      if (![colspan, rowspan].every(value => Number.isInteger(value) && value >= 1) || rowIndex + rowspan > (table.content?.length ?? 0)) throw new Error('VISUAL_TABLE_SPAN')
      const content = serializeCellContent(visualCell, 0).text
      const inline = old && content === original?.raw.slice(old.contentFrom - original.from, old.contentTo - original.from)
        ? old.inline : [opaqueToken(content)]
      const cell: LatexTableCell = {
        from: old?.from ?? -1, to: old?.to ?? -1, contentFrom: old?.contentFrom ?? -1, contentTo: old?.contentTo ?? -1,
        raw: old?.raw ?? '', inline, text: literalText(visualCell), row: rowIndex, col: column,
        colspan, rowspan, covered: false, alignment: old?.alignment ?? 'c', ...(old?.spanArguments ? { spanArguments: old.spanArguments } : {}),
      }
      cells.push(cell)
      for (let row = rowIndex; row < rowIndex + rowspan; row++) for (let col = column; col < column + colspan; col++) {
        if (occupied.has(`${row}:${col}`)) throw new Error('VISUAL_TABLE_OVERLAP')
        if (row !== rowIndex) occupied.set(`${row}:${col}`, true)
      }
      column += colspan
    }
    while (occupied.has(`${rowIndex}:${column}`)) { cells.push(coveredCell()); column++ }
    columns = Math.max(columns, column)
    rows.push({ from: oldRow?.from ?? -(rowIndex + 1), to: oldRow?.to ?? -1, raw: oldRow?.raw ?? '', terminatorFrom: oldRow?.terminatorFrom ?? -1, terminatorTo: oldRow?.terminatorTo ?? -1, cells })
  }
  if (!rows.length || !columns || rows.some(row => row.cells.reduce((sum, cell) => sum + cell.colspan, 0) !== columns)) throw new Error('VISUAL_TABLE_RECTANGLE')
  return { rows, columns }
}

function resizedColumnSpec(original: LatexTable, projected: ProjectedRows): string {
  const { columns, rows } = projected
  if (columns === original.columns) return original.columnSpec.raw
  const spec = original.columnSpec.raw
  if (!/^[lcrX| \t\r\n]+$/.test(spec)) throw new Error('VISUAL_UNSUPPORTED_TABLE_COLUMNS')
  const tokens = [...spec.matchAll(/[lcrX]/g)]
  const bySource = new Map(original.rows.flatMap(row => row.cells.map(cell => [cell.from, cell] as const)))
  const origins = new Map<number, Map<number, number>>()
  for (const row of rows) for (const cell of row.cells) {
    const old = bySource.get(cell.from)
    if (!old || cell.covered) continue
    for (let span = 0; span < Math.min(cell.colspan, old.colspan); span++) {
      const column = cell.col + span
      const votes = origins.get(column) ?? new Map<number, number>()
      votes.set(old.col + span, (votes.get(old.col + span) ?? 0) + 1)
      origins.set(column, votes)
    }
  }
  let result = spec.slice(0, tokens[0]?.index ?? 0)
  for (let column = 0; column < columns; column++) {
    const origin = [...(origins.get(column)?.entries() ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0]
    const token = origin === undefined ? undefined : tokens[origin]
    result += token?.[0] ?? 'c'
    const nextToken = origin === undefined ? undefined : tokens[origin + 1]
    if (column < columns - 1 && token && nextToken) result += spec.slice(token.index + 1, nextToken.index)
  }
  return result + spec.slice((tokens.at(-1)?.index ?? spec.length - 1) + 1)
}

function newTableSource(table: VisualNode): string {
  const { rows, columns } = tableRows(table)
  const body = rows.map(row => row.cells.map((cell) => {
    if (cell.covered) return ''
    let value = cell.inline.map(token => token.raw).join('')
    if (cell.rowspan > 1) value = `\\multirow{${cell.rowspan}}{*}{${value}}`
    if (cell.colspan > 1) value = `\\multicolumn{${cell.colspan}}{${cell.alignment}}{${value}}`
    return value
  }).join(' & ') + '\\\\').join('\n')
  return `\\begin{tabular}{${'c'.repeat(columns)}}\n\\hline\n${body}\n\\hline\n\\end{tabular}`
}

function headingCommand(level = 1): string {
  const command = ['section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'subparagraph'][Math.max(0, Math.min(5, level - 1))]
  if (command === undefined) throw new Error('VISUAL_HEADING_COMMAND')
  return command
}

function fieldCommand(field: string | undefined, content: string): string {
  const name = field ?? 'title'
  if (['abstract', 'keyword', 'keywords'].includes(name)) return `\\begin{${name}}\n${content}\n\\end{${name}}`
  if (!/^[A-Za-z]+$/.test(name)) throw new Error('VISUAL_FIELD_NAME')
  return `\\${name}{${content}}`
}

function newRootSource(visual: VisualNode): string {
  if (visual.type === 'paragraph') return serializeInline(visual.content ?? [], 0).text
  if (visual.type === 'heading') return `\\${headingCommand(visual.attrs?.level)}{${serializeInline(visual.content ?? [], 0).text}}`
  if (visual.type === 'field') return fieldCommand(visual.attrs?.field, serializeInline(visual.content ?? [], 0).text)
  if (visual.type === 'mathBlock') {
    const environment = visual.attrs?.environment ?? 'equation'
    if (!/^(equation|align|gather|multline|displaymath)\*?$/.test(environment)) throw new Error('VISUAL_MATH_ENVIRONMENT')
    const labelSource = visual.attrs?.label ? `\n\\label{${validKey(visual.attrs.label)}}` : ''
    return `\\begin{${environment}}\n${visual.attrs?.latex ?? ''}${labelSource}\n\\end{${environment}}`
  }
  if (visual.type === 'figure' || visual.type === 'tableObject') {
    const parts: string[] = []
    for (const child of visual.content ?? []) {
      if (child.type === 'image') parts.push(`\\includegraphics[width=0.8\\linewidth]{${validPath(child.attrs?.path ?? '')}}`)
      else if (child.type === 'caption') parts.push(`\\caption{${serializeInline(child.content ?? [], 0).text}}`)
      else if (child.type === 'label') {
        const key = validKey(literalText(child))
        if (key.trim()) parts.push(`\\label{${key}}`)
      }
      else if (child.type === 'table') parts.push(newTableSource(child))
      else if (child.type === 'note') parts.push(`\\begin{minipage}{\\linewidth}\n${serializeInline(child.content ?? [], 0).text}\n\\end{minipage}`)
      else if (child.type === 'paragraph' && !literalText(child)) continue
      else throw new Error('VISUAL_OBJECT_CHILD')
    }
    const environment = visual.type === 'figure' ? 'figure' : 'table'
    return `\\begin{${environment}}[htbp]\n\\centering\n${parts.join('\n')}\n\\end{${environment}}`
  }
  if (visual.type === 'includeBlock') return `\\input{${validPath(visual.attrs?.path ?? '')}}`
  throw new Error(`VISUAL_NEW_ROOT_TYPE:${visual.type}`)
}

function serializeRootSource(base: LatexDocument, visual: VisualNode, original: LatexNode | undefined): string {
  if (!original) return newRootSource(visual)
  const patches: LatexPatch[] = []
  const replace = (from: number, to: number, insert: string) => patches.push({ from, to, insert, expected: base.source.slice(from, to) })
  if (['paragraph', 'heading', 'field'].includes(visual.type ?? '')) {
    const requiredKind = visual.type === 'paragraph' ? 'text' : visual.type
    if (original.kind !== requiredKind) {
      if (!['text', 'heading'].includes(original.kind) || !['paragraph', 'heading'].includes(visual.type ?? '')) throw new Error('VISUAL_ROOT_TYPE_CHANGE')
      return newRootSource(visual) + (original.label ? '\n' + original.label.raw : '')
    }
    replace(original.contentFrom, original.contentTo, serializeInline(visual.content ?? [], 0).text)
    if (visual.type === 'heading' && visual.attrs?.level !== original.level) {
      const command = /^\\[A-Za-z]+\*?/.exec(original.raw)?.[0]
      if (!command) throw new Error('VISUAL_HEADING_COMMAND')
      replace(original.from, original.from + command.length, '\\' + headingCommand(visual.attrs?.level) + (command.endsWith('*') ? '*' : ''))
    }
  } else if (visual.type === 'mathBlock' && original.kind === 'math') {
    const patch = createLatexMathPatch(original, visual.attrs?.latex ?? '')
    const key = validKey(visual.attrs?.label ?? '')
    const old = original.label
    if (old && key !== old.text) {
      if (old.from >= patch.from && old.to <= patch.to) patch.insert = patch.insert.replace(old.raw, key ? `\\label{${key}}` : '')
      else replace(key ? old.contentFrom : old.from, key ? old.contentTo : old.to, key)
    } else if (!old && key) patch.insert += `\n\\label{${key}}`
    patches.push(patch)
  } else if ((visual.type === 'figure' && original.kind === 'figure') || (visual.type === 'tableObject' && original.kind === 'table')) {
    const usedImages = new Set<number>()
    const usedNotes = new Set<number>()
    let hasCaption = false
    let hasLabel = false
    let hasTable = false
    const additions: string[] = []
    for (const child of visual.content ?? []) {
      if (child.type === 'caption') {
        if (hasCaption) throw new Error('VISUAL_DUPLICATE_CAPTION')
        hasCaption = true
        const content = serializeInline(child.content ?? [], 0).text
        if (original.caption) patches.push(fieldPatch(original.caption, content))
        else additions.push(`\\caption{${content}}`)
      } else if (child.type === 'label') {
        if (hasLabel) throw new Error('VISUAL_DUPLICATE_LABEL')
        const content = validKey(literalText(child))
        hasLabel = !!content.trim() || original.label?.text === content
        if (hasLabel && original.label) patches.push(fieldPatch(original.label, content))
        else if (hasLabel) additions.push(`\\label{${content}}`)
      } else if (child.type === 'image') {
        const image = child.attrs?.sourceImage ?? original.images?.[child.attrs?.imageIndex ?? -1]
        const path = validPath(child.attrs?.path ?? '')
        if (image && original.images?.some(value => value.from === image.from) && !usedImages.has(image.from)) {
          usedImages.add(image.from)
          replace(image.contentFrom, image.contentTo, path)
        } else additions.unshift(`\\includegraphics[width=0.8\\linewidth]{${path}}`)
      } else if (child.type === 'note') {
        const index = child.attrs?.sourceIndex ?? -1
        const note = original.notes?.[index]
        const content = serializeInline(child.content ?? [], 0).text
        if (note && !usedNotes.has(index)) { usedNotes.add(index); patches.push(fieldPatch(note, content)) }
        else additions.push(`\\begin{minipage}{\\linewidth}\n${content}\n\\end{minipage}`)
      } else if (child.type === 'table') {
        if (hasTable) throw new Error('VISUAL_DUPLICATE_TABLE')
        hasTable = true
        if (original.table) {
          const value = tableRows(child, original.table)
          replace(original.table.contentFrom, original.table.contentTo, serializeLatexTable(original.table, value.rows))
          replace(original.table.columnSpec.from, original.table.columnSpec.to, resizedColumnSpec(original.table, value))
        } else additions.push(newTableSource(child))
      } else if (child.type === 'paragraph' && !literalText(child)) continue
      else throw new Error('VISUAL_OBJECT_CHILD')
    }
    if (original.caption && !hasCaption) replace(original.caption.from, original.caption.to, '')
    if (original.label && !hasLabel) replace(original.label.from, original.label.to, '')
    for (const image of original.images ?? []) if (!usedImages.has(image.from)) replace(image.from, image.to, '')
    for (const [index, note] of (original.notes ?? []).entries()) if (!usedNotes.has(index)) replace(note.from, note.to, '')
    if (original.table && !hasTable) throw new Error('VISUAL_TABLE_REQUIRED')
    if (additions.length) replace(original.contentTo, original.contentTo, '\n' + additions.join('\n') + '\n')
  } else if (visual.type === 'includeBlock' && original.kind === 'include') {
    replace(original.contentFrom, original.contentTo, validPath(visual.attrs?.path ?? original.path ?? ''))
  } else if (visual.type === 'opaqueBlock' && (!original.editable || original.kind === 'opaque')) {
    if (visual.attrs?.text !== original.raw) throw new Error('VISUAL_OPAQUE_EDIT')
  } else throw new Error('VISUAL_ROOT_TYPE_CHANGE')
  return patchObject(base, original, patches)
}

function mapInlineContent(visual: VisualNode, from: number, source: string, field: LatexField | LatexNode): VisualSourceMap[] {
  const value = serializeInline(visual.content ?? [], from + 1)
  let start = field.contentFrom
  if (source.slice(start, start + value.text.length) !== value.text) {
    const candidate = source.slice(field.from, field.to).indexOf(value.text)
    if (candidate < 0) throw new Error('VISUAL_CONTENT_MAPPING')
    start = field.from + candidate
  }
  return shifted(value.maps, start)
}

function collectRootMaps(visual: VisualNode, from: number, source: string): VisualSourceMap[] {
  const maps: VisualSourceMap[] = [{ from, to: from + visualNodeSize(visual), offsets: [0, source.length], root: true, atomic: true }]
  if (visual.type === 'paragraph') return maps.concat(serializeInline(visual.content ?? [], from + 1).maps)
  const document = parseLatexDocument(source)
  const parsed = document.nodes[0]
  if (!parsed) {
    if (!source && visual.type === 'paragraph') return maps
    throw new Error('VISUAL_ROOT_MAPPING')
  }
  if (visual.type === 'heading' || visual.type === 'field') maps.push(...mapInlineContent(visual, from, source, parsed))
  else if (visual.type === 'figure' || visual.type === 'tableObject') {
    let imageIndex = 0
    let noteIndex = 0
    for (const child of childrenWithPositions(visual, from)) {
      if (child.node.type === 'caption' && parsed.caption) maps.push(...mapInlineContent(child.node, child.from, source, parsed.caption))
      else if (child.node.type === 'label' && parsed.label) {
        const text = literalText(child.node)
        const labelFrom = parsed.label.contentFrom
        maps.push({ from: child.from + 1, to: child.from + 1 + text.length,
          offsets: Array.from({ length: text.length + 1 }, (_, index) => labelFrom + index) })
      } else if (child.node.type === 'note') {
        const note = parsed.notes?.[noteIndex++]
        if (note) maps.push(...mapInlineContent(child.node, child.from, source, note))
      } else if (child.node.type === 'image') {
        const image = parsed.images?.[imageIndex++]
        if (image) maps.push({ from: child.from, to: child.from + 1, offsets: [image.from, image.to], atomic: true })
      } else if (child.node.type === 'table' && parsed.table) {
        for (const [rowIndex, row] of childrenWithPositions(child.node, child.from).entries()) {
          const sourceCells = parsed.table.rows[rowIndex]?.cells.filter(cell => !cell.covered)
          const cells = childrenWithPositions(row.node, row.from)
          if (!sourceCells || sourceCells.length !== cells.length) throw new Error('VISUAL_TABLE_MAPPING')
          for (const [cellIndex, cell] of cells.entries()) {
            const sourceCell = sourceCells[cellIndex]
            if (sourceCell === undefined) throw new Error('VISUAL_TABLE_MAPPING')
            const value = serializeCellContent(cell.node, cell.from)
            const start = sourceCell.raw.indexOf(value.text)
            if (start < 0) throw new Error('VISUAL_CELL_MAPPING')
            maps.push(...shifted(value.maps, sourceCell.from + start))
            maps.push({ from: cell.from, to: cell.from + visualNodeSize(cell.node),
              offsets: [sourceCell.from, sourceCell.to], atomic: true })
          }
        }
      }
    }
  }
  return maps
}

/** Compiles an edited visual document using its immutable source and local object edits.
 * Unsupported structural mutations fail before any source is returned.
 * @param document JSON from the manuscript schema, with its original base in doc attrs.
 * @returns Exact current TeX and visual selection maps in UTF-16 units.
 */
export function compileVisualDocument(document: VisualNode): CompiledVisualDocument {
  if (document.type !== 'doc' || !document.attrs?.base) throw new Error('VISUAL_BASE_REQUIRED')
  const base = document.attrs.base
  const byId = new Map(base.nodes.map(node => [node.id, node]))
  const seen = new Set<string>()
  let previous = -1
  let visualFrom = 0
  const roots = (document.content ?? []).map((visual) => {
    const id = visual.attrs?.sourceId
    const original = id && !seen.has(id) ? byId.get(id) : undefined
    if (original) {
      if (original.from < previous) throw new Error('VISUAL_REORDER_UNSUPPORTED')
      previous = original.from
      seen.add(original.id)
    }
    const entry = { visual, original, from: visualFrom }
    visualFrom += visualNodeSize(visual)
    return entry
  })
  const deleted = base.nodes.filter(node => !seen.has(node.id))
  const retainedGap = (from: number, to: number) => {
    let result = ''
    let cursor = from
    for (const node of deleted) {
      if (node.from >= to || ownedEnd(node) <= cursor) continue
      result += base.source.slice(cursor, Math.max(cursor, node.from))
      cursor = Math.min(to, ownedEnd(node))
    }
    return result + base.source.slice(cursor, to)
  }
  const compiled: CompiledVisualDocument = { source: '', maps: [] }
  let cursor = 0
  for (const [index, root] of roots.entries()) {
    if (root.original) {
      compiled.source += retainedGap(cursor, root.original.from)
      cursor = root.original.from
    } else if (index === 0) {
      const next = roots.find(candidate => candidate.original)?.original
      const boundary = next?.from ?? base.nodes[0]?.from ?? 0
      compiled.source += retainedGap(cursor, boundary)
      cursor = boundary
    }
    const source = serializeRootSource(base, root.visual, root.original)
    if (!root.original && compiled.source && !compiled.source.endsWith('\n\n')) compiled.source += '\n\n'
    compiled.maps.push(...shifted(collectRootMaps(root.visual, root.from, source), compiled.source.length))
    compiled.source += source
    if (root.original) cursor = ownedEnd(root.original)
    else compiled.source += '\n\n'
  }
  compiled.source += retainedGap(cursor, base.source.length)
  return compiled
}

function visualBoundary(maps: readonly VisualSourceMap[], position: number, side: 'left' | 'right'): number | null {
  const candidates = maps.filter(map => position >= map.from && position <= map.to)
    .sort((a, b) => Number(a.root) - Number(b.root) || (a.to - a.from) - (b.to - b.from))
  for (const map of candidates) {
    if (!map.atomic && map.offsets.length === map.to - map.from + 1) return map.offsets[position - map.from] ?? null
    if (position === map.from) return map.offsets[0] ?? null
    if (position === map.to) return map.offsets.at(-1) ?? null
  }
  const edges = maps.filter(map => !map.root).flatMap(map => [
    { visual: map.from, source: map.offsets[0] }, { visual: map.to, source: map.offsets.at(-1) },
  ])
  const ordered = edges.filter(edge => side === 'left' ? edge.visual <= position : edge.visual >= position)
    .sort((a, b) => side === 'left' ? b.visual - a.visual : a.visual - b.visual)
  return ordered[0]?.source ?? null
}

/** Maps a current visual selection to a bounded current-source interval.
 * @param compiled Current compiled document, never a stale base projection.
 * @param selection ProseMirror positions.
 * @returns A source interval, or null when no mapped content is selected.
 */
export function mapVisualSelection(
  compiled: CompiledVisualDocument, selection: { from: number; to: number },
): { from: number; to: number } | null {
  const from = visualBoundary(compiled.maps, selection.from, 'right')
  const to = visualBoundary(compiled.maps, selection.to, 'left')
  return from === null || to === null || to < from ? null : { from, to }
}

function sourceBoundary(maps: readonly VisualSourceMap[], offset: number, side: 'left' | 'right'): number | null {
  const candidates = maps.flatMap((map) => {
    const first = map.offsets[0]
    const last = map.offsets.at(-1)
    return first !== undefined && last !== undefined && offset >= first && offset <= last ? [{ map, first, last }] : []
  }).sort((a, b) => Number(a.map.root) - Number(b.map.root) || (a.last - a.first) - (b.last - b.first))
  for (const { map, first, last } of candidates) {
    if (map.atomic) {
      if (offset === first) return map.from
      if (offset === last) return map.to
      return side === 'left' ? map.from : map.to
    }
    let index = side === 'left' ? 0 : map.offsets.length - 1
    if (side === 'left') {
      while (index + 1 < map.offsets.length) {
        const next = map.offsets[index + 1]
        if (next !== undefined && next <= offset) index++
        else break
      }
    } else {
      while (index > 0) {
        const previous = map.offsets[index - 1]
        if (previous !== undefined && previous >= offset) index--
        else break
      }
    }
    return map.from + index
  }
  return null
}

/** Locates a source diagnostic or AI edit in the current visual projection.
 * @param compiled Current compiled source maps.
 * @param selection Half-open UTF-16 source interval.
 * @returns Visual endpoints, or null for source outside the visible projection.
 */
export function mapSourceSelection(
  compiled: CompiledVisualDocument, selection: { from: number; to: number },
): { from: number; to: number } | null {
  const from = sourceBoundary(compiled.maps, selection.from, 'left')
  const to = sourceBoundary(compiled.maps, selection.to, 'right')
  return from === null || to === null || to < from ? null : { from, to }
}
