/**
 * The shared plan source: it reads on the first consumer, publishes only the
 * Host's answer, keeps the last authoritative snapshot when a write fails, and
 * turns a refused proposal application into the stale flag the preview renders.
 *
 * The source is plain TypeScript, so this suite drives it directly with a
 * scripted Remote face and fake forwarded-event subscriptions.
 */
import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { PlanChangedEvent, PlanSnapshot } from '@deepseek-ai/dsh-personal-plan/client'
import { createPlanSource, type PlanRemote, type PlanViewState } from '../src/client/plan-source.ts'

/** One authoritative snapshot. */
function snapshot(revision: number): PlanSnapshot {
  return { revision, items: [], tasks: [], proposal: null, run: null, updatedAt: `2026-10-21T00:00:0${revision}.000Z` }
}

/** A successful Remote answer. */
function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

/** A refused Remote answer. */
function fail(message: string): { ok: false; error: RemoteError<'gateway/internal'> } {
  return { ok: false, error: new RemoteError('gateway/internal', message, {}) }
}

/** The scripted Host operations. */
function remoteOf(overrides: Partial<PlanRemote> = {}): PlanRemote {
  return {
    snapshot: vi.fn(async () => ok(snapshot(1))),
    addItem: vi.fn(async () => ok(snapshot(2))),
    updateItem: vi.fn(async () => ok(snapshot(2))),
    deleteItem: vi.fn(async () => ok(snapshot(2))),
    setStatus: vi.fn(async () => ok(snapshot(2))),
    reorder: vi.fn(async () => ok(snapshot(2))),
    applyProposal: vi.fn(async () => ok({ applied: true, code: 'ok', snapshot: snapshot(3) })),
    discardProposal: vi.fn(async () => ok(snapshot(2))),
    addTask: vi.fn(async () => ok(snapshot(2))),
    updateTask: vi.fn(async () => ok(snapshot(2))),
    deleteTask: vi.fn(async () => ok(snapshot(2))),
    reorderTasks: vi.fn(async () => ok(snapshot(2))),
    startRun: vi.fn(async () => ok({ started: true, code: 'ok', snapshot: snapshot(4) })),
    stopRun: vi.fn(async () => ok({ stopped: true, code: 'ok', snapshot: snapshot(5) })),
    revealSession: vi.fn(async () => ok({ accepted: true })),
    revealTaskSession: vi.fn(async () => ok({ code: 'ok' })),
    requestPanel: vi.fn(async () => ok({ accepted: true })),
    ...overrides,
  }
}

/**
 * Build a source over scripted dependencies and expose the event drivers.
 * @param overrides - Host operations the case replaces.
 * @returns the source, its dependencies, and the two subscription drivers.
 */
function create(overrides: Partial<PlanRemote> = {}) {
  const remote = remoteOf(overrides)
  const changed = new Set<(payload: PlanChangedEvent) => void>()
  const reset = new Set<() => void>()
  const disposeChanged = vi.fn()
  const disposeReset = vi.fn()
  const onProposal = vi.fn()
  const source = createPlanSource({
    remote,
    subscribeChanged: (listener) => { changed.add(listener); return disposeChanged },
    subscribeReset: (listener) => { reset.add(listener); return disposeReset },
    onProposal,
  })
  return {
    source, remote, onProposal,
    emitChanged: (payload: PlanChangedEvent): void => { for (const listener of [...changed]) listener(payload) },
    emitReset: (): void => { for (const listener of [...reset]) listener() },
    disposeChanged, disposeReset,
  }
}

/** Current view state. */
function stateOf(source: ReturnType<typeof createPlanSource>): PlanViewState {
  return source.hooks.plan.getSnapshot()
}

