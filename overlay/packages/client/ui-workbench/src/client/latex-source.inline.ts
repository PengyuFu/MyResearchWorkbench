/** Inline TeX projection and context-aware text encoding. */
import type { LatexInline } from './latex-source.types.ts'
import { readTexCommand, readTexGroup, requiredTexGroup, skipTexSpace } from './latex-source.scan.ts'

const textMarks: Record<string, NonNullable<LatexInline['marks']>[number]> = {
  textbf: 'bold', textit: 'italic', emph: 'italic', texttt: 'code',
  textsuperscript: 'superscript', textsubscript: 'subscript',
}
const literalCommands: Record<string, string> = {
  '%': '%', '&': '&', '#': '#', '_': '_', '$': '$', '{': '{', '}': '}',
  ' ': ' ', ',': '\u2009', ';': '\u2004', ':': '\u2005', '!': '',
  textbackslash: '\\', textasciitilde: '~', textasciicircum: '^',
  LaTeX: 'LaTeX', TeX: 'TeX', ldots: '…', dots: '…', quad: '\u2003', qquad: '\u2003\u2003',
}
const escapedText: Record<string, string> = {
  '\\': '\\textbackslash{}', '%': '\\%', '&': '\\&', '#': '\\#', '_': '\\_', '$': '\\$',
  '{': '\\{', '}': '\\}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}', '\u00a0': '~',
}

function decodedText(source: string, from: number, to: number): { text: string; textMap: number[] } {
  let text = ''
  const textMap = [from]
  let at = from
  const emit = (value: string, start: number, end: number) => {
    textMap[textMap.length - 1] = start
    text += value
    for (let i = 0; i < value.length; i++) textMap.push(i + 1 === value.length ? end : start)
  }
  while (at < to) {
    const char = source[at]!
    if (/\s/.test(char)) {
      let end = at + 1
      while (end < to && /\s/.test(source[end]!)) end++
      emit(' ', at, end); at = end; continue
    }
    if (char === '~') { emit('\u00a0', at, at + 1); at++; continue }
    const dash = source.startsWith('---', at) ? '---' : source.startsWith('--', at) ? '--' : ''
    if (dash) { emit(dash.length === 3 ? '—' : '–', at, at + dash.length); at += dash.length; continue }
    if (source.startsWith('``', at) || source.startsWith("''", at)) {
      emit(source[at] === '`' ? '“' : '”', at, at + 2); at += 2; continue
    }
    if (char === '\\') {
      const command = readTexCommand(source, at)
      if (command && command.name in literalCommands) {
        let end = command.to
        if (source.slice(end, end + 2) === '{}') end += 2
        emit(literalCommands[command.name]!, at, Math.min(end, to)); at = end; continue
      }
    }
    const point = source.codePointAt(at)!
    const value = String.fromCodePoint(point)
    emit(value, at, at + value.length); at += value.length
  }
  if (!text.length) textMap[0] = from
  return { text, textMap }
}

function mathEnd(source: string, from: number, to: number, delimiter: string): number {
  let at = from
  while (at < to) {
    if (source.startsWith(delimiter, at)) return at
    if (source[at] === '\\') at = readTexCommand(source, at)?.to ?? at + 1
    else at++
  }
  return -1
}

/** Projects inline text, mathematical objects and reference keys without expanding macros.
 * @param source The complete TeX file.
 * @param from First UTF-16 offset, defaulting to the beginning.
 * @param to End UTF-16 offset, defaulting to the end.
 * @returns Ordered, non-overlapping source-backed inline tokens.
 */
