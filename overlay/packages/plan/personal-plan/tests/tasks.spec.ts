/**
 * Task management and task-change proposals: a task belongs to one plan, keeps
 * its own order, and a model draft never moves anything until the user applies
 * the selected changes.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { harness } from './harness.ts'
import type { Harness } from './harness.ts'
import { rejectionCode } from './harness.ts'

const tests: Harness[] = []
afterEach(async () => {
  await Promise.all(tests.splice(0).map(test => test.ctx.fiber.dispose()))
})

/**
 * Mount one isolated service over fresh media.
 * @returns the harness, registered for teardown.
 */
async function setup(): Promise<Harness> {
  const test = await harness()
  tests.push(test)
  return test
}

describe('personal-plan tasks', () => {
  it('appends tasks to their own plan and publishes them in plan order', async () => {
    const { service } = await setup()
    const first = await service.addItem({ title: 'Weekly report' })
    const planId = first.items[0]?.id ?? ''
    const second = await service.addItem({ title: 'Other plan' })
    const otherId = second.items[1]?.id ?? ''

    const added = await service.addTask({ planId, title: 'Gather data', detail: 'Read data.csv' })
    await service.addTask({ planId, title: 'Plot results' })
    const final = await service.addTask({ planId: otherId, title: 'Unrelated' })

    expect(added.tasks).toHaveLength(1)
    const own = final.tasks.filter(task => task.planId === planId)
    expect(own.map(task => task.title)).toEqual(['Gather data', 'Plot results'])
    expect(own.map(task => task.order)).toEqual([0, 1])
    expect(own[0]).toMatchObject({ status: 'pending', sessionId: null, result: null, detail: 'Read data.csv' })
    expect(final.tasks.filter(task => task.planId === otherId)).toHaveLength(1)
  })

  it('refuses a task for a plan that does not exist', async () => {
    const { service } = await setup()
    await rejectionCode(service.addTask({ planId: 'pl-missing', title: 'Task' }), 'missing-plan')
  })

  it('edits and deletes one task without touching its plan', async () => {
    const { service } = await setup()
    const seeded = await service.addItem({ title: 'Weekly report' })
    const planId = seeded.items[0]?.id ?? ''
    const added = await service.addTask({ planId, title: 'Gather data' })
    const taskId = added.tasks[0]?.id ?? ''

    const edited = await service.updateTask({ id: taskId, title: 'Gather data v2', detail: 'Only A/B groups' })
    expect(edited.tasks[0]).toMatchObject({ title: 'Gather data v2', detail: 'Only A/B groups' })
    expect(edited.items[0]?.title).toBe('Weekly report')

    const deleted = await service.deleteTask({ id: taskId })
    expect(deleted.tasks).toHaveLength(0)
    expect(deleted.items).toHaveLength(1)
    await rejectionCode(service.deleteTask({ id: taskId }), 'missing-task')
  })

  it('saves a dragged task order and rejects an incomplete list', async () => {
    const { service } = await setup()
    const seeded = await service.addItem({ title: 'Weekly report' })
    const planId = seeded.items[0]?.id ?? ''
    await service.addTask({ planId, title: 'A' })
    await service.addTask({ planId, title: 'B' })
    const third = await service.addTask({ planId, title: 'C' })
    const ids = third.tasks.map(task => task.id)

    const reordered = await service.reorderTasks({ planId, order: [ids[2] as string, ids[0] as string, ids[1] as string] })
    expect(reordered.tasks.map(task => task.title)).toEqual(['C', 'A', 'B'])
    expect(reordered.tasks.map(task => task.order)).toEqual([0, 1, 2])

    await rejectionCode(service.reorderTasks({ planId, order: [ids[0] as string] }), 'invalid-order')
  })

  it('deletes a plan together with its tasks and keeps other plans intact', async () => {
    const { service } = await setup()
    const seeded = await service.addItem({ title: 'Weekly report' })
    const removedId = seeded.items[0]?.id ?? ''
    const kept = await service.addItem({ title: 'Keep me' })
    const keptId = kept.items[1]?.id ?? ''
    await service.addTask({ planId: removedId, title: 'Removed task' })
    await service.addTask({ planId: keptId, title: 'Kept task' })

    const after = await service.deleteItem({ id: removedId })
    expect(after.items.map(item => item.title)).toEqual(['Keep me'])
    expect(after.tasks.map(task => task.title)).toEqual(['Kept task'])
  })

  it('stores a task proposal without writing the board, then applies only the kept changes', async () => {
    const { service } = await setup()
    const seeded = await service.addItem({ title: 'Weekly report' })
    const planId = seeded.items[0]?.id ?? ''
    const seededTask = await service.addTask({ planId, title: 'Gather data' })
    const taskId = seededTask.tasks[0]?.id ?? ''
    const revisionBefore = (await service.snapshot()).revision

    const proposal = await service.propose({
      changes: [
        { kind: 'task-add', planId, title: 'Plot results', detail: 'Comparison chart' },
        { kind: 'task-edit', taskId, detail: 'Read data.csv and summarize' },
      ],
    })
    expect(proposal.changes).toHaveLength(2)
    expect(proposal.changes[0]).toMatchObject({ kind: 'task-add', planId, taskAfter: { title: 'Plot results', detail: 'Comparison chart' } })
    expect(proposal.changes[1]).toMatchObject({ kind: 'task-edit', taskId, taskBefore: { title: 'Gather data' } })

    const pending = await service.snapshot()
    expect(pending.revision).toBe(revisionBefore)
    expect(pending.tasks).toHaveLength(1)
    expect(pending.tasks[0]?.detail).toBe('')

    const applied = await service.applyProposal({
      proposalId: proposal.proposalId,
      changeIds: [proposal.changes[0]?.changeId ?? '', proposal.changes[1]?.changeId ?? ''],
    })
    expect(applied).toMatchObject({ applied: true, code: 'ok' })
    expect(applied.snapshot.tasks.map(task => task.title)).toEqual(['Gather data', 'Plot results'])
    expect(applied.snapshot.tasks[0]?.detail).toBe('Read data.csv and summarize')
  })

  it('lets a task proposal be applied, but not an older one over a later manual edit', async () => {
    const { service } = await setup()
    const seeded = await service.addItem({ title: 'Weekly report' })
    const planId = seeded.items[0]?.id ?? ''
    const seededTask = await service.addTask({ planId, title: 'Gather data' })
    const taskId = seededTask.tasks[0]?.id ?? ''

    const proposal = await service.propose({ changes: [{ kind: 'task-edit', taskId, title: 'Model title' }] })
    await service.updateTask({ id: taskId, title: 'Manual title' })
    const stale = await service.applyProposal({ proposalId: proposal.proposalId, changeIds: [proposal.changes[0]?.changeId ?? ''] })
    expect(stale).toMatchObject({ applied: false, code: 'stale' })
    expect(stale.snapshot.tasks[0]?.title).toBe('Manual title')
  })

  it('rejects a task change that names a missing plan or task', async () => {
    const { service } = await setup()
    await rejectionCode(service.propose({ changes: [{ kind: 'task-add', planId: 'pl-missing', title: 'X' }] }), 'missing-plan')
    await rejectionCode(service.propose({ changes: [{ kind: 'task-edit', taskId: 'tk-missing', title: 'X' }] }), 'missing-task')
    await rejectionCode(service.propose({ changes: [{ kind: 'task-add', title: 'X' }] }), 'missing-plan')
  })

  it('keeps completion requirements and required artifacts on the task', async () => {
    const { service } = await setup()
    const seeded = await service.addItem({ title: 'Weekly report' })
    const planId = seeded.items[0]?.id ?? ''
    const added = await service.addTask({
      planId,
      title: 'Gather data',
      detail: 'Read data.csv',
      requirement: 'summary.csv lists both group means',
      requestedFiles: ['summary.csv', ' summary.csv ', ''],
    })
    expect(added.tasks[0]).toMatchObject({
      detail: 'Read data.csv',
      requirement: 'summary.csv lists both group means',
      requestedFiles: ['summary.csv'],
    })

    const id = added.tasks[0]?.id ?? ''
    const edited = await service.updateTask({ id, requirement: 'means A=12 B=22', requestedFiles: ['summary.csv', 'notes.md'] })
    expect(edited.tasks[0]).toMatchObject({
      requirement: 'means A=12 B=22',
      requestedFiles: ['summary.csv', 'notes.md'],
    })

    const proposal = await service.propose({
      changes: [
        { kind: 'task-add', planId, title: 'Plot', requirement: 'PNG shows both groups', requestedFiles: ['comparison.png'] },
      ],
    })
    expect(proposal.changes[0]?.taskAfter).toMatchObject({
      requirement: 'PNG shows both groups',
      requestedFiles: ['comparison.png'],
    })
  })
})
