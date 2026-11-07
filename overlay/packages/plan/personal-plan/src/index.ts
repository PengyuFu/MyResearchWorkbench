/**
 * Host-wide personal plan board: durable plan and task management, model tools
 * that only draft changes or submit one task result, the client Remote API whose
 * apply step requires user confirmation, and the serial task execution engine.
 *
 * The board is one user-level document, independent of Sessions and workspaces.
 * Manual edits from the browser save directly through the Remote methods below.
 * Model-visible tools can only read the board, attach a proposal, or submit the
 * result of the task it is executing; applying a proposal is a separate method
 * the client calls after the user confirms the preview, and it refuses when the
 * board changed since the proposal was built.
 *
 * Execution composes existing Harness capabilities: one ordinary Session per
 * task, the Session Controller for creation, prompting, idle completion, and
 * cancellation, and the {@link PlanRunEngine} state machine for the serial
 * cursor. No timer, scheduler, or model routing is added here.
 *
 * @module @deepseek-ai/dsh-personal-plan
 */

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { personalPlanDomain } from './storage.ts'
import type { PlanDocument } from './storage.ts'
import { PlanRunEngine } from './engine.ts'
import type { PlanRunPromptContext, PlanRunSessionGateway } from './engine.ts'
import {
  MAX_TASKS_PER_PLAN,
  isTaskUnfinished,
  nextTaskOrder,
  normalizeTaskDetail,
  normalizeTaskDraft,
  normalizeTaskFiles,
  normalizeTaskTitle,
  orderTasksForSnapshot,
  pendingTasksOfPlan,
  reorderTasksInPlan,
} from './tasks.ts'
import type {
  PlanAddItemRequest,
  PlanAddTaskRequest,
  PlanApplyProposalRequest,
  PlanApplyResult,
  PlanChangedEvent,
  PlanDeleteItemRequest,
  PlanDeleteTaskRequest,
  PlanDiscardProposalRequest,
  PlanItem,
  PlanItemDraft,
  PlanItemStatus,
  PlanProposal,
  PlanProposalChange,
  PlanProposeRequest,
  PlanProposedChangeInput,
  PlanReorderRequest,
  PlanReorderTasksRequest,
  PlanRequestPanelValue,
  PlanRevealSessionRequest,
  PlanRevealSessionValue,
  PlanRevealTaskRequest,
  PlanRevealTaskValue,
  PlanRun,
  PlanSetStatusRequest,
  PlanSnapshot,
  PlanStartRunRequest,
  PlanStartRunResult,
  PlanStopRunResult,
  PlanSubmitTaskResultRequest,
  PlanSubmitTaskResultResult,
  PlanTask,
  PlanTaskDraft,
  PlanTaskOutcome,
  PlanUpdateItemRequest,
  PlanUpdateTaskRequest,
} from './types.ts'

export type * from './types.ts'
export { personalPlanDomain, emptyPlanDocument } from './storage.ts'
export type { PlanDocument } from './storage.ts'
export { PlanRunEngine } from './engine.ts'
export type { PlanRunPromptContext, PlanRunSessionGateway } from './engine.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable Host-wide personal plan and task management. */
    personalPlan: PersonalPlanService
  }
}

const MAX_TITLE_LENGTH = 200
const MAX_NOTE_LENGTH = 4000
const MAX_WORKDIR_LENGTH = 1024
const MAX_ITEMS = 500
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Rejection carrying a stable code the client can explain. */
export class PersonalPlanError extends Error {
  /** Stable machine code for the rejection. */
  readonly code: string

  /**
   * @param code - stable rejection code.
   * @param message - actionable English description.
   */
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PersonalPlanError'
    this.code = code
  }
}

/** Durable Host-wide personal plan service, its three model tools, and the batch engine. */
export class PersonalPlanService extends TypertRemoteService {
  static inject = ['storageDomain', 'tools']

  private readonly ready: Promise<Domain<typeof personalPlanDomain>>
  private readonly initialized: PromiseLike<unknown>
  private chain: Promise<unknown> = Promise.resolve()
  private stopping = false
  private engine: PlanRunEngine | undefined

  /**
   * @param ctx - owning Host context.
   */
  constructor(ctx: Context) {
    super(ctx, 'personalPlan')
    this.ready = ctx.storageDomain.open(personalPlanDomain)
    this.initialized = ctx.effect(async () => {
      const domain = await this.ready
      try {
        const recovery = await this.recoverInterruptedRun(domain)
        return ctx.effect(() => async () => {
          this.stopping = true
          await this.engine?.stop('exit').catch(() => undefined)
          await recovery
          await this.chain
          await domain.close()
        })
      } catch (error: unknown) {
        this.stopping = true
        await domain.close()
        throw error
      }
    })
    ctx.effect(() => this.registerTools(), 'personal-plan: model tools')
  }

  async [Service.init](): Promise<void> {
    await this.initialized
  }

  /**
   * Read the current board without changing it.
   * @returns the authoritative snapshot.
   */
  @Remote('snapshot')
  async snapshot(): Promise<PlanSnapshot> {
    const domain = await this.getDomain()
    return snapshotOf(domain.global.get())
  }

  /**
   * Append one plan item to the end of the incomplete list.
   * @param request - required title plus optional note and calendar date.
   * @returns the snapshot after the durable write.
   */
  @Remote('addItem')
  async addItem(request: PlanAddItemRequest): Promise<PlanSnapshot> {
    return this.mutate(async (doc) => {
      if (doc.items.length >= MAX_ITEMS) throw new PersonalPlanError('too-many-items', `The plan is limited to ${String(MAX_ITEMS)} items.`)
      const now = new Date().toISOString()
      const draft = normalizeDraft(request, '')
      const item: PlanItem = {
        id: `pl-${randomUUID()}`,
        ...draft,
        status: 'todo',
        order: nextOrder(doc.items),
        createdAt: now,
        updatedAt: now,
      }
      return { ...doc, items: [...doc.items, item], revision: doc.revision + 1, updatedAt: now }
    })
  }

  /**
   * Edit one plan item's title, note, or calendar date; omitted fields keep their value.
   * @param request - target identity and the fields to replace.
   * @returns the snapshot after the durable write.
   */
  @Remote('updateItem')
  async updateItem(request: PlanUpdateItemRequest): Promise<PlanSnapshot> {
    return this.mutate(async (doc) => {
      const index = doc.items.findIndex(item => item.id === request.id)
      if (index === -1) throw new PersonalPlanError('missing-item', 'The item no longer exists.')
      const current = doc.items[index] as PlanItem
      const title = request.title === undefined ? current.title : normalizeTitle(request.title)
      const note = request.note === undefined ? current.note : normalizeNote(request.note)
      const dueDate = request.dueDate === undefined ? current.dueDate : normalizeDueDate(request.dueDate)
      const workdir = request.workdir === undefined ? current.workdir : normalizeWorkdir(request.workdir)
      const now = new Date().toISOString()
      const items = doc.items.slice()
      items[index] = { ...current, title, note, dueDate, workdir, updatedAt: now }
      return { ...doc, items, revision: doc.revision + 1, updatedAt: now }
    })
  }

  /**
   * Delete one plan item and every task that belongs to it.
   *
   * The plan's Harness Sessions and generated files survive: only the board
   * records go away. A plan taking part in the running batch must be stopped
   * first, so a deleted target never receives the next dispatch.
   * @param request - identity of the item to delete.
   * @returns the snapshot after the durable write.
   */
  @Remote('deleteItem')
  async deleteItem(request: PlanDeleteItemRequest): Promise<PlanSnapshot> {
    return this.mutate(async (doc) => {
      if (!doc.items.some(item => item.id === request.id)) {
        throw new PersonalPlanError('missing-item', 'The item no longer exists.')
      }
      requireStoppedBatchFor(doc, task => task.planId === request.id)
      const now = new Date().toISOString()
      return {
        ...doc,
        items: doc.items.filter(item => item.id !== request.id),
        tasks: doc.tasks.filter(task => task.planId !== request.id),
        revision: doc.revision + 1,
        updatedAt: now,
      }
    })
  }

