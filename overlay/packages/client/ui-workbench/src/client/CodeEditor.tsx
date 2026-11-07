/** CodeMirror document surface; display wrapping never changes file contents. */
import { useEffect, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { Decoration, EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyField, historyKeymap, indentWithTab, isolateHistory, redo, undo } from '@codemirror/commands'
import { bracketMatching, HighlightStyle, foldGutter, indentOnInput, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { python } from '@codemirror/lang-python'
import { cpp } from '@codemirror/lang-cpp'
import { octave } from '@codemirror/legacy-modes/mode/octave'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import type { DevelopmentLanguage } from './DevelopmentControls.tsx'
import type { EditorBuffer, SelectionSnapshot, WorkbenchActions, WorkbenchSnapshot } from './types.ts'
import type { WorkbenchKey } from './locales.ts'
import css from './Workbench.module.css'

interface CodeEditorProps {
  file: EditorBuffer
  fontSize: number
  wrap: boolean
  language?: DevelopmentLanguage
  palette?: 'vscode' | 'scientific' | undefined
  selection: SelectionSnapshot | null
  sourceTarget: WorkbenchSnapshot['sourceTarget']
  command: { type: 'undo' | 'redo' | 'find'; token: number } | null
  onEdit: WorkbenchActions['edit']
  onSave: () => void
  onSelect: (mode: 'ask' | 'edit' | 'assist') => void
  t: (key: WorkbenchKey) => string
}

function language(path: string, override?: DevelopmentLanguage) {
  if (override === 'matlab') return StreamLanguage.define(octave)
  if (override === 'python') return python()
  if (override === 'cpp' || override === 'cuda') return cpp()
  if (override === 'text') return []
  if (/\.m$/i.test(path)) return StreamLanguage.define(octave)
  if (/\.(tex|bib|sty|cls)$/i.test(path)) return StreamLanguage.define(stex)
  if (/\.(py|pyw|pyi)$/i.test(path)) return python()
  if (/\.(cu|cuh|c|cpp|cc|cxx|h|hh|hpp|hxx)$/i.test(path)) return cpp()
  return []
}

const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--dsw-alias-label-primary)', backgroundColor: 'var(--dsw-alias-bg-base)' },
  '.cm-scroller': { fontFamily: 'var(--dsw-font-mono, Consolas, monospace)', lineHeight: '1.6', overflow: 'auto' },
  '.cm-content': { padding: '18px 0', caretColor: 'var(--dsw-alias-label-primary)' },
  '.cm-line': { padding: '0 20px 0 10px' },
  '.cm-gutters': { backgroundColor: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-tertiary)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--dsw-alias-interactive-bg-hover) 25%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--dsw-alias-interactive-bg-hover)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--dsw-alias-bg-document-selection)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--dsw-alias-label-primary)' },
  '.cm-panels': { backgroundColor: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
  '.cm-textfield': { backgroundColor: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)', borderColor: 'var(--dsw-alias-border-l2)' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', borderColor: 'var(--dsw-alias-border-l2)' },
  '.mrw-selection-target': { backgroundColor: 'var(--dsw-alias-bg-document-selection)', borderBottom: '2px solid var(--dsw-alias-link)' },
})

const highlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword], color: 'var(--dsw-alias-code-keyword)', fontWeight: '500' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--dsw-alias-code-string)' },
  { tag: tags.comment, color: 'var(--dsw-alias-code-comment)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--dsw-alias-code-number)' },
  { tag: [tags.typeName, tags.className], color: 'var(--dsw-alias-code-type)' },
  { tag: tags.function(tags.variableName), color: 'var(--dsw-alias-code-function)' },
  { tag: tags.meta, color: 'var(--dsw-alias-code-keyword)' },
  { tag: tags.invalid, textDecoration: 'underline wavy', color: 'var(--dsw-alias-state-error-primary)' },
])

