/** Continuous directly editable DOCX surface; lifecycle belongs to the document controller. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WordEditorBuffer, WorkbenchActions } from './types.ts'
import type { WorkbenchKey } from './locales.ts'
import '@docx-editor.dev/core/styles/editor.css'
import css from './DocxSurface.module.css'

interface Props {
  compact?: boolean
  outlineOpen?: boolean
  onOutline?: () => void
  file: WordEditorBuffer
  mount: WorkbenchActions['wordMount']
  navigate: WorkbenchActions['wordNavigate']
  sourceTarget?: { path: string; from: number; to: number; token: number } | null
  command: { type: 'undo' | 'redo' | 'find'; token: number } | null
  save: () => void | Promise<void>
  t: (key: WorkbenchKey) => string
}
/** Render the continuous viewport using controller-owned editor callbacks. */
export function WordPageEditor({ file, mount, navigate, sourceTarget, command, save, t, compact = false, outlineOpen, onOutline }: Props) {
  const dispose = useRef<(() => void) | undefined>()
  const [outline, setOutline] = useState(false)
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState('')
  const attach = useCallback((element: HTMLDivElement | null) => {
    dispose.current?.()
    dispose.current = element === null ? undefined : mount(file.path, element)
  }, [file.path, mount])
  useEffect(() => {
    if (sourceTarget?.path === file.path) navigate(file.path, sourceTarget.from, sourceTarget.to)
  }, [file.path, navigate, sourceTarget])
  return <section className={css.frame} aria-label={t('wordContentEdit')}>
    {!compact && <div className={css.navigation}>
      <button type="button" onClick={() => { if (onOutline) onOutline(); else setOutline(!outline) }} aria-expanded={outlineOpen ?? outline}>{t('wordOutlineToggle')}</button>
      <span>{t('wordContentHint')}</span>
    </div>}
    {(outlineOpen ?? outline) && <nav className={css.outline} aria-label={t('wordOutline')}>
      {file.word.projection.blocks.filter(block => block.level > 0).map(block =>
        <button key={block.id} type="button" style={{ paddingInlineStart: block.level * 12 }}
          onClick={() => { navigate(file.path, block.from, block.from) }}>{block.text || t('wordUntitled')}</button>)}
    </nav>}
    {command?.type === 'find' && <form className={css.find} onSubmit={(event) => {
      event.preventDefault()
      let at = query ? file.text.indexOf(query, file.selection.to) : -1
      if (at < 0 && query) at = file.text.indexOf(query)
      if (at < 0) setNotice(t('wordNotFound'))
      else { navigate(file.path, at, at + query.length); setNotice('') }
    }}><input aria-label={t('search')} value={query} onChange={(event) => { setQuery(event.target.value) }} />
      <button type="submit">{t('search')}</button></form>}
    {notice && <p role="status">{notice}</p>}
    <div className={['docx-editor', 'docx-editor__scroll-container', css.surface].filter(Boolean).join(' ')} data-docx-writing-board=""
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault(); event.stopPropagation(); void save()
        }
      }}><div ref={attach} className="docx-paginated-surface" /></div>
  </section>
}
