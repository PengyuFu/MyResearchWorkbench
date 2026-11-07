/** Compact suggested result and detailed change review share one proposal. */
import { useMemo, useRef, useState } from 'react'
import { presentableDiff } from '@codemirror/merge'
import type { WorkbenchKey } from './locales.ts'
import type { EditProposal, EditorBuffer, SelectionSnapshot, WorkbenchActions } from './types.ts'
import { VisualEditor } from './VisualEditor.tsx'
import { allowsPartialProposal } from './proposal-operations.ts'
import css from './Workbench.module.css'

interface ProposalProps {
  proposal: EditProposal
  presentation: 'compact' | 'detail'
  onDetails: () => void
  onDocument: () => void
  selection: SelectionSnapshot | null
  stale: boolean
  accept: (index?: number) => void
  discard: () => void
  refine: () => void
  locate: () => void
  t: (key: WorkbenchKey) => string
  resolveAsset: WorkbenchActions['resolveAsset']
  mathFontsDirectory: string
  fontSize: number
}

const ignoreEdit: WorkbenchActions['edit'] = () => {}
const ignoreAction = () => {}

function previewBuffer(path: string, text: string, side: string): EditorBuffer {
  return {
    mode: 'writing', path: path + '.proposal-' + side + '.tex', absolutePath: path + '#proposal-' + side,
    text, savedText: text, savedRawText: text, diskVersion: null, lineEnding: 'lf',
    revision: 0, selection: { from: 0, to: 0 }, scrollTop: 0, saveState: 'clean',
  }
}

