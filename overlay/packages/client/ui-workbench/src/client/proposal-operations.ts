/** Version-bound scientific selections and atomic source application. */
import { applyLatexPatches, parseLatexDocument } from './latex-source.ts'
import type { LatexDocument, LatexInline, LatexPatch } from './latex-source.types.ts'
import type { EditProposal, EditorBuffer, SelectionSnapshot } from './types.ts'

function inlineTokens(document: LatexDocument): LatexInline[] {
  const result: LatexInline[] = []
  const visit = (tokens: readonly LatexInline[]) => {
    for (const token of tokens) {
      result.push(token)
      if (token.children) visit(token.children)
    }
  }
  for (const node of document.nodes) {
    visit(node.inline)
    if (node.caption) visit(node.caption.inline)
    for (const note of node.notes ?? []) visit(note.inline)
    for (const row of node.table?.rows ?? []) for (const cell of row.cells) visit(cell.inline)
  }
  return [...new Map(result.map(token => [token.from + ':' + token.to, token])).values()]
}

/** Capture complete mathematical objects while retaining ordinary prose selections.
 * @param file Current authoritative editor buffer.
 * @param origin Visible editor surface.
 * @returns A versioned selection or null for a caret without a selected object.
 */
export function scientificSelection(file: EditorBuffer, origin: 'source' | 'visual'): SelectionSnapshot | null {
  let { from, to } = file.selection
  if (from === to) return null
  let objectKind: SelectionSnapshot['objectKind'] = /\.tex$/iu.test(file.path) ? 'text' : 'code'
  let nodeId: string | undefined
  let assetPaths: string[] | undefined
  if (/\.tex$/iu.test(file.path)) {
    const document = parseLatexDocument(file.text, file.path)
    const node = document.nodes.find(item => item.from <= from && item.to >= to)
    if (node) {
      nodeId = node.id
      if (node.kind === 'math' || node.kind === 'figure' || node.kind === 'table') {
        from = node.from
        to = node.to
        objectKind = node.kind === 'math' ? 'formula' : node.kind
        if (node.images?.length) assetPaths = node.images.map(image => image.path)
      }
    }
    for (const token of inlineTokens(document)) {
      if (token.kind === 'text' || token.kind === 'linebreak') continue
      if (from > token.from && from < token.to) from = token.from
      if (to > token.from && to < token.to) to = token.to
      if (token.kind === 'math' && from === token.from && to === token.to) objectKind = 'formula'
    }
  }
  return {
    path: file.path, from, to, selectedText: file.text.slice(from, to),
    contextBefore: file.text.slice(Math.max(0, from - 8000), from),
    contextAfter: file.text.slice(to, to + 8000), bufferVersion: String(file.revision),
    lineFrom: file.text.slice(0, from).split('\n').length,
    lineTo: file.text.slice(0, to).split('\n').length, origin, objectKind,
    ...(nodeId === undefined ? {} : { nodeId }), ...(assetPaths === undefined ? {} : { assetPaths }),
  }
}

/** Place a new object after the explicitly focused body block.
 * @param file Current TeX buffer with a caret or selection.
 * @param kind Object the user requested.
 * @param assetPath A real selected figure asset, if applicable.
 * @returns A zero-width source anchor that never overwrites existing text.
 */
export function scientificInsertion(file: EditorBuffer, kind: 'figure' | 'table', assetPath?: string): SelectionSnapshot {
  const document = parseLatexDocument(file.text, file.path)
  const at = file.selection.to
  const node = document.nodes.find(item => item.from <= at && item.to >= at)
    ?? document.nodes.filter(item => item.to <= at).at(-1)
  const body = /\\begin\s*\{document\}/u.exec(file.text)
  if (!node || !node.editable || node.kind === 'field' || node.kind === 'include'
    || (body && node.from < body.index + body[0].length)) throw new Error('insertionBodyRequired')
  const from = node.to
  return {
    path: file.path, from, to: from, selectedText: '',
    contextBefore: file.text.slice(Math.max(0, from - 8000), from),
    contextAfter: file.text.slice(from, from + 8000), bufferVersion: String(file.revision),
    lineFrom: file.text.slice(0, from).split('\n').length,
    lineTo: file.text.slice(0, from).split('\n').length,
    origin: 'visual', objectKind: 'insertion', insertionKind: kind, nodeId: node.id,
    ...(assetPath === undefined ? {} : { assetPaths: [assetPath] }),
  }
}

