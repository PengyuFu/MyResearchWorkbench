/** Pure Word editing projection helpers; DOCX bytes remain exclusively Host-owned. */
import type { JSONContent } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { WordOperation, WordProjection, WordSnapshot } from '@deepseek-ai/dsh-workbench-word/types'
import type { EditorBuffer, SelectionSnapshot, WordEditorBuffer } from './types.ts'

export function wordBuffer(word: WordSnapshot, previous?: EditorBuffer): WordEditorBuffer {
  const text = word.projection.text
  return { ...previous, kind: 'word', mode: 'writing', path: word.path, absolutePath: word.absolutePath,
    text, savedText: word.revision === word.savedRevision ? text : previous?.savedText ?? text,
    savedRawText: text, lineEnding: 'lf', diskVersion: word.diskVersion, revision: word.revision,
    selection: previous?.selection ?? { from: 0, to: 0 }, scrollTop: previous?.scrollTop ?? 0,
    pane: word.engine === 'ooxml' ? 'visual' : word.projection.readOnly ? 'pdf' : previous?.pane ?? 'pdf', word, wordSync: 'idle', pendingWord: undefined,
    unavailable: false, restoredDraft: false, error: undefined,
    saveState: word.originalStatus === 'conflict' ? 'conflict' : word.originalStatus === 'unavailable' ? 'error'
      : word.revision === word.savedRevision ? 'clean' : 'dirty' }
}

/** UTF-16 common prefix/suffix, widened off surrogate-pair boundaries. */
export function wordTextChange(before: string, after: string): Extract<WordOperation, { kind: 'replace' }> | null {
  if (before === after) return null
  let from = 0, endA = before.length, endB = after.length
  const prefixLimit = Math.min(endA, endB) - (before.endsWith('\n') && after.endsWith('\n') ? 1 : 0)
  while (from < prefixLimit && before[from] === after[from]) from++
  if (from > 0 && /[\uD800-\uDBFF]/u.test(before.charAt(from - 1))) from--
  while (endA > from && endB > from && before[endA - 1] === after[endB - 1]) { endA--; endB-- }
  if (endA < before.length && /[\uDC00-\uDFFF]/u.test(before.charAt(endA))) { endA++; endB++ }
  return { kind: 'replace', from, to: endA, before: before.slice(from, endA), text: after.slice(from, endB) }
}

export function wordSelection(file: WordEditorBuffer, insertion = false): SelectionSnapshot | null {
  if (file.pendingWord !== undefined || file.wordSync !== 'idle' || file.unavailable) return null
  const { from, to } = file.selection
  if (!insertion && from === to) return null
  const node = file.word.projection.blocks.find(block => from >= block.from && from <= block.to)
  return { path: file.path, from, to: insertion ? from : to, selectedText: insertion ? '' : file.text.slice(from, to),
    contextBefore: file.text.slice(Math.max(0, from - 1000), from), contextAfter: file.text.slice(to, to + 1000),
    bufferVersion: String(file.revision), origin: 'visual', objectKind: insertion ? 'insertion' : 'text',
    ...(node === undefined ? {} : { nodeId: node.id }), lineFrom: file.text.slice(0, from).split('\n').length,
    lineTo: file.text.slice(0, to).split('\n').length }
}

/** Match PDF line wrapping to one current text range; ambiguous or protected text stays read-only. */
export function wordPageSelection(file: WordEditorBuffer, text: string): SelectionSnapshot | null {
  if (file.word.projection.readOnly || file.pendingWord !== undefined || file.wordSync !== 'idle' || file.unavailable) return null
  const compact = (value: string) => {
    let text = ''
    const offsets: number[] = []
    for (let i = 0; i < value.length; i++) {
      if (/\s/u.test(value.charAt(i))) continue
      text += value[i]; offsets.push(i)
    }
    return { text, offsets }
  }
  const source = compact(file.text), selected = compact(text)
  if (!selected.text) return null
  const at = source.text.indexOf(selected.text)
  if (at < 0 || source.text.indexOf(selected.text, at + 1) >= 0) return null
  const from = source.offsets[at], last = source.offsets[at + selected.text.length - 1]
  if (from === undefined || last === undefined) return null
  const to = last + 1
  const blocks = file.word.projection.blocks.filter(block => block.to > from && block.from < to)
  if (blocks.length === 0 || blocks.some(block => block.kind !== 'paragraph')) return null
  return wordSelection({ ...file, selection: { from, to } })
}

function paragraph(block: WordProjection['blocks'][number]): JSONContent {
  const attrs = { id: block.id, level: block.level, style: block.style, alignment: block.alignment,
    spaceBefore: block.spaceBefore, spaceAfter: block.spaceAfter, lineSpacing: block.lineSpacing ?? null, table: block.table ?? null,
    list: block.list ?? '' }
  if (block.kind !== 'paragraph') return { type: 'wordObject', attrs: { ...attrs, kind: block.kind,
    text: block.text, reason: block.reason ?? '', image: block.image ?? null } }
  const content: JSONContent[] = []
  let offset = 0
  for (const run of block.runs) {
    const start = Math.max(0, run.from), end = Math.min(block.text.length, run.to)
    if (start > offset) content.push({ type: 'text', text: block.text.slice(offset, start) })
    if (end > start) content.push({ type: 'text', text: block.text.slice(start, end), marks: [
      { type: 'wordFormat', attrs: { bold: run.bold ?? false, italic: run.italic ?? false,
        underline: run.underline ?? false, font: run.font ?? '', size: run.size ?? 0 } },
    ] })
    offset = Math.max(offset, end)
  }
  if (offset < block.text.length) content.push({ type: 'text', text: block.text.slice(offset) })
  return { type: 'wordParagraph', attrs, content }
}

