/** Tabular projection and bounded reconstruction of deliberately edited rows. */
import type { LatexField, LatexPatch, LatexTable, LatexTableCell, LatexTableRow } from './latex-source.types.ts'
import { inlineToLatex, parseLatexInline } from './latex-source.inline.ts'
import { readTexCommand, readTexEnvironment, readTexGroup, requiredTexGroup, skipTexSpace, texCommands, trimTexRange } from './latex-source.scan.ts'

function columnCount(spec: string): number {
  let count = 0
  let at = 0
  while (at < spec.length) {
    const char = spec[at]!
    if ('lcrX'.includes(char)) { count++; at++; continue }
    if ('pmb'.includes(char)) { count++; const group = requiredTexGroup(spec, at + 1); at = group?.to ?? at + 1; continue }
    if ('@!><'.includes(char)) { const group = requiredTexGroup(spec, at + 1); at = group?.to ?? at + 1; continue }
    if (char === '*') {
      const repeat = requiredTexGroup(spec, at + 1)
      const repeated = repeat && requiredTexGroup(spec, repeat.to)
      if (repeat && repeated) { count += Number(spec.slice(repeat.contentFrom, repeat.contentTo)) * columnCount(spec.slice(repeated.contentFrom, repeated.contentTo)); at = repeated.to; continue }
    }
    at++
  }
  return count
}

function cellFrom(source: string, from: number, to: number, row: number, col: number): LatexTableCell {
  const trimmed = trimTexRange(source, from, to)
  let contentFrom = trimmed.from
  let contentTo = trimmed.to
  let rowspan = 1
  let colspan = 1
  let alignment = 'c'
  const spanArguments: NonNullable<LatexTableCell['spanArguments']> = {}
  for (let depth = 0; depth < 2; depth++) {
    const command = readTexCommand(source, contentFrom)
    if (!command || !['multicolumn', 'multirow'].includes(command.name)) break
    const span = requiredTexGroup(source, command.to)
    const layout = span && requiredTexGroup(source, span.to)
    const body = layout && requiredTexGroup(source, layout.to)
    if (!span || !layout || !body || body.to > contentTo) break
    const size = Number(source.slice(span.contentFrom, span.contentTo))
    if (!Number.isInteger(size) || size < 1) break
    const range = { from: span.contentFrom, to: span.contentTo, raw: source.slice(span.contentFrom, span.contentTo) }
    if (command.name === 'multirow') { rowspan = size; spanArguments.row = range }
    else { colspan = size; spanArguments.col = range; alignment = source.slice(layout.contentFrom, layout.contentTo) }
    contentFrom = body.contentFrom
    contentTo = body.contentTo
  }
  const inline = parseLatexInline(source, contentFrom, contentTo)
  return { from, to, raw: source.slice(from, to), contentFrom, contentTo, inline, text: inline.map(x => x.text).join(''), row, col, rowspan, colspan, covered: false, alignment, ...(Object.keys(spanArguments).length ? { spanArguments } : {}) }
}

function skipRowPrefix(source: string, start: number, end: number): number {
  let at = skipTexSpace(source, start, end)
  while (at < end) {
    const command = readTexCommand(source, at)
    if (!command || !['toprule', 'midrule', 'bottomrule', 'hline', 'cline', 'cmidrule', 'addlinespace', 'noalign'].includes(command.name)) break
    at = command.to
    const optionAt = skipTexSpace(source, at, end)
    if (source[optionAt] === '[') at = readTexGroup(source, optionAt, '[', ']')?.to ?? at
    if (source[skipTexSpace(source, at, end)] === '(') {
      const closing = source.indexOf(')', at)
      if (closing >= 0 && closing < end) at = closing + 1
    }
    if (['cline', 'cmidrule', 'noalign'].includes(command.name)) at = requiredTexGroup(source, at)?.to ?? at
    at = skipTexSpace(source, at, end)
  }
  return at
}

/** Finds the tabular inside a table or wrapper and keeps physical cell source intervals.
 * @param source Complete TeX source.
 * @param from Start of the enclosing object.
 * @param to End of the enclosing object.
 * @returns Its table projection, or null when no supported balanced tabular exists.
 */
