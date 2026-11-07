import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WordSnapshot } from '@deepseek-ai/dsh-workbench-word/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkbenchSelectionRequest } from '@deepseek-ai/dsh-workbench-assistant/types'
import { captureWorkbench, type WorkbenchRecord } from '../src/client/buffer-persistence.ts'
import { workbenchStateKey, type WorkbenchPersistence } from '../src/client/workbench-state.ts'
import { activeBuffer, activePath, activePane } from '../src/client/editor-state.ts'
import { WorkbenchController } from '../src/client/controller.ts'
import type { FileSnapshot, WorkbenchIO } from '../src/client/types.ts'

const sessionId = 'workbench-test' as SessionId
const controllers: WorkbenchController[] = []
afterEach(async () => { await Promise.all(controllers.splice(0).map(controller => controller.dispose())); vi.useRealTimers() })

function memoryScenes() {
  const records = new Map<string, WorkbenchRecord>()
  const persistence: WorkbenchPersistence = {
    load: async (id, root) => structuredClone(records.get(workbenchStateKey(id, root)) ?? null),
    stage: (record) => { records.set(workbenchStateKey(record.sessionId, record.workspaceRoot), structuredClone(record)) },
    flush: async () => undefined,
  }
  return { records, persistence }
}

function setup(persistence?: WorkbenchPersistence) {
  let disk: FileSnapshot = { path: 'main.tex', absolutePath: '/fixture/main.tex', text: 'Original paragraph.', version: 'disk-1', bytes: 19 }
  let proposed = 'Improved paragraph.'
  const save = vi.fn(async (_sessionId: SessionId, request: { path: string; text: string; version: string | null }) => {
    if (request.version !== disk.version && request.version !== null) throw new Error('version conflict')
    disk = { ...disk, path: request.path, text: request.text, version: `${disk.version}+1`, bytes: request.text.length }
    return disk
  })
  const io: WorkbenchIO = {
    publishEditor: vi.fn(async () => undefined),
    attachment: async () => { throw new Error('No attachment was requested in this fixture.') },
    assetRecovery: async () => ({ records: [], issues: [], truncated: false }),
    environments: async () => ({ python: [], cpp: [], cuda: [], matlab: [] }),
    preview: vi.fn(), asset: async () => ({ path: 'image.png', version: '1', mimeType: 'image/png', data: new Uint8Array() }),
    read: async () => disk, stat: async () => disk, save,
    list: async () => ({ workspaceRoot: '/fixture', path: '.', entries: [], truncated: false }),
    start: async requestSession => ({ id: String(requestSession), state: 'succeeded', kind: 'latex', path: 'main.tex', output: '', diagnostics: [] }),
    current: async () => null,
    status: async () => ({ id: 'job', state: 'succeeded', kind: 'latex', path: 'main.tex', output: '', diagnostics: [] }),
    stop: async () => ({ id: 'job', state: 'cancelled', kind: 'latex', path: 'main.tex', output: '', diagnostics: [] }),
    pdf: async () => null, synctexForward: async () => ({ page: 1, x: 0, y: 0, width: 1, height: 1 }), synctexReverse: async () => ({ path: 'main.tex', line: 1, column: 1 }),
    request: async request => ({ actionId: 'action', state: 'proposed', proposal: { replacement: proposed, explanation: '', base: request } }),
    review: vi.fn(async () => undefined),
    getAction: async () => ({ actionId: 'action', state: 'completed' }), cancelAction: async () => ({ actionId: 'action', state: 'cancelled' }),
  }
  const controller = new WorkbenchController(sessionId, io, key => key, 1000, persistence)
  controllers.push(controller)
  return {
    controller, save, io, disk: () => disk,
    setDisk: (file: Partial<FileSnapshot>) => { disk = { ...disk, ...file } },
    replacement: (text: string) => { proposed = text },
  }
}

async function propose(controller: WorkbenchController) {
  await controller.actions.open('main.tex')
  const file = controller.state.getSnapshot().buffers['main.tex']!
  controller.actions.edit(file.path, file.text, { from: 0, to: file.text.length }, '{}', 0)
  controller.actions.select('edit')
  controller.actions.setInstruction('Improve this paragraph.')
  await controller.actions.ask()
}