export function wordDocument(projection: WordProjection): JSONContent {
  const content: JSONContent[] = []
  for (let i = 0; i < projection.blocks.length;) {
    const block = projection.blocks[i]
    if (block === undefined) break
    if (block.table === undefined) { content.push(paragraph(block)); i++; continue }
    const id = block.table.id, rows: JSONContent[] = []
    let current = projection.blocks[i]
    while (current?.table?.id === id) {
      const rowNumber = current.table.row, cells: JSONContent[] = []
      while (current?.table?.id === id && current.table.row === rowNumber) {
        const column = current.table.column, paragraphs: JSONContent[] = []
        while (current?.table?.id === id && current.table.row === rowNumber && current.table.column === column) {
          paragraphs.push(paragraph(current))
          current = projection.blocks[++i]
        }
        cells.push({ type: 'wordCell', content: paragraphs })
      }
      rows.push({ type: 'wordRow', content: cells })
    }
    content.push({ type: 'wordTable', content: rows })
  }
  return { type: 'doc', content }
}

export function wordText(document: PMNode): string {
  let text = ''
  document.descendants((node) => {
    if (node.type.name === 'wordParagraph') { text += node.textContent + '\n'; return false }
    if (node.type.name === 'wordObject') { text += String(node.attrs.text) + '\n'; return false }
    return true
  })
  return text
}

export function wordPosition(document: PMNode, position: number): number {
  let offset = 0, result = 0, found = false
  document.descendants((node, pos) => {
    if (node.type.name !== 'wordParagraph' && node.type.name !== 'wordObject') return true
    const length = node.type.name === 'wordObject' ? String(node.attrs.text).length : node.textContent.length
    if (!found && position <= pos + node.nodeSize) { result = offset + Math.max(0, Math.min(length, position - pos - 1)); found = true }
    offset += length + 1
    return false
  })
  return found ? result : Math.max(0, offset - 1)
}

export function editorPosition(document: PMNode, offset: number): number {
  let consumed = 0, result = 1, found = false
  document.descendants((node, pos) => {
    if (node.type.name !== 'wordParagraph' && node.type.name !== 'wordObject') return true
    const length = node.type.name === 'wordObject' ? String(node.attrs.text).length : node.textContent.length
    if (!found && offset <= consumed + length) { result = pos + (node.type.name === 'wordObject' ? 0 : 1 + Math.max(0, offset - consumed)); found = true }
    consumed += length + 1
    return false
  })
  return found ? result : Math.max(1, document.content.size - 1)
}

/** Native table boundaries and protected objects cannot be deleted by a browser transaction. */
export function preservesWordObjects(before: PMNode, after: PMNode): boolean {
  const signature = (doc: PMNode): string => {
    const objects: unknown[] = []
    doc.descendants((node) => {
      if (node.type.name === 'wordObject') { objects.push(node.toJSON()); return false }
      if (node.type.name === 'wordTable') objects.push({ table: node.childCount, cells: Array.from({ length: node.childCount }, (_, i) => node.child(i).childCount) })
      return true
    })
    return JSON.stringify(objects)
  }
  return signature(before) === signature(after)
}

/** Build the pending-input view without serializing or replacing native Word formatting.
 * @param projection - last acknowledged native paragraphs.
 * @param text - full browser draft retained by the existing recovery coordinator.
 * @returns a preview document for the pending-input record. */
export function wordDraftDocument(projection: WordProjection, text: string): string {
  const change = wordTextChange(projection.text, text)
  if (change === null) return JSON.stringify(wordDocument(projection))
  const first = projection.blocks.findIndex(block => block.from <= change.from && change.from <= block.to)
  const last = projection.blocks.findIndex(block => block.from <= change.to && change.to <= block.to)
  const start = projection.blocks[first], end = projection.blocks[last]
  if (start === undefined || end === undefined) throw new Error('The Word draft range is no longer available.')
  const value = start.text.slice(0, change.from - start.from) + change.text + end.text.slice(change.to - end.from)
  const replacement = value.split('\n').map((part, index) => ({ ...start,
    id: index === 0 ? start.id : start.id + ':input:' + index, text: part, runs: [] }))
  let offset = 0
  const blocks = [...projection.blocks.slice(0, first), ...replacement, ...projection.blocks.slice(last + 1)]
    .map((block) => { const next = { ...block, from: offset, to: offset + block.text.length }; offset = next.to + 1; return next })
  return JSON.stringify(wordDocument({ ...projection, text, blocks }))
}
