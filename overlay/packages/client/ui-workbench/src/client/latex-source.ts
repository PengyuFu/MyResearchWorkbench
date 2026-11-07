/** Lossless source projection for the manuscript structures supported by the visual editor. */
import type { LatexDiagnostic, LatexDocument, LatexField, LatexImage, LatexInline, LatexNode, LatexPatch } from './latex-source.types.ts'
import { parseLatexInline } from './latex-source.inline.ts'
import { latexField, parseLatexTable } from './latex-source.table.ts'
import { readTexCommand, readTexEnvironment, readTexGroup, requiredTexGroup, skipTexSpace, texCommands, trimTexRange } from './latex-source.scan.ts'

export type * from './latex-source.types.ts'
export { parseLatexInline, textToLatex, inlineToLatex, inlineOffsetToSource } from './latex-source.inline.ts'
export { parseLatexTable, serializeLatexTable, createLatexTablePatch } from './latex-source.table.ts'

const headingLevels: Record<string, number> = { part: 1, chapter: 1, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 5 }
const fieldNames = new Set(['title', 'author', 'address', 'ead', 'cortext', 'thanks', 'affiliation'])
const layoutCommands = new Set(['begingroup', 'endgroup', 'FloatBarrier', 'linenumbers', 'nolinenumbers', 'centering', 'small', 'footnotesize', 'normalsize', 'noindent', 'maketitle'])
const mathEnvironments = new Set(['equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'displaymath', 'multline', 'multline*', 'eqnarray', 'eqnarray*'])

function fieldForCommand(source: string, command: { from: number; to: number }): LatexField | null {
  const group = requiredTexGroup(source, command.to)
  return group ? latexField(source, command.from, group.to, group.contentFrom, group.contentTo) : null
}

function objectFields(source: string, from: number, to: number, name: string): LatexField[] {
  return texCommands(source, from, to).filter(command => command.name === name).flatMap(command => {
    const field = fieldForCommand(source, command)
    return field && field.to <= to ? [field] : []
  })
}

function imageFields(source: string, from: number, to: number): LatexImage[] {
  return texCommands(source, from, to).filter(command => command.name === 'includegraphics' || command.name === 'includegraphics*').flatMap(command => {
    const argument = requiredTexGroup(source, command.to)
    if (!argument || argument.to > to) return []
    const optionFrom = skipTexSpace(source, command.to)
    const option = readTexGroup(source, optionFrom, '[', ']')
    return [{ from: command.from, to: argument.to, raw: source.slice(command.from, argument.to), contentFrom: argument.contentFrom, contentTo: argument.contentTo, path: source.slice(argument.contentFrom, argument.contentTo), ...(option ? { options: option } : {}) }]
  })
}

function plainText(inline: LatexInline[]): string { return inline.map(token => token.text).join('') }

function skipMath(source: string, from: number, to: number): number | null {
  const delimiter = source[from] === '$' ? (source.startsWith('$$', from) ? '$$' : '$') : source.startsWith('\\(', from) ? '\\(' : source.startsWith('\\[', from) ? '\\[' : ''
  if (!delimiter) return null
  const endDelimiter = delimiter === '\\(' ? '\\)' : delimiter === '\\[' ? '\\]' : delimiter
  let at = from + delimiter.length
  while (at < to) {
    if (source.startsWith(endDelimiter, at)) return at + endDelimiter.length
    if (source[at] === '\\') at = readTexCommand(source, at)?.to ?? at + 1
    else at++
  }
  return null
}

/** Parses supported manuscript structures while retaining every source byte in source.
 * @param source Unmodified UTF-16 representation of the decoded TeX file.
 * @param file File identity carried by every node; an omitted identity denotes a synthetic fragment.
 * @returns A source projection with exact offsets and explicit unsupported-object diagnostics.
 */
export function parseLatexDocument(source: string, file = ''): LatexDocument {
  const nodes: LatexNode[] = []
  const diagnostics: LatexDiagnostic[] = []
  const includes: LatexDocument['includes'] = []
  const graphicsPaths: string[] = []
  const bibliography: string[] = []
  const makeNode = (kind: LatexNode['kind'], from: number, to: number, contentFrom = from, contentTo = to, extra: Partial<LatexNode> = {}): LatexNode => ({
    id: `${file}:${kind}:${from}`, file, kind, from, to, raw: source.slice(from, to), contentFrom, contentTo, inline: [], editable: true, ...extra,
  })
  const diagnostic = (code: string, message: string, from: number, to: number, severity: LatexDiagnostic['severity'] = 'warning') => {
    diagnostics.push({ code, message, from, to, raw: source.slice(from, to), severity })
  }
  const mathNode = (from: number, to: number, bodyFrom: number, bodyTo: number, environment: string) => {
    const range = trimTexRange(source, bodyFrom, bodyTo)
    const labels = objectFields(source, range.from, range.to, 'label')
    let contentTo = range.to
    for (const label of [...labels].reverse()) {
      if (source.slice(label.to, contentTo).trim() === '') contentTo = trimTexRange(source, range.from, label.from).to
    }
    const embedded = labels.filter(label => label.from < contentTo)
    let math = source.slice(range.from, contentTo)
    for (const label of [...embedded].reverse()) math = math.slice(0, label.from - range.from) + math.slice(label.to - range.from)
    nodes.push(makeNode('math', from, to, range.from, contentTo, { math, environment, ...(labels[0] ? { label: labels[0] } : {}), ...(embedded.length ? { mathEmbeddedLabels: embedded } : {}) }))
  }
  const parseBlocks = (from: number, to: number, ordered = false) => {
    let at = from
    let textStart = from
    const flush = (end: number) => {
      const range = trimTexRange(source, textStart, end)
      if (range.to <= range.from) return
      const inline = parseLatexInline(source, range.from, range.to)
      if (!plainText(inline).trim()) return
      const node = makeNode('text', range.from, range.to, range.from, range.to, { inline, ...(ordered ? { ordered: true, field: 'item' } : {}) })
      nodes.push(node)
      for (const token of inline) if (token.kind === 'opaque' && token.command !== 'comment') diagnostic('UNSUPPORTED_INLINE', `Unsupported inline command: ${token.command ?? 'unknown'}`, token.from, token.to)
    }
    const consumed = (end: number) => { at = end; textStart = end }
    while (at < to) {
      if (source[at] === '%') {
        flush(at)
        const next = source.indexOf('\n', at)
        consumed(next < 0 ? to : next + 1)
        continue
      }
      if (source[at] === '\r' || source[at] === '\n') {
        const blank = /^(?:\r?\n[ \t]*\r?\n|\r(?!\n)[ \t]*\r(?!\n))/.exec(source.slice(at, to))
        if (blank) { flush(at); consumed(at + blank[0].length); continue }
      }
      if (source.startsWith('$$', at) || source.startsWith('\\[', at)) {
        const end = skipMath(source, at, to)
        if (end) { flush(at); mathNode(at, end, at + 2, end - 2, source.slice(at, at + 2)); consumed(end); continue }
      }
      if (source[at] === '$' || source.startsWith('\\(', at)) { const end = skipMath(source, at, to); if (end) { at = end; continue } }
      if (source[at] === '{') { const group = readTexGroup(source, at); if (group && group.to <= to) { at = group.to; continue } }
      if (source[at] !== '\\') { at++; continue }
      const command = readTexCommand(source, at)
      if (!command) { at++; continue }
      const baseName = command.name.replace(/\*$/, '')
      if (command.name === 'label') {
        const field = fieldForCommand(source, command)
        if (field && field.to <= to) {
          flush(at)
          const owner = nodes.at(-1)
          if (owner && !owner.label) owner.label = field
          consumed(field.to)
          continue
        }
      }
      if (layoutCommands.has(command.name) || command.name === 'par' || command.name === 'item') {
        flush(at)
        let end = command.to
        if (command.name === 'item') {
          const option = readTexGroup(source, skipTexSpace(source, end), '[', ']')
          if (option) end = option.to
        }
        consumed(end)
        continue
      }
      if (baseName in headingLevels || fieldNames.has(baseName)) {
        const field = fieldForCommand(source, command)
        if (field && field.to <= to) {
          flush(at)
          nodes.push(makeNode(baseName in headingLevels ? 'heading' : 'field', at, field.to, field.contentFrom, field.contentTo, { inline: field.inline, ...(baseName in headingLevels ? { level: headingLevels[baseName]!, field: command.name } : { field: baseName }) }))
          consumed(field.to)
          continue
        }
      }
      if (command.name === 'input' || command.name === 'include' || command.name === 'bibliography') {
        const field = fieldForCommand(source, command)
        if (field && field.to <= to) {
          flush(at)
          const path = source.slice(field.contentFrom, field.contentTo)
          if (command.name === 'bibliography') {
            bibliography.push(...path.split(',').map(value => value.trim()).filter(Boolean))
            nodes.push(makeNode('field', at, field.to, field.contentFrom, field.contentTo, { field: 'bibliography', inline: field.inline }))
          } else {
            includes.push({ path, command: command.name, from: at, to: field.to })
            nodes.push(makeNode('include', at, field.to, field.contentFrom, field.contentTo, { path, inline: field.inline, editable: false }))
          }
          consumed(field.to)
          continue
        }
      }
      if (command.name === 'begin') {
        const env = readTexEnvironment(source, at)
        if (!env || env.to > to) { diagnostic('UNBALANCED_ENVIRONMENT', 'Unbalanced environment; preserved without structural editing.', at, command.to, 'error'); at = command.to; continue }
        flush(at)
        if (['document', 'frontmatter', 'enumerate', 'itemize', 'center'].includes(env.name)) {
          parseBlocks(env.contentFrom, env.contentTo, env.name === 'enumerate')
        } else if (env.name === 'abstract' || env.name === 'keyword' || env.name === 'keywords') {
          const range = trimTexRange(source, env.contentFrom, env.contentTo)
          nodes.push(makeNode('field', env.from, env.to, range.from, range.to, { field: env.name, inline: parseLatexInline(source, range.from, range.to) }))
        } else if (mathEnvironments.has(env.name)) {
          mathNode(env.from, env.to, env.contentFrom, env.contentTo, env.name)
        } else if (env.name === 'figure' || env.name === 'figure*' || env.name === 'table' || env.name === 'table*') {
          const caption = objectFields(source, env.contentFrom, env.contentTo, 'caption')[0]
          const label = objectFields(source, env.contentFrom, env.contentTo, 'label')[0]
          const fields = { environment: env.name, ...(caption ? { caption } : {}), ...(label ? { label } : {}) }
          if (env.name.startsWith('figure')) nodes.push(makeNode('figure', env.from, env.to, env.contentFrom, env.contentTo, { ...fields, images: imageFields(source, env.contentFrom, env.contentTo) }))
          else {
            try {
              const table = parseLatexTable(source, env.from, env.to)
              const notes = texCommands(source, env.contentFrom, env.contentTo).filter(token => token.name === 'begin').flatMap(token => {
                const name = requiredTexGroup(source, token.to)
                if (!name || source.slice(name.contentFrom, name.contentTo) !== 'minipage') return []
                const note = readTexEnvironment(source, token.from)
                const width = note && requiredTexGroup(source, note.nameEnd)
                if (!note || !width) return []
                let contentFrom = skipTexSpace(source, width.to)
                const size = readTexCommand(source, contentFrom)
                if (size && ['footnotesize', 'small', 'normalsize'].includes(size.name)) contentFrom = skipTexSpace(source, size.to)
                const range = trimTexRange(source, contentFrom, note.contentTo)
                return [latexField(source, note.from, note.to, range.from, range.to)]
              })
              nodes.push(makeNode('table', env.from, env.to, env.contentFrom, env.contentTo, { ...fields, ...(table ? { table, rows: table.rows } : {}), notes, editable: !!table }))
              if (!table) diagnostic('UNSUPPORTED_TABLE', 'No supported balanced tabular was found.', env.from, env.to)
            } catch (error) {
              nodes.push(makeNode('table', env.from, env.to, env.contentFrom, env.contentTo, { ...fields, editable: false }))
              diagnostic('INVALID_TABLE', error instanceof Error ? error.message : String(error), env.from, env.to, 'error')
            }
          }
        } else {
          nodes.push(makeNode('opaque', env.from, env.to, env.contentFrom, env.contentTo, { environment: env.name, editable: false }))
          diagnostic('UNSUPPORTED_ENVIRONMENT', `Unsupported environment: ${env.name}`, env.from, env.to)
        }
        consumed(env.to)
        continue
      }
      at = command.to
    }
    flush(to)
  }
  const commands = texCommands(source)
  for (const command of commands.filter(token => token.name === 'graphicspath')) {
    const group = requiredTexGroup(source, command.to)
    if (!group) continue
    let at = group.contentFrom
    while (at < group.contentTo) {
      const path = readTexGroup(source, skipTexSpace(source, at))
      if (!path) break
      graphicsPaths.push(source.slice(path.contentFrom, path.contentTo))
      at = path.to
    }
  }
  const documentCommand = commands.find(command => command.name === 'begin' && (() => { const name = requiredTexGroup(source, command.to); return name && source.slice(name.contentFrom, name.contentTo) === 'document' })())
  if (documentCommand) {
    // Standard article classes store title/author before the document body.
    // Only project top-level metadata; grouped macro definitions and every
    // other preamble byte remain outside the editable document projection.
    let preambleAt = 0
    while (preambleAt < documentCommand.from) {
      if (source[preambleAt] === '%') { const next = source.indexOf('\n', preambleAt); preambleAt = next < 0 ? documentCommand.from : next + 1; continue }
      if (source[preambleAt] === '{' || source[preambleAt] === '[') {
        const group = source[preambleAt] === '{' ? readTexGroup(source, preambleAt) : readTexGroup(source, preambleAt, '[', ']')
        if (group) { preambleAt = group.to; continue }
      }
      const command = readTexCommand(source, preambleAt)
      if (!command) { preambleAt++; continue }
      const name = command.name.replace(/\*$/, '')
      const field = fieldNames.has(name) ? fieldForCommand(source, command) : null
      if (field && field.to <= documentCommand.from) {
        nodes.push(makeNode('field', command.from, field.to, field.contentFrom, field.contentTo, { field: name, inline: field.inline }))
        preambleAt = field.to
      } else preambleAt = command.to
    }
    const document = readTexEnvironment(source, documentCommand.from)
    if (document) parseBlocks(document.contentFrom, document.contentTo)
    else { diagnostic('UNBALANCED_DOCUMENT', 'The document environment is incomplete.', documentCommand.from, source.length, 'error'); parseBlocks(requiredTexGroup(source, documentCommand.to)?.to ?? documentCommand.to, source.length) }
  } else parseBlocks(0, source.length)
  const labels = commands.filter(token => token.name === 'label').flatMap(command => {
    const field = fieldForCommand(source, command)
    if (!field) return []
    const node = nodes.find(value => (value.from <= command.from && value.to >= field.to) || (value.label?.from === command.from))
    return [{ key: source.slice(field.contentFrom, field.contentTo), nodeId: node?.id ?? '', from: field.contentFrom, to: field.contentTo }]
  })
  const seen = new Set<string>()
  for (const label of labels) {
    if (seen.has(label.key)) diagnostic('DUPLICATE_LABEL', `Duplicate label: ${label.key}`, label.from, label.to)
    seen.add(label.key)
  }
  return { file, source, nodes, labels, includes, graphicsPaths, bibliography, diagnostics }
}

function safeOffset(source: string, offset: number): boolean {
  if (offset < 1 || offset >= source.length) return true
  const previous = source.charCodeAt(offset - 1)
  const next = source.charCodeAt(offset)
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
}

/** Applies disjoint compare-before-write edits without normalizing any untouched text.
 * @param source The exact source against which patches were prepared.
 * @param patches Half-open UTF-16 replacements; expected, when supplied, must still match.
 * @returns Updated source, or throws before returning any partial update.
 */
export function applyLatexPatches(source: string, patches: readonly LatexPatch[]): string {
  const ordered = [...patches].sort((a, b) => a.from - b.from || a.to - b.to)
  let previousEnd = -1
  for (const patch of ordered) {
    if (!Number.isInteger(patch.from) || !Number.isInteger(patch.to) || patch.from < 0 || patch.to < patch.from || patch.to > source.length) throw new Error('LATEX_PATCH_RANGE')
    if (patch.from < previousEnd || !safeOffset(source, patch.from) || !safeOffset(source, patch.to)) throw new Error('LATEX_PATCH_OVERLAP_OR_CHARACTER')
    if (patch.expected !== undefined && source.slice(patch.from, patch.to) !== patch.expected) throw new Error('LATEX_PATCH_STALE')
    previousEnd = patch.to
  }
  let result = source
  for (const patch of ordered.reverse()) result = result.slice(0, patch.from) + patch.insert + result.slice(patch.to)
  return result
}

/** Encodes a changed formula and preserves its labels within the same equation.
 * @param node Original source-backed mathematical block.
 * @param latex Formula emitted by the visual math input, without its outer equation wrapper.
 * @returns One bounded formula patch; unchanged input produces the original exact source.
 */
export function createLatexMathPatch(node: LatexNode, latex: string): LatexPatch {
  if (node.kind !== 'math') throw new Error('LATEX_EXPECTED_MATH_NODE')
  const expected = node.raw.slice(node.contentFrom - node.from, node.contentTo - node.from)
  const retained = node.mathEmbeddedLabels?.map(label => label.raw).join('\n') ?? ''
  const insert = latex === node.math ? expected : latex + (retained ? `\n${retained}` : '')
  return { from: node.contentFrom, to: node.contentTo, expected, insert }
}

/** Extracts BibTeX entry identities without evaluating values or rewriting the bibliography.
 * @param source A decoded .bib file.
 * @returns Entry keys, excluding comments, string definitions and preambles.
 */
export function parseBibtexKeys(source: string): string[] {
  return [...source.matchAll(/@([A-Za-z]+)\s*[({]\s*([^,\s]+)\s*,/g)].filter(match => !/^(comment|string|preamble)$/i.test(match[1]!)).map(match => match[2]!)
}

/** Reports missing reference and citation identities using the currently loaded project.
 * @param document One parsed TeX file.
 * @param availableLabels Label keys collected across the loaded main and child files.
 * @param availableCitations Bibliography entry keys; undefined leaves citation validation pending.
 * @returns Source-local diagnostics without mutating the document.
 */
export function validateLatexReferences(document: LatexDocument, availableLabels: readonly string[], availableCitations?: readonly string[]): LatexDiagnostic[] {
  const labels = new Set(availableLabels)
  const citations = availableCitations === undefined ? undefined : new Set(availableCitations)
  const result: LatexDiagnostic[] = []
  for (const command of texCommands(document.source)) {
    const isCitation = /^cite/.test(command.name)
    const isReference = /^(?:eq|auto|page|v)?ref\*?$/.test(command.name)
    if (!isCitation && !isReference) continue
    const field = fieldForCommand(document.source, command)
    if (!field) continue
    for (const key of document.source.slice(field.contentFrom, field.contentTo).split(',').map(value => value.trim())) {
      if ((isCitation && citations && !citations.has(key)) || (isReference && !labels.has(key))) result.push({ from: field.from, to: field.to, raw: field.raw, code: isCitation ? 'MISSING_CITATION' : 'MISSING_REFERENCE', message: `${isCitation ? 'Missing citation' : 'Missing reference'}: ${key}`, severity: 'warning' })
    }
  }
  return result
}
