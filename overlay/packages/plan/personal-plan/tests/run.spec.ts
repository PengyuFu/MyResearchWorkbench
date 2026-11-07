/**
 * Batch execution over ordinary Sessions: dispatch order, the submitted result
 * as the only advance signal, halts that must not start later tasks, user stop,
 * restart recovery, and the refusals that keep one batch authoritative.
 *
 * The Session gateway is replaced through the service's own package seam, so the
 * state machine under test is the shipping one; only Session creation, prompting,
 * idle completion, and cancellation are simulated.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import PersonalPlanService from '../src/index.ts'
import type { PlanRunSessionGateway } from '../src/index.ts'
import { harness, rejectionCode } from './harness.ts'
import type { Harness } from './harness.ts'

const tests: Harness[] = []
const temporaryDirectories: string[] = []
afterEach(async () => {
  await Promise.all(tests.splice(0).map(test => test.ctx.fiber.dispose()))
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

/** Simulated Session operations plus the observable calls. */
class FakeGateway implements PlanRunSessionGateway {
  readonly created: string[] = []
  readonly workdirs: string[] = []
  readonly prompts: { sessionId: string; text: string }[] = []
  readonly cancelled: string[] = []
  /** Simulates the model inside one task: called after the prompt is accepted. */
  onPrompt: ((sessionId: string, text: string) => Promise<void>) | undefined
  /** When true, `waitIdle` blocks until {@link releaseAll}. */
  holdIdle = false
  private readonly idleResolvers: (() => void)[] = []
  private counter = 0

  async createSession(cwd: string): Promise<string> {
    this.counter += 1
    const id = `se-fake-${String(this.counter)}`
    this.created.push(id)
    this.workdirs.push(cwd)
    return id
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    this.prompts.push({ sessionId, text })
    await this.onPrompt?.(sessionId, text)
  }

  async waitIdle(): Promise<void> {
    if (!this.holdIdle) return
    await new Promise<void>((resolve) => { this.idleResolvers.push(resolve) })
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancelled.push(sessionId)
    this.releaseAll()
  }

  /** Simulated missing Sessions; a stored Session in this set cannot be opened. */
  readonly missingSessions = new Set<string>()

  async sessionAvailable(sessionId: string): Promise<boolean> {
    return !this.missingSessions.has(sessionId)
  }

  releaseAll(): void {
    for (const resolve of this.idleResolvers.splice(0)) resolve()
  }
}

/**
 * Build a service class whose only difference from the shipping one is the Session gateway.
 * @param gateway - simulated Session operations.
 * @returns the mountable service class.
 */
function serviceClass(gateway: PlanRunSessionGateway): typeof PersonalPlanService {
  return class TestPersonalPlanService extends PersonalPlanService {
    protected override sessionGateway(): PlanRunSessionGateway {
      return gateway
    }
  }
}

/**
 * Mount one service over fresh media with a simulated Session gateway.
 * @param gateway - simulated Session operations.
 * @param pool - optional media pool to reopen a previous harness's document.
 * @returns the harness and a temp directory usable as a working directory.
 */
async function setup(gateway: PlanRunSessionGateway, pool?: Harness['pool']): Promise<{ test: Harness; workdir: string }> {
  const test = await harness({ service: serviceClass(gateway), ...(pool === undefined ? {} : { pool }) })
  tests.push(test)
  const workdir = await mkdtemp(join(tmpdir(), 'mrw-plan-run-'))
  temporaryDirectories.push(workdir)
  return { test, workdir }
}

/**
 * Seed one plan with the given tasks and its working directory.
 * @param service - mounted service.
 * @param workdir - plan working directory, or undefined to leave it unset.
 * @param titles - task titles in order.
 * @returns the plan identity and the created task identities.
 */
async function seedPlan(
  service: PersonalPlanService,
  workdir: string | undefined,
  titles: readonly string[],
): Promise<{ planId: string; taskIds: string[] }> {
  const seeded = await service.addItem({ title: 'Weekly report', ...(workdir === undefined ? {} : { workdir }) })
  const planId = seeded.items[0]?.id ?? ''
  const taskIds: string[] = []
  for (const title of titles) {
    const snapshot = await service.addTask({ planId, title, detail: `${title} instruction` })
    const added = snapshot.tasks.filter(task => task.planId === planId).at(-1)
    taskIds.push(added?.id ?? '')
  }
  return { planId, taskIds }
}

