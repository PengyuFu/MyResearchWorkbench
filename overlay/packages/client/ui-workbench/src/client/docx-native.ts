/** Basic command adapters for the pinned tree editor, always through its guarded live surface. */
import type { DocxEditorInstance } from '@docx-editor.dev/core/editor'
import type { OoxmlNode, TreeDocOp } from '@docx-editor.dev/core/store'
import { cellSelectionBetween, tableContextAt, type TableCellAddress } from '@docx-editor.dev/core/layout'
import type { WordNativeCommand } from '@deepseek-ai/dsh-workbench-word/types'

type Defined<T> = T extends WordNativeCommand ? { [K in keyof T]: Exclude<T[K], undefined> } : never
function defined<T extends WordNativeCommand>(command: T): Defined<T> {
  return Object.fromEntries(Object.entries(command).filter(([, value]) => value !== undefined)) as Defined<T>
}
function tableAt(root: OoxmlNode, paragraphId: string): OoxmlNode | undefined {
  const pending: { node: OoxmlNode; table: OoxmlNode | undefined }[] = [{ node: root, table: undefined }]
  let visited = 0
  while (pending.length > 0) {
    if (++visited > 100000) throw new Error('The table context exceeds the supported document size.')
    const current = pending.pop()
    if (current === undefined) break
    const table = 'localName' in current.node && current.node.localName === 'tbl' ? current.node : current.table
    if (current.node.id === paragraphId) return table
    if ('children' in current.node) for (const child of current.node.children) pending.push({ node: child, table })
  }
  return undefined
}
/** Apply a validated command through the guarded native editor.
 * @param editor - Open authoritative editor.
 * @param command - Validated native operation.
 */
export function applyDocxNative(editor: DocxEditorInstance, command: WordNativeCommand): void {
  const surface = editor.surface
  if (!surface || !editor.snapshot().editable) throw new Error('The current DOCX cannot be edited.')
  if (command.type === 'setParagraphPagination') {
    if (surface.activeScope().kind !== 'body' || editor.getEditingMode() !== 'editing') throw new Error('Pagination changes require ordinary body editing.')
    const { type: _type, ...flags } = defined(command)
    surface.setParagraphFormat(flags)
    return
  }
  if (command.type === 'selectTableRegion') {
    if (surface.activeScope().kind !== 'body') throw new Error('Return to the document body before selecting a table region.')
    const layout = surface.layout(), at = tableContextAt(layout, surface.state().selection.anchor.paragraphId)
    if (!at) throw new Error('Place the caret in a table first.')
    const table = tableAt(surface.session.part().root, surface.state().selection.anchor.paragraphId)
    if (!table) throw new Error('The table structure is unavailable.')
    const cells = new Map<string, TableCellAddress>()
    const pending = [{ node: table, rowId: '', cellId: '' }]
    while (pending.length > 0) {
      const current = pending.pop()
      if (current === undefined) break
      const { node, rowId: parentRow, cellId: parentCell } = current
      if (node !== table && 'localName' in node && node.localName === 'tbl') continue
      const rowId = 'localName' in node && node.localName === 'tr' ? node.id : parentRow
      const cellId = 'localName' in node && node.localName === 'tc' ? node.id : parentCell
      if (rowId && cellId && !cells.has(cellId)) {
        const context = tableContextAt(layout, node.id)
        if (context?.tableId === at.tableId) cells.set(cellId, { tableId: at.tableId, rowId, cellId,
          rowIndex: context.rowIndex, gridColumn: context.columnIndex, gridSpan: 1 })
      }
      if ('children' in node) for (const child of node.children) pending.push({ node: child, rowId, cellId })
    }
    let candidates = [...cells.values()].sort((a, b) => a.rowIndex - b.rowIndex || a.gridColumn - b.gridColumn)
    candidates = candidates.map((cell, index) => {
      const next = candidates[index + 1]
      const endColumn = next !== undefined && next.rowIndex === cell.rowIndex ? next.gridColumn : at.columns
      return { ...cell, gridSpan: endColumn - cell.gridColumn }
    })
    if (command.region === 'row') candidates = candidates.filter(cell => cell.rowIndex === at.rowIndex)
    if (command.region === 'column') {
      const rows = new Map<number, TableCellAddress>()
      for (const cell of candidates) if (cell.gridColumn <= at.columnIndex) rows.set(cell.rowIndex, cell)
      candidates = [...rows.values()]
    }
    const first = candidates[0], last = candidates.at(-1)
    const selected = first && last && cellSelectionBetween(layout, first, last)
    if (!selected) throw new Error('The table region cannot be selected.')
    surface.setCellSelection(selected)
    return
  }
  if (command.type === 'replaceAllMatches') {
    if (surface.activeScope().kind !== 'body') throw new Error('Return to the document body before replacing all body matches.')
    if (editor.getEditingMode() !== 'editing') throw new Error('Bulk replacement requires ordinary editing mode.')
    const matches = editor.findMatches(command.query, {
      matchCase: command.matchCase ?? false, wholeWord: command.wholeWord ?? false,
    }).filter(match => !match.scope)
    if (matches.length > 10000) throw new Error('Too many matches for one basic replacement.')
    const ops: TreeDocOp[] = []
    for (const match of matches.slice().reverse()) {
      if (command.text !== '') ops.push({ op: 'insertText', paragraphId: match.blockId, offset: match.start, text: command.text, bias: 'right' })
      ops.push({ op: 'deleteText', paragraphId: match.blockId, start: match.start + command.text.length, end: match.start + command.text.length + match.length })
    }
    if (ops.length === 0) return
    const result = surface.applyAutomationOps(() => ops)
    if (result.rejected) throw new Error(result.reason)
    return
  }
  if (command.type === 'autoFitTable') {
    if (surface.activeScope().kind !== 'body' || editor.getEditingMode() !== 'editing') throw new Error('Table AutoFit requires ordinary body editing.')
    const selection = surface.state().selection, part = surface.session.part()
    const table = tableAt(part.root, selection.anchor.paragraphId)
    if (!table || tableAt(part.root, selection.head.paragraphId)?.id !== table.id) throw new Error('Select cells in a single table first.')
    const result = surface.applyAutomationOps(() => [{ op: 'setTableProperties', tableId: table.id, autoFit: command.mode, autoRowHeight: command.resetRowHeights ?? true }])
    if (result.rejected) throw new Error(result.reason)
    return
  }
  if (command.type === 'setTableProperties') {
    const selection = surface.state().selection, part = surface.session.part()
    const table = tableAt(part.root, selection.anchor.paragraphId)
    if (!table || tableAt(part.root, selection.head.paragraphId)?.id !== table.id) throw new Error('Select cells in a single table first.')
    const result = surface.applyAutomationOps(() => [{ op: 'setTableProperties', tableId: table.id,
      ...command.styleId === undefined ? {} : { styleId: command.styleId },
      ...command.headerRowCount === undefined ? {} : { headerRowCount: command.headerRowCount },
      ...command.columnWidthsTwips === undefined ? {} : { columnWidthsTwips: command.columnWidthsTwips } }])
    if (result.rejected) throw new Error(result.reason)
    return
  }
  const result = editor.exec(defined(command))
  if (!result.ok) throw new Error(result.reason)
}
