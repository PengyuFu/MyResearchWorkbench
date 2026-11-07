/**
 * Personal plan and task vocabulary shared by the Host service, the model tools,
 * the execution engine, and the browser client.
 *
 * The plan board is one user-level document independent of Sessions and
 * workspaces. A plan is a list entry with a required title, an optional note and
 * calendar date, one of three statuses, and the user's own order. Tasks belong
 * to exactly one plan with their own order; each task keeps a stable identity,
 * an optional execution detail, its latest execution state, the ordinary
 * Harness Session created for it, and the last submitted result. One execution
 * batch at a time ("run") fixes the task list it dispatches and serializes the
 * tasks. A pending proposal is a draft change set the model produced: it never
 * alters the plan until the user confirms it through the client.
 *
 * @module @deepseek-ai/dsh-personal-plan
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** One plan item's lifecycle state. */
export type PlanItemStatus = 'todo' | 'in_progress' | 'done'

/** The kinds of change one proposal entry can describe. */
export type PlanChangeKind =
  | 'add' | 'edit' | 'delete' | 'status' | 'reorder'
  | 'task-add' | 'task-edit' | 'task-delete' | 'task-reorder'

/** User-editable plan content; `dueDate` is a `YYYY-MM-DD` calendar date or null. */
export interface PlanItemDraft {
  /** Required, trimmed, non-empty item title. */
  readonly title: string
  /** Optional free-form note; empty string when absent. */
  readonly note: string
  /** Optional calendar date, or null when the item has none. */
  readonly dueDate: string | null
  /**
   * Execution working directory shared by the plan's tasks, or empty when none is
   * chosen yet. Sessions created for this plan's tasks start in this directory.
   */
  readonly workdir: string
}

/** One durable plan item. */
export interface PlanItem extends PlanItemDraft {
  /** Stable identity minted once at creation and never derived from the title. */
  readonly id: string
  /** Lifecycle state. */
  readonly status: PlanItemStatus
  /** Position within the incomplete list (todo and in_progress items only). */
  readonly order: number
  /** Creation instant, RFC 3339 UTC. */
  readonly createdAt: string
  /** Last change instant, RFC 3339 UTC. */
  readonly updatedAt: string
}

/**
 * One task's execution state.
 *
 * `pending` never started, `running` is this task's Session working now,
 * `needs_user` waits for material, permission, or an explanation, `done` carries
 * a submitted result whose files were verified, `stopped` was cancelled or
 * detected as interrupted, and `failed` carries a submitted failure.
 */
export type PlanTaskStatus = 'pending' | 'running' | 'needs_user' | 'done' | 'stopped' | 'failed'

/** User-editable task content. */
export interface PlanTaskDraft {
  /** Required, trimmed, non-empty task title. */
  readonly title: string
  /** Optional execution instruction; the title is the requirement when empty. */
  readonly detail: string
  /** Optional completion requirements: what a `done` result must demonstrate. */
  readonly requirement: string
  /** Required artifacts, relative to the batch working directory or absolute. */
  readonly requestedFiles: readonly string[]
}

/** The outcome a task run may submit. */
export type PlanTaskOutcome = 'done' | 'needs_user' | 'failed'

/** The result one task Session submitted for the current run. */
export interface PlanTaskResult {
  /** Submitted outcome. */
  readonly outcome: PlanTaskOutcome
  /** Short result summary, or why the task could not continue. */
  readonly summary: string
  /** Absolute artifact paths the task produced; every one must exist for `done`. */
  readonly files: readonly string[]
  /** Session that submitted the result. */
  readonly sessionId: string
  /** Identity of the execution batch the result belongs to. */
  readonly runId: string
  /** Submission instant, RFC 3339 UTC. */
  readonly recordedAt: string
}

/** One durable task belonging to one plan. */
export interface PlanTask extends PlanTaskDraft {
  /** Stable identity minted once at creation. */
  readonly id: string
  /** Owning plan item identity. */
  readonly planId: string
  /** Execution state. */
  readonly status: PlanTaskStatus
  /** Position within its plan's task list. */
  readonly order: number
  /** Ordinary Harness Session created for this task, or null before its first run. */
  readonly sessionId: string | null
  /** Latest submitted result, or null. */
  readonly result: PlanTaskResult | null
  /** Short progress or stop reason shown beside the status; empty when none. */
  readonly message: string
  /** Creation instant, RFC 3339 UTC. */
  readonly createdAt: string
  /** Last change instant, RFC 3339 UTC. */
  readonly updatedAt: string
}

