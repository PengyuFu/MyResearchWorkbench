/** Project reference suggestions never create or rewrite bibliography files. */
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { parseLatexDocument } from './latex-source.ts'
import type { VisualKey } from './visual-locales.ts'
import css from './VisualEditor.module.css'

export interface VisualReferenceCandidate {
  key: string
  kind: 'citation' | 'label'
  path?: string | undefined
}

export interface VisualReferenceIndex {
  entries: VisualReferenceCandidate[]
  warnings?: string[] | undefined
}

export type VisualReferenceQuery = (
  kind: VisualReferenceCandidate['kind'], sourcePath: string,
) => Promise<VisualReferenceIndex>

function samePath(left: string | undefined, right: string) {
  return left?.replaceAll('\\', '/').toLowerCase() === right.replaceAll('\\', '/').toLowerCase()
}

/** Unsaved labels in this document supersede that file's disk index, including duplicate definitions. */
export function referenceCandidates(
  kind: VisualReferenceCandidate['kind'], source: string, sourcePath: string, entries: VisualReferenceCandidate[],
): VisualReferenceCandidate[] {
  const matching = entries.filter(entry => entry.kind === kind && entry.key.trim())
  if (kind === 'citation') return matching
  return matching.filter(entry => !samePath(entry.path, sourcePath)).concat(
    parseLatexDocument(source, sourcePath).labels.map<VisualReferenceCandidate>(label => ({ key: label.key, kind: 'label', path: sourcePath })),
  )
}

export function chooseReferenceKey(kind: VisualReferenceCandidate['kind'], value: string, key: string) {
  if (kind === 'label') return key
  const keys = value.split(',').map(item => item.trim())
  keys[keys.length - 1] = key
  return keys.filter(Boolean).join(', ')
}

interface ReferencePickerProps {
  kind: VisualReferenceCandidate['kind']
  source: string
  sourcePath: string
  value: string
  onChange: (value: string) => void
  query?: VisualReferenceQuery | undefined
  t: (key: VisualKey) => string
}

/** A bounded, keyboard-accessible list beside the existing reference-key input. */
export function VisualReferencePicker(props: ReferencePickerProps) {
  const [index, setIndex] = useState<VisualReferenceIndex>({ entries: [] })
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const { kind, source, sourcePath, query, t, value, onChange } = props
  useEffect(() => {
    let current = true
    setIndex({ entries: [] })
    if (query === undefined) { setStatus('unavailable'); return () => { current = false } }
    setStatus('loading')
    void query(kind, sourcePath).then((result) => {
      if (current) { setIndex(result); setStatus('ready') }
    }, () => {
      if (current) setStatus('unavailable')
    })
    return () => { current = false }
  }, [kind, sourcePath, query])
  const candidates = useMemo(() => referenceCandidates(kind, source, sourcePath, index.entries),
    [kind, source, sourcePath, index])
  const grouped = new Map<string, VisualReferenceCandidate[]>()
  for (const candidate of candidates) {
    const group = grouped.get(candidate.key) ?? []
    group.push(candidate)
    grouped.set(candidate.key, group)
  }
  const keys = kind === 'citation' ? value.split(',').map(key => key.trim()).filter(Boolean) : [value.trim()].filter(Boolean)
  const search = (kind === 'citation' ? value.split(',').at(-1) ?? '' : value).trim().toLowerCase()
  const matching = [...grouped.entries()]
    .filter(([key]) => key.toLowerCase().includes(search)).sort(([a], [b]) => a.localeCompare(b))
  const missing = status === 'ready' ? keys.filter(key => !grouped.has(key)) : []
  const duplicates = keys.filter(key => (grouped.get(key)?.length ?? 0) > 1)
  return <section className={css.referencePicker} aria-label={t(kind === 'citation' ? 'visualProjectCitations' : 'visualProjectLabels')}>
    <div className={css.referenceHeading}>
      <strong>{t(kind === 'citation' ? 'visualProjectCitations' : 'visualProjectLabels')}</strong>
      <span className={css.hint}>{t(kind === 'citation' ? 'visualCitationChoiceHint' : 'visualLabelChoiceHint')}</span>
    </div>
    {status === 'loading' && <p className={css.hint} role="status">{t('visualReferenceLoading')}</p>}
    {status === 'unavailable' && <p className={css.hint} role="status">{t('visualReferenceUnavailable')}</p>}
    {matching.length > 0 && <div className={css.referenceList}>
      {matching.slice(0, 60).map(([key, definitions]) => <Button key={key} type="button" variant="ghost" size="sm"
        className={css.referenceChoice} aria-label={key} onClick={() => onChange(chooseReferenceKey(kind, value, key))}>
        <span><code>{key}</code>{definitions.length > 1 && <span className={css.referenceWarning}>{t('visualDuplicateKey')}</span>}</span>
        <small>{[...new Set(definitions.map(item => item.path).filter(Boolean))].join(' · ')}</small>
      </Button>)}
    </div>}
    {status === 'ready' && matching.length === 0 && <p className={css.hint}>{t('visualReferenceNoMatch')}</p>}
    {matching.length > 60 && <p className={css.hint}>{t('visualReferenceNarrow')}</p>}
    {missing.length > 0 && <p className={css.referenceWarning} role="status">{t('visualUnknownKey')}: {missing.join(', ')}</p>}
    {duplicates.length > 0 && <p className={css.referenceWarning} role="status">
      {t('visualDuplicateKeyDescription')}: {duplicates.join(', ')}</p>}
    {(index.warnings ?? []).map((warning, i) => <p key={i} className={css.hint} role="status">{warning}</p>)}
  </section>
}
