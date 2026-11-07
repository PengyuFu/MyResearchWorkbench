/**
 * Serial execution of one plan's tasks over ordinary Harness Sessions.
 *
 * A batch is durable state on the plan board, not a process-local queue: the
 * cursor, the current task, and every submitted result live in the stored
 * document, and the engine reads them back before each step. That is what makes
 * "only advance after the current turn ended with a matching result" hold across
 * user actions in other windows: a stop writes the batch as stopped, and the
 * next step of the loop observes it instead of dispatching.
 *
 * The engine owns no timer, no model client, and no Session lifecycle. It asks a
 * {@link PlanRunSessionGateway} to create a Session, prompt it, wait for idle,
 * and cancel it, so a test can drive the same state machine with a fake.
 * @module @deepseek-ai/dsh-personal-plan/engine
 */

import type { PlanDocument } from './storage.ts'
import type { PlanItem, PlanRun, PlanTask, PlanTaskOutcome } from './types.ts'

/** Session operations one batch needs from the Host; the service binds these to the Session Controller. */
export interface PlanRunSessionGateway {
  /**
   * Create one ordinary Session in a working directory.
   * @param cwd - absolute working directory the Session owns.
   * @returns the durable Session identity.
   */
  createSession(cwd: string): Promise<string>
  /**
   * Send one task instruction to a Session as a user message.
   * @param sessionId - target Session.
   * @param text - instruction text.
   * @returns acceptance of the queued message.
   */
  prompt(sessionId: string, text: string): Promise<void>
  /**
   * Resolve after the Session's active work reaches quiescence.
   * @param sessionId - Session to observe.
   */
  waitIdle(sessionId: string): Promise<void>
  /**
   * Cancel the Session's active work; failures are the caller's to report.
   * @param sessionId - Session to cancel.
   */
  cancel(sessionId: string): Promise<void>
  /**
   * Whether a stored Session can still be opened.
   *
   * A missing Session is reported instead of being replaced: the batch must not
   * silently re-execute work whose conversation and artifacts the user can no
   * longer see.
   * @param sessionId - Session to check.
   * @returns whether the Session still exists or can be resumed.
   */
  sessionAvailable(sessionId: string): Promise<boolean>
}

/** Prior task artifact one later task is told about. */
export interface PlanRunPriorResult {
  /** Task title that produced the artifacts. */
  readonly title: string
  /** Submitted summary. */
  readonly summary: string
  /** Submitted absolute artifact paths. */
  readonly files: readonly string[]
}

/** Everything the prompt renderer needs for one dispatched task. */
export interface PlanRunPromptContext {
  /** The plan the batch was started from. */
  readonly plan: PlanItem
  /** Task about to run. */
  readonly task: PlanTask
  /** The fixed batch. */
  readonly run: PlanRun
  /** Results of the tasks this batch already completed, in dispatch order. */
  readonly prior: readonly PlanRunPriorResult[]
}

/** Collaborators the engine needs; all durable state stays in the board document. */
export interface PlanRunEngineOptions {
  readonly gateway: PlanRunSessionGateway
  /** Read the current authoritative document, without starting a write. */
  readonly read: () => Promise<PlanDocument>
  /**
   * Apply one transition and publish it.
   * @param work - pure document transform.
   */
  readonly update: (work: (doc: PlanDocument) => PlanDocument) => Promise<void>
  /**
   * Render the instruction sent to one task's Session.
   * @param context - plan, task, batch, and prior results.
   * @returns the prompt text.
   */
  readonly renderPrompt: (context: PlanRunPromptContext) => string
  /**
   * Report artifact paths that do not exist.
   * @param files - submitted absolute paths.
   * @returns the missing paths, in submission order.
   */
  readonly missingFiles: (files: readonly string[]) => Promise<readonly string[]>
  /**
   * Report declared required artifacts that do not exist.
   * @param workdir - batch working directory relative paths resolve against.
   * @param files - declared paths, possibly relative.
   * @returns the missing paths, in declaration order.
   */
  readonly missingRequestedFiles: (workdir: string, files: readonly string[]) => Promise<readonly string[]>
  /** Host logger for contained failures. */
  readonly logger: { warn(message: string): void }
}

/** One batch's stopping cause. */
export type PlanRunHaltReason = 'user' | 'exit'

/** Statuses a dispatched task can end in without a submitted result. */
const NO_RESULT_MESSAGE = 'No task result was submitted; review the Session and continue.'

/**
 * The serial batch state machine. At most one batch drives at a time; the
 * service enforces that by rejecting a second start while the stored batch is
 * running.
 */
export class PlanRunEngine {
  private readonly options: PlanRunEngineOptions
  private driving: Promise<void> | undefined
  private stopRequested = false
  private stoppingSessionId: string | null = null

  /**
   * @param options - Session gateway, state access, prompt rendering, and artifact checks.
   */
  constructor(options: PlanRunEngineOptions) {
    this.options = options
  }

