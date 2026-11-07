/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { chooseReferenceKey, referenceCandidates, VisualReferencePicker } from '../src/client/visual-references.tsx'
import type { VisualReferenceIndex } from '../src/client/visual-references.tsx'
import { visualEn } from '../src/client/visual-locales.ts'

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount() })
  document.body.replaceChildren()
})

describe('project reference chooser', () => {
  it('uses unsaved labels while preserving duplicate definitions and other files', () => {
    const source = '\\section{First}\\label{new}\n\\section{Second}\\label{duplicate}\n\\section{Third}\\label{duplicate}'
    const entries = referenceCandidates('label', source, 'main.tex', [
      { key: 'old-disk-label', kind: 'label', path: 'main.tex' },
      { key: 'external', kind: 'label', path: 'sections/child.tex' },
      { key: 'a-citation', kind: 'citation', path: 'refs.bib' },
    ])
    expect(entries.map(entry => entry.key)).toEqual(['external', 'new', 'duplicate', 'duplicate'])
    expect(chooseReferenceKey('citation', 'first, sec', 'second')).toBe('first, second')
    expect(chooseReferenceKey('label', 'stale', 'external')).toBe('external')
  })

  it('shows unknown and duplicate keys, then chooses an indexed key without writing a bibliography', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    roots.push(root)
    const query = vi.fn(async (): Promise<VisualReferenceIndex> => ({ entries: [
      { key: 'known', kind: 'citation', path: 'refs.bib' },
      { key: 'known', kind: 'citation', path: 'appendix.bib' },
    ], warnings: ['One included bibliography is unavailable.'] }))
    const onChange = vi.fn()
    const render = (value: string) => <VisualReferencePicker kind="citation" source="" sourcePath="main.tex"
      value={value} onChange={onChange} query={query} t={key => visualEn[key]} />
    await act(async () => { root.render(render('missing')) })
    expect(host.textContent).toContain('This key is absent from the project index')
    expect(host.textContent).toContain('One included bibliography is unavailable.')
    await act(async () => { root.render(render('known')) })
    expect(host.textContent).toContain('This key has multiple definitions')
    expect(host.textContent).toContain('refs.bib')
    expect(host.textContent).toContain('appendix.bib')
    const choice = host.querySelector<HTMLButtonElement>('button[aria-label="known"]')
    if (choice === null) throw new Error('Indexed choice missing')
    act(() => choice.click())
    expect(onChange).toHaveBeenLastCalledWith('known')
    expect(query).toHaveBeenCalledTimes(1)
  })
})