/** State of the one execution batch the board may have active. */
export type PlanRunStatus = 'running' | 'stopped' | 'done' | 'interrupted'

/** One execution batch: the task list fixed at start, its working directory, and its cursor. */
export interface PlanRun {
  /** Stable batch identity, also recorded on every submitted result. */
  readonly runId: string
  /** Plan the batch was started from. */
  readonly planId: string
  /** Tasks the batch will dispatch, in order; later edits do not change it. */
  readonly taskIds: readonly string[]
  /** Working directory every Session of this batch uses. */
  readonly workdir: string
  /** Batch state. */
  readonly status: PlanRunStatus
  /** Task currently dispatching, or null between tasks. */
  readonly currentTaskId: string | null
  /** Why a running batch stopped early; empty when it ran to its end. */
  readonly message: string
  /** Start instant, RFC 3339 UTC. */
  readonly startedAt: string
  /** Last change instant, RFC 3339 UTC. */
  readonly updatedAt: string
}

/** One concrete change in a proposal, with the before and after values the preview shows. */
export interface PlanProposalChange {
  /** Stable identity of this change within its proposal. */
  readonly changeId: string
  /** Discriminator for the change. */
  readonly kind: PlanChangeKind
  /** The target plan item; for `add` this is the identity the new item will receive. */
  readonly itemId: string | null
  /** Owning plan identity for a task change; null for plan-only changes. */
  readonly planId: string | null
  /** Target task identity for a task change; null otherwise. */
  readonly taskId: string | null
  /** Prior plan content for edit, delete, and status changes; null otherwise. */
  readonly before: PlanItemDraft | null
  /** Resulting plan content for add and edit changes; null otherwise. */
  readonly after: PlanItemDraft | null
  /** Prior task content for a task edit or delete; null otherwise. */
  readonly taskBefore: PlanTaskDraft | null
  /** Resulting task content for a task add or edit; null otherwise. */
  readonly taskAfter: PlanTaskDraft | null
  /** Prior status for status changes; null otherwise. */
  readonly beforeStatus: PlanItemStatus | null
  /** Resulting status for status changes; null otherwise. */
  readonly afterStatus: PlanItemStatus | null
  /** Prior plan order for plan reorder changes; null otherwise. */
  readonly beforeOrder: readonly string[] | null
  /** Resulting plan order for plan reorder changes; null otherwise. */
  readonly afterOrder: readonly string[] | null
  /** Prior task order for task reorder changes; null otherwise. */
  readonly beforeTaskOrder: readonly string[] | null
  /** Resulting task order for task reorder changes; null otherwise. */
  readonly afterTaskOrder: readonly string[] | null
}

/** A model-proposed change set waiting for the user's confirmation. */
export interface PlanProposal {
  /** Stable proposal identity, checked again when the application request arrives. */
  readonly proposalId: string
  /** Plan revision observed when the proposal was built; a later revision makes it stale. */
  readonly baseRevision: number
  /** Creation instant, RFC 3339 UTC. */
  readonly createdAt: string
  /** Concrete changes in application order. */
  readonly changes: readonly PlanProposalChange[]
}

/** The complete authoritative plan state a client renders. */
export interface PlanSnapshot {
  /** Monotonic revision of the plan content, incremented by every applied write. */
  readonly revision: number
  /** Every plan item, incomplete items in user order and completed items after them. */
  readonly items: readonly PlanItem[]
  /** Every task, incomplete tasks in user order and finished tasks after them. */
  readonly tasks: readonly PlanTask[]
  /** The pending proposal, or null when nothing awaits confirmation. */
  readonly proposal: PlanProposal | null
  /** The one execution batch in force, or null when none started or it was cleared. */
  readonly run: PlanRun | null
  /** Last durable change instant, RFC 3339 UTC; empty before the first write. */
  readonly updatedAt: string
}

/** Request body for adding one plan item. */
export interface PlanAddItemRequest {
  /** Required, trimmed, non-empty item title. */
  readonly title: string
  /** Optional note; omitted stores an empty note. */
  readonly note?: string
  /** Optional calendar date; omitted stores no date. */
  readonly dueDate?: string | null
  /** Optional absolute working directory; omitted stores no directory. */
  readonly workdir?: string
}

