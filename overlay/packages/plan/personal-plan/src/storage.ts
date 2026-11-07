/**
 * Durable storage of the personal plan board document.
 *
 * One Host-wide board is the domain's global singleton, so a backend write always
 * publishes the whole document and a read validates it at the durable boundary.
 * Tasks and the execution batch live in that same document: a task edit and a
 * plan edit share one revision, so a proposal built against one revision cannot
 * be applied over either kind of later change. Documents written before tasks
 * existed stay readable 鈥?the task list and the run default to empty.
 * @module @deepseek-ai/dsh-personal-plan/storage
 */

import { z } from 'zod'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { PlanItem, PlanItemStatus, PlanProposal, PlanRun, PlanTask } from './types.ts'

const STATUSES: readonly PlanItemStatus[] = ['todo', 'in_progress', 'done']

const itemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  note: z.string(),
  dueDate: z.string().nullable(),
  workdir: z.string().default(''),
  status: z.enum(['todo', 'in_progress', 'done']),
  order: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict()

const taskResultSchema = z.object({
  outcome: z.enum(['done', 'needs_user', 'failed']),
  summary: z.string(),
  files: z.array(z.string()),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  recordedAt: z.string(),
}).strict()

const taskDraftSchema = z.object({
  title: z.string(),
  detail: z.string(),
  requirement: z.string().default(''),
  requestedFiles: z.array(z.string()).default([]),
}).strict()

const taskSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  title: z.string().min(1),
  detail: z.string().default(''),
  requirement: z.string().default(''),
  requestedFiles: z.array(z.string()).default([]),
  status: z.enum(['pending', 'running', 'needs_user', 'done', 'stopped', 'failed']),
  order: z.number().int().min(0),
  sessionId: z.string().min(1).nullable(),
  result: taskResultSchema.nullable(),
  message: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict()

const runSchema = z.object({
  runId: z.string().min(1),
  planId: z.string().min(1),
  taskIds: z.array(z.string()),
  workdir: z.string(),
  status: z.enum(['running', 'stopped', 'done', 'interrupted']),
  currentTaskId: z.string().nullable(),
  message: z.string(),
  startedAt: z.string(),
  updatedAt: z.string(),
}).strict()

const changeSchema = z.object({
  changeId: z.string().min(1),
  kind: z.enum([
    'add', 'edit', 'delete', 'status', 'reorder',
    'task-add', 'task-edit', 'task-delete', 'task-reorder',
  ]),
  itemId: z.string().nullable(),
  planId: z.string().nullable(),
  taskId: z.string().nullable(),
  before: z.object({ title: z.string(), note: z.string(), dueDate: z.string().nullable(), workdir: z.string().default('') }).strict().nullable(),
  after: z.object({ title: z.string(), note: z.string(), dueDate: z.string().nullable(), workdir: z.string().default('') }).strict().nullable(),
  taskBefore: taskDraftSchema.nullable(),
  taskAfter: taskDraftSchema.nullable(),
  beforeStatus: z.enum(['todo', 'in_progress', 'done']).nullable(),
  afterStatus: z.enum(['todo', 'in_progress', 'done']).nullable(),
  beforeOrder: z.array(z.string()).nullable(),
  afterOrder: z.array(z.string()).nullable(),
  beforeTaskOrder: z.array(z.string()).nullable(),
  afterTaskOrder: z.array(z.string()).nullable(),
}).strict()

const proposalSchema = z.object({
  proposalId: z.string().min(1),
  baseRevision: z.number().int().min(0),
  createdAt: z.string(),
  changes: z.array(changeSchema),
}).strict()

/** One stored board document. `version` stays 1 while every predecessor stays readable. */
export interface PlanDocument {
  /** Stored document schema version. */
  readonly version: 1
  /** Monotonic revision of the board content. */
  readonly revision: number
  /** Every durable plan item. */
  readonly items: readonly PlanItem[]
  /** Every durable task. */
  readonly tasks: readonly PlanTask[]
  /** Pending draft change set, or null. */
  readonly proposal: PlanProposal | null
  /** The one execution batch in force, or null. */
  readonly run: PlanRun | null
  /** Last durable change instant, RFC 3339 UTC; empty before the first write. */
  readonly updatedAt: string
}

const documentSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().min(0),
  items: z.array(itemSchema),
  tasks: z.array(taskSchema).default([]),
  proposal: proposalSchema.nullable(),
  run: runSchema.nullable().default(null),
  updatedAt: z.string(),
}).strict()

/**
 * The empty document served before the user's first write.
 * @returns a fresh document that no caller may mutate in place.
 */
export function emptyPlanDocument(): PlanDocument {
  return { version: 1, revision: 0, items: [], tasks: [], proposal: null, run: null, updatedAt: '' }
}

/**
 * The personal plan storage domain: one global board document, no tables.
 *
 * The global slot is the whole board because the plan, its tasks, and the one
 * execution batch are a single user-level document; the domain layer serializes
 * every write and validates the record on open.
 */
export const personalPlanDomain = defineDomain({
  name: 'personal_plan',
  version: 1,
  global: { schema: documentSchema, initial: emptyPlanDocument() },
  tables: {},
})

/** Exposed for the storage schema test. */
export const personalPlanDocumentSchema = documentSchema

/** Exposed for the storage schema test. */
export { STATUSES as PLAN_STATUSES }