/** Own the imperative editor lifecycle without exposing its object through slots. */
export function CodeEditor(props: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const current = useRef(props)
  current.current = props
  const font = useRef(new Compartment())
  const wrapping = useRef(new Compartment())
  const target = useRef(new Compartment())
  const syntax = useRef(new Compartment())
  const palette = useRef(new Compartment())
  const lastEdit = useRef(0)
  const lastLocation = useRef(0)

  useEffect(() => {
    if (host.current === null) return
    const initial = current.current
    lastEdit.current = 0
    lastLocation.current = 0
    const emit = (editor: EditorView) => {
      // An unavailable placeholder must never overwrite the file that replaces it.
      if (initial.file.unavailable === true) return
      const range = editor.state.selection.main
      initial.onEdit(initial.file.path, editor.state.doc.toString(), { from: range.from, to: range.to },
        JSON.stringify(editor.state.toJSON({ history: historyField })), editor.scrollDOM.scrollTop)
    }
    const extensions = [
      EditorState.readOnly.of(initial.file.unavailable === true), EditorView.editable.of(initial.file.unavailable !== true),
      theme, palette.current.of(EditorView.theme({}, { dark: initial.palette === 'vscode' })), lineNumbers(), highlightActiveLineGutter(), history(), drawSelection(), indentOnInput(),
      bracketMatching(), closeBrackets(), foldGutter(),
      syntaxHighlighting(highlighting), highlightActiveLine(), search({ top: true }),
      syntax.current.of(language(initial.file.path, initial.language)),
      font.current.of(EditorView.theme({ '&': { fontSize: `${initial.fontSize}px` } })),
      wrapping.current.of(initial.wrap ? EditorView.lineWrapping : []), target.current.of([]),
      keymap.of([
        // Character key normalization can match Mod-k before its shifted form.
        // Read the actual event so both lowercase and uppercase keys retain Shift.
        { any: (_editor, event) => {
          if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.isComposing || event.key.toLowerCase() !== 'k') return false
          current.current.onSelect('assist')
          return true
        } },
        { key: 'Mod-s', run: () => { current.current.onSave(); return true } },
        ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab,
      ]),
      EditorView.updateListener.of((update) => { if (update.docChanged || update.selectionSet) emit(update.view) }),
      EditorView.contentAttributes.of({ 'aria-label': initial.file.path, spellcheck: /\.(tex|md|txt)$/i.test(initial.file.path) ? 'true' : 'false' }),
    ]
    const selection = { anchor: Math.min(initial.file.selection.from, initial.file.text.length),
      head: Math.min(initial.file.selection.to, initial.file.text.length) }
    let state: EditorState
    if (initial.file.editorState !== undefined) {
      try {
        const serialized: object = JSON.parse(initial.file.editorState)
        state = EditorState.fromJSON(serialized, { extensions }, { history: historyField })
        const previous = state.doc.toString()
        if (previous !== initial.file.text) {
          const edit = initial.file.edit
          if (edit !== undefined && edit.to <= previous.length
            && previous.slice(0, edit.from) + edit.insert + previous.slice(edit.to) === initial.file.text) {
            state = state.update({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, annotations: isolateHistory.of('full'),
              selection: { anchor: edit.from, head: edit.from + edit.insert.length } }).state
            lastEdit.current = edit.id
          } else state = EditorState.create({
            doc: initial.file.text, extensions,
            selection,
          })
        }
      } catch (_error) { state = EditorState.create({ doc: initial.file.text, extensions }) }
    } else state = EditorState.create({
      doc: initial.file.text, extensions,
      selection,
    })
    const editor = new EditorView({ state, parent: host.current })
    view.current = editor
    editor.scrollDOM.scrollTop = initial.file.scrollTop
    let scrollTimer: ReturnType<typeof setTimeout> | undefined
    const onScroll = () => {
      if (scrollTimer !== undefined) clearTimeout(scrollTimer)
      scrollTimer = setTimeout(() => emit(editor), 100)
    }
    const checkpoint = () => { if (host.current?.getClientRects().length) emit(editor) }
    window.addEventListener('mrw:checkpoint-editors', checkpoint)
    editor.scrollDOM.addEventListener('scroll', onScroll)
    return () => {
      if (scrollTimer !== undefined) clearTimeout(scrollTimer)
      checkpoint()
      window.removeEventListener('mrw:checkpoint-editors', checkpoint)
      editor.scrollDOM.removeEventListener('scroll', onScroll)
      editor.destroy()
      view.current = null
    }
  }, [props.file.path, props.onEdit, props.file.unavailable])

  useEffect(() => {
    const editor = view.current
    if (editor === null) return
    const content = editor.state.doc.toString()
    if (content === props.file.text) return
    const edit = props.file.edit
    if (edit !== undefined && edit.id !== lastEdit.current && edit.to <= content.length
      && content.slice(0, edit.from) + edit.insert + content.slice(edit.to) === props.file.text) {
      lastEdit.current = edit.id
      editor.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, annotations: isolateHistory.of('full') })
    } else editor.dispatch({ changes: { from: 0, to: content.length, insert: props.file.text }, annotations: isolateHistory.of('full') })
  }, [props.file.text, props.file.edit])

  useEffect(() => {
    view.current?.dispatch({ effects: [
      font.current.reconfigure(EditorView.theme({ '&': { fontSize: `${props.fontSize}px` } })),
      wrapping.current.reconfigure(props.wrap ? EditorView.lineWrapping : []),
      syntax.current.reconfigure(language(props.file.path, props.language)),
      palette.current.reconfigure(EditorView.theme({}, { dark: props.palette === 'vscode' })),
    ] })
  }, [props.fontSize, props.wrap, props.file.path, props.language, props.palette])

  useEffect(() => {
    const editor = view.current
    if (editor === null) return
    const selected = props.selection
    const from = selected === null ? 0 : Math.min(selected.from, editor.state.doc.length)
    const to = selected === null ? 0 : Math.min(selected.to, editor.state.doc.length)
    editor.dispatch({ effects: target.current.reconfigure(selected?.path === props.file.path && to > from
      ? EditorView.decorations.of(Decoration.set([Decoration.mark({ class: 'mrw-selection-target' }).range(from, to)])) : []) })
  }, [props.selection, props.file.path, props.file.text])

  useEffect(() => {
    const editor = view.current
    const location = props.sourceTarget
    if (editor === null || location === null || location.path !== props.file.path || location.token === lastLocation.current) return
    lastLocation.current = location.token
    const from = Math.min(location.from, editor.state.doc.length)
    const to = Math.min(location.to, editor.state.doc.length)
    editor.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) })
    editor.focus()
  }, [props.sourceTarget, props.file.path])

  useEffect(() => {
    const editor = view.current
    if (editor === null || props.command === null) return
    if (props.command.type === 'undo') undo(editor)
    else if (props.command.type === 'redo') redo(editor)
    else openSearchPanel(editor)
    editor.focus()
  }, [props.command])

  return <div ref={host} className={css.codeEditor} data-workbench-code-editor="" data-workbench-code-theme={props.palette} />
}
