/** Header/footer operations use the canonical editor and leave the body untouched. */
import type { DocxEditorInstance } from '@docx-editor.dev/core/editor'
import type { EditorCommand, HistoryGroup } from '@docx-editor.dev/core/contracts/editor'
import { paragraphTextOf } from '@docx-editor.dev/core/store'
import type { WordOperation } from '@deepseek-ai/dsh-workbench-word/types'

function exec(editor: DocxEditorInstance, command: EditorCommand, historyGroup?: HistoryGroup): void {
  const result = editor.exec(command, historyGroup === undefined ? undefined : { historyGroup })
  if (!result.ok) throw new Error(result.reason)
}

/** Apply one explicit region or page-option request to the live draft. */
export function applyDocxPage(editor: DocxEditorInstance, operation: Extract<WordOperation, { kind: 'header-footer' | 'page-options' }>, group?: HistoryGroup): void {
  const command = (value: EditorCommand) => exec(editor, value, group)
  const surface = editor.surface
  if (!surface || !editor.snapshot().editable) throw new Error('The current DOCX cannot be edited.')
  surface.flushPendingInput()
  const sections = surface.session.headerFooterResolutionBySection()
  const section = sections[operation.sectionIndex]
  if (section === undefined) throw new Error('The requested section does not exist. Inspect the current document.')
  if (operation.kind === 'page-options') {
    command({ type: 'setHeaderFooterOptions', sectionIndex: operation.sectionIndex,
      ...(operation.firstPageDifferent === undefined ? {} : { titlePage: operation.firstPageDifferent }),
      ...(operation.oddEvenDifferent === undefined ? {} : { evenAndOddHeaders: operation.oddEvenDifferent }),
      ...(operation.headerDistancePt === undefined ? {} : { headerDistanceTwips: Math.round(operation.headerDistancePt * 20) }),
      ...(operation.footerDistancePt === undefined ? {} : { footerDistanceTwips: Math.round(operation.footerDistancePt * 20) }) })
    return
  }
  const slot = (operation.position === 'header' ? section.headers : section.footers).get(operation.variant)
  const paragraphs: string[] = []
  let complex = false
  if (slot) {
    const visit = (node: (typeof slot.part.root)['children'][number]): void => {
      if (!('children' in node)) return
      if (['tbl', 'drawing', 'pict', 'object', 'sdt', 'altChunk'].includes(node.localName)) complex = true
      if (node.kind === 'paragraph') paragraphs.push(paragraphTextOf(slot.part, node.id) ?? '')
      for (const child of node.children) visit(child)
    }
    visit(slot.part.root)
  }
  if (complex) throw new Error('This region contains a table, image or protected object. Edit it directly on the page.')
  if (paragraphs.join('\n') !== operation.expectedText) throw new Error('The header/footer text changed. Inspect it before replacing it.')
  // A region inherited from another section must not change its predecessor.
  if (slot?.inherited) command({ type: 'unlinkHeaderFooterFromPrevious', position: operation.position,
    variant: operation.variant, sectionIndex: operation.sectionIndex })
  command({ type: 'editHeaderFooter', position: operation.position, variant: operation.variant, sectionIndex: operation.sectionIndex })
  try {
    if (surface.activeScope().kind !== 'headerFooter') throw new Error('The header/footer did not open; no body text was selected.')
    command({ type: 'selectAll' })
    command({ type: 'insertText', text: '' })
    const pieces = operation.content.split(/(\{(?:PAGE|NUMPAGES|SECTIONPAGES)\})/gu)
    for (const piece of pieces) {
      const field = piece.slice(1, -1)
      if (piece.startsWith('{') && (field === 'PAGE' || field === 'NUMPAGES' || field === 'SECTIONPAGES')) command({ type: 'insertPageField', field })
      else if (piece) command({ type: 'insertText', text: piece })
    }
    command({ type: 'selectAll' })
    if (operation.alignment !== undefined) command({ type: 'setAlignment', align: operation.alignment })
    if (operation.font !== undefined) command({ type: 'setMarkAttr', mark: 'fontFamily', attr: 'family', value: operation.font })
    if (operation.size !== undefined) command({ type: 'setMarkAttr', mark: 'fontSize', attr: 'val', value: Math.round(operation.size * 2) })
  } finally { command({ type: 'exitHeaderFooter' }) }
}
