/**
 * Real domain storage plus the real tool registry for personal-plan service tests.
 *
 * The harness mounts the shipping plugin on a real Cordis Context over an
 * in-memory storage backend, so every assertion covers the production write
 * chain (domain open, schema validation, serialization) without touching disk
 * or starting an application.
 */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import PersonalPlanService from '../src/index.ts'
import type { PlanSnapshot } from '../src/types.ts'

/** Mounted service and the media its domain was opened over. */
export interface Harness {
  /** Root Context owning every fixture service. */
  readonly ctx: Context
  /** The mounted personal-plan service under test. */
  readonly service: PersonalPlanService
  /** Fiber owning the plugin, for disposal assertions. */
  readonly fiber: Context['fiber']
  /** Shared media, so a second harness can reopen the same durable unit. */
  readonly pool: MemoryMediaPool
}

/**
 * Mount the shipping plugin over an in-memory storage backend.
 * @param options - optional media pool to reopen a unit that a previous harness wrote,
 * and an optional service subclass that overrides the Session gateway.
 * @returns the mounted harness.
 */
export async function harness(options: { pool?: MemoryMediaPool; service?: typeof PersonalPlanService } = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Storage)
  const pool = options.pool ?? new MemoryMediaPool()
  const backend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  ctx.effect(() => async () => { await backend.close() })
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => {
      await facility.closeAll()
      unmount()
    }
  })
  const fiber = await ctx.plugin(options.service ?? PersonalPlanService)
  return { ctx, service: ctx.personalPlan, fiber, pool }
}

/**
 * Title projection of a snapshot, in the snapshot's own order.
 * @param snapshot - plan snapshot returned by the service.
 * @returns item titles in snapshot order.
 */
export function titles(snapshot: PlanSnapshot): string[] {
  return snapshot.items.map(item => item.title)
}

/**
 * Identify one item's position in the snapshot order.
 * @param snapshot - plan snapshot returned by the service.
 * @param id - item identity.
 * @returns the 0-based index, or -1 when absent.
 */
export function indexOf(snapshot: PlanSnapshot, id: string): number {
  return snapshot.items.findIndex(item => item.id === id)
}

/**
 * Read one item by identity.
 * @param snapshot - plan snapshot returned by the service.
 * @param id - item identity.
 * @returns the item, or undefined when absent.
 */
export function itemOf(snapshot: PlanSnapshot, id: string): PlanSnapshot['items'][number] | undefined {
  return snapshot.items.find(item => item.id === id)
}

/**
 * Assert a rejection carries the stable code the client explains.
 * @param operation - promise expected to reject.
 * @param code - expected `PersonalPlanError.code`.
 * @returns the rejection for further assertions.
 */
export async function rejectionCode(operation: Promise<unknown>, code: string): Promise<Error> {
  const failure = await operation.then(
    () => { throw new Error(`expected a rejection with code ${code}`) },
    (error: unknown) => error,
  )
  if (!(failure instanceof Error)) throw new Error(`expected an Error rejection, received ${String(failure)}`)
  if (!('code' in failure)) {
    throw new Error(`expected rejection code ${code}, received an Error without a code: ${failure.message}`)
  }
  if (failure.code !== code) {
    throw new Error(`expected rejection code ${code}, received ${String(failure.code)}: ${failure.message}`)
  }
  return failure
}