/**
 * Poll until a condition holds.
 * @param check - condition to observe.
 * @param message - failure text.
 */
async function waitFor(check: () => Promise<boolean> | boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(message)
}

/**
 * Read the task id the engine embedded in one task instruction.
 * @param text - rendered prompt.
 * @returns the task identity.
 */
function taskIdOf(text: string): string {
  const match = /taskId="([^"]+)"/u.exec(text)
  if (match === null) throw new Error(`prompt carries no task id: ${text}`)
  return match[1] as string
}

describe('personal-plan task execution', () => {
  it('dispatches pending tasks in order, one ordinary Session each, and finishes the batch', async () => {
    const gateway = new FakeGateway()
    const { test, workdir } = await setup(gateway)
    const { service } = test
    const { planId } = await seedPlan(service, workdir, ['Gather data', 'Plot results', 'Write analysis'])
    gateway.onPrompt = async (sessionId, text) => {
      const taskId = taskIdOf(text)
      await service.submitTaskResult({ taskId, outcome: 'done', summary: `finished ${taskId}`, files: [] }, sessionId)
    }

    const started = await service.startRun({ planId })
    expect(started).toMatchObject({ started: true, code: 'ok' })
    await waitFor(async () => (await service.snapshot()).run?.status === 'done', 'batch did not finish')

    const snapshot = await service.snapshot()
    expect(snapshot.tasks.map(task => task.status)).toEqual(['done', 'done', 'done'])
    expect(gateway.created).toHaveLength(3)
    expect(gateway.workdirs).toEqual([workdir, workdir, workdir])
    // Each task keeps its own Session, and a later prompt carries the earlier artifacts.
    expect(snapshot.tasks.map(task => task.sessionId)).toEqual(gateway.created)
    expect(gateway.prompts[1]?.text).toContain('Earlier tasks of this batch:')
    expect(gateway.prompts[1]?.text).toContain('Gather data')
    expect(gateway.prompts[0]?.text).toContain('None; this is the first task of the batch.')
    expect(snapshot.run).toMatchObject({ status: 'done', currentTaskId: null, workdir })
  })

  it('runs a single task without dispatching its siblings', async () => {
    const gateway = new FakeGateway()
    const { test, workdir } = await setup(gateway)
    const { service } = test
    const { planId, taskIds } = await seedPlan(service, workdir, ['First', 'Second'])
    gateway.onPrompt = async (sessionId, text) => {
      await service.submitTaskResult({ taskId: taskIdOf(text), outcome: 'done', summary: 'ok', files: [] }, sessionId)
    }

    await service.startRun({ planId, taskId: taskIds[1] as string })
    await waitFor(async () => (await service.snapshot()).run?.status === 'done', 'single task batch did not finish')

    const snapshot = await service.snapshot()
    expect(snapshot.tasks.map(task => task.status)).toEqual(['pending', 'done'])
    expect(gateway.created).toHaveLength(1)
  })

  it('treats a turn that ends without a submitted result as needing the user', async () => {
    const gateway = new FakeGateway()
    const { test, workdir } = await setup(gateway)
    const { service } = test
    const { planId } = await seedPlan(service, workdir, ['First', 'Second'])

    await service.startRun({ planId })
    await waitFor(async () => (await service.snapshot()).run?.status === 'stopped', 'batch did not halt')

    const snapshot = await service.snapshot()
    expect(snapshot.tasks.map(task => task.status)).toEqual(['needs_user', 'pending'])
    expect(snapshot.tasks[0]?.message).toContain('No task result was submitted')
    // The later task was never started: one Session, one prompt.
    expect(gateway.created).toHaveLength(1)
    expect(gateway.prompts).toHaveLength(1)
  })

  it('stops the batch on a needs_user result and never starts the next task', async () => {
    const gateway = new FakeGateway()
    const { test, workdir } = await setup(gateway)
    const { service } = test
    const { planId } = await seedPlan(service, workdir, ['First', 'Second'])
    gateway.onPrompt = async (sessionId, text) => {
      await service.submitTaskResult({ taskId: taskIdOf(text), outcome: 'needs_user', summary: 'data.csv is missing', files: [] }, sessionId)
    }

    await service.startRun({ planId })
    await waitFor(async () => (await service.snapshot()).run?.status === 'stopped', 'batch did not halt')

    const snapshot = await service.snapshot()
    expect(snapshot.tasks[0]).toMatchObject({ status: 'needs_user', message: 'data.csv is missing' })
    expect(snapshot.tasks[1]?.status).toBe('pending')
    expect(snapshot.run?.message).toBe('data.csv is missing')
    expect(gateway.created).toHaveLength(1)
  })

  it('records a failed result as a task failure and halts', async () => {
    const gateway = new FakeGateway()
    const { test, workdir } = await setup(gateway)
    const { service } = test
    const { planId } = await seedPlan(service, workdir, ['First', 'Second'])
    gateway.onPrompt = async (sessionId, text) => {
      await service.submitTaskResult({ taskId: taskIdOf(text), outcome: 'failed', summary: 'command failed', files: [] }, sessionId)
    }

    await service.startRun({ planId })
    await waitFor(async () => (await service.snapshot()).run?.status === 'stopped', 'batch did not halt')

    const snapshot = await service.snapshot()
    expect(snapshot.tasks[0]).toMatchObject({ status: 'failed', message: 'command failed' })
    expect(snapshot.tasks[1]?.status).toBe('pending')
  })

  it('refuses a done result whose declared artifact does not exist', async () => {
    const gateway = new FakeGateway()
    const { test, workdir } = await setup(gateway)
    const { service } = test
    const { planId } = await seedPlan(service, workdir, ['First', 'Second'])
    let rejection: string | undefined
    gateway.onPrompt = async (sessionId, text) => {
      const result = await service.submitTaskResult({
        taskId: taskIdOf(text), outcome: 'done', summary: 'wrote it', files: [join(workdir, 'missing.csv')],
      }, sessionId)
      rejection = result.code
    }

    await service.startRun({ planId })
    await waitFor(async () => (await service.snapshot()).run?.status === 'stopped', 'batch did not halt')

    expect(rejection).toBe('missing-files')
    const snapshot = await service.snapshot()
    expect(snapshot.tasks[0]?.status).toBe('needs_user')
    expect(snapshot.tasks[1]?.status).toBe('pending')
  })

  it('accepts a done result whose declared artifact exists', async () => {
    const { writeFile } = await import('node:fs/promises')
    const gateway = new FakeGateway()
    const { test, workdir } = await setup(gateway)
    const { service } = test
    const { planId } = await seedPlan(service, workdir, ['First'])
    const artifact = join(workdir, 'summary.csv')
    await writeFile(artifact, 'group,mean\nA,12\n', 'utf8')
    gateway.onPrompt = async (sessionId, text) => {
      await service.submitTaskResult({ taskId: taskIdOf(text), outcome: 'done', summary: 'wrote summary', files: [artifact] }, sessionId)
    }

    await service.startRun({ planId })
    await waitFor(async () => (await service.snapshot()).run?.status === 'done', 'batch did not finish')

    const snapshot = await service.snapshot()
    expect(snapshot.tasks[0]?.status).toBe('done')
    expect(snapshot.tasks[0]?.result).toMatchObject({ outcome: 'done', files: [artifact] })
  })

  it('rejects a result that does not match the current task Session', async () => {
    const gateway = new FakeGateway()
    const { test, workdir } = await setup(gateway)
    const { service } = test
    const { planId, taskIds } = await seedPlan(service, workdir, ['First'])
    const codes: string[] = []
    gateway.onPrompt = async (sessionId, text) => {
      codes.push((await service.submitTaskResult({ taskId: taskIds[0] as string, outcome: 'done', summary: 'x', files: [] }, 'se-other')).code)
      codes.push((await service.submitTaskResult({ taskId: 'tk-missing', outcome: 'done', summary: 'x', files: [] }, sessionId)).code)
      await service.submitTaskResult({ taskId: taskIdOf(text), outcome: 'done', summary: 'ok', files: [] }, sessionId)
    }

    await service.startRun({ planId })
    await waitFor(async () => (await service.snapshot()).run?.status === 'done', 'batch did not finish')
    expect(codes).toEqual(['wrong-session', 'not-current'])
  })

  it('stops the batch on request, cancels its Session, and dispatches nothing more', async () => {
    const gateway = new FakeGateway()
    const { test, workdir } = await setup(gateway)
    const { service } = test
    const { planId } = await seedPlan(service, workdir, ['First', 'Second'])
    gateway.holdIdle = true

    await service.startRun({ planId })
    await waitFor(() => gateway.prompts.length === 1, 'first task did not start')

    const stopped = await service.stopRun()
    expect(stopped).toMatchObject({ stopped: true, code: 'ok' })
    expect(gateway.cancelled).toEqual(['se-fake-1'])
    const stoppedSnapshot = await service.snapshot()
    expect(stoppedSnapshot.run).toMatchObject({ status: 'stopped', currentTaskId: null })
    expect(stoppedSnapshot.tasks[0]?.status).toBe('stopped')

    gateway.releaseAll()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(gateway.prompts).toHaveLength(1)
    expect(gateway.created).toHaveLength(1)
    expect((await service.snapshot()).tasks[1]?.status).toBe('pending')
  })

  it('reports no run when asked to stop an idle board and refuses a second start', async () => {
    const gateway = new FakeGateway()
    const { test, workdir } = await setup(gateway)
    const { service } = test
    const { planId } = await seedPlan(service, workdir, ['First'])

    expect(await service.stopRun()).toMatchObject({ stopped: false, code: 'no-run' })

    gateway.holdIdle = true
    gateway.onPrompt = async (sessionId, text) => {
      await service.submitTaskResult({ taskId: taskIdOf(text), outcome: 'done', summary: 'ok', files: [] }, sessionId)
    }
    await service.startRun({ planId })
    await waitFor(() => gateway.prompts.length === 1, 'first task did not start')
    const second = await service.startRun({ planId })
    expect(second).toMatchObject({ started: false, code: 'run-active' })
    await service.stopRun()
    gateway.releaseAll()
  })

  it('halts when the task Session itself fails', async () => {
    const gateway = new FakeGateway()
    const { test, workdir } = await setup(gateway)
    const { service } = test
    const { planId } = await seedPlan(service, workdir, ['First', 'Second'])
    gateway.onPrompt = async () => { throw new Error('provider unreachable') }

    await service.startRun({ planId })
    await waitFor(async () => (await service.snapshot()).run?.status === 'stopped', 'batch did not halt')

    const snapshot = await service.snapshot()
    expect(snapshot.tasks[0]).toMatchObject({ status: 'failed' })
    expect(snapshot.tasks[0]?.message).toContain('provider unreachable')
    expect(snapshot.tasks[1]?.status).toBe('pending')
  })

  it('refuses a plan working directory that is not an absolute existing directory', async () => {
    const gateway = new FakeGateway()
    const { test, workdir } = await setup(gateway)
    const { service } = test
    const { planId } = await seedPlan(service, workdir, ['First'])
    await rejectionCode(service.updateItem({ id: planId, workdir: 'relative/path' }), 'invalid-workdir')
    await service.updateItem({ id: planId, workdir: join(tmpdir(), 'mrw-not-here-0000') })
    expect(await service.startRun({ planId })).toMatchObject({ started: false, code: 'invalid-workdir' })
  })

  it('refuses to start a plan that has no working directory yet', async () => {
    const gateway = new FakeGateway()
    const { test } = await setup(gateway)
    const { service } = test
    const { planId } = await seedPlan(service, undefined, ['First'])
    expect(await service.startRun({ planId })).toMatchObject({ started: false, code: 'missing-workdir' })
  })

  it('refuses editing a task the running batch dispatches', async () => {
    const gateway = new FakeGateway()
    const { test, workdir } = await setup(gateway)
    const { service } = test
    const { planId, taskIds } = await seedPlan(service, workdir, ['First', 'Second'])
    gateway.holdIdle = true

    await service.startRun({ planId })
    await waitFor(() => gateway.prompts.length === 1, 'first task did not start')
    await rejectionCode(service.updateTask({ id: taskIds[0] as string, title: 'Rewritten' }), 'run-active')
    await rejectionCode(service.deleteTask({ id: taskIds[1] as string }), 'run-active')
    await rejectionCode(service.deleteItem({ id: planId }), 'run-active')
    await service.stopRun()
    gateway.releaseAll()
  })

  it('reports a batch left running by an exited process as interrupted, without resuming it', async () => {
    const gateway = new FakeGateway()
    const { test, workdir } = await setup(gateway)
    const { service } = test
    const { planId } = await seedPlan(service, workdir, ['First', 'Second'])
    gateway.holdIdle = true

    await service.startRun({ planId })
    await waitFor(() => gateway.prompts.length === 1, 'first task did not start')
    const running = await service.snapshot()
    expect(running.run).toMatchObject({ status: 'running' })
    expect(running.tasks[0]?.status).toBe('running')

    // Simulate the process losing the run: the next mount reads the stored document.
    const pool = test.pool
    await test.ctx.fiber.dispose()
    gateway.releaseAll()

    const second = await harness({ service: serviceClass(new FakeGateway()), pool })
    tests.push(second)
    const recovered = await second.service.snapshot()
    expect(recovered.run).toMatchObject({ status: 'interrupted', currentTaskId: null })
    expect(recovered.tasks[0]).toMatchObject({ status: 'stopped', message: 'The application exited during this task.' })
    expect(recovered.tasks[1]?.status).toBe('pending')
  })

  it('refuses a done result while a declared required artifact is missing, then accepts it once present', async () => {
    const { writeFile } = await import('node:fs/promises')
    const gateway = new FakeGateway()
    const { test, workdir } = await setup(gateway)
    const { service } = test
    const seeded = await service.addItem({ title: 'Weekly report', workdir })
    const planId = seeded.items[0]?.id ?? ''
    const added = await service.addTask({
      planId,
      title: 'Gather data',
      requirement: 'summary.csv lists both means',
      requestedFiles: ['summary.csv'],
    })
    const taskId = added.tasks[0]?.id ?? ''
    const codes: string[] = []
    let attempt = 0
    gateway.onPrompt = async (sessionId, text) => {
      attempt += 1
      if (attempt === 1) {
        codes.push((await service.submitTaskResult({ taskId: taskIdOf(text), outcome: 'done', summary: 'claimed', files: [] }, sessionId)).code)
        return
      }
      await writeFile(join(workdir, 'summary.csv'), 'group,mean\nA,12\nB,22\n', 'utf8')
      codes.push((await service.submitTaskResult({ taskId: taskIdOf(text), outcome: 'done', summary: 'wrote summary', files: [] }, sessionId)).code)
    }

    await service.startRun({ planId })
    await waitFor(async () => (await service.snapshot()).run?.status === 'stopped', 'first attempt did not halt')
    const first = await service.snapshot()
    expect(codes).toEqual(['missing-required-files'])
    expect(first.tasks[0]?.status).toBe('needs_user')

    await service.startRun({ planId, taskId })
    await waitFor(async () => (await service.snapshot()).run?.status === 'done', 'second attempt did not finish')
    const second = await service.snapshot()
    expect(codes).toEqual(['missing-required-files', 'ok'])
    expect(second.tasks[0]?.status).toBe('done')
  })

  it('reports a stored task Session that can no longer be opened instead of replacing it', async () => {
    const gateway = new FakeGateway()
    const { test, workdir } = await setup(gateway)
    const { service } = test
    const { planId } = await seedPlan(service, workdir, ['First'])

    // The first attempt creates the task's Session but submits no result.
    await service.startRun({ planId })
    await waitFor(async () => (await service.snapshot()).run?.status === 'stopped', 'first attempt did not halt')
    const sessionId = (await service.snapshot()).tasks[0]?.sessionId
    if (sessionId === null || sessionId === undefined) throw new Error('expected the task to keep its Session')
    gateway.missingSessions.add(sessionId)
    const promptsBefore = gateway.prompts.length
    const taskId = (await service.snapshot()).tasks[0]?.id as string

    const start = await service.startRun({ planId, taskId })
    expect(start.started).toBe(true)
    await waitFor(async () => (await service.snapshot()).run?.status === 'stopped', 'second attempt did not halt')

    const snapshot = await service.snapshot()
    expect(snapshot.tasks[0]?.status).toBe('needs_user')
    expect(snapshot.tasks[0]?.message).toContain('deleted or is unavailable')
    // No replacement Session was created and nothing was prompted.
    expect(gateway.prompts.length).toBe(promptsBefore)
    expect(gateway.created).toHaveLength(1)
  })
})