/** Request body for editing one plan item; an omitted field keeps its stored value. */
export interface PlanUpdateItemRequest {
  /** Identity of the item to edit. */
  readonly id: string
  /** Replacement title; omitted keeps the stored title. */
  readonly title?: string
  /** Replacement note; omitted keeps the stored note. */
  readonly note?: string
  /** Replacement calendar date; null clears it, omitted keeps it. */
  readonly dueDate?: string | null
  /** Replacement absolute working directory; empty clears it, omitted keeps it. */
  readonly workdir?: string
}

/** Request body for deleting one plan item. */
export interface PlanDeleteItemRequest {
  /** Identity of the item to delete. */
  readonly id: string
}

/** Request body for changing one plan item's status. */
export interface PlanSetStatusRequest {
  /** Identity of the item whose status changes. */
  readonly id: string
  /** Target status. */
  readonly status: PlanItemStatus
}

/** Request body for saving a new incomplete plan order. */
export interface PlanReorderRequest {
  /** Every incomplete item identity in the desired order. */
  readonly order: readonly string[]
}

/** Request body for adding one task to a plan. */
export interface PlanAddTaskRequest {
  /** Owning plan identity. */
  readonly planId: string
  /** Required, trimmed, non-empty task title. */
  readonly title: string
  /** Optional execution instruction. */
  readonly detail?: string
  /** Optional completion requirements. */
  readonly requirement?: string
  /** Optional required artifacts, relative to the batch working directory or absolute. */
  readonly requestedFiles?: readonly string[]
}

/** Request body for editing one task; an omitted field keeps its stored value. */
export interface PlanUpdateTaskRequest {
  /** Identity of the task to edit. */
  readonly id: string
  /** Replacement title; omitted keeps the stored title. */
  readonly title?: string
  /** Replacement execution instruction; omitted keeps it. */
  readonly detail?: string
  /** Replacement completion requirements; omitted keeps them. */
  readonly requirement?: string
  /** Replacement required artifacts; omitted keeps them. */
  readonly requestedFiles?: readonly string[]
}

/** Request body for deleting one task. */
export interface PlanDeleteTaskRequest {
  /** Identity of the task to delete. */
  readonly id: string
}

/** Request body for saving a new task order within one plan. */
export interface PlanReorderTasksRequest {
  /** Owning plan identity. */
  readonly planId: string
  /** Every task identity of that plan in the desired order. */
  readonly order: readonly string[]
}

/** Request body for starting one task or one plan's pending tasks. */
export interface PlanStartRunRequest {
  /** Plan to run. */
  readonly planId: string
  /** Single task to run; omitted runs every pending task of the plan in order. */
  readonly taskId?: string
}

/** Result of one execution request; `code` names why nothing started. */
export interface PlanStartRunResult {
  /** Whether a batch started. */
  readonly started: boolean
  /** Stable outcome code: `ok`, `run-active`, `nothing-to-run`, `missing-plan`, `missing-task`, `invalid-workdir`. */
  readonly code: string
  /** Authoritative plan state after the attempt. */
  readonly snapshot: PlanSnapshot
}

/** Result of one stop request. */
export interface PlanStopRunResult {
  /** Whether a running batch was stopped. */
  readonly stopped: boolean
  /** Stable outcome code: `ok` or `no-run`. */
  readonly code: string
  /** Authoritative plan state after the attempt. */
  readonly snapshot: PlanSnapshot
}

/** The one change a model proposes. Omitted fields keep their stored value. */
export interface PlanProposedChangeInput {
  /** Discriminator for the intended change. */
  readonly kind: PlanChangeKind
  /** Target plan identity for every task change. */
  readonly planId?: string
  /** Target plan item identity for plan edit, delete, and status changes. */
  readonly itemId?: string
  /** Target task identity for task changes other than `task-add`. */
  readonly taskId?: string
  /** Plan title: required for an add, optional replacement for an edit. */
  readonly title?: string
  /** Plan note: optional replacement text. */
  readonly note?: string
  /** Calendar date: a `YYYY-MM-DD` value, or null to clear it. */
  readonly dueDate?: string | null
  /** Target status for a status change. */
  readonly status?: PlanItemStatus
  /** Complete desired incomplete plan order for a reorder change. */
  readonly order?: readonly string[]
  /** Task execution instruction for a task add or task edit. */
  readonly detail?: string
  /** Task completion requirements for a task add or task edit. */
  readonly requirement?: string
  /** Required task artifacts for a task add or task edit. */
  readonly requestedFiles?: readonly string[]
  /** Complete desired task order for a task reorder change. */
  readonly taskOrder?: readonly string[]
}