describe('createPlanSource', () => {
  it('stays idle until the first consumer and then reads once', async () => {
    const { source, remote } = create()
    expect(remote.snapshot).not.toHaveBeenCalled()
    const unsubscribe = source.hooks.plan.subscribe(() => {})
    await vi.waitFor(() => { expect(stateOf(source).status).toBe('ready') })
    expect(remote.snapshot).toHaveBeenCalledTimes(1)
    expect(stateOf(source).snapshot?.revision).toBe(1)
    unsubscribe()
  })

  it('does not read on retry before any consumer arrived', async () => {
    const { source, remote } = create()
    await source.retry()
    expect(remote.snapshot).not.toHaveBeenCalled()
  })

  it('publishes the answer a successful write returns', async () => {
    const { source, remote } = create()
    const unsubscribe = source.hooks.plan.subscribe(() => {})
    await vi.waitFor(() => { expect(stateOf(source).status).toBe('ready') })
    const written = await source.addItem({ title: 'Write report' })
    expect(written).toBe(true)
    expect(remote.addItem).toHaveBeenCalledWith({ title: 'Write report' })
    expect(stateOf(source).snapshot?.revision).toBe(2)
    expect(stateOf(source).saving).toBe(false)
    unsubscribe()
  })

  it('keeps the last authoritative snapshot and reports the failure reason', async () => {
    const { source, remote } = create()
    const unsubscribe = source.hooks.plan.subscribe(() => {})
    await vi.waitFor(() => { expect(stateOf(source).status).toBe('ready') })
    const authoritative = stateOf(source).snapshot
    vi.mocked(remote.addItem).mockResolvedValueOnce(fail('disk full'))
    const written = await source.addItem({ title: 'Write report' })
    expect(written).toBe(false)
    expect(stateOf(source).saveError).toBe('disk full')
    expect(stateOf(source).saving).toBe(false)
    expect(stateOf(source).snapshot).toBe(authoritative)
    unsubscribe()
  })

  it('reports a thrown write as a failure without dropping the snapshot', async () => {
    const { source, remote } = create()
    const unsubscribe = source.hooks.plan.subscribe(() => {})
    await vi.waitFor(() => { expect(stateOf(source).status).toBe('ready') })
    vi.mocked(remote.deleteItem).mockRejectedValueOnce(new Error('connection lost'))
    const deleted = await source.deleteItem('a')
    expect(deleted).toBe(false)
    expect(stateOf(source).saveError).toBe('connection lost')
    expect(stateOf(source).snapshot?.revision).toBe(1)
    unsubscribe()
  })

  it('marks a refused proposal application stale and adopts the returned snapshot', async () => {
    const { source, remote } = create()
    const unsubscribe = source.hooks.plan.subscribe(() => {})
    await vi.waitFor(() => { expect(stateOf(source).status).toBe('ready') })
    vi.mocked(remote.applyProposal).mockResolvedValueOnce(
      ok({ applied: false, code: 'stale', snapshot: snapshot(4) }),
    )
    const applied = await source.applyProposal('proposal-1', ['chg-add'])
    expect(applied).toBe(false)
    expect(remote.applyProposal).toHaveBeenCalledWith({ proposalId: 'proposal-1', changeIds: ['chg-add'] })
    expect(stateOf(source).stale).toBe(true)
    expect(stateOf(source).snapshot?.revision).toBe(4)
    unsubscribe()
  })

  it('applies a kept subset and clears the stale flag', async () => {
    const { source, remote } = create()
    const unsubscribe = source.hooks.plan.subscribe(() => {})
    await vi.waitFor(() => { expect(stateOf(source).status).toBe('ready') })
    const applied = await source.applyProposal('proposal-1', ['chg-add', 'chg-reorder'])
    expect(applied).toBe(true)
    expect(remote.applyProposal).toHaveBeenCalledWith({
      proposalId: 'proposal-1', changeIds: ['chg-add', 'chg-reorder'],
    })
    expect(stateOf(source).stale).toBe(false)
    expect(stateOf(source).snapshot?.revision).toBe(3)
    unsubscribe()
  })

  it('opens the panel on a proposal notification and re-reads every change', async () => {
    const { source, remote, onProposal, emitChanged } = create()
    const unsubscribe = source.hooks.plan.subscribe(() => {})
    await vi.waitFor(() => { expect(stateOf(source).status).toBe('ready') })
    const payload: PlanChangedEvent = { revision: 2, proposalId: 'proposal-1' }
    emitChanged(payload)
    expect(onProposal).toHaveBeenCalledWith(payload)
    await vi.waitFor(() => { expect(remote.snapshot).toHaveBeenCalledTimes(2) })
    unsubscribe()
  })

  it('re-reads a write notification without opening the panel', async () => {
    const { source, remote, onProposal, emitChanged } = create()
    const unsubscribe = source.hooks.plan.subscribe(() => {})
    await vi.waitFor(() => { expect(stateOf(source).status).toBe('ready') })
    emitChanged({ revision: 2, proposalId: null })
    expect(onProposal).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(remote.snapshot).toHaveBeenCalledTimes(2) })
    unsubscribe()
  })

  it('re-reads after a connection reset', async () => {
    const { source, remote, emitReset } = create()
    const unsubscribe = source.hooks.plan.subscribe(() => {})
    await vi.waitFor(() => { expect(stateOf(source).status).toBe('ready') })
    emitReset()
    await vi.waitFor(() => { expect(remote.snapshot).toHaveBeenCalledTimes(2) })
    unsubscribe()
  })

  it('drops both Host subscriptions when the last consumer leaves', async () => {
    const { source, disposeChanged, disposeReset } = create()
    const first = source.hooks.plan.subscribe(() => {})
    const second = source.hooks.plan.subscribe(() => {})
    await vi.waitFor(() => { expect(stateOf(source).status).toBe('ready') })
    first()
    expect(disposeChanged).not.toHaveBeenCalled()
    second()
    expect(disposeChanged).toHaveBeenCalledTimes(1)
    expect(disposeReset).toHaveBeenCalledTimes(1)
  })

  it('subscribes afresh for a new consumer after everyone left', async () => {
    const { source, remote } = create()
    const first = source.hooks.plan.subscribe(() => {})
    await vi.waitFor(() => { expect(remote.snapshot).toHaveBeenCalledTimes(1) })
    first()
    const second = source.hooks.plan.subscribe(() => {})
    await vi.waitFor(() => { expect(remote.snapshot).toHaveBeenCalledTimes(2) })
    second()
  })

  it('reports a started batch', async () => {
    const { source, remote } = create()
    const unsubscribe = source.hooks.plan.subscribe(() => {})
    await vi.waitFor(() => { expect(stateOf(source).status).toBe('ready') })
    const code = await source.startRun({ planId: 'a' })
    expect(code).toBe('ok')
    expect(remote.startRun).toHaveBeenCalledWith({ planId: 'a' })
    expect(stateOf(source).snapshot?.revision).toBe(4)
    expect(stateOf(source).runError).toBeNull()
    unsubscribe()
  })

  it('keeps the refusal code of a batch that could not start', async () => {
    const { source, remote } = create({
      startRun: vi.fn(async () => ok({ started: false, code: 'run-active', snapshot: snapshot(3) })),
    })
    const unsubscribe = source.hooks.plan.subscribe(() => {})
    await vi.waitFor(() => { expect(stateOf(source).status).toBe('ready') })
    const code = await source.startRun({ planId: 'a' })
    expect(code).toBe('run-active')
    expect(stateOf(source).runError).toBe('run-active')
    expect(stateOf(source).snapshot?.revision).toBe(3)
    expect(remote.startRun).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('reports a stopped batch and an unanswered reveal request', async () => {
    const { source, remote } = create({
      revealSession: vi.fn(async () => ok({ accepted: false })),
    })
    const unsubscribe = source.hooks.plan.subscribe(() => {})
    await vi.waitFor(() => { expect(stateOf(source).status).toBe('ready') })
    expect(await source.stopRun()).toBe('ok')
    expect(stateOf(source).snapshot?.revision).toBe(5)
    expect(await source.revealSession('se-1')).toBe(false)
    expect(remote.revealSession).toHaveBeenCalledWith({ sessionId: 'se-1' })
    unsubscribe()
  })

  it('reports the outcome code of a task-Session reveal and requests the embedded panel', async () => {
    const { source, remote } = create({
      revealTaskSession: vi.fn(async () => ok({ code: 'unavailable' })),
      requestPanel: vi.fn(async () => ok({ accepted: false })),
    })
    const unsubscribe = source.hooks.plan.subscribe(() => {})
    await vi.waitFor(() => { expect(stateOf(source).status).toBe('ready') })
    expect(await source.revealTaskSession('t1')).toBe('unavailable')
    expect(remote.revealTaskSession).toHaveBeenCalledWith({ taskId: 't1' })
    expect(await source.requestPanel()).toBe(false)
    expect(remote.requestPanel).toHaveBeenCalledTimes(1)
    unsubscribe()
  })
})
