/**
 * Task vocabulary rules shared by the personal-plan service and its engine:
 * normalization, per-plan ordering, and the status classifier the run cursor
 * advances by.
 *
 * A task always belongs to exactly one plan and keeps one position inside that
 * plan's task list. Positions never move because of a status; the user's own
 * drag order is the only order, and a batch dispatches the pending tasks in it.
 * @module @deepseek-ai/dsh-personal-plan/tasks
 */

import type { PlanTask, PlanTaskDraft, PlanTaskStatus } from './types.ts'

/** Longest accepted task title. */
export const MAX_TASK_TITLE_LENGTH = 200
/** Longest accepted task instruction or completion requirement. */
export const MAX_TASK_DETAIL_LENGTH = 8000
/** Largest number of required artifact paths one task declares. */
export const MAX_TASK_FILES = 20
/** Longest accepted required artifact path. */
export const MAX_TASK_FILE_PATH_LENGTH = 1024
/** Largest number of tasks one plan accepts. */
export const MAX_TASKS_PER_PLAN = 100

/** Statuses that have not finished, so a batch may still dispatch them. */
const UNFINISHED: readonly PlanTaskStatus[] = ['pending', 'running', 'needs_user', 'failed']

/**
 * Trim and validate a task title.
 * @param value - raw title text.
 * @returns the trimmed title.
 */
export function normalizeTaskTitle(value: string): string {
  const title = value.trim()
  if (title.length === 0) throw new Error('A task title cannot be empty.')
  if (title.length > MAX_TASK_TITLE_LENGTH) {
    throw new Error(`A task title is limited to ${String(MAX_TASK_TITLE_LENGTH)} characters.`)
  }
  return title
}

/**
 * Trim a task instruction and enforce its bound.
 * @param value - raw instruction text.
 * @returns the trimmed instruction.
 */
export function normalizeTaskDetail(value: string): string {
  const detail = value.trim()
  if (detail.length > MAX_TASK_DETAIL_LENGTH) {
    throw new Error(`A task instruction is limited to ${String(MAX_TASK_DETAIL_LENGTH)} characters.`)
  }
  return detail
}

/**
 * Normalize the declared required artifacts of one task.
 *
 * Paths stay as the user typed them: a relative path is later resolved against
 * the batch working directory, so a plan stays portable between directories.
 * @param files - raw declared paths.
 * @returns the trimmed, deduplicated, non-empty paths.
 */
export function normalizeTaskFiles(files: readonly string[] | undefined): readonly string[] {
  if (files === undefined) return []
  const normalized: string[] = []
  for (const file of files) {
    const path = file.trim()
    if (path === '' || normalized.includes(path)) continue
    if (path.length > MAX_TASK_FILE_PATH_LENGTH) {
      throw new Error(`A required artifact path is limited to ${String(MAX_TASK_FILE_PATH_LENGTH)} characters.`)
    }
    normalized.push(path)
  }
  if (normalized.length > MAX_TASK_FILES) {
    throw new Error(`A task declares at most ${String(MAX_TASK_FILES)} required artifacts.`)
  }
  return normalized
}

/**
 * Normalize the user-editable fields of one task request.
 * @param title - required title.
 * @param detail - optional instruction.
 * @param requirement - optional completion requirements.
 * @param requestedFiles - optional required artifacts.
 * @returns the normalized draft.
 */
export function normalizeTaskDraft(
  title: string,
  detail: string | undefined,
  requirement?: string,
  requestedFiles?: readonly string[],
): PlanTaskDraft {
  return {
    title: normalizeTaskTitle(title),
    detail: detail === undefined ? '' : normalizeTaskDetail(detail),
    requirement: requirement === undefined ? '' : normalizeTaskDetail(requirement),
    requestedFiles: normalizeTaskFiles(requestedFiles),
  }
}

/**
 * Next position after every task of one plan.
 * @param tasks - every task of the board.
 * @param planId - owning plan identity.
 * @returns the next order value.
 */
export function nextTaskOrder(tasks: readonly PlanTask[], planId: string): number {
  return tasks.reduce((max, task) => task.planId === planId ? Math.max(max, task.order) : max, -1) + 1
}

/**
 * Whether one task has not finished, so a batch may dispatch it.
 * @param task - task to classify.
 * @returns whether the status is unfinished.
 */
export function isTaskUnfinished(task: PlanTask): boolean {
  return UNFINISHED.includes(task.status)
}

/**
 * Every task of one plan in the user's order.
 * @param tasks - every task of the board.
 * @param planId - owning plan identity.
 * @returns the plan's tasks sorted by position.
 */
export function tasksOfPlan(tasks: readonly PlanTask[], planId: string): PlanTask[] {
  return tasks.filter(task => task.planId === planId).sort((left, right) => left.order - right.order)
}

/**
 * The pending tasks to dispatch for one plan in user order.
 * @param tasks - every task of the board.
 * @param planId - owning plan identity.
 * @returns the tasks a plan-wide batch runs.
 */
export function pendingTasksOfPlan(tasks: readonly PlanTask[], planId: string): PlanTask[] {
  return tasksOfPlan(tasks, planId).filter(task => task.status === 'pending')
}

/**
 * Rewrite one plan's task positions; the request must name exactly that plan's tasks.
 * @param tasks - every task of the board.
 * @param planId - owning plan identity.
 * @param order - every task identity of the plan in the desired order.
 * @returns the rewritten task list.
 */
export function reorderTasksInPlan(tasks: readonly PlanTask[], planId: string, order: readonly string[]): PlanTask[] {
  const owned = tasksOfPlan(tasks, planId)
  const expected = new Set(owned.map(task => task.id))
  if (order.length !== expected.size || new Set(order).size !== order.length || order.some(id => !expected.has(id))) {
    throw new Error('The reorder request must list every task of the plan exactly once.')
  }
  const now = new Date().toISOString()
  const positions = new Map(order.map((id, index) => [id, index]))
  return tasks.map(task => task.planId !== planId ? task : { ...task, order: positions.get(task.id) as number, updatedAt: now })
}

/**
 * The board-wide task order a snapshot publishes: plans in plan order, tasks in
 * task order inside each plan.
 * @param items - plan items in their authoritative order.
 * @param tasks - every task of the board.
 * @returns the tasks in snapshot order.
 */
export function orderTasksForSnapshot(items: readonly { readonly id: string }[], tasks: readonly PlanTask[]): PlanTask[] {
  const planRank = new Map(items.map((item, index) => [item.id, index]))
  return [...tasks].sort((left, right) => {
    const leftRank = planRank.get(left.planId) ?? Number.MAX_SAFE_INTEGER
    const rightRank = planRank.get(right.planId) ?? Number.MAX_SAFE_INTEGER
    return leftRank - rightRank || left.order - right.order
  })
}
