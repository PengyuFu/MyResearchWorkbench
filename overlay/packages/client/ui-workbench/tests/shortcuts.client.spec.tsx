// @vitest-environment jsdom
/** Verify both browser key spellings against the real CodeMirror input handler. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodeEditor } from '../src/client/CodeEditor.tsx'
import { en } from '../src/client/locales.ts'
import type { EditorBuffer } from '../src/client/types.ts'

afterEach(cleanup)

describe('workbench source shortcuts', () => {
  it('routes both selection shortcuts to unified assistance for lowercase and uppercase event keys', () => {
    const file: EditorBuffer = {
      mode: 'development', path: 'sample.txt', absolutePath: '/fixture/sample.txt', text: 'Selected words.', savedText: 'Selected words.', savedRawText: 'Selected words.', diskVersion: 'v1',
      lineEnding: 'lf', revision: 0, selection: { from: 0, to: 8 }, scrollTop: 0, saveState: 'clean',
    }
    const onSelect = vi.fn()
    const view = render(<CodeEditor file={file} fontSize={16} wrap selection={null} sourceTarget={null} command={null}
      onEdit={vi.fn()} onSave={vi.fn()} onSelect={onSelect} t={key => en[key]} />)
    const content = view.container.querySelector<HTMLElement>('.cm-content')
    if (content === null) throw new Error('CodeMirror content did not mount')
    for (const keyCode of [0, 75]) {
      fireEvent.keyDown(content, { key: 'k', code: 'KeyK', keyCode, ctrlKey: true, shiftKey: true })
      fireEvent.keyDown(content, { key: 'K', code: 'KeyK', keyCode, ctrlKey: true, shiftKey: true })
      fireEvent.keyDown(content, { key: 'k', code: 'KeyK', keyCode, ctrlKey: true })
    }
    expect(onSelect.mock.calls).toEqual(Array.from({ length: 6 }, () => ['assist']))
    view.unmount()
  })
})