  /**
   * Change one plan item's status: marking done moves it into the completed section,
   * and restoring it appends it to the end of the incomplete list.
   * @param request - target identity and status.
   * @returns the snapshot after the durable write.
   */
  @Remote('setStatus')
  async setStatus(request: PlanSetStatusRequest): Promise<PlanSnapshot> {
    return this.mutate(async (doc) => {
      const index = doc.items.findIndex(item => item.id === request.id)
      if (index === -1) throw new PersonalPlanError('missing-item', 'The item no longer exists.')
      const current = doc.items[index] as PlanItem
      // A status that is already in force is not a change: writing it would bump
      // the revision and invalidate a pending proposal for nothing.
      if (current.status === request.status) return doc
      const now = new Date().toISOString()
      const items = doc.items.slice()
      items[index] = applyStatus(current, request.status, doc.items, now)
      return { ...doc, items, revision: doc.revision + 1, updatedAt: now }
    })
  }

  /**
   * Save a new order for the incomplete plan list. The completed section is untouched.
   * @param request - every incomplete item identity in the desired order.
   * @returns the snapshot after the durable write.
   */
  @Remote('reorder')
  async reorder(request: PlanReorderRequest): Promise<PlanSnapshot> {
    return this.mutate(async (doc) => {
      const items = reorderIncomplete(doc.items, request.order)
      const now = new Date().toISOString()
      return { ...doc, items, revision: doc.revision + 1, updatedAt: now }
    })
  }

  /**
   * Append one task to the end of its plan's task list.
   * @param request - owning plan, required title, and optional instruction, requirements, and artifacts.
   * @returns the snapshot after the durable write.
   */
  @Remote('addTask')
  async addTask(request: PlanAddTaskRequest): Promise<PlanSnapshot> {
    return this.mutate(async (doc) => {
      if (!doc.items.some(item => item.id === request.planId)) {
        throw new PersonalPlanError('missing-plan', 'The plan no longer exists.')
      }
      if (doc.tasks.filter(task => task.planId === request.planId).length >= MAX_TASKS_PER_PLAN) {
        throw new PersonalPlanError('too-many-tasks', `A plan is limited to ${String(MAX_TASKS_PER_PLAN)} tasks.`)
      }
      const now = new Date().toISOString()
      const draft = normalizeTaskRequest(request.title, request.detail, request.requirement, request.requestedFiles)
      const task: PlanTask = {
        id: `tk-${randomUUID()}`,
        planId: request.planId,
        ...draft,
        status: 'pending',
        order: nextTaskOrder(doc.tasks, request.planId),
        sessionId: null,
        result: null,
        message: '',
        createdAt: now,
        updatedAt: now,
      }
      return { ...doc, tasks: [...doc.tasks, task], revision: doc.revision + 1, updatedAt: now }
    })
  }

  /**
   * Edit one task's title, instruction, completion requirements, or required
   * artifacts; omitted fields keep their value.
   *
   * The task taking part in the running batch is refused: the batch fixed its
   * list and instruction at start, so the target of the running work cannot be
   * swapped underneath it. Stop the batch to edit and restart.
   * @param request - target identity and the fields to replace.
   * @returns the snapshot after the durable write.
   */
  @Remote('updateTask')
  async updateTask(request: PlanUpdateTaskRequest): Promise<PlanSnapshot> {
    return this.mutate(async (doc) => {
      const index = doc.tasks.findIndex(task => task.id === request.id)
      if (index === -1) throw new PersonalPlanError('missing-task', 'The task no longer exists.')
      requireStoppedBatchFor(doc, task => task.id === request.id)
      const current = doc.tasks[index] as PlanTask
      const title = request.title === undefined ? current.title : normalizeTaskTitle(request.title)
      const detail = request.detail === undefined ? current.detail : normalizeTaskDetail(request.detail)
      const requirement = request.requirement === undefined
        ? current.requirement
        : normalizeTaskDetail(request.requirement)
      const requestedFiles = request.requestedFiles === undefined
        ? current.requestedFiles
        : normalizeTaskRequestFiles(request.requestedFiles)
      const now = new Date().toISOString()
      const tasks = doc.tasks.slice()
      tasks[index] = { ...current, title, detail, requirement, requestedFiles, updatedAt: now }
      return { ...doc, tasks, revision: doc.revision + 1, updatedAt: now }
    })
  }

  /**
   * Delete one task; its Harness Session and generated files stay.
   * @param request - identity of the task to delete.
   * @returns the snapshot after the durable write.
   */
  @Remote('deleteTask')
  async deleteTask(request: PlanDeleteTaskRequest): Promise<PlanSnapshot> {
    return this.mutate(async (doc) => {
      if (!doc.tasks.some(task => task.id === request.id)) {
        throw new PersonalPlanError('missing-task', 'The task no longer exists.')
      }
      requireStoppedBatchFor(doc, task => task.id === request.id)
      const now = new Date().toISOString()
      return {
        ...doc,
        tasks: doc.tasks.filter(task => task.id !== request.id),
        revision: doc.revision + 1,
        updatedAt: now,
      }
    })
  }

  /**
   * Save a new task order inside one plan.
   * @param request - owning plan and every task identity of it in the desired order.
   * @returns the snapshot after the durable write.
   */
  @Remote('reorderTasks')
  async reorderTasks(request: PlanReorderTasksRequest): Promise<PlanSnapshot> {
    return this.mutate(async (doc) => {
      if (!doc.items.some(item => item.id === request.planId)) {
        throw new PersonalPlanError('missing-plan', 'The plan no longer exists.')
      }
      requireStoppedBatchFor(doc, task => task.planId === request.planId)
      let tasks: PlanTask[]
      try {
        tasks = reorderTasksInPlan(doc.tasks, request.planId, request.order)
      } catch (error: unknown) {
        throw new PersonalPlanError('invalid-order', error instanceof Error ? error.message : 'Invalid task order.')
      }
      const now = new Date().toISOString()
      return { ...doc, tasks, revision: doc.revision + 1, updatedAt: now }
    })
  }

  /**
   * Apply the changes the user kept selected in one proposal preview.
   *
   * The whole application is persisted as one write. Nothing is applied when the
   * board revision moved since the proposal was built, when the proposal is gone,
   * or when the selection no longer matches the current board.
   * @param request - proposal identity and the kept change identities.
   * @returns whether anything was applied plus the authoritative snapshot.
   */
  @Remote('applyProposal')
  async applyProposal(request: PlanApplyProposalRequest): Promise<PlanApplyResult> {
    const domain = await this.getDomain()
    return this.serialize(async () => {
      const doc = domain.global.get()
      const proposal = doc.proposal
      if (proposal === null || proposal.proposalId !== request.proposalId) {
        return { applied: false, code: 'missing-proposal', snapshot: snapshotOf(doc) }
      }
      if (proposal.baseRevision !== doc.revision) {
        return { applied: false, code: 'stale', snapshot: snapshotOf(doc) }
      }
      const selected = new Set(request.changeIds)
      const changes = proposal.changes.filter(change => selected.has(change.changeId))
      if (changes.length === 0) return { applied: false, code: 'nothing-selected', snapshot: snapshotOf(doc) }
      const now = new Date().toISOString()
      let board: { items: readonly PlanItem[]; tasks: readonly PlanTask[] } = { items: doc.items, tasks: doc.tasks }
      for (const change of changes) board = applyChange(board, change, now)
      const next: PlanDocument = {
        version: 1,
        revision: doc.revision + 1,
        items: board.items,
        tasks: board.tasks,
        proposal: null,
        run: doc.run,
        updatedAt: now,
      }
      await domain.global.set(next)
      this.emitChanged(next)
      return { applied: true, code: 'ok', snapshot: snapshotOf(next) }
    })
  }

