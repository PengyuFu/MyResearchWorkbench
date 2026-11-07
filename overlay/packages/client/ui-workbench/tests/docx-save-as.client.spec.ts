import { expect, it, vi } from 'vitest'
import { WorkbenchController } from '../src/client/controller.ts'
import { wordBuffer } from '../src/client/word-operations.ts'
import { captureWorkbench } from '../src/client/buffer-persistence.ts'
import type { WordSnapshot } from '@deepseek-ai/dsh-workbench-word/types'
import type { WorkbenchIO } from '../src/client/types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

it('retains typing and its recoverable bytes when Save As acknowledges an earlier revision', async () => {
  const confirmed: WordSnapshot = {
    id: 'a'.repeat(32), checkpoint: '1-' + 'b'.repeat(32), checkpointHash: 'c'.repeat(64),
    path: 'paper.docx', absolutePath: 'D:/fixture/paper.docx', workspaceRoot: 'D:/fixture',
    revision: 1, savedRevision: 0, checkpointTime: 1, diskVersion: 'original', engine: 'ooxml',
    projection: { text: 'confirmed\n', blocks: [], styles: [], canUndo: true, canRedo: false },
  }
  let acknowledge!: (value: WordSnapshot) => void
  let started!: () => void
  const entered = new Promise<void>((resolve) => { started = resolve })
  const save = vi.fn(async () => {
    started()
    return new Promise<WordSnapshot>((resolve) => { acknowledge = resolve })
  })
  const word: NonNullable<WorkbenchIO['word']> = {
    save, open: async () => confirmed, mutate: async () => confirmed, proof: async () => null,
    stop: async () => {}, close: async () => {},
    commit: async () => { throw new Error('No pending commit at save start') },
    resources: async () => { throw new Error('No mounted editor in this controller fixture') },
  }
  const unexpected = (): Promise<never> => Promise.reject(new Error('Unexpected non-DOCX operation'))
  const io: WorkbenchIO = {
    word, publishEditor: async () => {}, preview: () => {},
    attachment: unexpected, read: unexpected, environments: unexpected, asset: unexpected,
    stat: unexpected, save: unexpected, assetRecovery: unexpected, list: unexpected,
    start: unexpected, current: unexpected, status: unexpected, stop: unexpected, pdf: unexpected,
    synctexForward: unexpected, synctexReverse: unexpected, request: unexpected,
    getAction: unexpected, cancelAction: unexpected, review: unexpected,
  }
  const controller = new WorkbenchController('save-as-test' as SessionId, io, key => key)
  const file = wordBuffer(confirmed)
  controller.state.set({ ...controller.state.getSnapshot(), workspaceRoot: 'D:/fixture',
    mode: 'writing', activePaths: { writing: file.path, development: null }, buffers: { [file.path]: file } })
  try {
    const saving = controller.actions.saveAs('copy.docx')
    await entered
    const current = controller.state.getSnapshot()
    controller.state.set({ ...current, buffers: { ...current.buffers, [file.path]: {
      ...file, text: 'confirmed\nlate typing', revision: 2, wordSync: 'pending', saveState: 'dirty',
      pendingWord: { text: 'confirmed\nlate typing', document: 'docx:cmVjb3ZlcmFibGU=' },
      word: { ...confirmed, projection: { ...confirmed.projection, text: 'confirmed\nlate typing' } },
    } } })
    acknowledge({ ...confirmed, path: 'copy.docx', absolutePath: 'D:/fixture/copy.docx', savedRevision: 1 })
    await saving
    const state = controller.state.getSnapshot(), saved = state.buffers['copy.docx']
    expect(state.buffers['paper.docx']).toBeUndefined()
    expect(state.activePaths.writing).toBe('copy.docx')
    expect(saved).toMatchObject({ text: 'confirmed\nlate typing', revision: 2, saveState: 'dirty',
      word: { savedRevision: 1 }, pendingWord: { document: 'docx:cmVjb3ZlcmFibGU=' } })
    expect(captureWorkbench('save-as-test', state).buffers[0]?.word?.pending?.document).toBe('docx:cmVjb3ZlcmFibGU=')
  } finally {
    // This fixture has no mounted editor; retain the pending draft for cleanup without trying to serialize it.
    const state = controller.state.getSnapshot()
    controller.state.set({ ...state, buffers: Object.fromEntries(Object.entries(state.buffers).map(([name, buffer]) =>
      [name, buffer.kind === 'word' ? { ...buffer, wordSync: 'failed' as const } : buffer])) })
    await controller.dispose()
  }
})
