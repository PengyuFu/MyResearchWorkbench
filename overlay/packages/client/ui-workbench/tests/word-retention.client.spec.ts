import { describe, expect, it, vi } from 'vitest'
import type { WordRetention } from '@deepseek-ai/dsh-workbench-word/types'
import { WordSceneRetention } from '../src/client/word-retention.ts'
import { captureWorkbench, isWorkbenchRecord } from '../src/client/buffer-persistence.ts'
import { WorkbenchController } from '../src/client/controller.ts'
import type { WorkbenchRecord } from '../src/client/buffer-persistence.ts'
import type { WorkbenchIO } from '../src/client/types.ts'

function scene(sessionId: string, workspaceRoot = 'D:/fixture'): WorkbenchRecord {
  const controller = new WorkbenchController(undefined, {} as WorkbenchIO, key => key)
  return { ...captureWorkbench(sessionId, { ...controller.state.getSnapshot(), workspaceRoot }), buffers: [{
    mode: 'writing', path: 'paper.docx', absolutePath: workspaceRoot + '/paper.docx', diskVersion: 'disk',
    lineEnding: 'lf', revision: 2, selection: { from: 0, to: 0 }, scrollTop: 0, visualScrollTop: 0, pane: 'pdf',
    word: { snapshot: { id: 'a'.repeat(32), checkpoint: '2-' + 'b'.repeat(32), checkpointHash: 'c'.repeat(64),
      path: 'paper.docx', absolutePath: workspaceRoot + '/paper.docx', workspaceRoot, revision: 2,
      savedRevision: 0, checkpointTime: 1, diskVersion: 'disk', projection: {
        text: 'confirmed', blocks: [], styles: [], canUndo: false, canRedo: false } },
    pending: { text: 'unconfirmed', document: '{}' }, proof: { revision: 1, version: 'd'.repeat(64) } },
  }] }
}
const turn = () => new Promise(resolve => setTimeout(resolve, 0))

describe('committed Word scene retention', () => {
  it('includes inactive scopes, pending input bases and stale proof identities', async () => {
    const retain = vi.fn(async (_sessionId: string, _references: WordRetention) => ({ deleted: 0, failures: [] }))
    const report = vi.fn()
    const owner = new WordSceneRetention(retain, report)
    owner.committed([scene('A'), scene('B', 'D:/other'), { ...scene('legacy'), version: 1 }], 1)
    await turn()
    expect(retain).toHaveBeenCalledTimes(2)
    expect(retain.mock.calls[0]).toEqual(['A', { workspaceRoot: 'D:/fixture', documents: [{
      id: 'a'.repeat(32), checkpoints: [{ id: 'a'.repeat(32), checkpoint: '2-' + 'b'.repeat(32),
        checkpointHash: 'c'.repeat(64), revision: 2 }], proofs: [{ revision: 1, version: 'd'.repeat(64) }],
    }] }])
    expect(retain.mock.calls[1]?.[0]).toBe('B')
    expect(report).not.toHaveBeenCalled()
  })
  it('coalesces a busy worker without blocking scene writes or sending obsolete commits', async () => {
    let release!: () => void
    const retain = vi.fn(async (_sessionId: string, _references: WordRetention) => {
      await new Promise<void>((resolve) => { release = resolve })
      return { deleted: 0, failures: [] }
    })
    const owner = new WordSceneRetention(retain, () => {})
    owner.committed([scene('A')], 1)
    owner.committed([scene('obsolete')], 2)
    owner.committed([{ ...scene('closed'), buffers: [] }], 3)
    owner.committed([scene('late')], 2)
    expect(retain).toHaveBeenCalledTimes(1)
    release(); await turn()
    expect(retain).toHaveBeenCalledTimes(2)
    expect(retain.mock.calls[1]).toEqual(['closed', { workspaceRoot: 'D:/fixture', documents: [] }])
    release(); await turn()
  })
  it('reports cleanup failures while continuing independent scopes', async () => {
    const retain = vi.fn().mockRejectedValueOnce(new Error('disconnected')).mockResolvedValueOnce({ deleted: 0, failures: ['owned'] })
    const report = vi.fn(), owner = new WordSceneRetention(retain, report)
    owner.committed([scene('A'), scene('B')], 1)
    await turn()
    expect(report).toHaveBeenCalledTimes(2)
    expect(retain).toHaveBeenCalledTimes(2)
  })
  it('reads legacy records but validates new proof references', () => {
    const current = scene('A')
    expect(current.version).toBe(2)
    expect(isWorkbenchRecord(current)).toBe(true)
    expect(isWorkbenchRecord({ ...current, version: 1 })).toBe(true)
    current.buffers[0]!.word!.proof = { revision: 1, version: 'invalid' }
    expect(isWorkbenchRecord(current)).toBe(false)
  })
})
