// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WordSnapshot } from '@deepseek-ai/dsh-workbench-word/types'
import { WorkbenchController } from '../src/client/controller.ts'
import type { WorkbenchIO } from '../src/client/types.ts'
import { captureWorkbench } from '../src/client/buffer-persistence.ts'
import type { WorkbenchPersistence } from '../src/client/workbench-state.ts'

const model = vi.hoisted(() => ({ text: 'Original\n', changed: () => {} }))
vi.mock('@docx-editor.dev/core/editor', () => ({ createDocxEditor: () => ({
  surface: { flushPendingInput() {}, state: () => ({ selection: { anchor: { paragraphId: 'p', offset: 0 }, head: { paragraphId: 'p', offset: 0 } } }), activeScope: () => ({ kind: 'body' }) },
  getTableCellSelection: () => null, snapshot: () => ({ isOpening: false }),
  on: (name: string, callback: (change: object) => void) => { if (name === 'change') model.changed = () => callback({}) },
  save: async () => new TextEncoder().encode(model.text).buffer,
  attach() {}, detach() {}, destroy() {}, setZoomMode() {}, exec() {},
}) }))
vi.mock('../src/client/docx-projection.ts', () => ({
  docxProjection: () => ({ text: model.text, blocks: [], styles: [], canUndo: true, canRedo: false }),
  docxSelection: () => ({ from: 0, to: 0 }), docxPosition: () => ({}),
}))
vi.mock('../src/client/docx-operations.ts', () => ({ applyDocxOperation: async () => {
  model.text = 'AI revision\n'; model.changed()
} }))

const controllers: WorkbenchController[] = []
beforeEach(() => {
  vi.useFakeTimers(); model.text = 'Original\n'
  // Native crypto completes outside fake time; hashing is covered by worker tests.
  vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(new ArrayBuffer(32))
})
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function setup(restoredStatus?: 'conflict' | 'unavailable' | 'unchanged') {
  let durable: WordSnapshot = {
    id: 'a'.repeat(32), checkpoint: '0-' + 'b'.repeat(32), checkpointHash: 'c'.repeat(64),
    path: 'paper.docx', absolutePath: '/fixture/paper.docx', workspaceRoot: '/fixture',
    revision: 0, savedRevision: 0, checkpointTime: 1, diskVersion: 'original', data: btoa('Original\n'), engine: 'ooxml',
    projection: { text: model.text, blocks: [], styles: [], canUndo: false, canRedo: false },
  }
  let disk = model.text
  const save = vi.fn(async (_session: SessionId, _id: string, revision: number) => {
    durable = { ...durable, savedRevision: revision, originalStatus: undefined }
    disk = durable.projection.text
    return durable
  })
  const word: NonNullable<WorkbenchIO['word']> = {
    save, open: async () => durable, mutate: async () => durable,
    commit: async (_session, request) => {
      durable = { ...durable, revision: request.nextRevision, data: request.data, projection: request.projection }
      return durable
    },
    checkpoint: async () => durable, proof: async () => null, stop: async () => {}, close: async () => {},
    resources: async () => { throw new Error('Fonts are outside this scheduling test') },
  }
  const unexpected = (): Promise<never> => Promise.reject(new Error('Unexpected non-DOCX operation'))
  const io: WorkbenchIO = {
    word, publishEditor: async () => {}, preview: () => {},
    stat: async () => ({ path: 'paper.docx', absolutePath: '/fixture/paper.docx', bytes: 10, version: 'original' }),
    list: async () => ({ workspaceRoot: '/fixture', path: '.', entries: [], truncated: false }),
    attachment: unexpected, read: unexpected, environments: unexpected, asset: unexpected,
    save: unexpected, assetRecovery: unexpected, start: unexpected, current: unexpected, status: unexpected,
    stop: unexpected, pdf: unexpected, synctexForward: unexpected, synctexReverse: unexpected,
    request: unexpected, getAction: unexpected, cancelAction: unexpected, review: unexpected,
  }
  const first = new WorkbenchController('autosave' as SessionId, io, key => key)
  controllers.push(first)
  await first.actions.open('paper.docx')
  let controller = first
  if (restoredStatus !== undefined) {
    durable = { ...durable, revision: 1, originalStatus: restoredStatus === 'unchanged' ? undefined : restoredStatus }
    const state = first.state.getSnapshot()
    const file = state.buffers['paper.docx']!
    if (file.kind !== 'word') throw new Error('Word fixture not opened')
    const record = captureWorkbench('autosave', { ...state, buffers: { 'paper.docx': { ...file, word: durable, revision: 1 } } })
    const persistence: WorkbenchPersistence = { load: async () => record, stage() {}, flush: async () => {} }
    controller = new WorkbenchController('autosave' as SessionId, io, key => key, 1000, persistence)
    controllers.push(controller)
    await controller.actions.list('.')
  }
  const host = document.createElement('div')
  controller.actions.wordMount('paper.docx', host)
  await vi.advanceTimersByTimeAsync(0)
  const edit = (text: string) => { model.text = text; model.changed() }
  return { controller, save, edit, disk: () => disk, confirmed: () => durable }
}