/** Model-facing proposal request. */
export interface PlanProposeRequest {
  /** Concrete changes in application order. */
  readonly changes: readonly PlanProposedChangeInput[]
}

/** Result of applying a proposal. */
export interface PlanApplyProposalRequest {
  /** Proposal identity shown in the preview. */
  readonly proposalId: string
  /** Change identities the user kept selected. */
  readonly changeIds: readonly string[]
}

/** Outcome of one proposal application; `code` names why nothing changed. */
export interface PlanApplyResult {
  /** Whether the selected changes were durably applied. */
  readonly applied: boolean
  /** Stable outcome code: `ok`, `stale`, `missing-proposal`, or `plan-changed`. */
  readonly code: string
  /** Authoritative plan state after the attempt. */
  readonly snapshot: PlanSnapshot
}

/** Request body for discarding the pending proposal. */
export interface PlanDiscardProposalRequest {
  /** Proposal identity shown in the preview. */
  readonly proposalId: string
}

/** Request body for submitting one task result from inside its Session. */
export interface PlanSubmitTaskResultRequest {
  /** Task the submitting Session is executing. */
  readonly taskId: string
  /** Submitted outcome. */
  readonly outcome: PlanTaskOutcome
  /** Short result summary, or why the task cannot continue. */
  readonly summary: string
  /** Absolute artifact paths the task produced; required for `done`. */
  readonly files?: readonly string[]
}

/** Outcome of one task-result submission. */
export interface PlanSubmitTaskResultResult {
  /** Whether the result was recorded for the current batch. */
  readonly recorded: boolean
  /** Stable outcome code: `ok`, `no-run`, `not-current`, `wrong-session`, `missing-files`. */
  readonly code: string
}

/** Request to bring one task Session into the main window. */
export interface PlanRevealSessionRequest {
  /** Session to open; the plan window never opens a conversation itself. */
  readonly sessionId: string
}

/** Request to open one task's Session, or to learn that it is no longer usable. */
export interface PlanRevealTaskRequest {
  /** Task whose Session should be shown. */
  readonly taskId: string
}

/** Acknowledged reveal request. */
export interface PlanRevealSessionValue {
  /** Whether the request was accepted and broadcast. */
  readonly accepted: boolean
}

/** Outcome of one task-Session reveal request. */
export interface PlanRevealTaskValue {
  /** Stable outcome code: `ok`, `no-session`, `unavailable`, or `missing-task`. */
  readonly code: string
}

/** Response to a request to bring the embedded board to the main window. */
export interface PlanRequestPanelValue {
  /** Whether the request was accepted and broadcast. */
  readonly accepted: boolean
}

/** Payload of the `personal-plan/changed` notification. */
export interface PlanChangedEvent {
  /** Authoritative plan revision after the change. */
  readonly revision: number
  /** Pending proposal identity, or null when none awaits confirmation. */
  readonly proposalId: string | null
}

/** Payload of the `personal-plan/reveal-session` notification. */
export interface PlanRevealSessionEvent {
  /** Session another window should show. */
  readonly sessionId: SessionId
}

/** Payload of the `personal-plan/panel-requested` notification. */
export interface PlanPanelRequestEvent {
  /** Which surface asked for the embedded board. */
  readonly source: 'float' | 'entry'
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One personal plan write, proposal, discard, or execution transition landed durably.
     * @param payload - revision and pending proposal identity after the change.
     * @mode emit
     */
    'personal-plan/changed'(payload: PlanChangedEvent): void
    /**
     * One window asked for a task Session to be shown in the main window.
     * @param payload - Session the main window should open.
     * @mode emit
     */
    'personal-plan/reveal-session'(payload: PlanRevealSessionEvent): void
    /**
     * One window asked for the embedded plan board to be shown in the main window.
     * @param payload - which surface asked for it.
     * @mode emit
     */
    'personal-plan/panel-requested'(payload: PlanPanelRequestEvent): void
  }
}