export function parseLatexTable(source: string, from: number, to: number): LatexTable | null {
  for (const command of texCommands(source, from, to)) {
    if (command.name !== 'begin') continue
    const name = requiredTexGroup(source, command.to)
    if (!name || !['tabular', 'tabular*', 'tabularx'].includes(source.slice(name.contentFrom, name.contentTo))) continue
    const env = readTexEnvironment(source, command.from)
    if (!env || env.to > to) return null
    let spec = requiredTexGroup(source, env.nameEnd)
    if (env.name !== 'tabular' && spec) spec = requiredTexGroup(source, spec.to)
    if (!spec) return null
    const rows: LatexTableRow[] = []
    let rowStart = skipRowPrefix(source, spec.to, env.contentTo)
    let cellStart = rowStart
    let at = rowStart
    let separators: number[] = []
    const addRow = (end: number, terminatorEnd: number) => {
      if (end <= rowStart) return
      const cuts = [rowStart, ...separators.map(n => n + 1)]
      const ends = [...separators, end]
      let col = 0
      const cells = cuts.map((start, i) => {
        const cell = cellFrom(source, start, ends[i]!, rows.length, col)
        col += cell.colspan
        return cell
      })
      rows.push({ from: rowStart, to: terminatorEnd, raw: source.slice(rowStart, terminatorEnd), cells, terminatorFrom: end, terminatorTo: terminatorEnd })
      separators = []
    }
    while (at < env.contentTo) {
      if (source[at] === '%') { const nl = source.indexOf('\n', at); at = nl < 0 ? env.contentTo : nl + 1; continue }
      if (source[at] === '{') { const group = readTexGroup(source, at); if (group) { at = group.to; continue } }
      if (source[at] === '\\') {
        const token = readTexCommand(source, at)
        if (!token) { at++; continue }
        if (token.name === 'begin') { const nested = readTexEnvironment(source, at); if (nested) { at = nested.to; continue } }
        if (token.name === '\\' || token.name === 'tabularnewline') {
          let end = token.to
          if (source[end] === '*') end++
          const next = skipTexSpace(source, end, env.contentTo)
          if (source[next] === '[') end = readTexGroup(source, next, '[', ']')?.to ?? end
          addRow(at, end)
          rowStart = skipRowPrefix(source, end, env.contentTo)
          cellStart = rowStart
          at = rowStart
          continue
        }
        at = token.to
        continue
      }
      if (source[at] === '&') { separators.push(at); cellStart = at + 1 }
      at++
    }
    if (cellStart < env.contentTo && source.slice(rowStart, env.contentTo).trim()) addRow(env.contentTo, env.contentTo)
    const occupied = new Map<string, true>()
    for (const row of rows) {
      for (const cell of row.cells) {
        cell.covered = occupied.has(`${cell.row}:${cell.col}`)
        if (cell.covered && cell.text.trim()) throw new Error(`LATEX_TABLE_OVERLAPPING_CONTENT:${cell.from}`)
        if (!cell.covered) {
          for (let r = cell.row; r < cell.row + cell.rowspan; r++) {
            for (let c = cell.col; c < cell.col + cell.colspan; c++) if (r !== cell.row || c !== cell.col) occupied.set(`${r}:${c}`, true)
          }
        }
      }
    }
    return { ...env, contentFrom: spec.to, contentTo: env.contentTo, columns: Math.max(columnCount(source.slice(spec.contentFrom, spec.contentTo)), ...rows.map(row => row.cells.reduce((sum, cell) => sum + cell.colspan, 0))), columnSpec: { from: spec.contentFrom, to: spec.contentTo, raw: source.slice(spec.contentFrom, spec.contentTo) }, rows }
  }
  return null
}

function serializeCell(cell: LatexTableCell): string {
  if (cell.covered) return ''
  let content = inlineToLatex(cell.inline)
  if (cell.rowspan > 1) content = `\\multirow{${cell.rowspan}}{*}{${content}}`
  if (cell.colspan > 1) content = `\\multicolumn{${cell.colspan}}{${cell.alignment}}{${content}}`
  return content
}

/** Serializes a deliberately changed table body while preserving existing rule gaps.
 * @param table Original source-backed table.
 * @param rows Edited rows; unchanged rows retain their original raw strings.
 * @returns Only the tabular body, leaving its column specification and wrappers untouched.
 */
export function serializeLatexTable(table: LatexTable, rows: readonly LatexTableRow[]): string {
  const relative = (offset: number) => offset - table.from
  const originalByOffset = new Map(table.rows.map(row => [row.from, row]))
  const prefix = table.raw.slice(relative(table.contentFrom), relative(table.rows[0]?.from ?? table.contentTo))
  const suffix = table.raw.slice(relative(table.rows.at(-1)?.to ?? table.contentFrom), relative(table.contentTo))
  let result = prefix
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const original = originalByOffset.get(row.from)
    const unchanged = original && row.cells.length === original.cells.length && row.cells.every((cell, j) => {
      const old = original.cells[j]!
      return cell.rowspan === old.rowspan && cell.colspan === old.colspan && cell.covered === old.covered && cell.alignment === old.alignment && inlineToLatex(cell.inline) === inlineToLatex(old.inline)
    })
    if (unchanged) result += original.raw
    else if (original && row.cells.length === original.cells.length && row.cells.every((cell, j) => {
      const old = original.cells[j]!
      return cell.from === old.from && cell.rowspan === old.rowspan && cell.colspan === old.colspan && cell.covered === old.covered && cell.alignment === old.alignment
    })) {
      let raw = original.raw
      for (let index = row.cells.length - 1; index >= 0; index--) {
        const old = original.cells[index]!
        const content = inlineToLatex(row.cells[index]!.inline)
        raw = raw.slice(0, old.contentFrom - original.from) + content + raw.slice(old.contentTo - original.from)
      }
      result += raw
    } else result += `${row.cells.map(serializeCell).join(' & ')}\\\\`
    if (i < rows.length - 1) {
      const originalIndex = original ? table.rows.indexOf(original) : -1
      const oldNext = table.rows[originalIndex + 1]
      result += original && oldNext ? table.raw.slice(relative(original.to), relative(oldNext.from)) : '\n'
    }
  }
  return result + suffix
}

/** Returns one bounded body replacement for a table-structure edit.
 * @param table Original source-backed table.
 * @param rows Edited rows.
 * @returns Compare-before-write patch for its body alone.
 */
export function createLatexTablePatch(table: LatexTable, rows: readonly LatexTableRow[]): LatexPatch {
  return { from: table.contentFrom, to: table.contentTo, expected: table.raw.slice(table.contentFrom - table.from, table.contentTo - table.from), insert: serializeLatexTable(table, rows) }
}

/** Builds an editable field from a braced argument or a body range. */
export function latexField(source: string, from: number, to: number, contentFrom = from, contentTo = to): LatexField {
  const inline = parseLatexInline(source, contentFrom, contentTo)
  return { from, to, contentFrom, contentTo, raw: source.slice(from, to), inline, text: inline.map(x => x.text).join('') }
}
