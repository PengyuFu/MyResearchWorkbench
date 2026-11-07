/**
 * Personal-plan service semantics: item order rules, the proposal lifecycle, and
 * durable storage behavior the release verification depends on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { harness, indexOf, itemOf, rejectionCode, titles } from './harness.ts'
import type { Harness } from './harness.ts'
import type { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const tests: Harness[] = []
afterEach(async () => {
  await Promise.all(tests.splice(0).map(test => test.ctx.fiber.dispose()))
})

/**
 * Mount one isolated service over fresh media.
 * @param options - optional pool to reopen previously written media.
 * @returns the harness, registered for teardown.
 */
async function setup(options: { pool?: MemoryMediaPool } = {}): Promise<Harness> {
  const test = await harness(options)
  tests.push(test)
  return test
}

/**
 * Add three titled items and return their identities in insertion order.
 * @param service - mounted personal-plan service.
 * @returns identities of Alpha, Beta, and Gamma.
 */
async function seedThree(service: Harness['service']): Promise<[string, string, string]> {
  await service.addItem({ title: 'Alpha' })
  await service.addItem({ title: 'Beta' })
  const seeded = await service.addItem({ title: 'Gamma' })
  const ids = seeded.items.map(item => item.id)
  if (ids.length !== 3) throw new Error(`expected three seeded items, received ${String(ids.length)}`)
  return [ids[0] as string, ids[1] as string, ids[2] as string]
}

describe('item writes', () => {
  it('appends each added item after the previous incomplete item', async () => {
    const { service } = await setup()
    const first = await service.addItem({ title: 'Alpha' })
    expect(first.revision).toBe(1)
    expect(titles(first)).toEqual(['Alpha'])

    const second = await service.addItem({ title: 'Beta', note: '  note  ', dueDate: '2026-12-31' })
    expect(second.revision).toBe(2)
    expect(titles(second)).toEqual(['Alpha', 'Beta'])
    expect(second.items[1]).toMatchObject({
      title: 'Beta',
      note: 'note',
      dueDate: '2026-12-31',
      status: 'todo',
      order: 1,
    })
  })

  it('trims editable fields, keeps an omitted field, and clears a date with an empty string', async () => {
    const { service } = await setup()
    const added = await service.addItem({ title: '  Task  ', note: 'note', dueDate: '2026-05-01' })
    const id = added.items[0]?.id ?? ''

    const renamed = await service.updateItem({ id, title: '  Renamed  ' })
    expect(renamed.items[0]).toMatchObject({ title: 'Renamed', note: 'note', dueDate: '2026-05-01' })

    const cleared = await service.updateItem({ id, dueDate: '' })
    expect(cleared.items[0]).toMatchObject({ title: 'Renamed', note: 'note', dueDate: null })
    expect(cleared.revision).toBe(3)
  })

  it('rejects blank titles and impossible calendar dates without writing', async () => {
    const { service } = await setup()
    await rejectionCode(service.addItem({ title: '   ' }), 'invalid-title')
    await rejectionCode(service.addItem({ title: 'Task', dueDate: '2026-02-30' }), 'invalid-date')
    await rejectionCode(service.addItem({ title: 'Task', dueDate: '05/01/2026' }), 'invalid-date')
    expect((await service.snapshot()).revision).toBe(0)
  })

  it('accepts the field bounds and rejects one character past them', async () => {
    const { service } = await setup()
    await rejectionCode(service.addItem({ title: 'x'.repeat(201) }), 'invalid-title')
    await rejectionCode(service.addItem({ title: 'Task', note: 'x'.repeat(4001) }), 'invalid-note')
    const atTitleBound = await service.addItem({ title: 'y'.repeat(200) })
    expect(atTitleBound.items[0]?.title).toHaveLength(200)
    const atNoteBound = await service.addItem({ title: 'Task', note: 'z'.repeat(4000) })
    expect(atNoteBound.items[1]?.note).toHaveLength(4000)
    expect(atNoteBound.revision).toBe(2)
  })

  it('replaces a note on its own and keeps the title', async () => {
    const { service } = await setup()
    const added = await service.addItem({ title: 'Task', note: 'before' })
    const id = added.items[0]?.id ?? ''
    const updated = await service.updateItem({ id, note: '  after  ' })
    expect(updated.items[0]).toMatchObject({ title: 'Task', note: 'after' })
  })

  it('deletes one item and rejects an unknown identity without writing', async () => {
    const { service } = await setup()
    const [, betaId] = await seedThree(service)
    const afterDelete = await service.deleteItem({ id: betaId })
    expect(titles(afterDelete)).toEqual(['Alpha', 'Gamma'])
    expect(afterDelete.revision).toBe(4)
    await rejectionCode(service.deleteItem({ id: betaId }), 'missing-item')
    await rejectionCode(service.updateItem({ id: betaId, title: 'gone' }), 'missing-item')
    expect((await service.snapshot()).revision).toBe(4)
  })
})

