/** Editable manuscript projection; TeX remains the authority for bounded writes and compilation. */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { MathfieldElement } from 'mathlive'
import { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { NodeSelection, PluginKey } from '@tiptap/pm/state'
import { DecorationSet } from '@tiptap/pm/view'
import { closeHistory, redo, undo } from '@tiptap/pm/history'
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow, mergeCells, splitCell } from '@tiptap/pm/tables'
import { Button, Input, Menu, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseLatexDocument } from './latex-source.ts'
import { projectVisualDocument, compileVisualDocument, mapSourceSelection, mapVisualSelection } from './visual-projection.ts'
import { createVisualExtensions, selectedVisualObject } from './visual-schema.ts'
import type { VisualAsset, VisualRuntime } from './visual-schema.ts'
import { ManuscriptOutline } from './ManuscriptOutline.tsx'
import { VisualReferencePicker } from './visual-references.tsx'
import type { VisualReferenceQuery } from './visual-references.tsx'
import { takeVisualEditor, retainVisualEditor } from './visual-lifecycle.ts'
import type { RetainedVisualEditor } from './visual-lifecycle.ts'
import { insertVisualBlock, insertVisualInline, selectVisualRange } from './visual-commands.ts'
import type { VisualKey } from './visual-locales.ts'
import type { EditorBuffer, SelectionSnapshot, WorkbenchActions, WorkbenchSnapshot } from './types.ts'
import css from './VisualEditor.module.css'

export interface VisualEditorProps {
  file: EditorBuffer & { visualState?: string | undefined }
  readOnly?: boolean | undefined
  fontSize: number
  selection: SelectionSnapshot | null
  sourceTarget: WorkbenchSnapshot['sourceTarget']
  command: { type: 'undo' | 'redo' | 'find'; token: number } | null
  onEdit: WorkbenchActions['edit']
  onSave: () => void
  onSelect: (mode: 'ask' | 'edit' | 'assist') => void
  onNavigateInclude: (path: string) => void
  resolveAsset: (path: string, sourcePath: string, graphicsPaths: string[]) => Promise<VisualAsset>
  queryReferences?: VisualReferenceQuery | undefined
  mathFontsDirectory: string
  t: (key: VisualKey) => string
}

type Panel = { kind: 'image' | 'reference' | 'citation'; position: number | null }
type Compiled = ReturnType<typeof compileVisualDocument>
const tableActions = [
  ['visualAddRow', addRowAfter], ['visualDeleteRow', deleteRow],
  ['visualAddColumn', addColumnAfter], ['visualDeleteColumn', deleteColumn],
  ['visualMergeCells', mergeCells], ['visualSplitCell', splitCell],
] as const

function isReferenceKey(value: string) { return /^[^\\{}\s]+$/.test(value) }
function isImagePath(value: string) { return value.trim().length > 0 && !/[\r\n{}]/.test(value) }