  /**
   * Discard the pending proposal without touching the board content.
   * @param request - identity of the proposal shown in the preview.
   * @returns the snapshot after the durable write.
   */
  @Remote('discardProposal')
  async discardProposal(request: PlanDiscardProposalRequest): Promise<PlanSnapshot> {
    const domain = await this.getDomain()
    return this.serialize(async () => {
      const doc = domain.global.get()
      if (doc.proposal === null || doc.proposal.proposalId !== request.proposalId) {
        return snapshotOf(doc)
      }
      const next: PlanDocument = { ...doc, proposal: null }
      await domain.global.set(next)
      this.emitChanged(next)
      return snapshotOf(next)
    })
  }

  /**
   * Start one batch: the named task alone, or every pending task of the plan in order.
   *
   * The batch fixes its task list and the plan's working directory now; later board
   * edits are refused for the tasks it dispatches, so the target cannot change while
   * the work runs. The plan owns that directory, so every batch of the plan starts
   * in the same place. Only one batch runs at a time.
   * @param request - plan and optional single task.
   * @returns whether a batch started plus the authoritative snapshot.
   */
  @Remote('startRun')
  async startRun(request: PlanStartRunRequest): Promise<PlanStartRunResult> {
    const domain = await this.getDomain()
    return this.serialize(async () => {
      const doc = domain.global.get()
      if (doc.run !== null && doc.run.status === 'running') {
        return { started: false, code: 'run-active', snapshot: snapshotOf(doc) }
      }
      const plan = doc.items.find(item => item.id === request.planId)
      if (plan === undefined) return { started: false, code: 'missing-plan', snapshot: snapshotOf(doc) }
      if (plan.workdir.trim() === '') {
        return { started: false, code: 'missing-workdir', snapshot: snapshotOf(doc) }
      }
      let workdir: string
      try {
        workdir = await resolveWorkdir(plan.workdir)
      } catch {
        return { started: false, code: 'invalid-workdir', snapshot: snapshotOf(doc) }
      }
      let taskIds: readonly string[]
      if (request.taskId === undefined) {
        taskIds = pendingTasksOfPlan(doc.tasks, plan.id).map(task => task.id)
      } else {
        const task = doc.tasks.find(candidate => candidate.id === request.taskId)
        if (task === undefined || task.planId !== plan.id) {
          return { started: false, code: 'missing-task', snapshot: snapshotOf(doc) }
        }
        if (!isTaskUnfinished(task)) return { started: false, code: 'nothing-to-run', snapshot: snapshotOf(doc) }
        taskIds = [task.id]
      }
      if (taskIds.length === 0) return { started: false, code: 'nothing-to-run', snapshot: snapshotOf(doc) }
      const engine = this.ensureEngine()
      if (engine === null) throw new PersonalPlanError('execution-unavailable', 'Task execution needs the Session Controller service.')
      const now = new Date().toISOString()
      const run: PlanRun = {
        runId: `rn-${randomUUID()}`,
        planId: plan.id,
        taskIds,
        workdir,
        status: 'running',
        currentTaskId: null,
        message: '',
        startedAt: now,
        updatedAt: now,
      }
      const next: PlanDocument = { ...doc, run, revision: doc.revision + 1, updatedAt: now }
      await domain.global.set(next)
      this.emitChanged(next)
      engine.start(run.runId)
      return { started: true, code: 'ok', snapshot: snapshotOf(next) }
    })
  }

  /**
   * Stop the running batch: cancel its current Session and dispatch nothing more.
   * @returns whether a batch was stopped plus the authoritative snapshot.
   */
  @Remote('stopRun')
  async stopRun(): Promise<PlanStopRunResult> {
    const domain = await this.getDomain()
    const doc = domain.global.get()
    if (doc.run === null || doc.run.status !== 'running') {
      return { stopped: false, code: 'no-run', snapshot: snapshotOf(doc) }
    }
    await this.engine?.stop('user')
    const after = await this.snapshot()
    return { stopped: true, code: 'ok', snapshot: after }
  }

  /**
   * Ask the main window to show one task Session.
   *
   * The plan window has no conversation surface of its own, so it never navigates
   * itself; this notification is what reaches the main window's client.
   * @param request - Session to reveal.
   * @returns acknowledgement that the request was broadcast.
   */
  @Remote('revealSession')
  async revealSession(request: PlanRevealSessionRequest): Promise<PlanRevealSessionValue> {
    try {
      this.ctx.emit('personal-plan/reveal-session', { sessionId: brandString<SessionId>(request.sessionId) })
    } catch (error: unknown) {
      this.ctx.logger.warn(`personal-plan: reveal-session listener failed: ${String(error)}`)
    }
    return { accepted: true }
  }

  /**
   * Open one task's Session in the main window, or report that it is gone.
   *
   * The Session's own existence is checked first so a deleted or unusable
   * Session is reported instead of opening a replacement conversation.
   * @param request - task whose Session should be shown.
   * @returns `ok`, `no-session`, `unavailable`, or `missing-task`.
   */
  @Remote('revealTaskSession')
  async revealTaskSession(request: PlanRevealTaskRequest): Promise<PlanRevealTaskValue> {
    const domain = await this.getDomain()
    const task = domain.global.get().tasks.find(candidate => candidate.id === request.taskId)
    if (task === undefined) return { code: 'missing-task' }
    if (task.sessionId === null) return { code: 'no-session' }
    const gateway = this.sessionGateway()
    if (gateway !== null && !await gateway.sessionAvailable(task.sessionId)) return { code: 'unavailable' }
    try {
      this.ctx.emit('personal-plan/reveal-session', { sessionId: brandString<SessionId>(task.sessionId) })
    } catch (error: unknown) {
      this.ctx.logger.warn(`personal-plan: reveal-session listener failed: ${String(error)}`)
    }
    return { code: 'ok' }
  }

  /**
   * Ask the main window to show the embedded plan board again.
   *
   * The floating window uses this when it is docked back: closing the window is
   * its own desktop action, and this notification is what reopens the panel.
   * @returns acknowledgement that the request was broadcast.
   */
  @Remote('requestPanel')
  async requestPanel(): Promise<PlanRequestPanelValue> {
    try {
      this.ctx.emit('personal-plan/panel-requested', { source: 'float' })
    } catch (error: unknown) {
      this.ctx.logger.warn(`personal-plan: panel-requested listener failed: ${String(error)}`)
    }
    return { accepted: true }
  }

  /**
   * Build a draft change set from the model's proposal, without changing the board.
   *
   * Not exposed as a Remote method: only the `plan_propose_changes` tool calls it,
   * and the client receives the proposal through its next snapshot read.
   * @param request - concrete changes in application order.
   * @returns the stored proposal waiting for confirmation.
   */
  async propose(request: PlanProposeRequest): Promise<PlanProposal> {
    const domain = await this.getDomain()
    return this.serialize(async () => {
      const doc = domain.global.get()
      const changes = buildProposalChanges(doc, request.changes)
      const now = new Date().toISOString()
      const proposal: PlanProposal = {
        proposalId: `pp-${randomUUID()}`,
        baseRevision: doc.revision,
        createdAt: now,
        changes,
      }
      const next: PlanDocument = { ...doc, proposal }
      await domain.global.set(next)
      this.emitChanged(next)
      return proposal
    })
  }

