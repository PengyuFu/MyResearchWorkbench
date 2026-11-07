/** @vitest-environment jsdom */
/** Real Tiptap transactions and the browser MathLive entry; fixtures contain no research manuscript. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MathfieldElement } from 'mathlive'
import { Editor } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import { DecorationSet } from '@tiptap/pm/view'
import { closeHistory, redo, undo } from '@tiptap/pm/history'
import { CellSelection, TableMap, addColumnAfter, addRowAfter, mergeCells, splitCell } from '@tiptap/pm/tables'
import { parseLatexDocument } from '../src/client/latex-source.ts'
import { compileVisualDocument, mapSourceSelection, mapVisualSelection, projectVisualDocument } from '../src/client/visual-projection.ts'
import { createVisualExtensions } from '../src/client/visual-schema.ts'
import { insertVisualBlock, newVisualFigure, newVisualTable, selectVisualRange } from '../src/client/visual-commands.ts'
import { visualEn } from '../src/client/visual-locales.ts'

// Node's conditional export is the static SSR renderer. This is the actual,
// unmodified browser distribution used by the application, not a math-field mock.
vi.mock('mathlive', async () => {
  // @ts-expect-error The browser bundle's public declaration is supplied by the package export.
  return await import('../node_modules/mathlive/mathlive.mjs')
})

vi.hoisted(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  const fonts = new Set()
  Object.defineProperty(document, 'fonts', { configurable: true, value: Object.assign(fonts, { ready: Promise.resolve(fonts), status: 'loaded' }) })
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false },
  }) })
})

const source = String.raw`\documentclass{article}
\usepackage{amsmath,multirow,booktabs}
\begin{document}
\title{Synthetic scientific document}
\author{Test author}
\begin{abstract}
A short abstract with $x+1$.
\end{abstract}
\section{Introduction}
First paragraph with $x+1$ and \cite{known2026}, then \ref{eq:aligned}.
\begin{equation}
\begin{aligned}
a &= b \\
c &= d \label{eq:aligned}
\end{aligned}
\end{equation}
\begin{equation}
q=\begin{cases}
a & x>0 \\
b & x\le 0
\end{cases}
\label{eq:cases}
\end{equation}
\begin{table}
\caption{Synthetic measurements}
\label{tab:sample}
\begin{tabular}{ll}
\toprule
A & B \\
\midrule
\multirow{2}{*}{C} & D \\
 & E \\
\bottomrule
\end{tabular}
\end{table}
\end{document}
`
const editors: Editor[] = []

function makeEditor(text = source) {
  const element = document.createElement('div')
  document.body.append(element)
  const documentSource = parseLatexDocument(text, 'synthetic.tex')
  const editor = new Editor({
    element,
    content: projectVisualDocument(documentSource),
    extensions: createVisualExtensions({
      targetKey: new PluginKey<DecorationSet>(),
      validateDocument: (document) => { compileVisualDocument(document.toJSON()); return true },
      runtime: () => ({
        t: key => visualEn[key], readOnly: false,
        mathFontsDirectory: '',
        resolveAsset: async () => ({ url: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', mimeType: 'image/svg+xml' }),
        openInclude() {}, editReference() {}, save() {}, find() {}, select() {},
      }),
    }),
  })
  editors.push(editor)
  return editor
}
function compiled(editor: Editor) { return compileVisualDocument(editor.state.doc.toJSON()) }
function firstTable(editor: Editor) {
  let result: { position: number; table: import('@tiptap/pm/model').Node } | undefined
  editor.state.doc.descendants((node, position) => {
    if (result === undefined && node.type.name === 'table') result = { position, table: node }
  })
  if (result === undefined) throw new Error('Fixture table missing')
  return result
}
function selectCells(editor: Editor, first: number, last = first) {
  const { position, table } = firstTable(editor)
  const map = TableMap.get(table)
  const anchor = map.map[first]
  const head = map.map[last]
  if (anchor === undefined || head === undefined) throw new Error('Fixture cell missing')
  editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, position + 1 + anchor, position + 1 + head)))
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy()
  document.body.replaceChildren()
})

describe('scientific visual editor', () => {
  it('renders real editable math fields, merged table cells and the full front matter without source changes', () => {
    const editor = makeEditor()
    expect(compiled(editor).source).toBe(source)
    expect(editor.view.dom.querySelectorAll<MathfieldElement>('math-field')).toHaveLength(4)
    expect(editor.view.dom.querySelector('td[rowspan="2"]')).not.toBeNull()
    expect(editor.view.dom.textContent).toContain('Synthetic scientific document')
    expect(editor.view.dom.querySelector('[data-source-id]')).not.toBeNull()
    expect(editor.view.dom.textContent).toContain('Test author')
    expect(editor.view.dom.textContent).toContain('short abstract')
    expect(editor.view.dom.querySelector<MathfieldElement>('math-field')?.shadowRoot).not.toBeNull()
  })

  it('writes a MathLive cases edit into only its source object and preserves the equation label', () => {
    const editor = makeEditor()
    const fields = [...editor.view.dom.querySelectorAll<MathfieldElement>('math-field')]
    const field = fields.find(item => item.getValue('latex').includes('cases'))
    expect(field).toBeDefined()
    if (field === undefined) return
    field.setValue(String.raw`q=\begin{cases}2a&x>0\\b&x\le0\end{cases}`, { silenceNotifications: true })
    field.dispatchEvent(new Event('input', { bubbles: true }))
    const updated = compiled(editor).source
    expect(updated).toContain('2a')
    expect(updated).toContain(String.raw`\label{eq:cases}`)
    expect(updated.slice(0, updated.indexOf(String.raw`\begin{equation}`, updated.indexOf(String.raw`\end{equation}`)))).toBe(
      source.slice(0, source.indexOf(String.raw`\begin{equation}`, source.indexOf(String.raw`\end{equation}`))))
    expect(updated.slice(updated.indexOf(String.raw`\begin{table}`))).toBe(source.slice(source.indexOf(String.raw`\begin{table}`)))
    expect(undo(editor.state, editor.view.dispatch)).toBe(true)
    expect(compiled(editor).source).toBe(source)
  })

  it('keeps a cell text edit bounded and performs actual multi-column merge and split', () => {
    const editor = makeEditor()
    const start = source.indexOf(' & D') + 3
    const range = mapSourceSelection(compiled(editor), { from: start, to: start + 1 })
    expect(range).not.toBeNull()
    if (range === null) return
    selectVisualRange(editor, range)
    editor.view.dispatch(editor.state.tr.insertText('D7'))
    expect(compiled(editor).source).toBe(source.slice(0, start) + 'D7' + source.slice(start + 1))
    editor.view.dispatch(closeHistory(editor.state.tr))
    selectCells(editor, 0, 1)
    expect(mergeCells(editor.state, editor.view.dispatch)).toBe(true)
    expect(editor.view.dom.querySelector('[data-visual-cell][colspan="2"]')).not.toBeNull()
    expect(compiled(editor).source).toContain(String.raw`\multicolumn{2}`)
    expect(splitCell(editor.state, editor.view.dispatch)).toBe(true)
    expect(editor.view.dom.querySelector('[data-visual-cell][colspan="2"]')).toBeNull()
    expect(compiled(editor).source).toContain('D7')
  })

  it('supports row and column insertion through the real table command model', () => {
    const editor = makeEditor()
    selectCells(editor, 0)
    expect(addRowAfter(editor.state, editor.view.dispatch)).toBe(true)
    expect(firstTable(editor).table.childCount).toBe(4)
    selectCells(editor, 0)
    expect(addColumnAfter(editor.state, editor.view.dispatch)).toBe(true)
    expect(TableMap.get(firstTable(editor).table).width).toBe(3)
    const output = compiled(editor).source
    expect(output).toContain(String.raw`\begin{tabular}{lcl}`)
    expect(output).toContain(String.raw`\multirow{2}`)
  })

  it('maps a dragged selection across text, inline math and citation to exact current source', () => {
    const editor = makeEditor()
    const from = source.indexOf('paragraph with')
    const to = source.indexOf(', then')
    const visual = mapSourceSelection(compiled(editor), { from, to })
    expect(visual).not.toBeNull()
    if (visual === null) return
    selectVisualRange(editor, visual)
    expect(mapVisualSelection(compiled(editor), editor.state.selection)).toEqual({ from, to })
  })

  it('preserves official undo across unmount/remount and treats an external proposal as one history event', () => {
    const editor = makeEditor()
    const from = source.indexOf('First paragraph')
    const visual = mapSourceSelection(compiled(editor), { from, to: from + 5 })
    if (visual === null) throw new Error('Fixture paragraph missing')
    selectVisualRange(editor, visual)
    editor.view.dispatch(editor.state.tr.insertText('Manual'))
    const manual = compiled(editor).source
    editor.unmount()
    const nextHost = document.createElement('div')
    document.body.append(nextHost)
    editor.mount(nextHost)
    expect(undo(editor.state, editor.view.dispatch)).toBe(true)
    expect(compiled(editor).source).toBe(source)
    expect(redo(editor.state, editor.view.dispatch)).toBe(true)
    expect(compiled(editor).source).toBe(manual)
    const external = manual.replace('Introduction', 'Revised introduction')
    const parsed = parseLatexDocument(external, 'synthetic.tex')
    const projected = editor.schema.nodeFromJSON(projectVisualDocument(parsed))
    editor.view.dispatch(closeHistory(editor.state.tr).replaceWith(0, editor.state.doc.content.size, projected.content).setDocAttribute('base', parsed))
    editor.view.dispatch(closeHistory(editor.state.tr))
    expect(compiled(editor).source).toBe(external)
    expect(undo(editor.state, editor.view.dispatch)).toBe(true)
    expect(compiled(editor).source).toBe(manual)
  })

  it('inserts a blank editable table and an asset-backed figure with captions', () => {
    const editor = makeEditor()
    expect(insertVisualBlock(editor, newVisualTable(2, 3, 'New table'))).toBe(false)
    expect(compiled(editor).source).toBe(source)
    const body = mapSourceSelection(compiled(editor), { from: source.indexOf('First paragraph'), to: source.indexOf('First paragraph') })
    if (body === null) throw new Error('Fixture body missing')
    selectVisualRange(editor, body)
    expect(insertVisualBlock(editor, newVisualTable(2, 3, 'New table'))).toBe(true)
    insertVisualBlock(editor, newVisualFigure('figures/example.png', 'New image'))
    const output = compiled(editor).source
    expect(output).toContain(String.raw`\begin{tabular}{ccc}`)
    expect(output).toContain(String.raw`\caption{New table}`)
    expect(output).toContain(String.raw`\includegraphics`)
    expect(output).toContain('{figures/example.png}')
    expect(output).toContain(String.raw`\caption{New image}`)
  })
})
