/** On-demand navigation derived from positions and heading levels in the current manuscript. */
import { useRef, useState } from 'react'
import type { VisualKey } from './visual-locales.ts'
import css from './ManuscriptOutline.module.css'

interface Entry {
  position: number
  level: number
  label: string
}

interface Branch extends Entry { children: Branch[] }

interface Props {
  entries: readonly Entry[]
  currentPosition: number
  onNavigate: (position: number) => void
  t: (key: VisualKey) => string
}

function hierarchy(entries: readonly Entry[]): Branch[] {
  const roots: Branch[] = []
  const parents: Branch[] = []
  for (const entry of entries) {
    const branch: Branch = { ...entry, children: [] }
    if (entry.level === 0) {
      roots.push(branch)
      parents.length = 0
      continue
    }
    while (parents.length > 0 && (parents.at(-1)?.level ?? 0) >= entry.level) parents.pop()
    const parent = parents.at(-1)
    if (parent === undefined) roots.push(branch)
    else parent.children.push(branch)
    parents.push(branch)
  }
  return roots
}

function OutlineBranch({ entry, current, onNavigate, t }: {
  entry: Branch
  current: number | undefined
  onNavigate: (position: number) => void
  t: Props['t']
}) {
  const [expanded, setExpanded] = useState(true)
  return <li data-outline-level={entry.level}>
    <div className={css.row}>
      {entry.children.length > 0
        ? <button type="button" className={css.disclosure} aria-expanded={expanded}
          aria-label={`${t(expanded ? 'visualCollapseSection' : 'visualExpandSection')}: ${entry.label}`}
          onClick={() => setExpanded(value => !value)}>{expanded ? '▾' : '▸'}</button>
        : <span className={css.leaf} />}
      <button type="button" className={css.label} data-outline-navigate={entry.position}
        aria-current={current === entry.position ? 'location' : undefined}
        title={entry.label} onClick={() => onNavigate(entry.position)}>{entry.label}</button>
    </div>
    {expanded && entry.children.length > 0 && <ul className={css.children}>
      {entry.children.map(child => <OutlineBranch key={child.position} entry={child} current={current} onNavigate={onNavigate} t={t} />)}
    </ul>}
  </li>
}

/**
 * Show a compact hierarchy without changing the manuscript or mounting another editor.
 * @param props - Current headings, selection position, navigation and localized labels.
 * @returns A collapsible navigation popover.
 */
export function ManuscriptOutline({ entries, currentPosition, onNavigate, t }: Props) {
  const [open, setOpen] = useState(false)
  const summary = useRef<HTMLElement>(null)
  const current = entries.findLast(entry => entry.position < currentPosition)?.position
  const branches = hierarchy(entries)
  return <details className={css.outline} open={open} data-manuscript-outline=""
    onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}
    onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); summary.current?.focus() }
    }}>
    <summary ref={summary} className={css.trigger} aria-expanded={open}
      onClick={(event) => { event.preventDefault(); setOpen(value => !value) }}>{t('visualOutline')} <span aria-hidden="true">⌄</span></summary>
    {open && <nav className={css.popover} aria-label={t('visualOutline')}>
      <ul className={css.roots}>{branches.map(entry => <OutlineBranch key={entry.position} entry={entry}
        current={current} t={t} onNavigate={(position) => { setOpen(false); onNavigate(position) }} />)}</ul>
    </nav>}
  </details>
}