  /**
   * Record the result one executing Session submitted for the current task.
   *
   * Only a result that matches the running batch, its current task, and that
   * task's own Session is accepted; the status stays `running` until the Session
   * reaches idle, so the batch advances on a settled announcement, never a guess.
   * @param request - task identity, outcome, summary, and artifacts.
   * @param sessionId - Session that submitted the result, when known.
   * @returns whether the result was recorded and a code explaining a refusal.
   */
  async submitTaskResult(request: PlanSubmitTaskResultRequest, sessionId: string | null): Promise<PlanSubmitTaskResultResult> {
    const domain = await this.getDomain()
    return this.serialize(async () => {
      const doc = domain.global.get()
      const run = doc.run
      if (run === null || run.status !== 'running') return { recorded: false, code: 'no-run' }
      const task = doc.tasks.find(candidate => candidate.id === request.taskId)
      if (task === undefined || run.currentTaskId !== task.id) return { recorded: false, code: 'not-current' }
      if (sessionId !== null && task.sessionId !== sessionId) return { recorded: false, code: 'wrong-session' }
      const taskSessionId = task.sessionId ?? sessionId
      if (taskSessionId === null) return { recorded: false, code: 'wrong-session' }
      const files = request.files === undefined ? [] : request.files.map(file => file.trim()).filter(file => file !== '')
      if (request.outcome === 'done') {
        const missing = await missingFiles(files)
        if (missing.length > 0) return { recorded: false, code: 'missing-files' }
        const missingRequired = await missingRequestedFiles(run.workdir, task.requestedFiles)
        if (missingRequired.length > 0) return { recorded: false, code: 'missing-required-files' }
      }
      const now = new Date().toISOString()
      const summary = request.summary.trim()
      const tasks = doc.tasks.map((candidate) => {
        if (candidate.id !== task.id) return candidate
        return {
          ...candidate,
          message: summary,
          result: {
            outcome: request.outcome,
            summary,
            files,
            sessionId: taskSessionId,
            runId: run.runId,
            recordedAt: now,
          },
          updatedAt: now,
        }
      })
      const next: PlanDocument = { ...doc, tasks, revision: doc.revision + 1, updatedAt: now }
      await domain.global.set(next)
      this.emitChanged(next)
      return { recorded: true, code: 'ok' }
    })
  }

  private ensureEngine(): PlanRunEngine | null {
    if (this.engine !== undefined) return this.engine
    const gateway = this.sessionGateway()
    if (gateway === null) return null
    this.engine = new PlanRunEngine({
      gateway,
      read: async () => (await this.getDomain()).global.get(),
      update: async (work) => { await this.mutate(async doc => work(doc)) },
      renderPrompt: context => renderTaskPrompt(context),
      missingFiles,
      missingRequestedFiles,
      logger: { warn: (message) => { this.ctx.logger.warn(message) } },
    })
    return this.engine
  }

  /**
   * Bind the Session operations one batch needs; a package test overrides this
   * to drive the same state machine without a Session Controller.
   * @returns the gateway, or null when the Host composes no Session Controller.
   */
  protected sessionGateway(): PlanRunSessionGateway | null {
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) return null
    return {
      createSession: async (cwd) => {
        const created = await controller.create({ cwd })
        return created.sessionId
      },
      prompt: async (sessionId, text) => {
        await controller.prompt({
          requestId: brandString<SessionRequestId>(`plr-${randomUUID()}`),
          sessionId: brandString<SessionId>(sessionId),
          mode: 'queue',
          content: [{ type: 'text', text }],
        }, new AbortController().signal)
      },
      waitIdle: async (sessionId) => {
        const resolved = await controller.resolveAgent(brandString<SessionId>(sessionId))
        if ('error' in resolved) throw resolved.error
        await resolved.agent.whenIdle()
      },
      cancel: async (sessionId) => {
        controller.cancel({ sessionId: brandString<SessionId>(sessionId) })
      },
      sessionAvailable: async (sessionId) => {
        try {
          const resolved = await controller.resolveAgent(brandString<SessionId>(sessionId))
          return !('error' in resolved)
        } catch {
          return false
        }
      },
    }
  }

  /**
   * Turn a batch left `running` by a previous process into a visible interruption.
   *
   * The exited process is gone; the board says so instead of pretending the last
   * task still runs or silently resuming it.
   * @param domain - opened storage domain.
   * @returns completion of the recovery write, when one was needed.
   */
  private async recoverInterruptedRun(domain: Domain<typeof personalPlanDomain>): Promise<void> {
    const doc = domain.global.get()
    const run = doc.run
    if (run === null || run.status !== 'running') return
    const now = new Date().toISOString()
    const message = 'The application exited during this task.'
    const tasks = doc.tasks.map(task => task.status !== 'running'
      ? task
      : { ...task, status: 'stopped' as const, message, updatedAt: now })
    const next: PlanDocument = {
      ...doc,
      revision: doc.revision + 1,
      tasks,
      run: { ...run, status: 'interrupted', currentTaskId: null, message, updatedAt: now },
      updatedAt: now,
    }
    await domain.global.set(next)
    this.emitChanged(next)
  }

  private async mutate(work: (doc: PlanDocument) => Promise<PlanDocument> | PlanDocument): Promise<PlanSnapshot> {
    const domain = await this.getDomain()
    return this.serialize(async () => {
      const current = domain.global.get()
      const next = await work(current)
      await domain.global.set(next)
      this.emitChanged(next)
      return snapshotOf(next)
    })
  }

  private async getDomain(): Promise<Domain<typeof personalPlanDomain>> {
    await this.initialized
    return this.ready
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new PersonalPlanError('stopping', 'The personal plan service is stopping.'))
    const pending = this.chain.then(work)
    this.chain = pending.catch(() => undefined)
    return pending
  }

  private emitChanged(doc: PlanDocument): void {
    const payload: PlanChangedEvent = { revision: doc.revision, proposalId: doc.proposal?.proposalId ?? null }
    try {
      this.ctx.emit('personal-plan/changed', payload)
    } catch (error: unknown) {
      this.ctx.logger.warn(`personal-plan: personal-plan/changed listener failed: ${String(error)}`)
    }
  }

  private registerTools(): () => void {
    const readTool = defineTool({
      name: 'plan_read',
      description:
        'Read the user\'s plan board: plans (a Host-wide list independent of this Session) and the tasks of each plan. '
        + 'Use it before proposing plan or task changes so ids, titles, notes, dates, statuses, order, and task ids are current. '
        + 'This tool never changes the board.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            revision: { type: 'integer', required: true },
            items: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  note: { type: 'string', required: true },
                  dueDate: { type: 'string', required: true },
                  workdir: { type: 'string', required: true },
                  status: { type: 'string', required: true, enum: ['todo', 'in_progress', 'done'] },
                  order: { type: 'integer', required: true },
                },
              },
            },
            tasks: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  planId: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  detail: { type: 'string', required: true },
                  requirement: { type: 'string', required: true },
                  requestedFiles: { type: 'array', required: true, items: { type: 'string' } },
                  status: { type: 'string', required: true, enum: ['pending', 'running', 'needs_user', 'done', 'stopped', 'failed'] },
                  order: { type: 'integer', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          if (value.items.length === 0) return [{ type: 'text', text: 'The plan board is empty.' }]
          const lines = value.items.map((item, index) => {
            const tasks = value.tasks.filter(task => task.planId === item.id)
            const taskLines = tasks.map(task =>
              `   - [${task.status}] ${task.title}${task.detail === '' ? '' : ` —${task.detail}`}`
              + (task.requirement === '' ? '' : ` (completion: ${task.requirement})`)
              + (task.requestedFiles.length === 0 ? '' : ` (required files: ${task.requestedFiles.join(', ')})`)
              + ` [task id=${task.id}]`)
            return `${String(index + 1)}. [${item.status}] ${item.title}`
              + (item.dueDate === '' ? '' : ` (due ${item.dueDate})`)
              + (item.workdir === '' ? '' : ` (workdir: ${item.workdir})`)
              + (item.note === '' ? '' : ` —${item.note}`)
              + ` [id=${item.id}]`
              + (taskLines.length === 0 ? '' : `\n${taskLines.join('\n')}`)
          })
          return [{
            type: 'text',
            text: `Plan board revision ${String(value.revision)}, ${String(value.items.length)} plan(s), `
              + `${String(value.tasks.length)} task(s):\n${lines.join('\n')}`,
          }]
        },
      },
      execute: async () => {
        const snapshot = await this.snapshot()
        return {
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
            requestedFiles: [...task.requestedFiles],
            status: task.status,
            order: task.order,
          })),
        }
      },
      presentCall: () => ({ card: 'generic', title: 'Read plan board', kind: 'other' }),
    })
    const proposeTool = defineTool({
      name: 'plan_propose_changes',
      description:
        'Draft changes to the user\'s plan board: add, edit, delete, change status, or reorder plans; '
        + 'and add, edit, delete, or reorder the tasks of one plan. '
        + 'This does NOT apply anything. It creates a preview the user must confirm in the plan panel; '
        + 'only the user\'s confirmation writes the board. Call plan_read first for current ids. '
        + 'Never tell the user their plan was changed by this call. '
        + 'Every task change needs `planId`; `task-add` also needs `title`; `task-edit` and `task-delete` need `taskId`; '
        + '`task-reorder` needs the complete desired task order in `taskOrder`. '
        + 'For a plan reorder change, pass the complete desired order of incomplete plan ids in `order`. '
        + 'To clear a due date, pass an empty string for `dueDate`.',
      parameters: {
        changes: {
          type: 'array',
          required: true,
          description: 'Concrete changes in application order.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: {
                type: 'string',
                required: true,
                enum: ['add', 'edit', 'delete', 'status', 'reorder', 'task-add', 'task-edit', 'task-delete', 'task-reorder'],
                description: 'One of the plan or task change kinds.',
              },
              planId: { type: 'string', description: 'Owning plan id for every task change.' },
              taskId: { type: 'string', description: 'Target task id for task-edit and task-delete.' },
              itemId: { type: 'string', description: 'Target plan id; required except for add.' },
              title: { type: 'string', description: 'Plan or task title: required for add and task-add, optional for edit.' },
              note: { type: 'string', description: 'Optional plan note text.' },
              detail: { type: 'string', description: 'Task execution instruction for task-add or task-edit.' },
              requirement: {
                type: 'string',
                description: 'Task completion requirements for task-add or task-edit: what a done result must show.',
              },
              requestedFiles: {
                type: 'array',
                items: { type: 'string' },
                description: 'Required artifacts for task-add or task-edit, relative to the task working directory or absolute.',
              },
              dueDate: {
                type: 'string',
                description: 'Calendar date YYYY-MM-DD; empty string clears it; omit to keep it.',
              },
              status: {
                type: 'string',
                enum: ['todo', 'in_progress', 'done'],
                description: 'Target status for a status change.',
              },
              order: {
                type: 'array',
                items: { type: 'string' },
                description: 'Complete desired order of incomplete plan ids for a reorder change.',
              },
              taskOrder: {
                type: 'array',
                items: { type: 'string' },
                description: 'Complete desired order of one plan\'s task ids for a task-reorder change.',
              },
            },
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            proposalId: { type: 'string', required: true },
            baseRevision: { type: 'integer', required: true },
            changeCount: { type: 'integer', required: true },
            changes: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  changeId: { type: 'string', required: true },
                  kind: { type: 'string', required: true, enum: [
                    'add', 'edit', 'delete', 'status', 'reorder', 'task-add', 'task-edit', 'task-delete', 'task-reorder',
                  ] },
                  itemId: { type: 'string', required: true },
                  summary: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `Prepared a plan-board change preview (${String(value.changeCount)} change(s), base revision ${String(value.baseRevision)}). `
            + 'Nothing has been applied. The user must review and confirm it in the plan panel; '
            + 'do not claim the board was updated.',
        }],
      },
      execute: async (args) => {
        const proposal = await this.propose({ changes: args.changes })
        return {
          proposalId: proposal.proposalId,
          baseRevision: proposal.baseRevision,
          changeCount: proposal.changes.length,
          changes: proposal.changes.map(change => ({
            changeId: change.changeId,
            kind: change.kind,
            itemId: change.itemId ?? change.taskId ?? '',
            summary: describeChange(change),
          })),
        }
      },
      presentCall: () => ({ card: 'generic', title: 'Prepare plan-board changes', kind: 'other' }),
    })
    const resultTool = defineTool({
      name: 'plan_task_result',
      description:
        'Submit the result of the plan task this Session is executing. '
        + 'Call it once the task is finished, blocked on the user, or failed. '
        + 'outcome="done" requires a short summary and every artifact path you produced (absolute paths in the working directory). '
        + 'Every required artifact the task declares must exist, or the result is refused. '
        + 'outcome="needs_user" means work cannot continue without user input; explain exactly what is missing. '
        + 'outcome="failed" means the task produced an error; explain it. '
        + 'Only the current task of the running batch accepts a result; a task that ends without this call is reported as needing the user.',
      parameters: {
        taskId: { type: 'string', required: true, description: 'Task id shown in the task instruction.' },
        outcome: {
          type: 'string',
          required: true,
          enum: ['done', 'needs_user', 'failed'],
          description: 'How the task ended.',
        },
        summary: { type: 'string', required: true, description: 'Short result summary or the exact blocking reason.' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute artifact paths produced by this task.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            recorded: { type: 'boolean', required: true },
            code: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.recorded
            ? 'Task result recorded. The batch advances after this turn ends.'
            : `Task result not recorded (${value.code}). Do not claim this task completed; report the problem to the user.`,
        }],
      },
      execute: async (args, exec) => {
        return await this.submitTaskResult({
          taskId: args.taskId,
          outcome: args.outcome as PlanTaskOutcome,
          summary: args.summary,
          files: args.files ?? [],
        }, exec.agent?.id ?? null)
      },
      presentCall: () => ({ card: 'generic', title: 'Submit plan task result', kind: 'other' }),
    })
    const disposers = [readTool, proposeTool, resultTool].map(tool => this.ctx.tools.register(tool))
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }
}

