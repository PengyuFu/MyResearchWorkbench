/**
 * Proposal preview construction and application: every change kind the model may
 * draft, plus the rejection paths that keep an invalid draft out of the plan.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { harness, itemOf, rejectionCode, titles } from './harness.ts'
import type { Harness } from './harness.ts'

const tests: Harness[] = []
afterEach(async () => {
  await Promise.all(tests.splice(0).map(test => test.ctx.fiber.dispose()))
})

/** Mount one isolated service over fresh media. */
async function setup(): Promise<Harness> {
  const test = await harness()
  tests.push(test)
  return test
}

describe('proposal previews', () => {
  it('previews every change kind with its before/after values', async () => {
    const { service } = await setup()
    const seeded = await service.addItem({ title: 'Alpha', note: 'first' })
    const second = await service.addItem({ title: 'Beta' })
    const alphaId = seeded.items[0]?.id ?? ''
    const betaId = second.items[1]?.id ?? ''

    const proposal = await service.propose({
      changes: [
        { kind: 'reorder', order: [betaId, alphaId] },
        { kind: 'add', title: 'Gamma', note: 'new' },
        { kind: 'edit', itemId: alphaId, title: 'Alpha v2', note: 'edited', dueDate: '2026-08-01' },
        { kind: 'delete', itemId: betaId },
        { kind: 'status', itemId: alphaId, status: 'in_progress' },
      ],
    })

    expect(proposal.baseRevision).toBe(2)
    expect(proposal.changes.map(change => change.kind)).toEqual(['reorder', 'add', 'edit', 'delete', 'status'])
    const reorder = proposal.changes[0]
    expect(reorder).toMatchObject({ itemId: null })
    expect(reorder?.beforeOrder).toEqual([alphaId, betaId])
    expect(reorder?.afterOrder).toEqual([betaId, alphaId])
    const add = proposal.changes[1]
    expect(add).toMatchObject({ before: null, after: { title: 'Gamma', note: 'new', dueDate: null } })
    expect(add?.itemId).not.toBeNull()
    const edit = proposal.changes[2]
    expect(edit).toMatchObject({
      itemId: alphaId,
      before: { title: 'Alpha', note: 'first', dueDate: null },
      after: { title: 'Alpha v2', note: 'edited', dueDate: '2026-08-01' },
    })
    expect(proposal.changes[3]).toMatchObject({ itemId: betaId, before: { title: 'Beta' }, after: null })
    expect(proposal.changes[4]).toMatchObject({ itemId: alphaId, beforeStatus: 'todo', afterStatus: 'in_progress' })

    // Nothing in the preview reached the plan.
    const pending = await service.snapshot()
    expect(pending.revision).toBe(2)
    expect(titles(pending)).toEqual(['Alpha', 'Beta'])
    expect(itemOf(pending, alphaId)).toMatchObject({ title: 'Alpha', note: 'first', status: 'todo' })
  })

  it('applies a mixed selection so the plan matches the confirmed preview', async () => {
    const { service } = await setup()
    const seeded = await service.addItem({ title: 'Alpha', note: 'first' })
    const second = await service.addItem({ title: 'Beta' })
    const alphaId = seeded.items[0]?.id ?? ''
    const betaId = second.items[1]?.id ?? ''

    const proposal = await service.propose({
      changes: [
        { kind: 'add', title: 'Gamma' },
        { kind: 'edit', itemId: alphaId, title: 'Alpha v2' },
        { kind: 'delete', itemId: betaId },
        { kind: 'status', itemId: alphaId, status: 'in_progress' },
      ],
    })
    const changeIds = proposal.changes.map(change => change.changeId)
    const result = await service.applyProposal({ proposalId: proposal.proposalId, changeIds })

    expect(result).toMatchObject({ applied: true, code: 'ok' })
    expect(result.snapshot.revision).toBe(3)
    expect(result.snapshot.proposal).toBeNull()
    expect(itemOf(result.snapshot, alphaId)).toMatchObject({ title: 'Alpha v2', status: 'in_progress' })
    expect(result.snapshot.items.some(item => item.id === betaId)).toBe(false)
    expect(result.snapshot.items.map(item => item.title)).toContain('Gamma')
  })

  it('applies a status and reorder preview without editing content', async () => {
    const { service } = await setup()
    await service.addItem({ title: 'Alpha' })
    await service.addItem({ title: 'Beta' })
    const seeded = await service.addItem({ title: 'Gamma' })
    const ids = seeded.items.map(item => item.id)
    const [alphaId, betaId, gammaId] = [ids[0] as string, ids[1] as string, ids[2] as string]

    const proposal = await service.propose({
      changes: [
        { kind: 'status', itemId: betaId, status: 'done' },
        { kind: 'reorder', order: [gammaId, alphaId] },
      ],
    })
    const result = await service.applyProposal({
      proposalId: proposal.proposalId,
      changeIds: proposal.changes.map(change => change.changeId),
    })

    expect(result).toMatchObject({ applied: true, code: 'ok' })
    expect(itemOf(result.snapshot, betaId)).toMatchObject({ status: 'done', title: 'Beta' })
    expect(itemOf(result.snapshot, alphaId)?.title).toBe('Alpha')
    expect(itemOf(result.snapshot, gammaId)?.title).toBe('Gamma')
  })

  it('previews an edit that changes only the note', async () => {
    const { service } = await setup()
    const seeded = await service.addItem({ title: 'Alpha', note: 'before', dueDate: '2026-09-01' })
    const id = seeded.items[0]?.id ?? ''

    const proposal = await service.propose({ changes: [{ kind: 'edit', itemId: id, note: ' after ' }] })
    expect(proposal.changes[0]?.after).toEqual({ title: 'Alpha', note: 'after', dueDate: '2026-09-01', workdir: '' })
    expect(proposal.changes[0]?.before).toEqual({ title: 'Alpha', note: 'before', dueDate: '2026-09-01', workdir: '' })
  })
})

describe('proposal rejections', () => {
  it('rejects changes that name no existing item, with nothing written', async () => {
    const { service } = await setup()
    await service.addItem({ title: 'Alpha' })
    await rejectionCode(service.propose({ changes: [{ kind: 'edit', itemId: 'pl-missing', title: 'x' }] }), 'missing-item')
    await rejectionCode(service.propose({ changes: [{ kind: 'delete', itemId: 'pl-missing' }] }), 'missing-item')
    await rejectionCode(service.propose({ changes: [{ kind: 'status', itemId: 'pl-missing', status: 'done' }] }), 'missing-item')
    const after = await service.snapshot()
    expect(after.revision).toBe(1)
    expect(after.proposal).toBeNull()
  })

  it('rejects malformed change inputs instead of storing a partial proposal', async () => {
    const { service } = await setup()
    const seeded = await service.addItem({ title: 'Alpha' })
    const id = seeded.items[0]?.id ?? ''

    await rejectionCode(service.propose({ changes: [] }), 'empty-proposal')
    await rejectionCode(service.propose({ changes: [{ kind: 'add', title: '   ' }] }), 'invalid-title')
    await rejectionCode(service.propose({ changes: [{ kind: 'edit', itemId: id, title: '  ' }] }), 'invalid-title')
    await rejectionCode(service.propose({ changes: [{ kind: 'status', itemId: id }] }), 'invalid-status')
    await rejectionCode(service.propose({ changes: [{ kind: 'reorder' }] }), 'invalid-order')
    const after = await service.snapshot()
    expect(after.revision).toBe(1)
    expect(after.proposal).toBeNull()
  })
})
