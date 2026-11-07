/** Structural editing commands use the same ProseMirror document as ordinary typing. */
import type { Editor, JSONContent } from '@tiptap/core'
import { NodeSelection, TextSelection, Selection } from '@tiptap/pm/state'

/** Insert scientific blocks after the current top-level block, never inside a TeX field wrapper. */
export function insertVisualBlock(editor: Editor, node: JSONContent): boolean {
  const selection = editor.state.selection
  const top = selection.$from.depth > 0 ? selection.$from.node(1) : editor.state.doc.nodeAt(selection.from)
  if (top?.type.name === 'field') return false
  const position = selection.$from.depth > 0 ? selection.$from.after(1) : selection.to
  const inserted = editor.schema.nodeFromJSON(node)
  const transaction = editor.state.tr.insert(position, inserted)
  const inside = Math.min(position + 1, transaction.doc.content.size)
  transaction.setSelection(inserted.isAtom
    ? NodeSelection.create(transaction.doc, position)
    : Selection.near(transaction.doc.resolve(inside)))
  const before = editor.state.doc
  editor.view.dispatch(transaction.scrollIntoView())
  editor.view.focus()
  return !before.eq(editor.state.doc)
}

/** Inline objects preserve the current text selection; block selections receive a new paragraph. */
export function insertVisualInline(editor: Editor, node: JSONContent): boolean {
  if (!editor.state.selection.$from.parent.inlineContent) {
    return insertVisualBlock(editor, { type: 'paragraph', content: [node] })
  }
  return editor.commands.insertContent(node)
}

/** Focus a mapped source range, including atomic formulas, figures and references. */
export function selectVisualRange(editor: Editor, range: { from: number; to: number }, scroll = true): void {
  const document = editor.state.doc
  const from = Math.max(0, Math.min(range.from, document.content.size))
  const to = Math.max(from, Math.min(range.to, document.content.size))
  const node = document.nodeAt(from)
  const selection = node !== null && from + node.nodeSize === to && NodeSelection.isSelectable(node)
    ? NodeSelection.create(document, from)
    : TextSelection.between(document.resolve(from), document.resolve(to))
  const transaction = editor.state.tr.setSelection(selection)
  editor.view.dispatch(scroll ? transaction.scrollIntoView() : transaction)
}

/** Blank scientific tables carry no fabricated research values. */
export function newVisualTable(rows: number, columns: number, caption: string): JSONContent {
  return {
    type: 'tableObject',
    content: [
      { type: 'caption', content: caption ? [{ type: 'text', text: caption }] : [] },
      { type: 'table', content: Array.from({ length: rows }, (_, row) => ({
        type: 'tableRow', content: Array.from({ length: columns }, () => ({
          type: 'tableCell', attrs: { header: row === 0 },
          content: [{ type: 'paragraph' }],
        })),
      })) },
      { type: 'label', content: [] },
    ],
  }
}

/** New figures use a resolved project asset and an editable caption. */
export function newVisualFigure(path: string, caption: string): JSONContent {
  return { type: 'figure', content: [
    { type: 'image', attrs: { path, imageIndex: 0 } },
    { type: 'caption', content: caption ? [{ type: 'text', text: caption }] : [] },
    { type: 'label', content: [] },
  ] }
}