  /**
   * Start dispatching one stored batch. Returns immediately; the batch runs until
   * it finishes, halts on a task outcome, or is stopped.
   * @param runId - identity of the batch the service already committed.
   */
  start(runId: string): void {
    this.stopRequested = false
    this.stoppingSessionId = null
    const driving = this.drive(runId)
    this.driving = driving
    void driving.catch((error: unknown) => {
      this.options.logger.warn(`personal-plan: task batch ${runId} stopped unexpectedly: ${String(error)}`)
    }).finally(() => {
      if (this.driving === driving) this.driving = undefined
    })
  }

  /**
   * Stop the batch: cancel the Session working now and record the stop durably.
   * @param reason - user stop, or application exit while the batch ran.
   */
  async stop(reason: PlanRunHaltReason): Promise<void> {
    this.stopRequested = true
    const sessionId = this.stoppingSessionId
    const message = reason === 'user' ? 'Stopped by the user.' : 'The application exited during this task.'
    await this.options.update((doc) => {
      const run = doc.run
      if (run === null || run.status !== 'running') return doc
      const now = new Date().toISOString()
      const tasks = doc.tasks.map((task) => {
        if (task.id !== run.currentTaskId || task.status !== 'running') return task
        return { ...task, status: 'stopped' as const, message, updatedAt: now }
      })
      return {
        ...doc,
        revision: doc.revision + 1,
        tasks,
        run: { ...run, status: 'stopped' as const, currentTaskId: null, message, updatedAt: now },
        updatedAt: now,
      }
    })
    if (sessionId !== null) {
      try {
        await this.options.gateway.cancel(sessionId)
      } catch (error: unknown) {
        this.options.logger.warn(`personal-plan: cancelling task session ${sessionId} failed: ${String(error)}`)
      }
      this.stoppingSessionId = null
    }
  }

  /**
   * Wait for the driving loop to settle; used by teardown and tests.
   * @returns settlement of the current batch, or immediately when idle.
   */
  async settle(): Promise<void> {
    await this.driving?.catch(() => undefined)
  }

  /**
   * The dispatch loop: one task at a time, each step re-read from the document.
   * @param runId - batch to drive.
   */
  private async drive(runId: string): Promise<void> {
    const { read, update, gateway, renderPrompt } = this.options
    const initial = await read()
    const initialRun = initial.run
    if (initialRun === null || initialRun.runId !== runId) return
    const plan = initial.items.find(item => item.id === initialRun.planId)
    if (plan === undefined) {
      await this.halt('stopped', 'The plan of this batch no longer exists.')
      return
    }
    const prior: PlanRunPriorResult[] = []
    for (const taskId of initialRun.taskIds) {
      if (this.stopRequested) return
      const before = await read()
      const run = before.run
      if (run === null || run.runId !== runId || run.status !== 'running') return
      const task = before.tasks.find(candidate => candidate.id === taskId)
      if (task === undefined) {
        await this.halt('stopped', 'A task of this batch no longer exists.')
        return
      }
      // A stored Session that can no longer be opened is reported, never replaced:
      // re-running would hide that the user's original conversation is gone.
      if (task.sessionId !== null && !await gateway.sessionAvailable(task.sessionId)) {
        await this.halt(
          'stopped',
          'The task Session was deleted or is unavailable. Open the task, clear its Session, or create a new task.',
          taskId,
          'needs_user',
        )
        return
      }
      const sessionId = task.sessionId ?? await gateway.createSession(run.workdir)
      if (task.sessionId === null) {
        await update(doc => withTask(doc, taskId, current => ({ ...current, sessionId, updatedAt: nowIso() })))
      }
      await update(doc => withTask(doc, taskId, current => ({
        ...current,
        status: 'running',
        result: null,
        message: '',
        updatedAt: nowIso(),
      }), run => ({ ...run, currentTaskId: taskId, updatedAt: nowIso() })))
      this.stoppingSessionId = sessionId
      const dispatch = (await read()).tasks.find(candidate => candidate.id === taskId) ?? task
      try {
        await gateway.prompt(sessionId, renderPrompt({ plan, task: dispatch, run, prior }))
        await gateway.waitIdle(sessionId)
      } catch (error: unknown) {
        this.stoppingSessionId = null
        // A stop during the await already recorded the stop; only a genuine
        // Session failure halts the batch here.
        if (this.stopRequested) return
        await this.halt('stopped', `The task Session failed: ${describeError(error)}`, taskId, 'failed')
        return
      }
      this.stoppingSessionId = null
      const after = await read()
      const settledRun = after.run
      if (settledRun === null || settledRun.runId !== runId || settledRun.status !== 'running') return
      const settled = after.tasks.find(candidate => candidate.id === taskId)
      if (settled === undefined) {
        await this.halt('stopped', 'A task of this batch no longer exists.')
        return
      }
      const outcome = await this.evaluate({ settled, taskId })
      if (outcome === 'completed') {
        prior.push({
          title: settled.title,
          summary: settled.result?.summary ?? '',
          files: settled.result?.files ?? [],
        })
        continue
      }
      if (outcome === 'stopped' || outcome === 'failed') return
      return
    }
    await update((doc) => {
      const run = doc.run
      if (run === null || run.runId !== runId || run.status !== 'running') return doc
      return {
        ...doc,
        revision: doc.revision + 1,
        run: {
          ...run,
          status: 'done',
          currentTaskId: null,
          message: '',
          updatedAt: nowIso(),
        },
        updatedAt: nowIso(),
      }
    })
  }