/** Scientific object and linked-reference operations must be reviewed as one group.
 * @param proposal A complete Host-owned proposal.
 * @returns Whether independent prose/code diff hunks may be accepted.
 */
export function allowsPartialProposal(proposal: EditProposal): boolean {
  return proposal.structured === undefined && !proposal.labelChanges?.length
    && !['formula', 'table', 'figure', 'insertion'].includes(proposal.base.objectKind ?? '')
}

/** Apply a proposal and its same-file label references in one undo transaction.
 * @param file Current source with the verified proposal version.
 * @param proposal Host-owned replacement and explicit dependencies.
 * @param from Absolute start of the chosen replacement.
 * @param to Absolute end of the chosen replacement.
 * @param insert Complete replacement or one safe prose/code hunk.
 * @param partial Whether the user chose an independent hunk.
 * @returns New text and the single transaction range needed by either editor.
 */
export function applyScientificProposal(
  file: EditorBuffer, proposal: EditProposal, from: number, to: number, insert: string, partial: boolean,
): { text: string; from: number; to: number; insert: string } {
  if (partial && !allowsPartialProposal(proposal)) throw new Error('atomicProposalRequired')
  const latex = /\.tex$/iu.test(file.path)
  const before = latex ? parseLatexDocument(file.text, file.path) : null
  if (before) {
    for (const token of inlineTokens(before)) {
      if (token.kind === 'text' || token.kind === 'linebreak') continue
      if ((from > token.from && from < token.to) || (to > token.from && to < token.to)) {
        throw new Error('partialScientificObject')
      }
    }
  }
  let text = applyLatexPatches(file.text, [{ from, to, insert, expected: file.text.slice(from, to) }])
  const changes = proposal.labelChanges ?? []
  if (changes.length > 0) {
    if (!before || before.includes.length > 0) throw new Error('linkedReferencesNeedProjectReview')
    let after = parseLatexDocument(text, file.path)
    const patches: LatexPatch[] = []
    for (const change of changes) {
      if (before.labels.filter(label => label.key === change.from).length !== 1
        || before.labels.some(label => label.key === change.to)
        || after.labels.some(label => label.key === change.from)
        || after.labels.filter(label => label.key === change.to).length !== 1) {
        throw new Error('ambiguousLabelChange')
      }
      for (const token of inlineTokens(after)) {
        if (token.kind === 'reference' && token.key) {
          const keys = token.key.split(',')
          if (!keys.some(key => key.trim() === change.from)) continue
          patches.push({ from: token.contentFrom, to: token.contentTo, expected: token.key,
            insert: keys.map(key => key.trim() === change.from ? key.replace(change.from, change.to) : key).join(',') })
        } else if (token.kind === 'opaque' && token.raw.includes(change.from)) {
          throw new Error('linkedReferencesNeedProjectReview')
        }
      }
    }
    text = applyLatexPatches(text, patches)
    after = parseLatexDocument(text, file.path)
    if (after.diagnostics.some(issue => issue.severity === 'error')) throw new Error('invalidScientificProposal')
  }
  if (before) {
    const baseline = new Set(before.diagnostics.filter(issue => issue.severity === 'error').map(issue => issue.code + issue.raw))
    const after = parseLatexDocument(text, file.path)
    if (after.diagnostics.some(issue => issue.severity === 'error' && !baseline.has(issue.code + issue.raw))) {
      throw new Error('invalidScientificProposal')
    }
  }
  return changes.length > 0 ? { text, from: 0, to: file.text.length, insert: text } : { text, from, to, insert }
}