export default PersonalPlanService

/** Build the snapshot a client renders: incomplete plans in user order, then completed plans. */
function snapshotOf(doc: PlanDocument): PlanSnapshot {
  const ordered = [...doc.items]
  ordered.sort((left, right) => {
    const leftCompleted = left.status === 'done' ? 1 : 0
    const rightCompleted = right.status === 'done' ? 1 : 0
    return leftCompleted - rightCompleted || left.order - right.order
  })
  return {
    revision: doc.revision,
    items: ordered,
    tasks: orderTasksForSnapshot(ordered, doc.tasks),
    proposal: doc.proposal,
    run: doc.run,
    updatedAt: doc.updatedAt,
  }
}

/** Next order value that sorts after every existing item. */
function nextOrder(items: readonly PlanItem[]): number {
  return items.reduce((max, item) => Math.max(max, item.order), -1) + 1
}

/** Trim and validate a title. */
function normalizeTitle(value: string): string {
  const title = value.trim()
  if (title.length === 0) throw new PersonalPlanError('invalid-title', 'A plan item title cannot be empty.')
  if (title.length > MAX_TITLE_LENGTH) throw new PersonalPlanError('invalid-title', `A plan item title is limited to ${String(MAX_TITLE_LENGTH)} characters.`)
  return title
}

/** Trim a note and enforce its bound. */
function normalizeNote(value: string): string {
  const note = value.trim()
  if (note.length > MAX_NOTE_LENGTH) throw new PersonalPlanError('invalid-note', `A plan item note is limited to ${String(MAX_NOTE_LENGTH)} characters.`)
  return note
}