/** Keep mounted editor history and cursor stable while source changes are emitted to the local buffer. */
export function VisualEditor(props: VisualEditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const view = useRef<Editor | null>(null)
  const current = useRef(props)
  current.current = props
  const targetKey = useRef(new PluginKey<DecorationSet>('visual-selection'))
  const compiled = useRef<{ document: ProseMirrorNode; value: Compiled } | null>(null)
  const pending = useRef<Panel | null>(null)
  const lastLocation = useRef(0)
  const reconciling = useRef(false)
  const [revision, setRevision] = useState(0)
  const [menu, setMenu] = useState<'insert' | null>(null)
  const [panel, setPanel] = useState<Panel | null>(null)
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [findOpen, setFindOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [notFound, setNotFound] = useState(false)
  const [label, setLabel] = useState('')
  const { t } = props

  const compile = (document: ProseMirrorNode) => {
    if (compiled.current?.document === document) return compiled.current.value
    const result = compileVisualDocument(document.toJSON())
    compiled.current = { document, value: result }
    return result
  }
  const emit = (editor: Editor, path: string) => {
    if (current.current.readOnly) return
    const result = compile(editor.state.doc)
    const range = mapVisualSelection(result, editor.state.selection) ?? { from: 0, to: 0 }
    current.current.onEdit(path, result.source, range,
      JSON.stringify({ format: 'mrw-visual-v1', source: result.source, anchor: editor.state.selection.anchor, head: editor.state.selection.head }),
      scroller.current?.scrollTop ?? 0)
  }
  const closePanel = () => { pending.current = null; setPanel(null); setError('') }
  const openPanel = (kind: Panel['kind'], position: number | null = null, initialValue = '') => {
    const next = { kind, position }
    pending.current = next
    setPanel(next); setValue(initialValue); setError(''); setMenu(null)
  }
  const select = (mode: 'ask' | 'edit' | 'assist') => {
    const editor = view.current
    if (editor === null) return
    emit(editor, current.current.file.path)
    current.current.onSelect(mode)
  }

  useEffect(() => {
    const element = host.current
    const scroll = scroller.current
    if (element === null || scroll === null) return
    const initial = current.current
    lastLocation.current = 0
    compiled.current = null
    setError(''); setPanel(null); pending.current = null
    const runtime = (): VisualRuntime => ({
      readOnly: current.current.readOnly === true,
      t: current.current.t, mathFontsDirectory: current.current.mathFontsDirectory,
      resolveAsset: current.current.resolveAsset,
      openInclude: (path) => { if (!current.current.readOnly) current.current.onNavigateInclude(path) },
      editReference: (position, kind, key) => { if (!current.current.readOnly) openPanel(kind, position, key) },
      save: () => { if (!current.current.readOnly) current.current.onSave() }, find: () => setFindOpen(true),
      select: (mode) => { if (!current.current.readOnly) select(mode) },
    })
    const validate = (document: ProseMirrorNode) => {
      try { compile(document); setError(''); return true }
      catch (failure) {
        setError(current.current.t('visualEditFailed') + ' · ' + (failure instanceof Error ? failure.message : String(failure)))
        return false
      }
    }
    const transactionListener = ({ editor: active, transaction }: { editor: Editor; transaction: import('@tiptap/pm/state').Transaction }) => {
      if (transaction.docChanged && pending.current?.position !== null && pending.current?.position !== undefined) {
        const mapped = transaction.mapping.mapResult(pending.current.position)
        if (mapped.deleted) closePanel()
        else pending.current = { ...pending.current, position: mapped.pos }
      }
      if (transaction.docChanged || transaction.selectionSet) {
        if (!reconciling.current) emit(active, initial.file.path)
        setRevision(previous => previous + 1)
      }
    }
    let record: RetainedVisualEditor
    let editor: Editor
    try {
      const previous = takeVisualEditor(initial.onEdit, initial.file.path, initial.file.text)
      if (previous !== null) {
        record = previous
        record.live.runtime = runtime
        record.live.validate = validate
        targetKey.current = record.targetKey
        editor = record.editor
        editor.mount(element)
      } else {
        const document = parseLatexDocument(initial.file.text, initial.file.path)
        const live = { runtime, validate }
        editor = new Editor({
          element, extensions: createVisualExtensions({
            runtime: () => live.runtime(), targetKey: targetKey.current, validateDocument: document => live.validate(document),
          }),
          content: projectVisualDocument(document), editable: !initial.readOnly,
          editorProps: { attributes: { 'aria-label': initial.t('visualDocument'), spellcheck: 'true' } },
        })
        record = { editor, source: initial.file.text, targetKey: targetKey.current, live }
      }
      view.current = editor
      editor.on('transaction', transactionListener)
      let restored = false
      if (initial.file.visualState !== undefined) {
        try {
          const saved: unknown = JSON.parse(initial.file.visualState)
          if (typeof saved === 'object' && saved !== null && 'format' in saved && saved.format === 'mrw-visual-v1'
            && 'source' in saved && saved.source === initial.file.text
            && 'anchor' in saved && typeof saved.anchor === 'number' && Number.isInteger(saved.anchor)
            && 'head' in saved && typeof saved.head === 'number' && Number.isInteger(saved.head)) {
            selectVisualRange(editor, { from: Math.min(saved.anchor, saved.head), to: Math.max(saved.anchor, saved.head) }, false)
            restored = true
          }
        } catch { /* Older or foreign state is safely restored from the canonical source selection. */ }
      }
      if (!restored) {
        const selection = mapSourceSelection(compile(editor.state.doc), initial.file.selection)
        if (selection !== null) selectVisualRange(editor, selection, false)
      }
      scroll.scrollTop = initial.file.visualScrollTop ?? 0
      setRevision(previous => previous + 1)
    } catch (failure) {
      setError(initial.t('visualEditFailed') + ' · ' + (failure instanceof Error ? failure.message : String(failure)))
      return
    }
    let scrollTimer: ReturnType<typeof setTimeout> | undefined
    const onScroll = () => {
      if (scrollTimer !== undefined) clearTimeout(scrollTimer)
      scrollTimer = setTimeout(() => emit(editor, initial.file.path), 120)
    }
    const checkpoint = () => { if (scroll.getClientRects().length) emit(editor, initial.file.path) }
    window.addEventListener('mrw:checkpoint-editors', checkpoint)
    scroll.addEventListener('scroll', onScroll)
    return () => {
      if (scrollTimer !== undefined) clearTimeout(scrollTimer)
      checkpoint()
      window.removeEventListener('mrw:checkpoint-editors', checkpoint)
      scroll.removeEventListener('scroll', onScroll)
      editor.off('transaction', transactionListener)
      record.source = compile(editor.state.doc).source
      editor.unmount()
      retainVisualEditor(initial.onEdit, initial.file.path, record)
      view.current = null
      compiled.current = null
    }
  }, [props.file.path, props.onEdit])

  useEffect(() => {
    const editor = view.current
    if (editor === null || compile(editor.state.doc).source === props.file.text) return
    try {
      const source = parseLatexDocument(props.file.text, props.file.path)
      const document = editor.schema.nodeFromJSON(projectVisualDocument(source))
      const transaction = closeHistory(editor.state.tr)
        .replaceWith(0, editor.state.doc.content.size, document.content)
        .setDocAttribute('base', source).setMeta('visual-external', true)
      closePanel()
      reconciling.current = true
      editor.view.dispatch(transaction)
      editor.view.dispatch(closeHistory(editor.state.tr))
      const mapped = mapSourceSelection(compile(editor.state.doc), props.file.selection)
      if (mapped !== null) selectVisualRange(editor, mapped, false)
    } catch (failure) {
      setError(t('visualSourceChanged') + ' · ' + (failure instanceof Error ? failure.message : String(failure)))
    } finally { reconciling.current = false }
  }, [props.file.text, props.file.path, props.file.edit])

  useEffect(() => {
    const editor = view.current
    if (editor === null) return
    editor.setEditable(!props.readOnly)
    for (const field of host.current?.querySelectorAll<MathfieldElement>('math-field') ?? []) field.readOnly = props.readOnly === true
  }, [props.readOnly, props.file.path])

  useEffect(() => {
    const editor = view.current
    if (editor === null) return
    const selected = props.selection
    const range = selected?.path === props.file.path
      ? mapSourceSelection(compile(editor.state.doc), selected) : null
    editor.view.dispatch(editor.state.tr.setMeta(targetKey.current, range).setMeta('addToHistory', false))
  }, [props.selection, props.file.path, props.file.text])

  useEffect(() => {
    const editor = view.current
    const location = props.sourceTarget
    if (editor === null || location === null || location.path !== props.file.path || location.token === lastLocation.current) return
    lastLocation.current = location.token
    const range = mapSourceSelection(compile(editor.state.doc), location)
    if (range !== null) { selectVisualRange(editor, range); editor.view.focus() }
  }, [props.sourceTarget, props.file.path])

  useEffect(() => {
    const editor = view.current
    if (editor === null || props.command === null || props.readOnly) return
    if (props.command.type === 'find') setFindOpen(true)
    else {
      if (props.command.type === 'undo') undo(editor.state, editor.view.dispatch)
      else redo(editor.state, editor.view.dispatch)
      editor.view.focus()
    }
  }, [props.command])

  const editor = view.current
  const object = editor === null ? null : selectedVisualObject(editor)
  const objectName = object?.node.type.name
  const insideTable = editor !== null && (() => {
    for (let depth = editor.state.selection.$from.depth; depth > 0; depth--) {
      if (editor.state.selection.$from.node(depth).type.name === 'table') return true
    }
    return false
  })()
  const image = (() => {
    if (object === null) return null
    if (objectName === 'image') return object
    if (objectName !== 'figure') return null
    let result: typeof object | null = null
    object.node.forEach((node, offset) => {
      if (result === null && node.type.name === 'image') result = { node, position: object.position + offset + 1 }
    })
    return result
  })()
  const formula = objectName === 'mathBlock' ? object : null
  useEffect(() => { setLabel(String(formula?.node.attrs.label ?? '')) }, [formula?.position, formula?.node.attrs.label])

  const outline: { position: number; level: number; label: string }[] = []
  editor?.state.doc.forEach((node, position) => {
    if (node.type.name === 'heading' || (node.type.name === 'field' && ['title', 'abstract'].includes(String(node.attrs.field)))) {
      outline.push({ position, level: node.type.name === 'heading' ? Number(node.attrs.level) : 0,
        label: node.type.name === 'field' ? t(node.attrs.field === 'abstract' ? 'visualAbstract' : 'visualDocumentTitle')
          : node.textContent || t('visualUntitledSection') })
    }
  })
  const insert = (kind: string) => {
    setMenu(null)
    const active = view.current
    if (active === null) return
    if (kind === 'paragraph' || kind === 'heading') {
      if (!insertVisualBlock(active, { type: kind, attrs: kind === 'heading' ? { level: 1 } : {} })) setError(t('visualChooseBodyPosition'))
    } else if (kind === 'mathBlock') {
      if (!insertVisualBlock(active, { type: 'mathBlock', attrs: { latex: '', environment: 'equation', label: '' } })) {
        setError(t('visualChooseBodyPosition')); return
      }
      requestAnimationFrame(() => host.current?.querySelector<HTMLElement>('.' + css.nodeSelected + ' math-field')?.focus())
    } else if (kind === 'mathInline') {
      insertVisualInline(active, { type: 'mathInline', attrs: { latex: '' } })
    } else if (kind === 'reference' || kind === 'citation') openPanel(kind)
  }
  const apply = async () => {
    const active = view.current
    const action = pending.current
    if (active === null || action === null) return
    setError('')
    if (action.kind === 'image') {
      const path = value.trim()
      if (!isImagePath(path)) { setError(t('visualInvalidPath')); return }
      setBusy(true)
      try {
        const document = parseLatexDocument(compile(active.state.doc).source, current.current.file.path)
        await current.current.resolveAsset(path, document.file, document.graphicsPaths)
        if (view.current !== active || pending.current !== action) return
        if (action.position === null) { setError(t('visualSourceChanged')); return }
        const node = active.state.doc.nodeAt(action.position)
        if (node?.type.name !== 'image') { setError(t('visualSourceChanged')); return }
        active.view.dispatch(active.state.tr.setNodeMarkup(action.position, undefined, { ...node.attrs, path }))
        closePanel()
      } catch (failure) { setError(t('visualPreviewFailed') + ' · ' + (failure instanceof Error ? failure.message : String(failure))) }
      finally { setBusy(false) }
    } else {
      const key = action.kind === 'citation' ? value.split(',').map(item => item.trim()).join(',') : value.trim()
      if (!isReferenceKey(key) || (action.kind === 'citation' && key.split(',').some(item => !item))) {
        setError(t('visualInvalidReference')); return
      }
      if (action.position !== null) {
        const node = active.state.doc.nodeAt(action.position)
        if (node?.type.name !== 'reference') { setError(t('visualSourceChanged')); return }
        active.view.dispatch(active.state.tr.setNodeMarkup(action.position, undefined, { ...node.attrs, key }))
      } else insertVisualInline(active, { type: 'reference', attrs: { key, kind: action.kind, command: action.kind === 'citation' ? 'cite' : 'ref' } })
      closePanel(); active.view.focus()
    }
  }
  const applyLabel = () => {
    const active = view.current
    if (active === null || formula === null) return
    if (label && !isReferenceKey(label)) { setError(t('visualInvalidReference')); return }
    active.view.dispatch(active.state.tr.setNodeMarkup(formula.position, undefined, { ...formula.node.attrs, label }))
  }
  const findNext = () => {
    const active = view.current
    if (active === null || !query) return
    const result = compile(active.state.doc)
    const selected = mapVisualSelection(result, active.state.selection)
    const from = selected?.to ?? 0
    const match = result.source.indexOf(query, from)
    const next = match < 0 ? result.source.indexOf(query) : match
    const mapped = next < 0 ? null : mapSourceSelection(result, { from: next, to: next + query.length })
    setNotFound(mapped === null)
    if (mapped !== null) selectVisualRange(active, mapped)
  }
  const selectObject = () => {
    const active = view.current
    if (active === null || object === null) return
    active.view.dispatch(active.state.tr.setSelection(NodeSelection.create(active.state.doc, object.position)))
    active.view.focus()
  }

  return <div className={css.editor} data-workbench-visual-editor="" data-document-revision={revision} data-readonly={props.readOnly ? 'true' : undefined}>
    {!props.readOnly && <div className={css.toolbar} role="toolbar" aria-label={t('visualDocument')}>
      <ManuscriptOutline entries={outline} currentPosition={editor?.state.selection.from ?? 0} t={t}
        onNavigate={(position) => {
          const active = view.current
          if (active !== null) { selectVisualRange(active, { from: position + 1, to: position + 1 }); active.view.focus() }
        }} />
      <Menu open={menu === 'insert'} onClose={() => setMenu(null)} items={[
        { id: 'paragraph', label: t('visualParagraph') }, { id: 'heading', label: t('visualHeading') },
        { id: 'mathInline', label: t('visualInlineFormula') }, { id: 'mathBlock', label: t('visualFormula') },
        { id: 'reference', label: t('visualReference') }, { id: 'citation', label: t('visualCitation') },
      ]} onSelect={insert} align="start" portal anchor={<Button variant="toolbar" size="sm" aria-expanded={menu === 'insert'}
        onClick={() => setMenu(menu === 'insert' ? null : 'insert')}>{t('visualInsert')}<IconChevronDownOutlineRegular /></Button>} />
      <div className={css.contextTools} role="toolbar" aria-label={t(insideTable ? 'visualTable' : formula !== null ? 'visualFormula' : image !== null ? 'visualImage' : 'visualSelectObject')}
        aria-hidden={object === null} title={insideTable ? t('visualTableHint') : undefined} data-visual-context-tools="">
        {(formula !== null || image !== null || objectName === 'tableObject' || objectName === 'figure') && <>
          <Button variant="toolbar" size="sm" onClick={selectObject}>{t('visualSelectObject')}</Button>
          {formula !== null && <><label className={css.property}>{t('visualLabel')}<Input value={label}
            onChange={event => setLabel(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') applyLabel() }} /></label>
          <Button variant="toolbar" size="sm" disabled={label === String(formula.node.attrs.label ?? '')} onClick={applyLabel}>{t('visualApply')}</Button></>}
          {image !== null && <Button variant="toolbar" size="sm" onClick={() => openPanel('image', image.position, String(image.node.attrs.path ?? ''))}>{t('visualReplace')}</Button>}
        </>}
        {insideTable && tableActions.map(([key, command]) => <Button key={key} variant="toolbar" size="sm"
          disabled={editor === null || !command(editor.state)} onClick={() => {
            const active = view.current
            if (active !== null) { command(active.state, active.view.dispatch); active.view.focus() }
          }}>{t(key)}</Button>)}
      </div>
      <Button variant="toolbar" size="sm" disabled={editor?.state.selection.empty !== false} onClick={() => select('assist')}>{t('visualAssist')}</Button>
    </div>}
    {!props.readOnly && panel !== null && <form className={css.insertPanel} onSubmit={(event) => { event.preventDefault(); void apply() }}>
      <label className={css.propertyWide}>{t(panel.kind === 'image' ? 'visualImagePath' : 'visualReferenceKey')}
        <Input value={value} onChange={event => setValue(event.target.value)} autoFocus />
      </label>
      <Button variant="primary" size="sm" type="submit" disabled={busy}>{t(panel.position === null ? 'visualInsert' : 'visualApply')}</Button>
      <Button variant="ghost" size="sm" type="button" onClick={closePanel}>{t('visualCancel')}</Button>
      {(panel.kind === 'reference' || panel.kind === 'citation') && <VisualReferencePicker
        kind={panel.kind === 'citation' ? 'citation' : 'label'} source={props.file.text} sourcePath={props.file.path}
        value={value} onChange={setValue} query={props.queryReferences} t={t} />}
    </form>}
    {findOpen && <form className={css.contextBar} onSubmit={(event) => { event.preventDefault(); findNext() }}>
      <Input value={query} onChange={(event) => { setQuery(event.target.value); setNotFound(false) }} aria-label={t('visualFind')} autoFocus />
      <Button variant="toolbar" size="sm" type="submit">{t('visualFindNext')}</Button>
      <Button variant="toolbar" size="sm" type="button" onClick={() => setFindOpen(false)}>{t('visualCancel')}</Button>
      {notFound && <span className={css.hint}>{t('visualNotFound')}</span>}
    </form>}
    {error && <div className={css.error} role="alert">{error}</div>}
    <div ref={scroller} className={css.scroller} style={{ '--visual-font-size': Math.max(14, props.fontSize) + 'px' } as CSSProperties}>
      <div ref={host} className={css.paper} />
    </div>
  </div>
}
