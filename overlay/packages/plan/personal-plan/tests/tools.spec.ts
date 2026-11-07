/**
 * Model-facing tool behavior for the personal plan: registration shape, the read
 * projection, and the proposal tool's guarantee that it never writes the plan.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { harness } from './harness.ts'
import type { Harness } from './harness.ts'

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
  await test.ctx.plugin(NativeToolExecutor)
  return test
}

let callCounter = 0

/**
 * Invoke one registered tool through the real ToolRuntime.
 * @param test - mounted harness.
 * @param name - registered tool name.
 * @param args - tool arguments.
 * @returns the dispatch result.
 */
async function call(test: Harness, name: string, args: unknown) {
  const batch = await test.ctx.tools.execute({
    signal: new AbortController().signal,
    calls: [{ type: 'tool-call', id: ToolCallId(`plan-call-${++callCounter}`), name, arguments: JSON.stringify(args) }],
  })
  const result = batch.results[0]
  if (result === undefined) throw new Error('Expected one settled personal-plan tool call')
  return result.result
}

/**
 * Join the text blocks of one dispatch result.
 * @param result - tool dispatch result.
 * @returns concatenated text content.
 */
function text(result: { content: readonly ContentBlock[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('personal-plan tools', () => {
  it('registers plan_read and plan_propose_changes on the tools registry', async () => {
    const { ctx } = await setup()
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toEqual(expect.arrayContaining(['plan_read', 'plan_propose_changes']))
    expect(ctx.tools.get('plan_read')).toBeDefined()
    expect(ctx.tools.get('plan_propose_changes')).toBeDefined()
  })

  it('plan_read returns every item field of the authoritative snapshot', async () => {
    const test = await setup()
    const { service } = test
    await service.addItem({ title: 'Alpha', note: 'first', dueDate: '2026-07-01' })
    await service.addItem({ title: 'Beta' })
    const snapshot = await service.snapshot()

    const result = await call(test, 'plan_read', {})
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      revision: snapshot.revision,
      items: snapshot.items.map(item => ({
        id: item.id,
        title: item.title,
        note: item.note,
        dueDate: item.dueDate ?? '',
        workdir: item.workdir,
        status: item.status,
        order: item.order,
      })),
      tasks: snapshot.tasks.map(task => ({
        id: task.id,
        planId: task.planId,
        title: task.title,
        detail: task.detail,
        requirement: task.requirement,
        requestedFiles: task.requestedFiles,
        status: task.status,
        order: task.order,
      })),
    })
    expect(text(result)).toContain(`Plan board revision ${String(snapshot.revision)}`)
  })

  it('plan_read states an empty plan without inventing content', async () => {
    const test = await setup()
    const result = await call(test, 'plan_read', {})
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ revision: 0, items: [], tasks: [] })
    expect(text(result)).toContain('The plan board is empty.')
  })

  it('plan_propose_changes stores a proposal without writing the plan', async () => {
    const test = await setup()
    const { service } = test
    const seeded = await service.addItem({ title: 'Alpha' })
    const id = seeded.items[0]?.id ?? ''

    const result = await call(test, 'plan_propose_changes', {
      changes: [{ kind: 'edit', itemId: id, title: 'Alpha v2' }],
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      baseRevision: 1,
      changeCount: 1,
      changes: [{ kind: 'edit', itemId: id }],
    })
    expect(text(result)).toContain('Nothing has been applied')

    const after = await service.snapshot()
    expect(after.revision).toBe(1)
    expect(after.items[0]?.title).toBe('Alpha')
    const stored = after.proposal
    expect(stored).not.toBeNull()
    if (stored === null) throw new Error('expected the tool to store a proposal')
    // The stored proposal is the one the user's confirmation applies.
    expect(result.value).toMatchObject({ proposalId: stored.proposalId })
    const applied = await service.applyProposal({
      proposalId: stored.proposalId,
      changeIds: [stored.changes[0]?.changeId ?? ''],
    })
    expect(applied).toMatchObject({ applied: true, code: 'ok' })
    expect(applied.snapshot.items[0]?.title).toBe('Alpha v2')
  })

  it('presents both calls with stable generic cards', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.get('plan_read')?.presentCall?.({})).toEqual({
      card: 'generic',
      title: 'Read plan board',
      kind: 'other',
    })
    expect(ctx.tools.get('plan_propose_changes')?.presentCall?.({ changes: [] })).toEqual({
      card: 'generic',
      title: 'Prepare plan-board changes',
      kind: 'other',
    })
  })

  it('plan_propose_changes previews a reorder and summarizes each selected kind', async () => {
    const test = await setup()
    const { service } = test
    const seeded = await service.addItem({ title: 'Alpha' })
    const second = await service.addItem({ title: 'Beta' })
    const alphaId = seeded.items[0]?.id ?? ''
    const betaId = second.items[1]?.id ?? ''

    const result = await call(test, 'plan_propose_changes', {
      changes: [
        { kind: 'reorder', order: [betaId, alphaId] },
        { kind: 'add', title: 'Gamma' },
        { kind: 'edit', itemId: alphaId, title: 'Alpha v2' },
        { kind: 'status', itemId: alphaId, status: 'in_progress' },
        { kind: 'delete', itemId: betaId },
      ],
    })
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({
      baseRevision: 2,
      changeCount: 5,
      changes: [
        { kind: 'reorder', itemId: '' },
        { kind: 'add' },
        { kind: 'edit', itemId: alphaId },
        { kind: 'status', itemId: alphaId },
        { kind: 'delete', itemId: betaId },
      ],
    })
    expect(text(result)).toContain('5 change(s)')

    // The reorder preview names the planned order for the two current items.
    const stored = (await service.snapshot()).proposal
    expect(stored?.changes[0]).toMatchObject({ kind: 'reorder', beforeOrder: [alphaId, betaId], afterOrder: [betaId, alphaId] })
    expect((await service.snapshot()).revision).toBe(2)
  })

  it('withdraws both tools when the owning fiber is disposed (HMR-safety)', async () => {
    const { ctx, fiber } = await setup()
    expect(ctx.tools.schemas().some(schema => schema.name === 'plan_read')).toBe(true)
    expect(ctx.tools.schemas().some(schema => schema.name === 'plan_propose_changes')).toBe(true)

    await fiber.dispose()

    expect(ctx.tools.schemas().some(schema => schema.name === 'plan_read')).toBe(false)
    expect(ctx.tools.schemas().some(schema => schema.name === 'plan_propose_changes')).toBe(false)
  })
})
