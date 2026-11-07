/** Word editing stays inside the existing glass board; native mutations are controller-owned. */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Editor, type JSONContent } from '@tiptap/core'
import { Fragment, Slice } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import type { WordEditorBuffer, WorkbenchActions, WorkbenchSnapshot } from './types.ts'
import type { WorkbenchKey } from './locales.ts'
import { wordDocument, wordText, wordPosition, editorPosition } from './word-operations.ts'
import { wordExtensions } from './word-schema.ts'
import css from './WordEditor.module.css'

interface Props {
  file: WordEditorBuffer
  fontSize: number
  t(key: WorkbenchKey): string
  edit: WorkbenchActions['wordEdit']
  mutate: WorkbenchActions['wordMutate']
  resume: WorkbenchActions['wordResume']
  select: WorkbenchActions['select']
  save(): void
  importAsset: WorkbenchActions['importAsset']
  sourceTarget: WorkbenchSnapshot['sourceTarget']
  command: { type: 'undo' | 'redo' | 'find'; token: number } | null
}
export function WordEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null), scroller = useRef<HTMLDivElement>(null)
  const editor = useRef<Editor | null>(null), current = useRef(props), reconciling = useRef(false)
  const owner = useRef(props.file.absolutePath)
  current.current = props
  const [panel, setPanel] = useState<'find' | null>(null)
  const [notice, setNotice] = useState(''), [query, setQuery] = useState('')
  const initialView = () => { try { return JSON.parse(props.file.visualState ?? '{}') as { folded?: unknown; outlineOpen?: unknown } } catch { return {} } }
  const [folded, setFolded] = useState<string[]>(() => {
    const value = initialView().folded
    return Array.isArray(value) ? value.filter((s: unknown): s is string => typeof s === 'string') : []
  })
  const [outlineOpen, setOutlineOpen] = useState(() => initialView().outlineOpen === true)
  const viewRef = useRef({ folded, outlineOpen })
  viewRef.current = { folded, outlineOpen }
  const { file, t } = props
  const readOnly = file.unavailable || Boolean(file.word.projection.readOnly) || file.wordSync === 'failed'
    || file.wordSync === 'syncing' && file.pendingWord === undefined

  const emit = () => {
    const active = editor.current
    if (active === null || reconciling.current || current.current.file.absolutePath !== owner.current) return
    const from = wordPosition(active.state.doc, active.state.selection.from), to = wordPosition(active.state.doc, active.state.selection.to)
    current.current.edit(current.current.file.path, wordText(active.state.doc), JSON.stringify(active.state.doc.toJSON()),
      { from: Math.min(from, to), to: Math.max(from, to) }, scroller.current?.scrollTop ?? 0,
      JSON.stringify(viewRef.current), active.view.composing)
  }
  const command = (kind: 'undo' | 'redo' | 'save' | 'find') => {
    if (kind === 'save') current.current.save()
    else if (kind === 'find') setPanel('find')
    else void current.current.mutate(current.current.file.path, { kind })
  }
  const locate = (from: number, to = from) => {
    const active = editor.current
    if (active === null) return
    const a = editorPosition(active.state.doc, from), b = editorPosition(active.state.doc, to)
    active.view.dispatch(active.state.tr.setSelection(TextSelection.near(active.state.doc.resolve(a))))
    if (a !== b) active.commands.setTextSelection({ from: a, to: b })
    active.commands.focus()
    active.view.dispatch(active.state.tr.scrollIntoView())
  }
  useEffect(() => {
    if (host.current === null) return
    const initial = current.current
    owner.current = initial.file.absolutePath
    let content: JSONContent = wordDocument(initial.file.word.projection)
    if (initial.file.pendingWord !== undefined) {
      try { content = JSON.parse(initial.file.pendingWord.document) as JSONContent }
      catch { setNotice(initial.t('wordPendingRecovery')) }
    }
    const instance = new Editor({
      element: host.current, extensions: wordExtensions({
        command, protected: () => setNotice(current.current.t('wordProtected')),
        protectedLabel: initial.t('wordProtected'),
      }), content, editable: !readOnly,
      editorProps: {
        attributes: { 'aria-label': initial.t('wordDocument'), role: 'textbox', 'aria-multiline': 'true', spellcheck: 'true' },
        handlePaste: (view, event) => {
          const text = event.clipboardData?.getData('text/plain')
          if (text === undefined) return false
          const paragraph = view.state.schema.nodes.wordParagraph
          if (paragraph === undefined) return false
          const nodes = text.replaceAll('\r\n', '\n').split('\n').map(value => paragraph.create(
            null, value ? view.state.schema.text(value) : undefined))
          view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.fromArray(nodes), 1, 1)).scrollIntoView())
          return true
        },
        handleDOMEvents: { compositionend: () => { queueMicrotask(emit); return false } },
      },
      onTransaction: ({ transaction }) => { if (transaction.docChanged || transaction.selectionSet) emit() },
    })
    editor.current = instance
    // Restoring a caret must not turn a saved reading position into a jump to that caret.
    reconciling.current = true
    instance.commands.setTextSelection({
      from: editorPosition(instance.state.doc, initial.file.selection.from),
      to: editorPosition(instance.state.doc, initial.file.selection.to),
    })
    instance.commands.focus(undefined, { scrollIntoView: false })
    if (scroller.current !== null) scroller.current.scrollTop = initial.file.visualScrollTop ?? 0
    reconciling.current = false
    const capture = () => emit()
    window.addEventListener('mrw:checkpoint-editors', capture)
    return () => { emit(); window.removeEventListener('mrw:checkpoint-editors', capture); instance.destroy(); editor.current = null }
  }, [file.absolutePath])
  useEffect(() => {
    const active = editor.current
    if (active === null) return
    active.setEditable(!readOnly)
    if (file.pendingWord !== undefined) return
    reconciling.current = true
    const pos = file.selection, top = scroller.current?.scrollTop ?? 0
    const next = active.schema.nodeFromJSON(wordDocument(file.word.projection))
    if (!next.eq(active.state.doc)) {
      active.view.dispatch(active.state.tr.replaceWith(0, active.state.doc.content.size, next.content).setMeta('word-reconcile', true))
      const from = editorPosition(active.state.doc, pos.from), to = editorPosition(active.state.doc, pos.to)
      active.commands.setTextSelection({ from, to })
      if (scroller.current !== null) scroller.current.scrollTop = top
    }
    reconciling.current = false
  }, [file.word, file.pendingWord, readOnly])
  useEffect(() => { if (props.command !== null) command(props.command.type) }, [props.command?.token])
  useEffect(() => {
    if (props.sourceTarget?.path === file.path) locate(props.sourceTarget.from, props.sourceTarget.to)
  }, [props.sourceTarget?.token])
  useEffect(() => { emit() }, [folded, outlineOpen])

  const headings = file.word.projection.blocks.filter(block => block.level > 0)
  const visibleHeadings = headings.filter((heading, i) => {
    for (let n = i - 1, level = heading.level; n >= 0; n--) {
      const parent = headings[n]
      if (parent === undefined) continue
      if (parent.level < level) { if (folded.includes(parent.id)) return false; level = parent.level }
    }
    return true
  })
  const activeHeading = headings.filter(heading => heading.from <= file.selection.from).at(-1)?.id
  return <section className={css.root} data-word-board="" style={{ '--word-editor-font-size': props.fontSize + 'px' } as CSSProperties}>
    {headings.length > 0 && <div className={css.navigation}>
      <button type="button" aria-expanded={outlineOpen} aria-label={t('wordOutline')} onClick={() => setOutlineOpen(open => !open)}>
        {outlineOpen ? '‹' : '☰'} {t('wordOutlineToggle')}
      </button>
    </div>}
    {panel === 'find' && <form className={css.options} onSubmit={(event) => {
      event.preventDefault(); const at = file.text.indexOf(query, file.selection.to)
      const found = at >= 0 ? at : file.text.indexOf(query)
      if (query && found >= 0) { locate(found, found + query.length); setNotice('') } else setNotice(t('wordNotFound'))
    }}><input aria-label={t('search')} value={query} onChange={e => setQuery(e.target.value)} /><button type="submit">{t('search')}</button><button type="button" onClick={() => setPanel(null)}>{t('close')}</button></form>}
    {file.wordSync === 'failed' && <div className={css.notice} role="alert"><span>{t('wordPendingRecovery')}</span>
      <button type="button" onClick={() => { void props.resume(file.path) }}>{t('wordResume')}</button></div>}
    {file.word.projection.readOnly && <p className={css.notice}>{t('wordReadOnly')} · {file.word.projection.readOnly}</p>}
    {notice && <div className={css.notice} role="status">{notice}<button type="button" onClick={() => setNotice('')}>{t('dismiss')}</button></div>}
    <div className={css.content}>
      {outlineOpen && headings.length > 0 && <nav className={css.outline} aria-label={t('wordOutline')}>{visibleHeadings.map(heading => <div key={heading.id}
        data-active={heading.id === activeHeading || undefined} style={{ paddingInlineStart: (heading.level - 1) * 12 }}><button type="button" aria-expanded={!folded.includes(heading.id)}
          aria-label={t('wordFold')} onClick={() => setFolded(previous => previous.includes(heading.id) ? previous.filter(id => id !== heading.id) : [...previous, heading.id])}>{folded.includes(heading.id) ? '▸' : '▾'}</button>
        <button type="button" title={heading.text} aria-current={heading.id === activeHeading ? 'location' : undefined} onClick={() => locate(heading.from)}>{heading.text || t('wordUntitled')}</button></div>)}</nav>}
      <div className={css.scroller} data-word-scroller="" ref={scroller} onScroll={emit}><div ref={host} className={css.manuscript} /></div>
    </div>
  </section>
}