export function parseLatexInline(source: string, from = 0, to = source.length): LatexInline[] {
  const tokens: LatexInline[] = []
  let at = from
  let textStart = from
  const flush = (end: number) => {
    if (end <= textStart) return
    const decoded = decodedText(source, textStart, end)
    tokens.push({ kind: 'text', from: textStart, to: end, contentFrom: textStart, contentTo: end, raw: source.slice(textStart, end), ...decoded })
  }
  const push = (token: LatexInline) => { flush(token.from); tokens.push(token); at = token.to; textStart = at }
  while (at < to) {
    if (source[at] === '%') {
      const newline = source.indexOf('\n', at)
      const end = newline < 0 ? to : Math.min(newline + 1, to)
      push({ kind: 'opaque', from: at, to: end, contentFrom: at, contentTo: end, raw: source.slice(at, end), text: '', command: 'comment' })
      continue
    }
    if (source[at] === '$') {
      const delimiter = source.startsWith('$$', at) ? '$$' : '$'
      const end = mathEnd(source, at + delimiter.length, to, delimiter)
      if (end >= 0) {
        const latex = source.slice(at + delimiter.length, end)
        push({ kind: 'math', from: at, to: end + delimiter.length, contentFrom: at + delimiter.length, contentTo: end, raw: source.slice(at, end + delimiter.length), text: latex, latex })
        continue
      }
    }
    if (source[at] === '{') {
      const group = readTexGroup(source, at)
      if (group && group.to <= to) {
        const children = parseLatexInline(source, group.contentFrom, group.contentTo)
        const text = children.map(child => child.text).join('')
        push({ kind: 'text', ...group, children, text, textMap: children.flatMap((child, i) => (child.textMap ?? Array<number>(child.text.length + 1).fill(child.contentFrom)).slice(i ? 1 : 0)) })
        continue
      }
    }
    if (source[at] !== '\\') { at++; continue }
    const command = readTexCommand(source, at)
    if (!command) { at++; continue }
    if (command.name in literalCommands) {
      at = command.to
      if (source.slice(at, at + 2) === '{}') at += 2
      continue
    }
    if (command.name === '(' || command.name === '[') {
      const closer = command.name === '(' ? '\\)' : '\\]'
      const end = mathEnd(source, command.to, to, closer)
      if (end >= 0) {
        const latex = source.slice(command.to, end)
        push({ kind: 'math', from: at, to: end + 2, contentFrom: command.to, contentTo: end, raw: source.slice(at, end + 2), text: latex, latex })
        continue
      }
    }
    if (command.name === '\\' || command.name === 'par' || command.name === 'newline') {
      let end = command.to
      const after = skipTexSpace(source, end, to)
      if (source[after] === '[') end = readTexGroup(source, after, '[', ']')?.to ?? end
      push({ kind: 'linebreak', from: at, to: end, contentFrom: at, contentTo: end, raw: source.slice(at, end), text: command.name === 'par' ? '\n\n' : '\n', command: command.name })
      continue
    }
    if (command.name === 'sep') {
      push({ kind: 'linebreak', ...command, contentFrom: at, contentTo: command.to, text: '; ', command: 'sep' })
      continue
    }
    const group = requiredTexGroup(source, command.to)
    if (group && group.to <= to && (command.name in textMarks || ['textrm', 'textnormal', 'mbox', 'texorpdfstring', 'shortstack', 'makecell'].includes(command.name))) {
      let end = group.to
      if (command.name === 'texorpdfstring') {
        const alternative = requiredTexGroup(source, group.to)
        if (alternative) end = alternative.to
      }
      const children = parseLatexInline(source, group.contentFrom, group.contentTo)
      const text = children.map(child => child.text).join('')
      const mark = textMarks[command.name]
      push({ kind: 'text', from: at, to: end, contentFrom: group.contentFrom, contentTo: group.contentTo, raw: source.slice(at, end), text, children, ...(mark ? { marks: [mark] } : {}), command: command.name })
      continue
    }
    if (group && group.to <= to && command.name === 'ensuremath') {
      const latex = source.slice(group.contentFrom, group.contentTo)
      push({ kind: 'math', from: at, to: group.to, contentFrom: group.contentFrom, contentTo: group.contentTo, raw: source.slice(at, group.to), text: latex, latex, command: command.name })
      continue
    }
    if (group && group.to <= to && /^(?:cite(?:p|t|alp|alt|author|year|yearpar)?\*?|(?:eq|auto|page|v)?ref\*?|corref)$/.test(command.name)) {
      const key = source.slice(group.contentFrom, group.contentTo)
      const kind = command.name.startsWith('cite') ? 'citation' : 'reference'
      const text = command.name === 'corref' ? '†' : kind === 'citation' ? `[${key}]` : key
      push({ kind, from: at, to: group.to, contentFrom: group.contentFrom, contentTo: group.contentTo, raw: source.slice(at, group.to), text, key, command: command.name })
      continue
    }
    let end = command.to
    if (group && group.to <= to) end = group.to
    push({ kind: 'opaque', from: at, to: end, contentFrom: at, contentTo: end, raw: source.slice(at, end), text: source.slice(at, end), command: command.name })
  }
  flush(to)
  return tokens
}

/** Escapes inserted prose, preserving Unicode and paragraph breaks.
 * @param text Plain text supplied by the editor.
 * @returns TeX text safe in a prose or table-cell context.
 */
export function textToLatex(text: string): string {
  return text.replace(/[\\%&#_$\{\}~^\u00a0]/g, char => escapedText[char]!)
}

/** Maps an inline display offset to its original UTF-16 position.
 * @param token A token returned by parseLatexInline.
 * @param displayedOffset Offset in the token's displayed text.
 * @returns A source position; atomic objects map only to their complete endpoints.
 */
export function inlineOffsetToSource(token: LatexInline, displayedOffset: number): number {
  const offset = Math.max(0, Math.min(displayedOffset, token.text.length))
  if (token.kind !== 'text') return offset === 0 ? token.from : token.to
  if (token.textMap) return token.textMap[offset] ?? token.contentTo
  if (token.children) {
    let remaining = offset
    for (const child of token.children) {
      if (remaining <= child.text.length) return inlineOffsetToSource(child, remaining)
      remaining -= child.text.length
    }
  }
  return offset === 0 ? token.contentFrom : token.contentTo
}

/** Keeps original inline syntax; editor-created tokens without raw text are encoded.
 * @param tokens Ordered inline objects, with raw cleared only for deliberately new tokens.
 * @returns Their TeX representation.
 */
export function inlineToLatex(tokens: readonly LatexInline[]): string {
  return tokens.map(token => {
    if (token.raw) return token.raw
    if (token.kind === 'math') return `$${token.latex ?? token.text}$`
    if (token.kind === 'citation' || token.kind === 'reference') return `\\${token.command ?? (token.kind === 'citation' ? 'citep' : 'ref')}{${token.key ?? token.text}}`
    if (token.kind === 'linebreak') return token.command === 'sep' ? '\\sep ' : '\\\\'
    let value = token.children ? inlineToLatex(token.children) : textToLatex(token.text)
    const commands = { bold: 'textbf', italic: 'emph', code: 'texttt', superscript: 'textsuperscript', subscript: 'textsubscript' }
    for (const mark of token.marks ?? []) value = `\\${commands[mark]}{${value}}`
    return value
  }).join('')
}
