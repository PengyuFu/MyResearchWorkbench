// @vitest-environment jsdom
/** Word teardown must never relabel the outgoing document as the incoming file. */
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WordEditor } from '../src/client/WordEditor.tsx'
import { wordBuffer } from '../src/client/word-operations.ts'
import { en } from '../src/client/locales.ts'
import type { WordSnapshot } from '@deepseek-ai/dsh-workbench-word/types'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('does not send the previous Word content to a different file during a tab switch', () => {
  const rect = new DOMRect(0, 0, 400, 300)
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue(Object.assign([rect], { item: () => rect }))
  Object.defineProperties(Range.prototype, {
    getClientRects: { configurable: true, value: () => Object.assign([rect], { item: () => rect }) },
    getBoundingClientRect: { configurable: true, value: () => rect },
  })
  const file = (path: string, text: string) => wordBuffer({
    id: path, checkpoint: 'checkpoint', checkpointHash: 'hash', path, absolutePath: '/fixture/' + path,
    workspaceRoot: '/fixture', revision: 0, savedRevision: 0, checkpointTime: 1, diskVersion: 'disk',
    projection: { text: text + '\n', styles: ['Normal'], canUndo: false, canRedo: false, blocks: [{
      id: path, kind: 'paragraph', from: 0, to: text.length, text, style: 'Normal',
      level: 0, alignment: 0, spaceBefore: 0, spaceAfter: 0, runs: [],
    }] },
  } satisfies WordSnapshot)
  const edit = vi.fn()
  const viewOf = (path: string, text: string) => <WordEditor file={file(path, text)} fontSize={16} t={key => en[key]}
    edit={edit} mutate={async () => {}} resume={async () => {}} select={() => {}} save={() => {}}
    importAsset={async () => { throw new Error('No image import in this test') }} sourceTarget={null} command={null} />
  const view = render(viewOf('first.docx', 'FIRST'))
  view.rerender(viewOf('second.docx', 'SECOND'))
  expect(view.getByRole('textbox', { name: 'Word manuscript' }).textContent).toBe('SECOND')
  view.unmount()
  expect(edit.mock.calls.length).toBeGreaterThan(0)
  expect(edit.mock.calls.every(([path, text]) => text === (path === 'first.docx' ? 'FIRST\n' : 'SECOND\n'))).toBe(true)
})