/** The proposed replacement never enters the source buffer until acceptance. */
export function Proposal({ proposal, selection, stale, accept, discard, refine, locate, t,
  resolveAsset, mathFontsDirectory, fontSize, presentation, onDetails, onDocument }: ProposalProps) {
  const compact = presentation === 'compact'
  const latex = /\.tex$/iu.test(proposal.base.path)
  const atomic = !allowsPartialProposal(proposal)
  const before = useMemo(() => previewBuffer(proposal.base.path, proposal.base.selectedText, 'before'), [proposal])
  const after = useMemo(() => previewBuffer(proposal.base.path, proposal.replacement, 'after'), [proposal])
  const numbers = (value: string) => [...value.matchAll(/(?<![A-Za-z])[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/gu)].map(match => match[0])
  const beforeNumbers = numbers(proposal.base.selectedText)
  const afterNumbers = numbers(proposal.replacement)
  const changedNumbers = JSON.stringify(beforeNumbers) !== JSON.stringify(afterNumbers)
  const changes = useMemo(() => presentableDiff(proposal.base.selectedText, proposal.replacement), [proposal])
  const source = selection?.path === proposal.base.path && selection.from === proposal.base.from ? selection : null
  const locations = useMemo(() => changes.map((change) => {
    const text = proposal.base.selectedText
    const last = Math.max(change.fromA, change.toA - 1)
    const start = change.fromA === 0 ? 0 : text.lastIndexOf('\n', change.fromA - 1) + 1
    const newline = text.indexOf('\n', last)
    const end = newline < 0 ? text.length : newline
    const lineFrom = (source?.lineFrom ?? 1) + text.slice(0, change.fromA).split('\n').length - 1
    const lineTo = (source?.lineFrom ?? 1) + text.slice(0, last).split('\n').length - 1
    // Include the unchanged part of a partially selected logical line. These
    // snippets explain the hunk without changing its exact application range.
    const prefix = start === 0 ? source?.contextBefore.split('\n').at(-1) ?? '' : ''
    const suffix = end === text.length ? source?.contextAfter.split('\n')[0] ?? '' : ''
    return { lineFrom, lineTo, context: prefix + text.slice(start, end) + suffix }
  }), [changes, proposal, source])
  const [active, setActive] = useState(0)
  const rows = useRef(new Map<number, HTMLDivElement>())
  const move = (delta: number) => {
    const next = Math.max(0, Math.min(changes.length - 1, active + delta))
    setActive(next)
    rows.current.get(next)?.scrollIntoView({ behavior: 'auto', block: 'nearest' })
  }
  return <section className={css.proposal} aria-label={t('proposal')} data-workbench-proposal="" data-presentation={presentation}>
    <div className={css.proposalHeader}>
      <strong>{t('proposal')}</strong>
      <span className={css.spacer} />
      {!compact && <button type="button" className={css.quietButton} onClick={onDocument}>{t('returnDocument')}</button>}
      <button type="button" className={css.quietButton} onClick={locate}>{t('locate')}</button>
      {!compact && <><button type="button" className={css.iconButton} aria-label={t('previousChange')} disabled={active <= 0} onClick={() => move(-1)}>↑</button>
        <button type="button" className={css.iconButton} aria-label={t('nextChange')} disabled={active >= changes.length - 1} onClick={() => move(1)}>↓</button></>}
    </div>
    <p className={css.hint}>{stale ? t('staleProposal') : t('proposalHint')}</p>
    {!compact && proposal.explanation !== '' && <p className={css.explanation}>{proposal.explanation}</p>}
    {atomic && <p className={css.hint}>{t('atomicProposalHint')}</p>}
    {changedNumbers && <p className={css.scientificChange}><strong>{t('numberChanges')}</strong> {beforeNumbers.join(', ') || '∅'} → {afterNumbers.join(', ') || '∅'}</p>}
    {!!proposal.labelChanges?.length && <p className={css.scientificChange}><strong>{t('linkedLabelChanges')}</strong> {proposal.labelChanges.map(change => change.from + ' → ' + change.to).join('; ')}</p>}
    <div className={css.diffBody} aria-label={t('readOnlyProposal')}>
      {latex && <div className={css.semanticComparison}>
        {(compact ? [{ side: 'after', buffer: after, label: t('afterChange') }]
          : [{ side: 'before', buffer: before, label: t('beforeChange') }, { side: 'after', buffer: after, label: t('afterChange') }]).map(item =>
          <section className={css.semanticSide} data-proposal-side={item.side} key={item.side}>
            <strong>{item.label}</strong>
            {item.buffer.text === '' ? <p className={css.hint}>{t('emptyInsertion')}</p> : <VisualEditor
              file={item.buffer} readOnly fontSize={Math.min(18, fontSize)} selection={null} sourceTarget={null} command={null}
              onEdit={ignoreEdit} onSave={ignoreAction} onSelect={ignoreAction} onNavigateInclude={ignoreAction}
              resolveAsset={(path, _sourcePath, graphicsPaths) => resolveAsset(path, proposal.base.path, graphicsPaths)}
              mathFontsDirectory={mathFontsDirectory} t={t} />}
          </section>)}
      </div>}
      {compact && !latex && <pre className={css.compactReplacement} aria-label={t('afterChange')}>{proposal.replacement}</pre>}
      {!compact && <details open={!latex} className={css.proposalSource}>
        <summary>{latex ? t('sourceDifferences') : t('changes')}</summary>
        {changes.length === 0 && <p className={css.hint}>{t('noChanges')}</p>}
        {changes.map((change, index) => <div key={`${change.fromA}:${change.toA}:${index}`} className={css.change} ref={(element) => {
          if (element === null) rows.current.delete(index)
          else rows.current.set(index, element)
        }} data-change-index={index}>
          <div className={css.changeHeader}>
            <span>{index + 1} / {changes.length} · {source === null ? t('selectionLine') : t('sourceLine')} {locations[index]?.lineFrom}{locations[index]?.lineTo !== locations[index]?.lineFrom && `–${locations[index]?.lineTo}`}</span>
            <button type="button" className={css.quietButton} disabled={stale || atomic} onClick={() => accept(index)}>{t('acceptChange')}</button>
          </div>
          <pre className={css.changeContext} aria-label={t('sourceContext')}>{locations[index]?.context}</pre>
          {change.toA > change.fromA && <div className={css.removed}><span aria-label={t('deleted')}>−</span><del>{proposal.base.selectedText.slice(change.fromA, change.toA)}</del></div>}
          {change.toB > change.fromB && <div className={css.inserted}><span aria-label={t('inserted')}>+</span><ins>{proposal.replacement.slice(change.fromB, change.toB)}</ins></div>}
        </div>)}
      </details>}
    </div>
    <div className={css.proposalActions}>
      <button type="button" className={css.primaryButton} disabled={stale || changes.length === 0} onClick={() => accept()}>{t('accept')}</button>
      <button type="button" className={css.button} onClick={discard}>{t('discard')}</button>
      {compact && <button type="button" className={css.quietButton} onClick={onDetails}>{t('proposalDetails')}</button>}
      <button type="button" className={css.quietButton} onClick={refine}>{t('refine')}</button>
    </div>
  </section>
}