it('coalesces typing and does not write an unchanged original again', async () => {
  const test = await setup()
  expect(test.save).not.toHaveBeenCalled()
  for (const text of ['One\n', 'Two\n', 'Final\n']) {
    test.edit(text); await vi.advanceTimersByTimeAsync(300)
  }
  expect(test.disk()).toBe('Original\n')
  await vi.advanceTimersByTimeAsync(1000)
  expect(test.disk()).toBe('Final\n')
  expect(test.save).toHaveBeenCalledTimes(1)
  await test.controller.actions.save()
  await vi.advanceTimersByTimeAsync(3000)
  expect(test.save).toHaveBeenCalledTimes(1)
})

it('automatically publishes accepted AI edits through the same save path', async () => {
  const test = await setup()
  await test.controller.actions.wordMutate('paper.docx', { kind: 'undo' })
  await vi.advanceTimersByTimeAsync(1100)
  expect(test.disk()).toBe('AI revision\n')
  expect(test.save).toHaveBeenCalledTimes(1)
})

it('serializes Save with autosave and retains typing made during an earlier save', async () => {
  const test = await setup()
  let acknowledge!: () => void
  test.save.mockImplementationOnce(async () => {
    const older = test.confirmed()
    await new Promise<void>((resolve) => { acknowledge = resolve })
    return { ...older, savedRevision: older.revision }
  })
  test.edit('First\n'); await vi.advanceTimersByTimeAsync(1000)
  expect(test.save).toHaveBeenCalledTimes(1)
  test.edit('Later\n'); await vi.advanceTimersByTimeAsync(300)
  const manualSave = test.controller.actions.save()
  acknowledge(); await vi.advanceTimersByTimeAsync(1400)
  await manualSave
  expect(test.disk()).toBe('Later\n')
  expect(test.save).toHaveBeenCalledTimes(2)
  expect(test.controller.state.getSnapshot().buffers['paper.docx']).toMatchObject({ text: 'Later\n', saveState: 'clean' })
})

it('retains the draft on save failure and stops retrying until an explicit save', async () => {
  const test = await setup()
  test.save.mockRejectedValueOnce(new Error('Original locked'))
  test.edit('Retained\n'); await vi.advanceTimersByTimeAsync(1100)
  expect(test.disk()).toBe('Original\n')
  expect(test.controller.state.getSnapshot().buffers['paper.docx']).toMatchObject({ text: 'Retained\n', saveState: 'error' })
  test.edit('Further\n'); await vi.advanceTimersByTimeAsync(5000)
  expect(test.save).toHaveBeenCalledTimes(1)
  await test.controller.actions.save()
  expect(test.disk()).toBe('Further\n')
})

it('saves immediately when closing a dirty tab and does not ask to discard saved changes', async () => {
  const test = await setup()
  test.edit('Close me\n')
  await test.controller.actions.close('paper.docx')
  expect(test.disk()).toBe('Close me\n')
  expect(test.controller.state.getSnapshot().buffers['paper.docx']).toBeUndefined()
  expect(test.controller.state.getSnapshot().closePrompt).toBeNull()
})

it('publishes ready originals before normal quit and keeps failed drafts recoverable', async () => {
  const test = await setup()
  test.edit('Quit now\n')
  await test.controller.ready(true)
  expect(test.disk()).toBe('Quit now\n')
  test.save.mockRejectedValueOnce(new Error('Original locked'))
  test.edit('Retain on quit\n')
  await test.controller.ready(true)
  expect(test.disk()).toBe('Quit now\n')
  expect(captureWorkbench('autosave', test.controller.state.getSnapshot()).buffers[0]?.word?.snapshot.projection.text).toBe('Retain on quit\n')
})

it.each(['conflict', 'unavailable'] as const)('shows %s immediately on recovery and leaves the original untouched', async (status) => {
  const test = await setup(status)
  expect(test.controller.state.getSnapshot().buffers['paper.docx']).toMatchObject({
    word: { originalStatus: status }, saveState: status === 'conflict' ? 'conflict' : 'error',
  })
  test.edit('Retained changed draft\n')
  await vi.advanceTimersByTimeAsync(5000)
  expect(test.save).not.toHaveBeenCalled()
  expect(test.disk()).toBe('Original\n')
})

it('automatically saves a recovered draft when the original still matches', async () => {
  const test = await setup('unchanged')
  await vi.advanceTimersByTimeAsync(1100)
  expect(test.save).toHaveBeenCalledTimes(1)
  expect(test.controller.state.getSnapshot().buffers['paper.docx']).toMatchObject({ saveState: 'clean' })
})