  /**
   * Decide what one finished task means and record it.
   *
   * Only a result submitted against this batch and this task counts. A missing
   * result, unmet artifacts, `needs_user`, or `failed` all end the batch; nothing
   * advances on "the model stopped talking".
   * @param input - the settled task as the document holds it.
   * @returns whether the batch continues, and how it otherwise ended.
   */
  private async evaluate(input: { settled: PlanTask; taskId: string }): Promise<'completed' | 'halted' | 'stopped' | 'failed'> {
    const { settled } = input
    const result = settled.result
    if (result === null) {
      await this.halt('stopped', NO_RESULT_MESSAGE, input.taskId, 'needs_user')
      return 'stopped'
    }
    switch (result.outcome) {
      case 'done': {
        const missing = await this.options.missingFiles(result.files)
        if (missing.length > 0) {
          await this.halt('stopped', `The declared artifacts are missing: ${missing.join(', ')}`, input.taskId, 'failed')
          return 'failed'
        }
        const run = await this.options.read()
        const workdir = run.run?.workdir ?? ''
        const missingRequired = await this.options.missingRequestedFiles(workdir, settled.requestedFiles)
        if (missingRequired.length > 0) {
          await this.halt(
            'stopped',
            `The required artifacts are missing: ${missingRequired.join(', ')}`,
            input.taskId,
            'failed',
          )
          return 'failed'
        }
        await this.options.update((doc) => {
          const run = doc.run
          if (run === null || run.status !== 'running') return doc
          const now = nowIso()
          const tasks = doc.tasks.map((task) => {
            if (task.id !== input.taskId) return task
            return { ...task, status: 'done' as const, message: result.summary, updatedAt: now }
          })
          return { ...doc, revision: doc.revision + 1, tasks, updatedAt: now }
        })
        return 'completed'
      }
      case 'needs_user':
        await this.halt('stopped', result.summary, input.taskId, 'needs_user')
        return 'stopped'
      case 'failed':
        await this.halt('stopped', result.summary, input.taskId, 'failed')
        return 'failed'
      default:
        return 'halted'
    }
  }

  /**
   * Record a batch halt with the task state the user must see.
   * @param status - batch state to store.
   * @param message - reason shown beside the task.
   * @param taskId - task to close, when one was dispatching.
   * @param taskStatus - task state to store.
   */
  private async halt(
    status: 'stopped' | 'done',
    message: string,
    taskId?: string,
    taskStatus: Extract<PlanTaskOutcome, 'needs_user' | 'failed'> | 'stopped' = 'stopped',
  ): Promise<void> {
    await this.options.update((doc) => {
      const run = doc.run
      if (run === null || run.status !== 'running') return doc
      const now = nowIso()
      const tasks = doc.tasks.map((task) => {
        if (taskId === undefined || task.id !== taskId) return task
        return { ...task, status: taskStatus, message, updatedAt: now }
      })
      return {
        ...doc,
        revision: doc.revision + 1,
        tasks,
        run: { ...run, status, currentTaskId: null, message, updatedAt: now },
        updatedAt: now,
      }
    })
  }
}

/** Current instant, RFC 3339 UTC. */
function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Replace one task, and optionally the batch, in one document transition.
 * @param doc - current document.
 * @param taskId - task to replace.
 * @param change - transform of that task.
 * @param runChange - optional transform of the batch.
 * @returns the next document, or the same document when the task is absent.
 */
function withTask(
  doc: PlanDocument,
  taskId: string,
  change: (task: PlanTask) => PlanTask,
  runChange?: (run: PlanRun) => PlanRun,
): PlanDocument {
  const index = doc.tasks.findIndex(task => task.id === taskId)
  const run = doc.run
  if (index === -1) return doc
  const tasks = doc.tasks.slice()
  tasks[index] = change(tasks[index] as PlanTask)
  return {
    ...doc,
    revision: doc.revision + 1,
    tasks,
    run: run !== null && runChange !== undefined ? runChange(run) : run,
    updatedAt: nowIso(),
  }
}

/**
 * Short English description of a caught failure.
 * @param error - caught value.
 * @returns the description.
 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
