// @vitest-environment jsdom
/** A readonly recovery placeholder must not emit stale text when replaced. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { CodeEditor } from '../src/client/CodeEditor.tsx'
import { en } from '../src/client/locales.ts'
import type { EditorBuffer } from '../src/client/types.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('keeps the recovered source when an unavailable placeholder editor is replaced', () => {
  const rect = new DOMRect(0, 0, 400, 300)
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue(Object.assign([rect], { item: () => rect }))
  const file: EditorBuffer = {
    mode: 'development', path: 'kernel.cu', absolutePath: '/fixture/kernel.cu',
    text: '', savedText: '', savedRawText: '', diskVersion: 'old', lineEnding: 'lf',
    revision: 0, selection: { from: 0, to: 0 }, scrollTop: 0, saveState: 'error', unavailable: true,
  }
  const onEdit = vi.fn()
  const editor = (buffer: EditorBuffer) => <CodeEditor file={buffer} fontSize={16} wrap
    selection={null} sourceTarget={null} command={null}
    onEdit={onEdit} onSave={vi.fn()} onSelect={vi.fn()} t={key => en[key]} />
  const view = render(editor(file))
  fireEvent(window, new Event('mrw:checkpoint-editors'))
  expect(onEdit).not.toHaveBeenCalled()
  const text = '__global__ void kernel() {}\n'
  view.rerender(editor({ ...file, text, savedText: text, savedRawText: text, unavailable: false, saveState: 'clean', revision: 1 }))
  expect(view.getByRole('textbox', { name: 'kernel.cu' }).textContent).toBe(text.trim())
  fireEvent(window, new Event('mrw:checkpoint-editors'))
  expect(onEdit).toHaveBeenCalledWith('kernel.cu', text, expect.any(Object), expect.any(String), expect.any(Number))
  view.unmount()
  expect(onEdit.mock.calls.every(call => call[1] === text)).toBe(true)
})