describe('workbench editing transactions', () => {

  it('stops submission when editor publication fails and recovers on the next explicit synchronization', async () => {
    const { controller, io } = setup()
    await controller.actions.open('main.tex')
    await controller.prepareQuickCommand()
    vi.mocked(io.publishEditor).mockRejectedValueOnce(new Error('publication disconnected'))
    await expect(controller.prepareQuickCommand()).rejects.toThrow('publication disconnected')
    await expect(controller.prepareQuickCommand()).resolves.toBeUndefined()
    expect(io.publishEditor).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId, context: expect.objectContaining({ path: 'main.tex', text: 'Original paragraph.' }),
    }))
  })


  it('keeps the editor visible through unified selection, sending and refinement', async () => {
    vi.useFakeTimers()
    const { controller, io, disk } = setup()
    const request = vi.spyOn(io, 'request')
    await controller.actions.open('main.tex')
    controller.actions.setFocus('editor')
    const file = controller.state.getSnapshot().buffers['main.tex']!
    controller.actions.edit(file.path, file.text, { from: 0, to: file.text.length }, '{}', 0)
    controller.actions.select('assist')
    expect(controller.state.getSnapshot().focus).toBe('editor')
    controller.actions.setInstruction('Improve this sentence.')
    await controller.actions.ask()
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ mode: 'assist' }))
    expect(controller.state.getSnapshot().focus).toBe('editor')
    expect(disk().text).toBe('Original paragraph.')
    controller.actions.refine()
    expect(controller.state.getSnapshot().focus).toBe('editor')
    expect(controller.state.getSnapshot().selectionMode).toBe('assist')
  })

  it('opens a conversation-named code file directly in its editor without creating or running anything', async () => {
    vi.useFakeTimers()
    const { controller, io, setDisk, save } = setup()
    setDisk({ path: 'simulation.py', absolutePath: '/fixture/simulation.py', text: 'print(1)\n' })
    const run = vi.spyOn(io, 'start')
    controller.observeConversation({ open: { seq: 1, path: 'simulation.py', mode: 'development' }, prepared: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(controller.state.getSnapshot()).toMatchObject({ activePaths: { writing: null, development: 'simulation.py' }, mode: 'development', panes: { development: 'source' }, focus: 'editor' })
    expect(run).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('reviews a disk-captured ordinary conversation proposal before using the original save transaction', async () => {
    vi.useFakeTimers()
    const { controller, io, save, disk } = setup()
    const request: WorkbenchSelectionRequest = { sessionId, requestId: 'ordinary', mode: 'edit', path: 'main.tex',
      from: 0, to: 19, selectedText: 'Original paragraph.', contextBefore: '', contextAfter: '',
      bufferVersion: 'disk:disk-1', instruction: 'Improve this paragraph.', objectKind: 'text' }
    io.getAction = async () => ({ actionId: request.requestId, state: 'proposed',
      proposal: { base: request, replacement: 'Reviewed paragraph.', explanation: 'Clarified.' } })
    const view = { open: { seq: 1, path: 'main.tex', mode: 'writing' as const }, prepared: { seq: 2, request } }
    controller.observeConversation(view)
    await vi.advanceTimersByTimeAsync(0)
    expect(controller.state.getSnapshot()).toMatchObject({ focus: 'editor', action: { actionId: 'ordinary', state: 'proposed' } })
    expect(controller.state.getSnapshot().error).toBeNull()
    await vi.advanceTimersByTimeAsync(1500)
    expect(save).not.toHaveBeenCalled()
    expect(disk().text).toBe('Original paragraph.')
    controller.actions.accept()
    controller.observeConversation(view)
    await vi.advanceTimersByTimeAsync(1001)
    expect(save).toHaveBeenCalledTimes(1)
    expect(disk().text).toBe('Reviewed paragraph.')
    expect(controller.state.getSnapshot().action).toBeNull()
  })

  it('mints selection request IDs when the browser has no secure-context randomUUID method', async () => {
    vi.useFakeTimers()
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto)
    vi.stubGlobal('crypto', { getRandomValues })
    try {
      const { controller, io } = setup()
      const request = vi.spyOn(io, 'request')
      await propose(controller)
      expect(controller.state.getSnapshot().action?.state).toBe('proposed')
      expect(request).toHaveBeenCalledWith(expect.objectContaining({
        requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      }))
    } finally { vi.unstubAllGlobals() }
  })

  it('keeps proposed text outside the buffer and disk until accepted', async () => {
    vi.useFakeTimers()
    const { controller, save, disk } = setup()
    await propose(controller)
    expect(controller.hasPendingAction).toBe(true)
    await vi.advanceTimersByTimeAsync(1500)
    expect(controller.state.getSnapshot().buffers['main.tex']!.text).toBe('Original paragraph.')
    expect(save).not.toHaveBeenCalled()
    controller.actions.accept()
    expect(controller.hasPendingAction).toBe(false)
    expect(controller.state.getSnapshot().buffers['main.tex']!.edit).toMatchObject({ from: 0, to: 19, insert: 'Improved paragraph.' })
    await vi.advanceTimersByTimeAsync(1001)
    expect(disk().text).toBe('Improved paragraph.')
    expect(controller.state.getSnapshot().buffers['main.tex']!.saveState).toBe('clean')
  })

  it('refuses a suggestion after manual changes and keeps those changes intact', async () => {
    const { controller, save } = setup()
    await propose(controller)
    controller.actions.edit('main.tex', 'My newer words.', { from: 0, to: 0 }, '{}', 0)
    controller.actions.accept()
    expect(controller.state.getSnapshot().error).toBe('staleProposal')
    expect(controller.state.getSnapshot().buffers['main.tex']!.text).toBe('My newer words.')
    expect(save).not.toHaveBeenCalled()
  })

  it('stops saving on an external conflict without losing the dirty buffer', async () => {
    const { controller, setDisk, disk } = setup()
    await controller.actions.open('main.tex')
    controller.actions.edit('main.tex', 'My change.', { from: 0, to: 0 }, '{}', 0)
    setDisk({ text: 'External change.', version: 'disk-2' })
    await expect(controller.actions.save()).rejects.toThrow('version conflict')
    const file = controller.state.getSnapshot().buffers['main.tex']!
    expect(file.text).toBe('My change.')
    expect(file.external?.text).toBe('External change.')
    expect(file.saveState).toBe('conflict')
    expect(disk().text).toBe('External change.')
    await expect(controller.actions.save()).rejects.toThrow('conflict')
    controller.actions.edit('main.tex', 'Original paragraph.', { from: 0, to: 0 }, '{}', 0)
    expect(controller.state.getSnapshot().buffers['main.tex']!.saveState).toBe('conflict')
    expect(controller.hasUnsaved).toBe(true)
    await expect(controller.actions.save()).rejects.toThrow('conflict')
    await controller.actions.close('main.tex')
    expect(controller.state.getSnapshot().buffers['main.tex']).toBeDefined()
  })

  it('retains drafts, cursor and pending proposal across work-view switches', async () => {
    const { controller } = setup()
    await propose(controller)
    const before = controller.state.getSnapshot()
    controller.actions.setMode('development')
    controller.actions.setMode('chat')
    controller.actions.setMode('writing')
    const after = controller.state.getSnapshot()
    expect(after.buffers).toEqual(before.buffers)
    expect(after.selection).toEqual(before.selection)
    expect(after.action).toEqual(before.action)
  })

  it('serializes saves while preserving text typed during an in-flight write', async () => {
    const { controller, io } = setup()
    await controller.actions.open('main.tex')
    let finish: ((file: FileSnapshot) => void) | undefined
    io.save = vi.fn(() => new Promise<FileSnapshot>((resolve) => { finish = resolve }))
    controller.actions.edit('main.tex', 'First edit.', { from: 0, to: 0 }, '{}', 0)
    const saving = controller.actions.save()
    await Promise.resolve() // Wait until asynchronous staging validation reaches the deliberately held I/O.
    controller.actions.edit('main.tex', 'Second edit.', { from: 0, to: 0 }, '{}', 0)
    finish?.({ path: 'main.tex', absolutePath: '/fixture/main.tex', text: 'First edit.', version: 'disk-2', bytes: 11 })
    await saving
    const file = controller.state.getSnapshot().buffers['main.tex']!
    expect(file.text).toBe('Second edit.')
    expect(file.savedText).toBe('First edit.')
    expect(file.diskVersion).toBe('disk-2')
    expect(file.saveState).toBe('dirty')
  })

  it('retains accepted parts when the remaining proposal is discarded', async () => {
    const { controller, setDisk, replacement, io } = setup()
    const middle = '\nAn unchanged sentence keeps these independent changes separate.\n'.repeat(8)
    setDisk({ text: `alpha first paragraph.${middle}beta final paragraph.` })
    replacement(`gamma first paragraph.${middle}delta final paragraph.`)
    await propose(controller)
    controller.actions.accept(0)
    const partlyAccepted = controller.state.getSnapshot().buffers['main.tex']!.text
    expect(controller.state.getSnapshot().action?.proposal).toBeDefined()
    expect(io.review).not.toHaveBeenCalled()
    controller.actions.discard()
    expect(controller.state.getSnapshot().buffers['main.tex']!.text).toBe(partlyAccepted)
    expect(controller.state.getSnapshot().action).toBeNull()
    expect(io.review).toHaveBeenCalledWith(sessionId, 'action', 'partial', partlyAccepted, '0')
  })

  it('keeps an undone buffer open until an in-flight save and its correction have finished', async () => {
    vi.useFakeTimers()
    const { controller, io, save, disk } = setup()
    await controller.actions.open('main.tex')
    let finish: (() => void) | undefined
    io.save = vi.fn().mockImplementationOnce((id: SessionId, request: Parameters<WorkbenchIO['save']>[1]) => new Promise<FileSnapshot>((resolve, reject) => {
      finish = () => { void save(id, request).then(resolve, reject) }
    })).mockImplementation(save)
    controller.actions.edit('main.tex', 'Pending edit.', { from: 0, to: 0 }, '{}', 0)
    const saving = controller.actions.save()
    await Promise.resolve() // Wait until asynchronous staging validation reaches the deliberately held I/O.
    controller.actions.edit('main.tex', 'Original paragraph.', { from: 0, to: 0 }, '{}', 0)
    expect(controller.state.getSnapshot().buffers['main.tex']!.saveState).toBe('saving')
    expect(controller.hasUnsaved).toBe(true)
    await controller.actions.close('main.tex')
    expect(controller.state.getSnapshot().error).toBe('closeSaving')
    expect(controller.state.getSnapshot().buffers['main.tex']!.text).toBe('Original paragraph.')
    finish?.()
    await saving
    expect(disk().text).toBe('Pending edit.')
    expect(controller.state.getSnapshot().buffers['main.tex']!.saveState).toBe('dirty')
    expect(controller.hasUnsaved).toBe(true)
    await vi.advanceTimersByTimeAsync(1001)
    expect(disk().text).toBe('Original paragraph.')
    expect(controller.hasUnsaved).toBe(false)
    await controller.actions.close('main.tex')
    expect(controller.state.getSnapshot().buffers['main.tex']).toBeUndefined()
  })

  it('recovers the same selection action after a transient status failure', async () => {
    vi.useFakeTimers()
    const { controller, io } = setup()
    io.request = vi.fn(async () => ({ actionId: 'pending-action', state: 'generating' as const }))
    await propose(controller)
    io.getAction = vi.fn().mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce({
      actionId: 'pending-action', state: 'proposed',
      proposal: { replacement: 'Recovered suggestion.', explanation: '', base: controller.state.getSnapshot().selection! },
    })
    expect(controller.hasPendingAction).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(controller.state.getSnapshot().action).toMatchObject({ actionId: 'pending-action', state: 'generating', pollError: 'connection lost' })
    await controller.actions.ask()
    expect(io.request).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(controller.state.getSnapshot().action).toMatchObject({ actionId: 'pending-action', state: 'proposed' })
    expect(controller.state.getSnapshot().action?.pollError).toBeUndefined()
    expect(io.getAction).toHaveBeenNthCalledWith(2, sessionId, 'pending-action')
    controller.actions.discard()
    expect(controller.hasPendingAction).toBe(false)
  })

  it('keeps polling a running job after a transient status failure', async () => {
    vi.useFakeTimers()
    const { controller, io } = setup()
    const job = { id: 'pending-job', state: 'running' as const, kind: 'python', path: 'sample.py', output: '', diagnostics: [] }
    io.start = vi.fn(async () => job)
    io.status = vi.fn().mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce({ ...job, state: 'succeeded', output: 'done' })
    await controller.actions.run({ kind: 'python', path: 'sample.py' })
    await vi.advanceTimersByTimeAsync(600)
    expect(controller.state.getSnapshot().job).toMatchObject({ id: 'pending-job', state: 'running', pollError: 'connection lost' })
    await vi.advanceTimersByTimeAsync(1200)
    expect(controller.state.getSnapshot().job).toMatchObject({ id: 'pending-job', state: 'succeeded', output: 'done' })
    expect(controller.state.getSnapshot().job?.pollError).toBeUndefined()
    expect(io.start).toHaveBeenCalledTimes(1)
  })

  it('restores a running Host job with its original id and can stop it', async () => {
    vi.useFakeTimers()
    const { controller, io } = setup()
    const job = { id: 'restored-job', state: 'running' as const, kind: 'latex', path: 'main.tex', output: 'building', diagnostics: [] }
    io.current = vi.fn(async () => job)
    io.stop = vi.fn(async () => ({ ...job, state: 'cancelled' as const }))
    controller.actions.setMainFile('chosen-main.tex')
    await controller.restoreJob()
    expect(controller.state.getSnapshot().job?.id).toBe('restored-job')
    expect(controller.state.getSnapshot().mainFile).toBe('chosen-main.tex')
    await controller.actions.stop()
    expect(io.stop).toHaveBeenCalledWith(sessionId, 'restored-job')
    expect(controller.state.getSnapshot().job?.state).toBe('cancelled')
  })

  it('releases a vanished Host job without retrying its unavailable id forever', async () => {
    vi.useFakeTimers()
    const { controller, io } = setup()
    const job = { id: 'vanished-job', state: 'running' as const, kind: 'python', path: 'sample.py', output: 'last output', diagnostics: [] }
    io.start = async () => job
    io.current = vi.fn(async () => null)
    io.status = vi.fn().mockRejectedValue(Object.assign(new Error('job unavailable'), {
      code: 'workbench/unavailable', details: { reason: 'job-unavailable' },
    }))
    await controller.actions.run({ kind: 'python', path: 'sample.py' })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(controller.state.getSnapshot().job).toMatchObject({ id: 'vanished-job', state: 'failed', output: 'last output', error: 'jobUnavailable' })
    expect(io.status).toHaveBeenCalledTimes(1)
    expect(io.current).toHaveBeenCalledTimes(1)
  })

  it('never locates a failed diagnostic or SyncTeX open in the previous file', async () => {
    const { controller, io } = setup()
    await controller.actions.open('main.tex')
    io.read = async () => { throw new Error('missing target') }
    await controller.actions.locateDiagnostic({ path: 'missing.tex', line: 2, severity: 'error', message: 'diagnostic' })
    expect(activePath(controller.state.getSnapshot())).toBe('main.tex')
    expect(controller.state.getSnapshot().sourceTarget).toBeNull()
    controller.actions.setMainFile('main.tex')
    io.synctexReverse = vi.fn(async () => ({ path: 'missing.tex', line: 3, column: 1 }))
    await controller.actions.locateSource(1, 0, 0)
    expect(io.synctexReverse).toHaveBeenCalledWith(sessionId, 'main.tex', 1, 0, 0)
    expect(activePath(controller.state.getSnapshot())).toBe('main.tex')
    expect(controller.state.getSnapshot().sourceTarget).toBeNull()
  })

  it('preserves Windows line endings when saving display-normalized text', async () => {
    const { controller, setDisk, disk } = setup()
    setDisk({ text: 'First line.\r\nSecond line.\r\n' })
    await controller.actions.open('main.tex')
    expect(controller.state.getSnapshot().buffers['main.tex']!.text).toBe('First line.\nSecond line.\n')
    controller.actions.edit('main.tex', 'First line.\nRevised line.\n', { from: 0, to: 0 }, '{}', 0)
    await controller.actions.save()
    expect(disk().text).toBe('First line.\r\nRevised line.\r\n')
  })

  it('requires a fresh selection before requesting edits from changed text', async () => {
    const { controller, io } = setup()
    io.request = vi.fn(io.request)
    await propose(controller)
    controller.actions.refine()
    expect(controller.state.getSnapshot().instruction).toBe('')
    controller.actions.setInstruction('Continue revising this paragraph.')
    controller.actions.edit('main.tex', 'A later manual revision.', { from: 0, to: 0 }, '{}', 0)
    await controller.actions.ask()
    expect(io.request).toHaveBeenCalledTimes(1)
    expect(controller.state.getSnapshot().action?.error).toBe('staleProposal')
  })

  it('does not replace a dirty buffer when the same file is opened through a path alias', async () => {
    const { controller } = setup()
    await controller.actions.open('main.tex')
    controller.actions.edit('main.tex', 'My unsaved local text.', { from: 0, to: 0 }, '{}', 0)
    await controller.actions.open('./main.tex')
    expect(controller.state.getSnapshot().buffers['main.tex']!.text).toBe('My unsaved local text.')
    expect(activePath(controller.state.getSnapshot())).toBe('main.tex')
  })
})

describe('workbench recovery and source identity', () => {
  it('keeps untouched BOM, mixed line endings and Unicode bytes when a later word changes', async () => {
    const { controller, setDisk, disk, save } = setup()
    setDisk({ text: '\uFEFF标题 🦕\r\nalpha\nunchanged\r\nomega\n' })
    await controller.actions.open('main.tex')
    await controller.actions.save()
    expect(save).not.toHaveBeenCalled()
    const file = controller.state.getSnapshot().buffers['main.tex']!
    controller.actions.edit(file.path, file.text.replace('omega', '最后 omega'), file.selection, '{}', 0)
    await controller.actions.save()
    expect(disk().text).toBe('\uFEFF标题 🦕\r\nalpha\nunchanged\r\n最后 omega\n')
  })

  it('restores the complete scene automatically and retains a draft after an external conflict', async () => {
    const { persistence } = memoryScenes()
    try {
      const { controller, io, setDisk, disk } = setup(persistence)
      await controller.actions.open('main.tex')
      controller.actions.edit('main.tex', 'Local unfinished draft.', { from: 0, to: 5 }, '{}', 15)
      controller.checkpoint()
      await controller.dispose()
      setDisk({ text: 'Changed outside after exit.', version: 'disk-2' })
      const restored = new WorkbenchController(sessionId, io, key => key, 1000, persistence)
      controllers.push(restored)
      await restored.actions.list('.')
      expect(restored.state.getSnapshot().restoring).toBe(false)
      expect(restored.state.getSnapshot().buffers['main.tex']).toMatchObject({ text: 'Local unfinished draft.', saveState: 'conflict', external: { text: 'Changed outside after exit.' } })
      await expect(restored.actions.save()).rejects.toThrow('conflict')
      expect(disk().text).toBe('Changed outside after exit.')
    } finally { vi.unstubAllGlobals() }
  })

  it('clears old workspace buffers and rejects a late file response when the same Session changes root', async () => {
    const { controller, io } = setup()
    await controller.actions.open('main.tex')
    let finish: ((value: FileSnapshot) => void) | undefined
    io.read = () => new Promise((resolve) => { finish = resolve })
    const pending = controller.actions.open('late.tex')
    io.list = async () => ({ workspaceRoot: '/second', path: '.', entries: [], truncated: false })
    await controller.actions.list('.')
    finish!({ path: 'late.tex', absolutePath: '/fixture/late.tex', version: 'old', text: 'late source', bytes: 11 })
    await pending
    expect(controller.state.getSnapshot().workspaceRoot).toBe('/second')
    expect(controller.state.getSnapshot().buffers).toEqual({})
    expect(controller.state.getSnapshot().selection).toBeNull()
  })

  it('routes known preview files without decoding them as source and gives an explicit unsupported binary error', async () => {
    const { controller, io } = setup()
    const read = vi.spyOn(io, 'read')
    io.stat = async (_session, path) => ({ path, absolutePath: '/fixture/' + path, version: '1' })
    await controller.actions.open('figure.pdf')
    await controller.actions.open('notes.docx')
    expect(io.preview).toHaveBeenCalledWith(sessionId, 'figure.pdf')
    expect(io.preview).not.toHaveBeenCalledWith(sessionId, 'notes.docx')
    expect(controller.state.getSnapshot().error).toBe('wordUnavailable')
    await controller.actions.open('archive.zip')
    expect(read).not.toHaveBeenCalled()
    expect(controller.state.getSnapshot().error).toBe('unsupportedFile')
  })

  it('blocks old PDF navigation after local edits before issuing any SyncTeX request', async () => {
    const { controller, io } = setup()
    const forward = vi.spyOn(io, 'synctexForward')
    const reverse = vi.spyOn(io, 'synctexReverse')
    await controller.actions.open('main.tex')
    controller.actions.edit('main.tex', 'Inserted paragraph.\nOriginal paragraph.', { from: 0, to: 0 }, '{}', 0)
    await controller.actions.locatePdf()
    await controller.actions.locateSource(1, 5, 5)
    expect(forward).not.toHaveBeenCalled()
    expect(reverse).not.toHaveBeenCalled()
    expect(controller.state.getSnapshot().error).toBe('pdfNeedsCompile')
  })

  it('uses the captured insertion target after a picker moves the caret and rejects later document changes', async () => {
    const { controller, setDisk, save } = setup()
    const text = '\\documentclass{article}\n\\begin{document}\nFirst paragraph.\n\nSecond paragraph.\n\\end{document}\n'
    setDisk({ text, bytes: text.length })
    await controller.actions.list('.')
    await controller.actions.open('main.tex')
    const caret = text.indexOf('First paragraph.') + 5
    controller.actions.edit('main.tex', text, { from: caret, to: caret }, '{}', 0, 'visual')
    const initial = controller.state.getSnapshot()
    const target = { path: 'main.tex', workspaceRoot: initial.workspaceRoot,
      revision: initial.buffers['main.tex']!.revision, selection: { from: caret, to: caret } }
    controller.actions.edit('main.tex', text, { from: 0, to: 0 }, '{}', 0, 'visual')
    controller.actions.prepareInsertion('figure', 'figures/workbench/imported-12345678.png', target)
    const selection = controller.state.getSnapshot().selection
    expect(selection).toMatchObject({ objectKind: 'insertion', selectedText: '',
      assetPaths: ['figures/workbench/imported-12345678.png'] })
    expect(selection!.from).toBe(text.indexOf('First paragraph.') + 'First paragraph.'.length)
    expect(selection!.to).toBe(selection!.from)
    expect(save).not.toHaveBeenCalled()
    controller.actions.clearSelection()
    const newer = text.replace('Second paragraph.', 'Second paragraph with a manual change.')
    controller.actions.edit('main.tex', newer, { from: caret, to: caret }, '{}', 0, 'visual')
    controller.actions.prepareInsertion('figure', 'figures/workbench/imported-12345678.png', target)
    expect(controller.state.getSnapshot().selection).toBeNull()
    expect(controller.state.getSnapshot().error).toBe('insertionTargetChanged')
    expect(controller.state.getSnapshot().buffers['main.tex']!.text).toBe(newer)
  })

})


/** Two real buffer identities, with version-checked I/O kept independent for the affected workflows. */
function twoBoards(persistence?: WorkbenchPersistence) {
  const fixture = setup(persistence)
  const files: Record<string, FileSnapshot> = Object.fromEntries(['main.tex', 'main.py', 'notes.txt', 'second.py'].map(path => [path,
    { path, absolutePath: '/fixture/' + path, text: path === 'main.tex' ? 'Original paragraph.' : 'print(1)\n', version: '1', bytes: 19 }]))
  fixture.io.read = async (_session, path) => {
    const file = files[path.replace(/^\.\//u, '')]
    if (file === undefined) throw new Error('Missing fixture: ' + path)
    return file
  }
  fixture.io.stat = fixture.io.read
  fixture.io.save = vi.fn(async (_session, request) => {
    const current = files[request.path]
    if (request.version !== null && current?.version !== request.version) throw new Error('version conflict')
    const file = { path: request.path, absolutePath: '/fixture/' + request.path, text: request.text,
      version: (current?.version ?? '0') + '+1', bytes: request.text.length }
    files[request.path] = file
    return file
  })
  return { ...fixture, files }
}

describe('independent writing and development boards', () => {
  it('switches current files and saves without crossing board contents, views or editing state', async () => {
    vi.useFakeTimers()
    const { controller, io, files } = twoBoards()
    const a = controller.actions
    await a.open('main.tex')
    a.setPane('source')
    a.edit('main.tex', 'Writing draft.', { from: 2, to: 6 }, 'writing-undo', 37, 'source')
    await a.open('main.py')
    a.edit('main.py', 'print(2)\n', { from: 6, to: 7 }, 'code-undo', 84)
    expect(activeBuffer(controller.state.getSnapshot())?.path).toBe('main.py')
    await a.save()
    expect(files['main.py']?.text).toBe('print(2)\n')
    expect(files['main.tex']?.text).toBe('Original paragraph.')
    a.setMode('writing')
    expect(activeBuffer(controller.state.getSnapshot())).toMatchObject({ path: 'main.tex', text: 'Writing draft.', editorState: 'writing-undo', scrollTop: 37, selection: { from: 2, to: 6 } })
    expect(activePane(controller.state.getSnapshot())).toBe('source')
    await a.saveAs('copy.tex')
    expect(files['copy.tex']?.text).toBe('Writing draft.')
    expect(controller.state.getSnapshot().activePaths.development).toBe('main.py')
    a.setMode('development')
    await a.open('second.py')
    await a.close('second.py')
    expect(activePath(controller.state.getSnapshot())).toBe('main.py')
    await a.close('main.py')
    expect(activePath(controller.state.getSnapshot())).toBeNull()
    expect(controller.state.getSnapshot().activePaths.writing).toBe('copy.tex')
    a.setMode('writing')
    await a.open('main.tex')
    await a.save()
    expect(files['main.tex']?.text).toBe('Writing draft.')
    expect(io.save).toHaveBeenCalledTimes(3)
  })

  it('uses the same file ownership for chat opens, path aliases and proposal navigation', async () => {
    vi.useFakeTimers()
    const { controller } = twoBoards()
    const a = controller.actions
    await a.open('main.tex')
    a.edit('main.tex', 'Original paragraph.', { from: 0, to: 8 }, '{}', 0)
    a.select('assist')
    a.setInstruction('Improve')
    await a.ask()
    controller.observeConversation({ open: { seq: 1, path: 'main.py', mode: 'writing' }, prepared: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(controller.state.getSnapshot().mode).toBe('development')
    expect(controller.state.getSnapshot().activePaths).toEqual({ writing: 'main.tex', development: 'main.py' })
    a.locateSelection()
    expect(controller.state.getSnapshot().mode).toBe('writing')
    expect(activePath(controller.state.getSnapshot())).toBe('main.tex')
    await a.open('notes.txt')
    expect(controller.state.getSnapshot().buffers['notes.txt']?.mode).toBe('writing')
    a.setMode('development')
    await a.open('./notes.txt')
    expect(controller.state.getSnapshot().mode).toBe('writing')
    expect(Object.keys(controller.state.getSnapshot().buffers).filter(path => path.endsWith('notes.txt'))).toHaveLength(1)
  })

  it('restores outstanding drafts to their separate boards without writing either draft to disk', async () => {
    vi.useFakeTimers()
    const { persistence } = memoryScenes()
    try {
      const { controller, io, files } = twoBoards(persistence)
      await controller.actions.open('main.tex')
      controller.actions.edit('main.tex', 'Writing draft.', { from: 1, to: 4 }, '{}', 12)
      controller.actions.setPane('source')
      await controller.actions.open('main.py')
      controller.actions.edit('main.py', 'print(3)\n', { from: 2, to: 5 }, '{}', 28)
      controller.checkpoint()
      await controller.dispose()
      const restored = new WorkbenchController(sessionId, io, key => key, 1000, persistence)
      controllers.push(restored)
      await restored.actions.list('.')
      expect(restored.state.getSnapshot().activePaths).toEqual({ writing: 'main.tex', development: 'main.py' })
      expect(activeBuffer(restored.state.getSnapshot())).toMatchObject({ mode: 'development', text: 'print(3)\n', scrollTop: 28 })
      restored.actions.setMode('writing')
      expect(activeBuffer(restored.state.getSnapshot())).toMatchObject({ mode: 'writing', text: 'Writing draft.', scrollTop: 12 })
      expect(activePane(restored.state.getSnapshot())).toBe('source')
      expect(files['main.tex']?.text).toBe('Original paragraph.')
      expect(files['main.py']?.text).toBe('print(1)\n')
    } finally { vi.unstubAllGlobals() }
  })
})

describe('complete restart scenes', () => {

  it('publishes only the restored active file to its original session, without model or background draft injection', async () => {
    vi.useFakeTimers()
    const { persistence } = memoryScenes()
    const { controller, io } = twoBoards(persistence)
    const request = vi.spyOn(io, 'request')
    await controller.actions.open('main.tex')
    controller.actions.edit('main.tex', 'PRIVATE_BACKGROUND_DRAFT', { from: 0, to: 0 }, '{}', 0)
    await controller.actions.open('main.py')
    controller.actions.edit('main.py', 'CURRENT_SESSION_A', { from: 0, to: 0 }, '{}', 0)
    await controller.dispose()
    const otherId = 'other-restored-session' as SessionId
    const other = new WorkbenchController(otherId, io, key => key, 1000, persistence)
    controllers.push(other)
    await other.actions.open('main.py')
    other.actions.edit('main.py', 'PRIVATE_SESSION_B', { from: 0, to: 0 }, '{}', 0)
    await other.dispose()
    vi.mocked(io.publishEditor).mockClear()
    const restored = new WorkbenchController(sessionId, io, key => key, 1000, persistence)
    controllers.push(restored)
    await restored.actions.list('.')
    await vi.waitFor(() => expect(io.publishEditor).toHaveBeenCalledWith(expect.objectContaining({
      sessionId, context: expect.objectContaining({ path: 'main.py', text: 'CURRENT_SESSION_A' }),
    })))
    const published = JSON.stringify(vi.mocked(io.publishEditor).mock.calls)
    expect(published).not.toContain('PRIVATE_BACKGROUND_DRAFT')
    expect(published).not.toContain('PRIVATE_SESSION_B')
    expect(request).not.toHaveBeenCalled()
  })



  it('checkpoints continuous editing without waiting for an idle gap', async () => {
    vi.useFakeTimers()
    const { persistence, records } = memoryScenes()
    const { controller } = twoBoards(persistence)
    await controller.actions.open('main.py')
    for (let index = 0; index < 8; index++) {
      const text = 'continuous-' + index
      controller.actions.edit('main.py', text, { from: text.length, to: text.length }, '{}', 0)
      await vi.advanceTimersByTimeAsync(50)
    }
    const record = records.get(workbenchStateKey(sessionId, '/fixture'))!
    expect(record.buffers.find(file => file.path === 'main.py')?.draft?.text).toBe('continuous-5')
    await vi.advanceTimersByTimeAsync(50)
    expect(records.get(workbenchStateKey(sessionId, '/fixture'))!.buffers[0]?.draft?.text).toBe('continuous-7')
  })


  it('restores clean tabs, board ownership, reading positions and a collapsed chat without opening a model request', async () => {
    vi.useFakeTimers()
    const { persistence } = memoryScenes()
    const { controller, io } = twoBoards(persistence)
    const request = vi.spyOn(io, 'request')
    await controller.actions.open('main.tex')
    controller.actions.setPane('source')
    controller.actions.edit('main.tex', 'Original paragraph.', { from: 2, to: 6 }, '{}', 43)
    await controller.actions.open('notes.txt')
    await controller.actions.open('main.py')
    controller.actions.setMode('chat')
    controller.actions.setFocus('chat')
    controller.checkpoint()
    await controller.dispose()
    const restored = new WorkbenchController(sessionId, io, key => key, 1000, persistence)
    controllers.push(restored)
    await restored.actions.list('.')
    const state = restored.state.getSnapshot()
    expect(Object.keys(state.buffers)).toEqual(['main.tex', 'notes.txt', 'main.py'])
    expect(state.buffers['notes.txt']?.mode).toBe('writing')
    expect(Object.values(state.buffers).every(file => file.unavailable === false)).toBe(true)
    expect(state.buffers['main.tex']).toMatchObject({ selection: { from: 2, to: 6 }, scrollTop: 43, pane: 'source' })
    expect(state).toMatchObject({ mode: 'chat', focus: 'chat', activePaths: { writing: 'notes.txt', development: 'main.py' } })
    await vi.advanceTimersByTimeAsync(2000)
    expect(io.save).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps different drafts of the same path isolated by original Session and retains unvisited scenes', async () => {
    vi.useFakeTimers()
    const { persistence, records } = memoryScenes()
    const { controller, io } = twoBoards(persistence)
    await controller.actions.open('main.tex')
    controller.actions.edit('main.tex', 'FIRST private draft', { from: 0, to: 5 }, '{}', 20)
    controller.checkpoint()
    await controller.dispose()
    const secondId = 'second-session' as SessionId
    const second = new WorkbenchController(secondId, io, key => key, 1000, persistence)
    controllers.push(second)
    await second.actions.open('main.tex')
    second.actions.edit('main.tex', 'SECOND private draft', { from: 1, to: 3 }, '{}', 40)
    second.checkpoint()
    await second.dispose()
    const firstRecord = structuredClone(records.get(workbenchStateKey(sessionId, '/fixture')))
    const visible = new WorkbenchController(secondId, io, key => key, 1000, persistence)
    controllers.push(visible)
    await visible.actions.list('.')
    expect(activeBuffer(visible.state.getSnapshot())?.text).toBe('SECOND private draft')
    await visible.dispose()
    expect(records.get(workbenchStateKey(sessionId, '/fixture'))).toEqual(firstRecord)
    const otherRoot = new WorkbenchController(secondId, { ...io, list: async () => ({ workspaceRoot: '/other', path: '.', entries: [], truncated: false }) }, key => key, 1000, persistence)
    controllers.push(otherRoot)
    await otherRoot.actions.list('.')
    expect(otherRoot.state.getSnapshot().buffers).toEqual({})
  })

  it('retains an unavailable file and draft through another restart, then retries without writing it', async () => {
    vi.useFakeTimers()
    const { persistence } = memoryScenes()
    const { controller, io, files } = twoBoards(persistence)
    await controller.actions.open('main.tex')
    controller.actions.edit('main.tex', 'KEEP THIS DRAFT', { from: 2, to: 4 }, '{}', 30)
    controller.checkpoint()
    await controller.dispose()
    const original = files['main.tex']!
    delete files['main.tex']
    const restored = new WorkbenchController(sessionId, io, key => key, 1000, persistence)
    controllers.push(restored)
    await restored.actions.list('.')
    expect(activeBuffer(restored.state.getSnapshot())).toMatchObject({ unavailable: true, text: 'KEEP THIS DRAFT' })
    await expect(restored.actions.save()).rejects.toThrow('stateFileUnavailable')
    restored.checkpoint()
    await restored.dispose()
    files['main.tex'] = original
    const restarted = new WorkbenchController(sessionId, io, key => key, 1000, persistence)
    controllers.push(restarted)
    await restarted.actions.list('.')
    expect(activeBuffer(restarted.state.getSnapshot())).toMatchObject({ unavailable: false, text: 'KEEP THIS DRAFT', saveState: 'dirty' })
    await vi.advanceTimersByTimeAsync(2000)
    expect(io.save).not.toHaveBeenCalled()
  })

  it('does not reopen a user-closed tab or steal the newer file focus when a restored read arrives late', async () => {
    const { persistence } = memoryScenes()
    const { controller, io } = twoBoards(persistence)
    await controller.actions.open('main.tex')
    controller.checkpoint()
    await controller.dispose()
    const read = io.read
    const pending = Promise.withResolvers<FileSnapshot>()
    io.read = (id, path) => path === 'main.tex' ? pending.promise : read(id, path)
    const restored = new WorkbenchController(sessionId, io, key => key, 1000, persistence)
    controllers.push(restored)
    const loading = restored.actions.list('.')
    await vi.waitFor(() => { expect(restored.state.getSnapshot().buffers['main.tex']).toBeDefined() })
    await restored.actions.close('main.tex')
    const opening = restored.actions.open('main.py')
    pending.resolve({ path: 'main.tex', absolutePath: '/fixture/main.tex', text: 'Late', version: '1', bytes: 4 })
    await Promise.all([loading, opening])
    expect(restored.state.getSnapshot().buffers['main.tex']).toBeUndefined()
    expect(activePath(restored.state.getSnapshot())).toBe('main.py')
  })

  it('keeps corrupt persisted data protected from automatic empty-state writes', async () => {
    const persistence: WorkbenchPersistence = {
      load: async () => { throw new Error('invalid-record') }, stage: vi.fn(), flush: async () => undefined,
    }
    const { controller } = twoBoards(persistence)
    await controller.actions.list('.')
    expect(controller.state.getSnapshot().recoveryError).toContain('stateSaveFailed')
    await controller.actions.open('main.py')
    controller.checkpoint()
    expect(persistence.stage).not.toHaveBeenCalled()
    expect(controller.state.getSnapshot().recoveryError).toContain('invalid-record')
  })

  it('captures more than twelve files and a draft exceeding the former metadata limit without truncation', async () => {
    const { controller, io } = twoBoards()
    io.read = async (_id, path) => ({ path, absolutePath: '/fixture/' + path, text: 'base', version: '1', bytes: 4 })
    for (let index = 0; index < 14; index++) await controller.actions.open('file-' + index + '.py')
    const draft = '研究 draft '.repeat(12000)
    controller.actions.edit('file-13.py', draft, { from: 0, to: 2 }, '{}', 20)
    const snapshot = captureWorkbench(sessionId, controller.state.getSnapshot())
    expect(snapshot.buffers).toHaveLength(14)
    expect(snapshot.buffers[13]?.draft?.text).toBe(draft)
  })
})

describe('Word original save isolation', () => {
  it.each(['latex', 'python'] as const)('keeps a dirty Word draft out of %s preflight saves', async (kind) => {
    vi.useFakeTimers()
    const { controller, io, files } = twoBoards()
    const native: WordSnapshot = {
      id: 'a'.repeat(32), checkpoint: '1-' + 'b'.repeat(32), checkpointHash: 'c'.repeat(64),
      path: 'paper.docx', absolutePath: '/fixture/paper.docx', workspaceRoot: '/fixture',
      revision: 1, savedRevision: 0, checkpointTime: 1, diskVersion: 'original',
      projection: { text: 'Word draft\n', styles: ['Normal'], canUndo: true, canRedo: false, blocks: [] },
    }
    files['paper.docx'] = { path: native.path, absolutePath: native.absolutePath, text: '', version: 'original', bytes: 2000 }
    const saveWord = vi.fn(async () => ({ ...native, savedRevision: native.revision }))
    io.word = {
      open: async () => native, save: saveWord, commit: vi.fn(), resources: vi.fn(), mutate: vi.fn(), proof: async () => null,
      stop: async () => {}, close: async () => {},
    }
    const start = vi.fn(async () => ({
      id: 'job', state: 'succeeded' as const, kind, path: kind === 'latex' ? 'main.tex' : 'main.py',
      output: '', diagnostics: [],
    }))
    io.start = start
    await controller.actions.open('paper.docx')
    const target = kind === 'latex' ? 'main.tex' : 'main.py'
    await controller.actions.open(target)
    controller.actions.edit(target, 'Updated build input', { from: 0, to: 0 }, '{}', 0)
    await controller.actions.run({ kind, path: target })
    expect(start).toHaveBeenCalledOnce()
    expect(files[target]?.text).toBe('Updated build input')
    expect(saveWord).not.toHaveBeenCalled()
    expect(controller.state.getSnapshot().buffers['paper.docx']).toMatchObject({
      text: 'Word draft\n', saveState: 'dirty', word: { savedRevision: 0, revision: 1 },
    })
    await controller.actions.save('paper.docx')
    expect(saveWord).toHaveBeenCalledOnce()
    expect(controller.state.getSnapshot().buffers['paper.docx']?.saveState).toBe('clean')
  })
})


describe('explicit document close choices', () => {
  function native(text = 'Original\n', revision = 1): WordSnapshot {
    return { id: 'a'.repeat(32), checkpoint: '1-' + 'b'.repeat(32), checkpointHash: 'c'.repeat(64),
      path: 'paper.docx', absolutePath: '/fixture/paper.docx', workspaceRoot: '/fixture',
      revision, savedRevision: 0, checkpointTime: 1, diskVersion: 'original',
      projection: { text, styles: ['Normal'], canUndo: true, canRedo: false, blocks: [] } }
  }
  it.each([0, 1])('uses DOCX revision %i rather than projection differences for the close decision', async (revision) => {
    const { controller, io } = setup()
    const value = { ...native('Extractor text\n', revision), engine: 'ooxml' as const }
    const close = vi.fn(async () => {})
    io.word = { open: async () => value, save: vi.fn(), close, mutate: vi.fn(), proof: async () => null, stop: async () => {} }
    await controller.actions.open('paper.docx')
    const state = controller.state.getSnapshot(), file = state.buffers['paper.docx']
    if (file?.kind !== 'word') throw new Error('Expected DOCX buffer')
    controller.state.set({ ...state, buffers: { ...state.buffers, [file.path]: {
      ...file, text: revision === 0 ? 'Editor projection\n' : file.savedText,
    } } })
    expect(controller.hasUnsaved).toBe(revision !== 0)
    controller.actions.close('paper.docx')
    await vi.waitFor(() => {
      expect(controller.state.getSnapshot().closePrompt).toBe(revision === 0 ? null : 'paper.docx')
      expect(close).toHaveBeenCalledTimes(revision === 0 ? 1 : 0)
      expect(controller.state.getSnapshot().buffers['paper.docx'] === undefined).toBe(revision === 0)
    })
  })
  it.each(['save', 'discard', 'cancel'] as const)('honors %s after a Word close save fails and retains its durable scene', async (decision) => {
    const memory = memoryScenes(), { controller, io } = setup(memory.persistence)
    const value = native(), save = vi.fn(async () => ({ ...value, savedRevision: value.revision })).mockRejectedValueOnce(new Error('Original locked')), close = vi.fn(async () => {})
    io.word = { open: async () => value, save, close, commit: vi.fn(), resources: vi.fn(),
      mutate: vi.fn(), proof: async () => null, stop: async () => {} }
    await controller.actions.open('paper.docx')
    await controller.actions.close('paper.docx')
    expect(controller.state.getSnapshot().closePrompt).toBe('paper.docx')
    expect(close).not.toHaveBeenCalled()
    await controller.actions.close('paper.docx', decision)
    if (decision === 'cancel') {
      expect(controller.state.getSnapshot().buffers['paper.docx']).toBeDefined()
      expect(save).toHaveBeenCalledTimes(1); expect(close).not.toHaveBeenCalled()
    } else {
      expect(controller.state.getSnapshot().buffers['paper.docx']).toBeUndefined()
      expect(close).toHaveBeenCalledWith(sessionId, value.id, decision === 'discard')
      expect(save).toHaveBeenCalledTimes(decision === 'save' ? 2 : 1)
      const scene = await memory.persistence.load(sessionId, '/fixture')
      expect(scene?.buffers.some(buffer => buffer.path === 'paper.docx')).toBe(false)
    }
  })
  it('does not close a file after a failed explicit save', async () => {
    const { controller, io } = setup()
    io.word = { open: async () => native(), save: vi.fn(async () => { throw new Error('Disk is occupied') }),
      close: vi.fn(), commit: vi.fn(), resources: vi.fn(), mutate: vi.fn(), proof: async () => null, stop: async () => {} }
    await controller.actions.open('paper.docx')
    await controller.actions.close('paper.docx')
    await controller.actions.close('paper.docx', 'save')
    expect(controller.state.getSnapshot().buffers['paper.docx']).toBeDefined()
    expect(io.word.close).not.toHaveBeenCalled()
    expect(controller.state.getSnapshot().closePrompt).toBe('paper.docx')
  })
  it('discards retained pending Word bytes without sending them to the native worker', async () => {
    vi.useFakeTimers()
    const { controller, io } = setup(), value = native('Original\n', 0)
    io.word = { open: async () => value, save: vi.fn(), close: vi.fn(async () => {}),
      mutate: vi.fn(), proof: async () => null, stop: async () => {} }
    await controller.actions.open('paper.docx')
    const state = controller.state.getSnapshot(), file = state.buffers['paper.docx']
    if (file?.kind !== 'word') throw new Error('Expected DOCX buffer')
    controller.state.set({ ...state, buffers: { ...state.buffers, [file.path]: {
      ...file, text: 'Unsent\n', pendingWord: { text: 'Unsent\n', document: 'docx:retained-bytes' },
      wordSync: 'pending', saveState: 'dirty',
    } } })
    await controller.actions.close('paper.docx', 'discard')
    await vi.advanceTimersByTimeAsync(300)
    expect(io.word.mutate).not.toHaveBeenCalled()
    expect(controller.state.getSnapshot().buffers['paper.docx']).toBeUndefined()
  })
  it('keeps the draft when scene removal cannot be durably committed', async () => {
    const memory = memoryScenes(), { controller, io } = setup(memory.persistence), value = native()
    io.word = { open: async () => value, save: vi.fn(), close: vi.fn(), mutate: vi.fn(), proof: async () => null, stop: async () => {} }
    await controller.actions.open('paper.docx')
    memory.persistence.flush = async () => { throw new Error('quota') }
    await controller.actions.close('paper.docx', 'discard')
    expect(controller.state.getSnapshot().buffers['paper.docx']?.text).toBe(value.projection.text)
    expect(io.word.close).not.toHaveBeenCalled()
    memory.persistence.flush = async () => {}
  })
})


describe('native Word page lifecycle', () => {
  function value(path = 'paper.docx', revision = 0): WordSnapshot {
    const text = 'Unique original text.\n'
    return { id: path, checkpoint: '1-' + 'b'.repeat(32), checkpointHash: 'c'.repeat(64),
      path, absolutePath: '/fixture/' + path, workspaceRoot: '/fixture', revision, savedRevision: 0,
      checkpointTime: 1, diskVersion: 'original',
      projection: { text, styles: ['Normal'], canUndo: false, canRedo: false,
        blocks: [{ id: 'body', kind: 'paragraph', text: text.trimEnd(), from: 0, to: text.length - 1,
          style: 'Normal', level: 0, alignment: 0, spaceBefore: 0, spaceAfter: 0, runs: [] }] } }
  }
  const page = (revision: number) => ({ regions: [], revision, data: new Uint8Array([revision]), version: String(revision).repeat(64), builtAt: '2026-10-27T00:00:00.000Z' })

  it('opens native pages, reuses a current retained page and regenerates only after an edit', async () => {
    const { controller, io } = setup()
    let document = value()
    const proof = vi.fn(async (_s: SessionId, _id: string, revision: number, cached: boolean) => page(cached ? 0 : revision))
    io.word = { open: async () => document, save: vi.fn(), close: vi.fn(), stop: vi.fn(), proof,
      mutate: async () => (document = value('paper.docx', 1)) }
    await controller.actions.open('paper.docx')
    expect(activePane(controller.state.getSnapshot())).toBe('pdf')
    await controller.actions.refreshPdf(true)
    expect(proof).toHaveBeenCalledTimes(1)
    expect(proof.mock.calls[0]?.[3]).toBe(true)
    await controller.actions.refreshPdf(true)
    expect(proof).toHaveBeenCalledTimes(1)
    // A committed revision invalidates the retained proof; editing itself is tested by the live DOCX suite.
    document = value('paper.docx', 1)
    const state = controller.state.getSnapshot(), file = state.buffers['paper.docx']
    if (file?.kind !== 'word') throw new Error('Expected DOCX buffer')
    controller.state.set({ ...state, buffers: { ...state.buffers, [file.path]: {
      ...file, word: document, revision: document.revision, saveState: 'dirty',
    } } })
    await controller.actions.refreshPdf(true)
    expect(proof.mock.calls.map(call => call[3])).toEqual([true, true, false])
    expect(controller.state.getSnapshot().pdf?.sourceVersion).toBe('1')
    expect(io.word!.save).not.toHaveBeenCalled()
    expect({ pane: activePane(controller.state.getSnapshot()), path: controller.state.getSnapshot().pdf?.sourcePath,
      stale: controller.state.getSnapshot().pdfDirty }).toMatchSnapshot('native page identity')
  })

  it('does not replace the active document with a late page from another tab', async () => {
    const { controller, io, setDisk } = setup()
    let finish!: (result: ReturnType<typeof page>) => void
    io.word = { open: async (_id, path) => value(path), save: vi.fn(), close: vi.fn(), stop: vi.fn(), mutate: vi.fn(),
      proof: async (_s, id) => id === 'first.docx' ? new Promise((resolve) => { finish = resolve }) : page(0) }
    setDisk({ path: 'first.docx', absolutePath: '/fixture/first.docx' })
    await controller.actions.open('first.docx')
    const first = controller.actions.refreshPdf()
    await vi.waitFor(() => expect(finish).toBeDefined())
    setDisk({ path: 'second.docx', absolutePath: '/fixture/second.docx' })
    await controller.actions.open('second.docx')
    await controller.actions.refreshPdf()
    finish(page(0))
    await first
    expect(controller.state.getSnapshot().pdf?.sourcePath).toBe('second.docx')
  })

  it('reuses retained native pages when switching between already open Word tabs', async () => {
    const { controller, io, setDisk } = setup()
    const proof = vi.fn(async (_s: SessionId, _id: string, _revision: number, _cached: boolean, _ref: unknown) => page(0))
    io.word = { open: async (_id, path) => value(path), save: vi.fn(), close: vi.fn(), stop: vi.fn(), mutate: vi.fn(), proof }
    for (const path of ['first.docx', 'second.docx']) {
      setDisk({ path, absolutePath: '/fixture/' + path })
      await controller.actions.open(path)
      await controller.actions.refreshPdf(true)
    }
    for (const path of ['first.docx', 'second.docx']) {
      await controller.actions.open(path)
      await controller.actions.refreshPdf(true)
      expect(controller.state.getSnapshot().pdf?.sourcePath).toBe(path)
    }
    expect(proof.mock.calls).toHaveLength(4)
    expect(proof).toHaveBeenCalledWith(sessionId, 'first.docx', 0, true, { revision: 0, version: '0'.repeat(64) })
    expect(proof).toHaveBeenCalledWith(sessionId, 'second.docx', 0, true, { revision: 0, version: '0'.repeat(64) })
    expect(proof.mock.calls.every(call => call.length === 5 && call[3] === true)).toBe(true)
  })

  it('shares one native export between simultaneous refresh requests', async () => {
    const { controller, io } = setup()
    let finish!: (result: ReturnType<typeof page>) => void
    const proof = vi.fn(async () => new Promise<ReturnType<typeof page>>((resolve) => { finish = resolve }))
    io.word = { open: async () => value(), save: vi.fn(), close: vi.fn(), stop: vi.fn(), mutate: vi.fn(), proof }
    await controller.actions.open('paper.docx')
    const first = controller.actions.refreshPdf(), second = controller.actions.refreshPdf()
    await vi.waitFor(() => expect(finish).toBeDefined())
    finish(page(0)); await Promise.all([first, second])
    expect(proof).toHaveBeenCalledTimes(1)
  })

  it('captures current native-page text for assistance and refuses stale pages', async () => {
    const { controller, io } = setup()
    io.word = { open: async () => value(), save: vi.fn(), close: vi.fn(), stop: vi.fn(), mutate: vi.fn(),
      proof: async () => page(0) }
    await controller.actions.open('paper.docx'); await controller.actions.refreshPdf()
    controller.actions.selectPdf('Unique original\ntext.', 1)
    expect(controller.state.getSnapshot()).toMatchObject({ selectionMode: 'assist',
      selection: { path: 'paper.docx', from: 0, to: 21, selectedText: 'Unique original text.', origin: 'visual' } })
    controller.actions.clearSelection()
    const state = controller.state.getSnapshot()
    controller.state.set({ ...state, pdfDirty: true })
    controller.actions.selectPdf('Unique original text.', 1)
    expect(controller.state.getSnapshot().selection).toBeNull()
    expect(controller.state.getSnapshot().error).toBe('wordPageStale')
  })
})


it('keeps assisted creative requests in the ordinary conversation with the published selection', async () => {
  const { controller, io } = setup()
  io.quickEdit = vi.fn(async () => null)
  io.completeQuickEdit = vi.fn(async () => ({ kind: 'success' as const, text: '' }))
  await controller.actions.open('main.tex')
  controller.actions.edit('main.tex', 'Original paragraph.', { from: 0, to: 19 }, '{}', 0)
  controller.actions.select('assist')
  const request = vi.spyOn(io, 'request')
  expect(await controller.submitText('Improve this paragraph.', new AbortController().signal, 'assist-turn', () => {})).toBeNull()
  expect(request).not.toHaveBeenCalled()
  expect(io.publishEditor).toHaveBeenLastCalledWith(expect.objectContaining({
    context: expect.objectContaining({ selection: { from: 0, to: 19 } }),
  }))
})

it('claims a live Agent operation once, saves through the controller, and ignores expired replay', async () => {
  const { controller, io, save, disk } = setup()
  await controller.actions.open('main.tex')
  const file = controller.state.getSnapshot().buffers['main.tex']!
  io.claimAgentOperation = vi.fn(async () => ({ kind: 'prepared' as const, requestId: 'live', path: file.path,
    bufferVersion: String(file.revision), selection: file.selection, selectionKey: '',
    execution: { kind: 'source' as const, edits: [{ from: 0, to: 19, before: 'Original paragraph.', text: 'Verified.' }] },
  }))
  io.completeQuickEdit = vi.fn(async () => ({ kind: 'success' as const, text: 'saved' }))
  const view = { open: null, prepared: null, agentOperation: { requestId: 'live', seq: 1 } }
  controller.observeConversation(view); controller.observeConversation(view)
  await vi.waitFor(() => expect(io.completeQuickEdit).toHaveBeenCalledWith(sessionId, 'live', null))
  expect(io.claimAgentOperation).toHaveBeenCalledTimes(1)
  expect(save).toHaveBeenCalledTimes(1)
  expect(disk().text).toBe('Verified.')
  io.claimAgentOperation = vi.fn(async () => null)
  controller.observeConversation({ ...view, agentOperation: { requestId: 'expired', seq: 2 } })
  await vi.waitFor(() => expect(io.claimAgentOperation).toHaveBeenCalledOnce())
  expect(save).toHaveBeenCalledTimes(1)
})

it.each(['continue', 'edited', 'reattached'] as const)('rebases committed Agent assistance only for its unchanged attachment: %s', async (mode) => {
  const { controller, io, disk } = setup()
  await controller.actions.open('main.tex')
  controller.actions.edit('main.tex', 'Original paragraph.', { from: 0, to: 19 }, '{}', 0)
  controller.actions.select('assist')
  const reference = controller.state.getSnapshot().selection!
  const file = controller.state.getSnapshot().buffers['main.tex']!
  io.claimAgentOperation = vi.fn(async () => ({ kind: 'prepared' as const, requestId: 'continue', path: file.path,
    bufferVersion: String(file.revision), selection: file.selection, selectionKey: '',
    execution: { kind: 'source' as const, edits: [{ from: 0, to: 19, before: 'Original paragraph.', text: 'Verified paragraph.' }] },
  }))
  io.completeQuickEdit = vi.fn(async () => {
    if (mode === 'edited') controller.actions.edit('main.tex', 'Unrelated new text.', { from: 0, to: 19 }, '{}', 0)
    if (mode === 'reattached') controller.actions.select('assist')
    return { kind: 'success' as const, text: 'saved' }
  })
  controller.observeConversation({ open: null, prepared: null, agentOperation: { requestId: 'continue', seq: 1 } })
  await vi.waitFor(() => expect(io.completeQuickEdit).toHaveBeenCalledOnce())
  expect(disk().text).toBe('Verified paragraph.')
  const state = controller.state.getSnapshot()
  if (mode === 'continue') {
    expect(state.selection).toMatchObject({ selectedText: 'Verified paragraph.', bufferVersion: String(state.buffers['main.tex']!.revision) })
    io.quickEdit = vi.fn(async () => null)
    await expect(controller.submitText('Continue editing.', new AbortController().signal, 'next', () => {})).resolves.toBeNull()
    expect(io.quickEdit).toHaveBeenCalledOnce()
  } else if (mode === 'edited') {
    expect(state.selection).toBe(reference)
  } else {
    expect(state.selection).not.toBe(reference)
    expect(state.selection?.bufferVersion).toBe(String(state.buffers['main.tex']!.revision))
  }
})
