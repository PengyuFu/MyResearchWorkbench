/** @vitest-environment jsdom */
/** Reconciliation regressions at the React/local-buffer boundary. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MathfieldElement } from 'mathlive'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { VisualEditor } from '../src/client/VisualEditor.tsx'
import type { VisualEditorProps } from '../src/client/VisualEditor.tsx'
import { visualEn } from '../src/client/visual-locales.ts'

vi.hoisted(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const fonts = new Set()
  Object.defineProperty(document, 'fonts', { configurable: true, value: Object.assign(fonts, { ready: Promise.resolve(fonts), status: 'loaded' }) })
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false },
  }) })
})
vi.mock('mathlive', async () => {
  // @ts-expect-error Explicit browser entry avoids the Node-only static rendering export.
  return await import('../node_modules/mathlive/mathlive.mjs')
})

const source = String.raw`\documentclass{article}
\begin{document}
\section{Example}
A synthetic paragraph with $x+1$.
\end{document}
`

const roots: ReturnType<typeof createRoot>[] = []
function mount() {
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  roots.push(root)
  const onEdit = vi.fn<VisualEditorProps['onEdit']>()
  const props: VisualEditorProps = {
    file: { mode: 'writing', path: 'synthetic.tex', absolutePath: 'C:\\synthetic\\synthetic.tex', text: source, savedText: source, savedRawText: source, diskVersion: 'v1',
      lineEnding: 'lf', revision: 0, selection: { from: 0, to: 0 }, scrollTop: 0, saveState: 'clean' },
    fontSize: 16, selection: null, sourceTarget: null, command: null,
    onEdit, onSave() {}, onSelect() {}, onNavigateInclude() {},
    resolveAsset: async () => ({ url: 'data:image/svg+xml,<svg/>', mimeType: 'image/svg+xml' }),
    mathFontsDirectory: '', t: key => visualEn[key],
  }
  act(() => root.render(<VisualEditor {...props} />))
  return { element, root, props, onEdit }
}
function latestFile(props: VisualEditorProps, calls: Parameters<VisualEditorProps['onEdit']>[]): VisualEditorProps['file'] {
  const latest = calls.at(-1)
  if (latest === undefined) throw new Error('No edit emitted')
  return { ...props.file, text: latest[1], selection: latest[2], visualState: latest[3],
    scrollTop: latest[4], revision: props.file.revision + 1 }
}
afterEach(() => {
  act(() => { for (const root of roots.splice(0)) root.unmount() })
  document.body.replaceChildren()
})

describe('visual local-buffer integration', () => {
  it('keeps the same math node and undo history when the owning buffer echoes an edit', () => {
    const { element, root, props, onEdit } = mount()
    const field = element.querySelector<MathfieldElement>('math-field')
    if (field === null) throw new Error('Editable math field missing')
    act(() => { field.setValue('x+2', { silenceNotifications: true }); field.dispatchEvent(new Event('input', { bubbles: true })) })
    const edited = latestFile(props, onEdit.mock.calls)
    expect(edited.text).toBe(source.replace('$x+1$', '$x+2$'))
    act(() => root.render(<VisualEditor {...props} file={edited} />))
    expect(element.querySelector<MathfieldElement>('math-field')).toBe(field)
    act(() => root.render(<VisualEditor {...props} file={edited} command={{ type: 'undo', token: 1 }} />))
    expect(latestFile(props, onEdit.mock.calls).text).toBe(source)
  })

  it('applies an outside proposal as one reversible step without echoing its replacement back to the controller', () => {
    const { element, root, props, onEdit } = mount()
    const field = element.querySelector<MathfieldElement>('math-field')
    if (field === null) throw new Error('Editable math field missing')
    act(() => { field.setValue('x+3', { silenceNotifications: true }); field.dispatchEvent(new Event('input', { bubbles: true })) })
    const manual = latestFile(props, onEdit.mock.calls)
    act(() => root.render(<VisualEditor {...props} file={manual} />))
    const before = onEdit.mock.calls.length
    const external = { ...manual, text: manual.text.replace('synthetic paragraph', 'reviewed paragraph'), revision: manual.revision + 1 }
    act(() => root.render(<VisualEditor {...props} file={external} />))
    expect(onEdit.mock.calls.length).toBe(before)
    expect(element.textContent).toContain('reviewed paragraph')
    act(() => root.render(<VisualEditor {...props} file={external} command={{ type: 'undo', token: 1 }} />))
    expect(latestFile(props, onEdit.mock.calls).text).toBe(manual.text)
  })

  it('retains undo when the same controller and unchanged local buffer remount the file', () => {
    const { element, root, props, onEdit } = mount()
    const field = element.querySelector<MathfieldElement>('math-field')
    if (field === null) throw new Error('Editable math field missing')
    act(() => { field.setValue('x+4', { silenceNotifications: true }); field.dispatchEvent(new Event('input', { bubbles: true })) })
    const manual = latestFile(props, onEdit.mock.calls)
    act(() => root.render(null))
    act(() => root.render(<VisualEditor {...props} file={manual} />))
    act(() => root.render(<VisualEditor {...props} file={manual} command={{ type: 'undo', token: 1 }} />))
    expect(latestFile(props, onEdit.mock.calls).text).toBe(source)
  })
  it('uses the same scientific projection for read-only proposal previews with no editing controls or buffer writes', () => {
    const { element, root, props, onEdit } = mount()
    act(() => root.render(<VisualEditor {...props} readOnly />))
    const before = onEdit.mock.calls.length
    expect(element.querySelector('[role="toolbar"]')).toBeNull()
    expect(element.querySelector('.ProseMirror')?.getAttribute('contenteditable')).toBe('false')
    expect(element.querySelector<MathfieldElement>('math-field')?.readOnly).toBe(true)
    act(() => root.render(<VisualEditor {...props} readOnly file={{ ...props.file, text: source.replace('x+1', 'x+7') }} />))
    expect(element.querySelector<MathfieldElement>('math-field')?.getValue('latex')).toBe('x+7')
    expect(onEdit.mock.calls.length).toBe(before)
  })

})