describe('order rules', () => {
  it('removes a completed item from the incomplete order and restores it at the end', async () => {
    const { service } = await setup()
    const [alphaId, betaId, gammaId] = await seedThree(service)

    const completed = await service.setStatus({ id: betaId, status: 'done' })
    expect(itemOf(completed, betaId)?.status).toBe('done')
    // The incomplete order is exactly Alpha and Gamma while Beta is completed.
    await rejectionCode(service.reorder({ order: [gammaId, betaId, alphaId] }), 'invalid-order')

    const restored = await service.setStatus({ id: betaId, status: 'todo' })
    expect(itemOf(restored, betaId)?.status).toBe('todo')
    // Restoring appends: Alpha and Gamma keep their order and Beta sorts last.
    expect(titles(restored)).toEqual(['Alpha', 'Gamma', 'Beta'])
    expect(indexOf(restored, betaId)).toBe(2)
    const beta = itemOf(restored, betaId)
    const gamma = itemOf(restored, gammaId)
    if (beta === undefined || gamma === undefined) throw new Error('expected both restored items')
    expect(beta.order).toBeGreaterThan(gamma.order)
  })

  it('keeps the completed item out of reorder while its identity and content survive', async () => {
    const { service } = await setup()
    const [alphaId, betaId, gammaId] = await seedThree(service)
    await service.setStatus({ id: betaId, status: 'done' })

    const reordered = await service.reorder({ order: [gammaId, alphaId] })
    expect(indexOf(reordered, betaId)).toBeGreaterThanOrEqual(0)
    expect(itemOf(reordered, betaId)).toMatchObject({ status: 'done', title: 'Beta' })
    // The incomplete items keep exactly the requested relative order.
    expect(indexOf(reordered, gammaId)).toBeLessThan(indexOf(reordered, alphaId))
  })

  it('reorders every incomplete item and rejects a set that is not identical', async () => {
    const { service } = await setup()
    const [alphaId, betaId, gammaId] = await seedThree(service)

    const reordered = await service.reorder({ order: [gammaId, betaId, alphaId] })
    expect(titles(reordered)).toEqual(['Gamma', 'Beta', 'Alpha'])
    expect(reordered.items.map(item => item.order)).toEqual([0, 1, 2])
    expect(reordered.revision).toBe(4)

    await rejectionCode(service.reorder({ order: [alphaId, betaId] }), 'invalid-order')
    await rejectionCode(service.reorder({ order: [alphaId, alphaId, betaId] }), 'invalid-order')
    await rejectionCode(service.reorder({ order: [alphaId, betaId, 'pl-foreign'] }), 'invalid-order')
    expect((await service.snapshot()).revision).toBe(4)
  })

  it('keeps an item in place when its status is set to the current value', async () => {
    const { service } = await setup()
    const [alphaId] = await seedThree(service)
    const same = await service.setStatus({ id: alphaId, status: 'todo' })
    expect(itemOf(same, alphaId)).toMatchObject({ status: 'todo', order: 0 })
    expect(titles(same)).toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('rejects a status write for an item that no longer exists', async () => {
    const { service } = await setup()
    await rejectionCode(service.setStatus({ id: 'pl-missing', status: 'done' }), 'missing-item')
  })
})

describe('proposal lifecycle', () => {
  it('stores a proposal without changing item content or the revision', async () => {
    const { service } = await setup()
    const added = await service.addItem({ title: 'Alpha' })
    const id = added.items[0]?.id ?? ''

    const proposal = await service.propose({ changes: [{ kind: 'edit', itemId: id, title: 'Alpha v2' }] })
    expect(proposal.baseRevision).toBe(1)
    expect(proposal.changes.map(change => change.kind)).toEqual(['edit'])

    const after = await service.snapshot()
    expect(after.revision).toBe(1)
    expect(after.items[0]?.title).toBe('Alpha')
    expect(after.proposal).toMatchObject({ proposalId: proposal.proposalId, baseRevision: 1 })
  })

  it('applies only the selected changes, bumps the revision once, and clears the proposal', async () => {
    const { service } = await setup()
    const seeded = await service.addItem({ title: 'Alpha' })
    const second = await service.addItem({ title: 'Beta' })
    const alphaId = seeded.items[0]?.id ?? ''
    const betaId = second.items[1]?.id ?? ''

    const proposal = await service.propose({
      changes: [
        { kind: 'edit', itemId: alphaId, title: 'Alpha v2' },
        { kind: 'delete', itemId: betaId },
      ],
    })
    const result = await service.applyProposal({
      proposalId: proposal.proposalId,
      changeIds: [proposal.changes[0]?.changeId ?? ''],
    })

    expect(result).toMatchObject({ applied: true, code: 'ok' })
    expect(result.snapshot.revision).toBe(3)
    expect(result.snapshot.proposal).toBeNull()
    expect(titles(result.snapshot)).toEqual(['Alpha v2', 'Beta'])
    // The dropped deletion left the unrelated item untouched.
    expect(itemOf(result.snapshot, betaId)).toMatchObject({ title: 'Beta', status: 'todo' })
  })

  it('keeps a dropped addition out of the plan', async () => {
    const { service } = await setup()
    const seeded = await service.addItem({ title: 'Alpha' })
    const beta = await service.addItem({ title: 'Beta' })
    const alphaId = seeded.items[0]?.id ?? ''
    const betaId = beta.items[1]?.id ?? ''

    const proposal = await service.propose({
      changes: [
        { kind: 'add', title: 'Gamma' },
        { kind: 'delete', itemId: betaId },
      ],
    })
    const result = await service.applyProposal({
      proposalId: proposal.proposalId,
      changeIds: [proposal.changes[1]?.changeId ?? ''],
    })

    expect(result).toMatchObject({ applied: true, code: 'ok' })
    expect(titles(result.snapshot)).toEqual(['Alpha'])
    expect(itemOf(result.snapshot, alphaId)).toMatchObject({ title: 'Alpha' })
    expect(result.snapshot.items.some(item => item.title === 'Gamma')).toBe(false)
  })

  it('rejects a stale proposal after a manual edit and changes nothing', async () => {
    const { service } = await setup()
    const seeded = await service.addItem({ title: 'Alpha' })
    const beta = await service.addItem({ title: 'Beta' })
    const alphaId = seeded.items[0]?.id ?? ''
    const betaId = beta.items[1]?.id ?? ''

    const proposal = await service.propose({ changes: [{ kind: 'edit', itemId: alphaId, title: 'Alpha v2' }] })
    // The user edits manually before confirming; that write moves the revision.
    const manual = await service.updateItem({ id: betaId, title: 'Beta manual' })
    expect(manual.revision).toBe(3)

    const result = await service.applyProposal({
      proposalId: proposal.proposalId,
      changeIds: [proposal.changes[0]?.changeId ?? ''],
    })
    expect(result).toMatchObject({ applied: false, code: 'stale' })
    expect(result.snapshot.revision).toBe(3)
    expect(titles(result.snapshot)).toEqual(['Alpha', 'Beta manual'])
    expect(result.snapshot.proposal?.proposalId).toBe(proposal.proposalId)
  })

  it('discards the pending proposal without touching content or revision', async () => {
    const { service } = await setup()
    const added = await service.addItem({ title: 'Alpha' })
    const id = added.items[0]?.id ?? ''
    const proposal = await service.propose({ changes: [{ kind: 'edit', itemId: id, title: 'Alpha v2' }] })

    const discarded = await service.discardProposal({ proposalId: proposal.proposalId })
    expect(discarded.proposal).toBeNull()
    expect(discarded.revision).toBe(1)
    expect(titles(discarded)).toEqual(['Alpha'])

    // A proposal identity the store does not hold is a non-mutating lookup failure.
    const afterMissing = await service.applyProposal({ proposalId: 'pp-missing', changeIds: ['c-1'] })
    expect(afterMissing).toMatchObject({ applied: false, code: 'missing-proposal' })
    expect((await service.snapshot()).revision).toBe(1)
  })

  it('leaves the pending proposal alone when the discard names another identity', async () => {
    const { service } = await setup()
    const added = await service.addItem({ title: 'Alpha' })
    const id = added.items[0]?.id ?? ''
    const proposal = await service.propose({ changes: [{ kind: 'edit', itemId: id, title: 'Alpha v2' }] })

    const discarded = await service.discardProposal({ proposalId: 'pp-other' })
    expect(discarded.proposal?.proposalId).toBe(proposal.proposalId)
    expect(discarded.revision).toBe(1)
  })

  it('reports nothing-selected when the confirmed selection names no keeps', async () => {
    const { service } = await setup()
    const added = await service.addItem({ title: 'Alpha' })
    const id = added.items[0]?.id ?? ''
    const proposal = await service.propose({ changes: [{ kind: 'edit', itemId: id, title: 'Alpha v2' }] })

    const result = await service.applyProposal({ proposalId: proposal.proposalId, changeIds: [] })
    expect(result).toMatchObject({ applied: false, code: 'nothing-selected' })
    expect(titles(result.snapshot)).toEqual(['Alpha'])
    expect(result.snapshot.revision).toBe(1)
  })
})

describe('durability and notification', () => {
  it('notifies observers after each committed write with the resulting revision', async () => {
    const { ctx, service } = await setup()
    const changed = vi.fn()
    ctx.on('personal-plan/changed', changed)

    const added = await service.addItem({ title: 'Alpha' })
    expect(changed).toHaveBeenLastCalledWith({ revision: 1, proposalId: null })

    const id = added.items[0]?.id ?? ''
    const proposal = await service.propose({ changes: [{ kind: 'edit', itemId: id, title: 'Alpha v2' }] })
    expect(changed).toHaveBeenLastCalledWith({ revision: 1, proposalId: proposal.proposalId })

    await service.applyProposal({
      proposalId: proposal.proposalId,
      changeIds: [proposal.changes[0]?.changeId ?? ''],
    })
    expect(changed).toHaveBeenLastCalledWith({ revision: 2, proposalId: null })
  })

  it('reopens the same durable plan from shared media', async () => {
    const first = await harness()
    await first.service.addItem({ title: 'Alpha', note: 'kept' })
    const beta = await first.service.addItem({ title: 'Beta', dueDate: '2026-06-01' })
    const betaId = beta.items[1]?.id ?? ''
    await first.service.setStatus({ id: betaId, status: 'in_progress' })
    const written = await first.service.snapshot()
    await first.ctx.fiber.dispose()

    const second = await setup({ pool: first.pool })
    const reopened = await second.service.snapshot()
    expect(reopened.revision).toBe(written.revision)
    expect(titles(reopened)).toEqual(['Alpha', 'Beta'])
    expect(itemOf(reopened, betaId)).toMatchObject({ status: 'in_progress', dueDate: '2026-06-01' })
  })

  it('completes a write even when a change observer throws', async () => {
    const { ctx, service } = await setup()
    ctx.on('personal-plan/changed', () => { throw new Error('observer failure') })
    const added = await service.addItem({ title: 'Alpha' })
    expect(added.revision).toBe(1)
    expect((await service.snapshot()).revision).toBe(1)
  })

  it('stops at the item limit and refuses both a manual and a proposed addition', async () => {
    const { service } = await setup()
    for (let index = 0; index < 500; index += 1) await service.addItem({ title: `Item ${String(index)}` })
    await rejectionCode(service.addItem({ title: 'Overflow' }), 'too-many-items')
    await rejectionCode(service.propose({ changes: [{ kind: 'add', title: 'Overflow' }] }), 'too-many-items')
    const full = await service.snapshot()
    expect(full.items).toHaveLength(500)
    expect(full.proposal).toBeNull()
  })
})