/** Validate a calendar date; an empty string means no date. */
function normalizeDueDate(value: string | null): string | null {
  if (value === null) return null
  const date = value.trim()
  if (date === '') return null
  if (!DATE_RE.test(date)) throw new PersonalPlanError('invalid-date', 'A due date must be a YYYY-MM-DD calendar date.')
  const parsed = new Date(`${date}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new PersonalPlanError('invalid-date', 'A due date must be a real calendar date.')
  }
  return date
}

/** Normalize the user-editable fields of one create request. */
function normalizeDraft(
  input: { title: string; note?: string; dueDate?: string | null; workdir?: string },
  fallbackNote: string,
): PlanItemDraft {
  return {
    title: normalizeTitle(input.title),
    note: input.note === undefined ? fallbackNote : normalizeNote(input.note),
    dueDate: normalizeDueDate(input.dueDate ?? null),
    workdir: normalizeWorkdir(input.workdir ?? ''),
  }
}

/** Normalize one task request, reporting task bounds with the plan error codes the client explains. */
function normalizeTaskRequest(
  title: string,
  detail: string | undefined,
  requirement?: string,
  requestedFiles?: readonly string[],
): PlanTaskDraft {
  try {
    return normalizeTaskDraft(title, detail, requirement, requestedFiles)
  } catch (error: unknown) {
    throw new PersonalPlanError('invalid-task', error instanceof Error ? error.message : 'Invalid task content.')
  }
}

/** Normalize declared required artifacts with the plan error codes the client explains. */
function normalizeTaskRequestFiles(files: readonly string[]): readonly string[] {
  try {
    return normalizeTaskFiles(files)
  } catch (error: unknown) {
    throw new PersonalPlanError('invalid-task', error instanceof Error ? error.message : 'Invalid required artifacts.')
  }
}

/** Apply one status transition: done leaves the incomplete order, restoring appends. */
function applyStatus(item: PlanItem, status: PlanItemStatus, all: readonly PlanItem[], now: string): PlanItem {
  if (item.status === status) return item
  if (status === 'done') return { ...item, status, updatedAt: now }
  const wasDone = item.status === 'done'
  return { ...item, status, order: wasDone ? nextOrder(all) : item.order, updatedAt: now }
}

/** Rewrite the incomplete order; the request must name exactly the incomplete items. */
function reorderIncomplete(items: readonly PlanItem[], order: readonly string[]): PlanItem[] {
  const incomplete = items.filter(item => item.status !== 'done')
  const expected = new Set(incomplete.map(item => item.id))
  if (order.length !== expected.size || new Set(order).size !== order.length || order.some(id => !expected.has(id))) {
    throw new PersonalPlanError('invalid-order', 'The reorder request must list every incomplete item exactly once.')
  }
  const now = new Date().toISOString()
  const positions = new Map(order.map((id, index) => [id, index]))
  return items.map(item => positions.has(item.id) ? { ...item, order: positions.get(item.id) as number, updatedAt: now } : item)
}

/** Reject a write that targets a task the running batch dispatches. */
function requireStoppedBatchFor(doc: PlanDocument, matches: (task: PlanTask) => boolean): void {
  const run = doc.run
  if (run === null || run.status !== 'running') return
  if (doc.tasks.some(task => matches(task) && run.taskIds.includes(task.id))) {
    throw new PersonalPlanError('run-active', 'Stop the running batch before changing a task it dispatches.')
  }
}

/** Normalize an optional plan working directory; it must be absolute when present. */
function normalizeWorkdir(value: string): string {
  const workdir = value.trim()
  if (workdir === '') return ''
  if (!isAbsolute(workdir)) throw new PersonalPlanError('invalid-workdir', 'A plan working directory must be an absolute path.')
  if (workdir.length > MAX_WORKDIR_LENGTH) throw new PersonalPlanError('invalid-workdir', `A plan working directory is limited to ${String(MAX_WORKDIR_LENGTH)} characters.`)
  return workdir
}

/** Resolve and validate one batch working directory. */
async function resolveWorkdir(value: string): Promise<string> {
  const workdir = value.trim()
  if (workdir === '' || !isAbsolute(workdir)) {
    throw new PersonalPlanError('invalid-workdir', 'A batch needs an absolute working directory.')
  }
  try {
    const info = await stat(workdir)
    if (!info.isDirectory()) throw new PersonalPlanError('invalid-workdir', 'The working directory is not a directory.')
  } catch (error: unknown) {
    if (error instanceof PersonalPlanError) throw error
    throw new PersonalPlanError('invalid-workdir', 'The working directory does not exist.')
  }
  return workdir
}

/** Report submitted artifact paths that do not exist. */
async function missingFiles(files: readonly string[]): Promise<readonly string[]> {
  const missing: string[] = []
  for (const file of files) {
    try {
      await stat(file)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        missing.push(file)
        continue
      }
      throw error
    }
  }
  return missing
}

/**
 * Report declared required artifacts that do not exist, resolving relative paths
 * against the batch working directory.
 * @param workdir - batch working directory.
 * @param files - declared paths, possibly relative.
 * @returns the missing paths, in declaration order.
 */
async function missingRequestedFiles(workdir: string, files: readonly string[]): Promise<readonly string[]> {
  return await missingFiles(files.map(file => (isAbsolute(file) ? file : join(workdir, file))))
}

/**
 * Render the instruction one task's Session receives.
 *
 * The prompt carries the task identity the result tool needs, the fixed batch
 * working directory, and only the prior tasks' paths and summaries —never the
 * earlier conversations.
 * @param context - plan, task, batch, and prior results.
 * @returns the prompt text.
 */
export function renderTaskPrompt(context: PlanRunPromptContext): string {
  const { plan, task, run, prior } = context
  const instruction = task.detail === '' ? task.title : task.detail
  const priorLines = prior.length === 0
    ? '- None; this is the first task of the batch.'
    : prior.map(result => `- ${result.title}: ${result.summary}`
      + (result.files.length === 0 ? '' : ` (artifacts: ${result.files.join(', ')})`)).join('\n')
  return [
    'You are executing one task of the user\'s plan board in MyResearchWorkbench.',
    '',
    `Plan: ${plan.title}`,
    `Task: ${task.title}`,
    `Task instruction:\n${instruction}`,
    `Completion requirements:\n${task.requirement === '' ? 'Produce a result that satisfies the task instruction and explain it in the summary.' : task.requirement}`,
    `Required artifacts: ${task.requestedFiles.length === 0 ? 'none declared' : task.requestedFiles.join(', ')}`,
    '',
    `Working directory: ${run.workdir}`,
    'Work inside that directory and name artifacts with absolute paths.',
    '',
    'Earlier tasks of this batch:',
    priorLines,
    '',
    'Rules:',
    '- Use only data that actually exists in the working directory. If required material is missing, do not invent it.',
    '- When this task is finished, call plan_task_result with '
      + `taskId="${task.id}", outcome="done", a short summary, and every artifact path you produced.`,
    '- Every declared required artifact must exist when you submit a done result.',
    '- If you cannot continue without the user (missing data, permission, or an unclear requirement), call '
      + 'plan_task_result with outcome="needs_user" and explain exactly what is missing.',
    '- If the task failed with an error, call plan_task_result with outcome="failed" and explain it.',
    '- Do not start other tasks of the board and do not reorder it; the next task starts automatically only after a successful result.',
  ].join('\n')
}

/** Build the concrete preview entries for a model proposal over plans and tasks. */
function buildProposalChanges(doc: PlanDocument, inputs: readonly PlanProposedChangeInput[]): PlanProposalChange[] {
  if (inputs.length === 0) throw new PersonalPlanError('empty-proposal', 'A plan proposal needs at least one change.')
  let items = doc.items.slice()
  let tasks = doc.tasks.slice()
  const changes: PlanProposalChange[] = []
  inputs.forEach((input, index) => {
    const changeId = `c-${String(index + 1)}`
    const target = input.itemId === undefined ? undefined : items.find(item => item.id === input.itemId)
    switch (input.kind) {
      case 'add': {
        if (items.length >= MAX_ITEMS) throw new PersonalPlanError('too-many-items', 'The plan item limit would be exceeded.')
        if (input.title === undefined || input.title.trim() === '') {
          throw new PersonalPlanError('invalid-title', 'An add change requires a non-empty title.')
        }
        const id = `pl-${randomUUID()}`
        const draft = normalizeDraft({ title: input.title, note: input.note ?? '', dueDate: input.dueDate ?? null }, '')
        const now = new Date().toISOString()
        const item: PlanItem = { id, ...draft, status: 'todo', order: nextOrder(items), createdAt: now, updatedAt: now }
        items = [...items, item]
        changes.push({
          changeId, kind: 'add', itemId: id, planId: null, taskId: null, before: null, after: draft,
          taskBefore: null, taskAfter: null, beforeStatus: null, afterStatus: null,
          beforeOrder: null, afterOrder: null, beforeTaskOrder: null, afterTaskOrder: null,
        })
        return
      }
      case 'edit': {
        requireTarget(target, 'edit')
        const before = draftOf(target as PlanItem)
        const after: PlanItemDraft = {
          title: input.title === undefined ? before.title : normalizeTitle(input.title),
          note: input.note === undefined ? before.note : normalizeNote(input.note),
          dueDate: input.dueDate === undefined ? before.dueDate : normalizeDueDate(input.dueDate),
          workdir: before.workdir,
        }
        const now = new Date().toISOString()
        items = items.map(item => item === target ? { ...item, ...after, updatedAt: now } : item)
        changes.push({
          changeId, kind: 'edit', itemId: (target as PlanItem).id, planId: null, taskId: null, before, after,
          taskBefore: null, taskAfter: null, beforeStatus: null, afterStatus: null,
          beforeOrder: null, afterOrder: null, beforeTaskOrder: null, afterTaskOrder: null,
        })
        return
      }
      case 'delete': {
        requireTarget(target, 'delete')
        const before = draftOf(target as PlanItem)
        const deletedId = (target as PlanItem).id
        items = items.filter(item => item !== target)
        tasks = tasks.filter(task => task.planId !== deletedId)
        changes.push({
          changeId, kind: 'delete', itemId: deletedId, planId: null, taskId: null, before, after: null,
          taskBefore: null, taskAfter: null, beforeStatus: null, afterStatus: null,
          beforeOrder: null, afterOrder: null, beforeTaskOrder: null, afterTaskOrder: null,
        })
        return
      }
      case 'status': {
        requireTarget(target, 'status')
        if (input.status === undefined) throw new PersonalPlanError('invalid-status', 'A status change requires a target status.')
        const current = target as PlanItem
        const now = new Date().toISOString()
        const updated = applyStatus(current, input.status, items, now)
        items = items.map(item => item === current ? updated : item)
        changes.push({
          changeId, kind: 'status', itemId: current.id, planId: null, taskId: null, before: null, after: null,
          taskBefore: null, taskAfter: null, beforeStatus: current.status, afterStatus: input.status,
          beforeOrder: null, afterOrder: null, beforeTaskOrder: null, afterTaskOrder: null,
        })
        return
      }
      case 'reorder': {
        if (input.order === undefined) throw new PersonalPlanError('invalid-order', 'A reorder change requires the complete order.')
        const beforeOrder = items.filter(item => item.status !== 'done').sort(compareOrder).map(item => item.id)
        items = reorderIncomplete(items, input.order)
        const afterOrder = items.filter(item => item.status !== 'done').sort(compareOrder).map(item => item.id)
        changes.push({
          changeId, kind: 'reorder', itemId: null, planId: null, taskId: null, before: null, after: null,
          taskBefore: null, taskAfter: null, beforeStatus: null, afterStatus: null,
          beforeOrder, afterOrder, beforeTaskOrder: null, afterTaskOrder: null,
        })
        return
      }
      case 'task-add': {
        const owner = requirePlan(items, input.planId)
        if (tasks.filter(task => task.planId === owner.id).length >= MAX_TASKS_PER_PLAN) {
          throw new PersonalPlanError('too-many-tasks', 'The plan task limit would be exceeded.')
        }
        if (input.title === undefined || input.title.trim() === '') {
          throw new PersonalPlanError('invalid-title', 'A task-add change requires a non-empty title.')
        }
        const id = `tk-${randomUUID()}`
        const draft = normalizeTaskRequest(input.title, input.detail, input.requirement, input.requestedFiles)
        const now = new Date().toISOString()
        const task: PlanTask = {
          id,
          planId: owner.id,
          ...draft,
          status: 'pending',
          order: nextTaskOrder(tasks, owner.id),
          sessionId: null,
          result: null,
          message: '',
          createdAt: now,
          updatedAt: now,
        }
        tasks = [...tasks, task]
        changes.push({
          changeId, kind: 'task-add', itemId: null, planId: owner.id, taskId: id, before: null, after: null,
          taskBefore: null, taskAfter: draft, beforeStatus: null, afterStatus: null,
          beforeOrder: null, afterOrder: null, beforeTaskOrder: null, afterTaskOrder: null,
        })
        return
      }
      case 'task-edit': {
        const task = requireTask(tasks, input.taskId)
        const before: PlanTaskDraft = {
          title: task.title,
          detail: task.detail,
          requirement: task.requirement,
          requestedFiles: task.requestedFiles,
        }
        const after: PlanTaskDraft = {
          title: input.title === undefined ? before.title : normalizeTaskTitle(input.title),
          detail: input.detail === undefined ? before.detail : normalizeTaskDetail(input.detail),
          requirement: input.requirement === undefined ? before.requirement : normalizeTaskDetail(input.requirement),
          requestedFiles: input.requestedFiles === undefined
            ? before.requestedFiles
            : normalizeTaskRequestFiles(input.requestedFiles),
        }
        const now = new Date().toISOString()
        tasks = tasks.map(candidate => candidate === task ? { ...candidate, ...after, updatedAt: now } : candidate)
        changes.push({
          changeId, kind: 'task-edit', itemId: null, planId: task.planId, taskId: task.id, before: null, after: null,
          taskBefore: before, taskAfter: after, beforeStatus: null, afterStatus: null,
          beforeOrder: null, afterOrder: null, beforeTaskOrder: null, afterTaskOrder: null,
        })
        return
      }
      case 'task-delete': {
        const task = requireTask(tasks, input.taskId)
        const before: PlanTaskDraft = {
          title: task.title,
          detail: task.detail,
          requirement: task.requirement,
          requestedFiles: task.requestedFiles,
        }
        tasks = tasks.filter(candidate => candidate !== task)
        changes.push({
          changeId, kind: 'task-delete', itemId: null, planId: task.planId, taskId: task.id, before: null, after: null,
          taskBefore: before, taskAfter: null, beforeStatus: null, afterStatus: null,
          beforeOrder: null, afterOrder: null, beforeTaskOrder: null, afterTaskOrder: null,
        })
        return
      }
      case 'task-reorder': {
        const owner = requirePlan(items, input.planId)
        if (input.taskOrder === undefined) {
          throw new PersonalPlanError('invalid-order', 'A task-reorder change requires the complete task order.')
        }
        const owned = tasks.filter(task => task.planId === owner.id).sort(compareOrder)
        const beforeTaskOrder = owned.map(task => task.id)
        let reordered: PlanTask[]
        try {
          reordered = reorderTasksInPlan(tasks, owner.id, input.taskOrder)
        } catch (error: unknown) {
          throw new PersonalPlanError('invalid-order', error instanceof Error ? error.message : 'Invalid task order.')
        }
        tasks = reordered
        const afterTaskOrder = reordered.filter(task => task.planId === owner.id).sort(compareOrder).map(task => task.id)
        changes.push({
          changeId, kind: 'task-reorder', itemId: null, planId: owner.id, taskId: null, before: null, after: null,
          taskBefore: null, taskAfter: null, beforeStatus: null, afterStatus: null,
          beforeOrder: null, afterOrder: null, beforeTaskOrder, afterTaskOrder,
        })
        return
      }
      default:
        throw new PersonalPlanError('invalid-change', `Unknown change kind ${String((input as { kind?: unknown }).kind)}.`)
    }
  })
  return changes
}

/** Reject a change that names no existing plan. */
function requirePlan(items: readonly PlanItem[], planId: string | undefined): PlanItem {
  if (planId === undefined) throw new PersonalPlanError('missing-plan', 'A task change requires a plan id.')
  const plan = items.find(item => item.id === planId)
  if (plan === undefined) throw new PersonalPlanError('missing-plan', 'A task change names a plan that does not exist.')
  return plan
}

/** Reject a change that names no existing task. */
function requireTask(tasks: readonly PlanTask[], taskId: string | undefined): PlanTask {
  if (taskId === undefined) throw new PersonalPlanError('missing-task', 'A task change requires a task id.')
  const task = tasks.find(candidate => candidate.id === taskId)
  if (task === undefined) throw new PersonalPlanError('missing-task', 'A task change names a task that does not exist.')
  return task
}

/** Reject a change that names no existing item. */
function requireTarget(target: PlanItem | undefined, kind: string): void {
  if (target === undefined) throw new PersonalPlanError('missing-item', `A ${kind} change names an item that does not exist.`)
}

/** Item content projection used in previews. */
function draftOf(item: PlanItem): PlanItemDraft {
  return { title: item.title, note: item.note, dueDate: item.dueDate, workdir: item.workdir }
}

/** Order comparator shared by reorder previews. */
function compareOrder(left: { readonly order: number }, right: { readonly order: number }): number {
  return left.order - right.order
}

/** Apply one selected proposal change to the plan and task lists. */
function applyChange(
  board: { readonly items: readonly PlanItem[]; readonly tasks: readonly PlanTask[] },
  change: PlanProposalChange,
  now: string,
): { items: readonly PlanItem[]; tasks: readonly PlanTask[] } {
  switch (change.kind) {
    case 'add': {
      if (change.after === null) throw new PersonalPlanError('invalid-change', 'The add change has no content.')
      const id = change.itemId ?? `pl-${randomUUID()}`
      const item: PlanItem = {
        id,
        ...change.after,
        status: 'todo',
        order: nextOrder(board.items),
        createdAt: now,
        updatedAt: now,
      }
      return { items: [...board.items, item], tasks: board.tasks }
    }
    case 'edit': {
      if (change.after === null) throw new PersonalPlanError('invalid-change', 'The edit change has no content.')
      return { items: replaceItem(board.items, change.itemId, item => ({ ...item, ...change.after, updatedAt: now })), tasks: board.tasks }
    }
    case 'delete': {
      if (change.itemId === null || !board.items.some(item => item.id === change.itemId)) {
        throw new PersonalPlanError('missing-item', 'A selected deletion targets an item that no longer exists.')
      }
      return {
        items: board.items.filter(item => item.id !== change.itemId),
        tasks: board.tasks.filter(task => task.planId !== change.itemId),
      }
    }
    case 'status': {
      if (change.afterStatus === null) throw new PersonalPlanError('invalid-change', 'The status change has no target status.')
      return {
        items: replaceItem(board.items, change.itemId, item => applyStatus(item, change.afterStatus as PlanItemStatus, board.items, now)),
        tasks: board.tasks,
      }
    }
    case 'reorder': {
      if (change.afterOrder === null) throw new PersonalPlanError('invalid-change', 'The reorder change has no order.')
      return { items: reorderPresent(board.items, change.afterOrder), tasks: board.tasks }
    }
    case 'task-add': {
      if (change.taskAfter === null) throw new PersonalPlanError('invalid-change', 'The task-add change has no content.')
      const planId = change.planId
      if (planId === null || !board.items.some(item => item.id === planId)) {
        throw new PersonalPlanError('missing-plan', 'A selected task addition targets a plan that no longer exists.')
      }
      const task: PlanTask = {
        id: change.taskId ?? `tk-${randomUUID()}`,
        planId,
        ...change.taskAfter,
        status: 'pending',
        order: nextTaskOrder(board.tasks, planId),
        sessionId: null,
        result: null,
        message: '',
        createdAt: now,
        updatedAt: now,
      }
      return { items: board.items, tasks: [...board.tasks, task] }
    }
    case 'task-edit': {
      if (change.taskAfter === null) throw new PersonalPlanError('invalid-change', 'The task-edit change has no content.')
      return {
        items: board.items,
        tasks: replaceTask(board.tasks, change.taskId, task => ({ ...task, ...change.taskAfter, updatedAt: now })),
      }
    }
    case 'task-delete': {
      if (change.taskId === null || !board.tasks.some(task => task.id === change.taskId)) {
        throw new PersonalPlanError('missing-task', 'A selected task deletion targets a task that no longer exists.')
      }
      return { items: board.items, tasks: board.tasks.filter(task => task.id !== change.taskId) }
    }
    case 'task-reorder': {
      if (change.afterTaskOrder === null || change.planId === null) {
        throw new PersonalPlanError('invalid-change', 'The task-reorder change has no order.')
      }
      const owned = board.tasks.filter(task => task.planId === change.planId)
      const positions = new Map(change.afterTaskOrder.map((id, index) => [id, index]))
      const ordered: PlanTask[] = []
      for (const [id, position] of positions) {
        const task = owned.find(candidate => candidate.id === id)
        if (task === undefined) continue
        ordered.push({ ...task, order: position, updatedAt: now })
      }
      const remaining = owned.filter(task => !positions.has(task.id))
        .sort(compareOrder)
        .map((task, index) => ({ ...task, order: ordered.length + index, updatedAt: now }))
      const byId = new Map([...ordered, ...remaining].map(task => [task.id, task]))
      return { items: board.items, tasks: board.tasks.map(task => byId.get(task.id) ?? task) }
    }
    default:
      throw new PersonalPlanError('invalid-change', 'Unknown change kind.')
  }
}

/** Replace one item by identity, rejecting a missing target. */
function replaceItem(items: readonly PlanItem[], id: string | null, transform: (item: PlanItem) => PlanItem): PlanItem[] {
  const index = id === null ? -1 : items.findIndex(item => item.id === id)
  if (index === -1) throw new PersonalPlanError('missing-item', 'A selected change targets an item that no longer exists.')
  const items$ = items.slice()
  items$[index] = transform(items$[index] as PlanItem)
  return items$
}

/** Replace one task by identity, rejecting a missing target. */
function replaceTask(tasks: readonly PlanTask[], id: string | null, transform: (task: PlanTask) => PlanTask): PlanTask[] {
  const index = id === null ? -1 : tasks.findIndex(task => task.id === id)
  if (index === -1) throw new PersonalPlanError('missing-task', 'A selected change targets a task that no longer exists.')
  const tasks$ = tasks.slice()
  tasks$[index] = transform(tasks$[index] as PlanTask)
  return tasks$
}

/** Apply an order that names a subset of the incomplete items; unnamed items keep relative order after it. */
function reorderPresent(items: readonly PlanItem[], order: readonly string[]): PlanItem[] {
  const incomplete = items.filter(item => item.status !== 'done').sort(compareOrder)
  const byId = new Map(incomplete.map(item => [item.id, item]))
  const ordered: string[] = []
  for (const id of order) if (byId.has(id) && !ordered.includes(id)) ordered.push(id)
  for (const item of incomplete) if (!ordered.includes(item.id)) ordered.push(item.id)
  const positions = new Map(ordered.map((id, index) => [id, index]))
  const now = new Date().toISOString()
  return items.map(item => positions.has(item.id) ? { ...item, order: positions.get(item.id) as number, updatedAt: now } : item)
}

/** Human-readable one-line summary of a proposal change. */
function describeChange(change: PlanProposalChange): string {
  switch (change.kind) {
    case 'add': return `add "${change.after?.title ?? ''}"`
    case 'edit': return `edit "${change.before?.title ?? ''}" -> "${change.after?.title ?? ''}"`
    case 'delete': return `delete "${change.before?.title ?? ''}"`
    case 'status': return `status "${change.before?.title ?? ''}": ${change.beforeStatus ?? ''} -> ${change.afterStatus ?? ''}`
    case 'reorder': return `reorder ${String(change.afterOrder?.length ?? 0)} incomplete item(s)`
    case 'task-add': return `add task "${change.taskAfter?.title ?? ''}"`
    case 'task-edit': return `edit task "${change.taskBefore?.title ?? ''}" -> "${change.taskAfter?.title ?? ''}"`
    case 'task-delete': return `delete task "${change.taskBefore?.title ?? ''}"`
    case 'task-reorder': return `reorder ${String(change.afterTaskOrder?.length ?? 0)} task(s)`
    default: return 'change'
  }
}
