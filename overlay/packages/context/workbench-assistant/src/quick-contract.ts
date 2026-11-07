/** Public, bounded operation schemas and editor exchange types. */
import { z } from 'zod'
import type { WordOperation } from '@deepseek-ai/dsh-workbench-word/types'
import { wordFormatSchema } from './word-format.ts'
import { wordCommandSchema } from './word-command.ts'
import { wordPageSchema } from './word-page.ts'

/** Bump when a capability or target meaning changes; persisted rules must match exactly. */
export const QUICK_CAPABILITY_VERSION = '0.10.4/1'

const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['selection', 'document']) }).strict(),
  z.object({ kind: z.literal('anchor'), text: z.string().min(1).max(8192) }).strict(),
  z.object({ kind: z.literal('paragraphs'), ids: z.array(z.string().min(1).max(200)).min(1).max(256) }).strict(),
])
export const formatSchema = wordFormatSchema.omit({ mode: true, styles: true, anchor: true, target: true })
const pageSchema = wordPageSchema.omit({ mode: true, requestId: true, expectedText: true })
const stepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('format'), target: targetSchema, format: formatSchema }).strict(),
  z.object({ kind: z.literal('native'), target: targetSchema, command: wordCommandSchema.shape.command }).strict(),
  z.object({ kind: z.literal('page'), options: pageSchema }).strict(),
  z.object({ kind: z.literal('page-all'), header: z.string().max(2048).optional(), footer: z.string().max(2048).optional(), pageNumbers: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal('styles'), styles: wordFormatSchema.shape.styles.unwrap() }).strict(),
  z.object({ kind: z.enum(['save', 'undo', 'redo', 'run', 'stop']) }).strict(),
  z.object({ kind: z.literal('replace'), target: targetSchema, text: z.string().max(8192) }).strict(),
])

/** Complete operation plan accepted by both local parsing and the bounded model parser. */
export const readyQuickPlanSchema = z.object({ kind: z.literal('ready'), label: z.string().min(1).max(120),
  steps: z.array(stepSchema).min(1).max(16) }).strict()
/** Each offered choice is a complete plan, preserving every known operation and parameter. */
export const quickClarificationSchema = z.object({ kind: z.literal('clarify'), question: z.string().min(1).max(300),
  choices: z.array(z.object({ label: z.string().min(1).max(100), plan: readyQuickPlanSchema }).strict()).max(4).default([]),
}).strict()
/** The model can return a complete plan, one clarification, or explicitly delegate creative work. */
export const quickPlanSchema = z.discriminatedUnion('kind', [
  readyQuickPlanSchema,
  quickClarificationSchema,
  z.object({ kind: z.literal('recover'), reason: z.enum(['context', 'capability', 'correction']), detail: z.string().min(1).max(500) }).strict(),
  z.object({ kind: z.literal('blocked'), reason: z.enum(['capability', 'context', 'budget']), explanation: z.string().min(1).max(1200),
    alternatives: quickClarificationSchema.shape.choices }).strict(),
  z.object({ kind: z.literal('answer'), text: z.string().min(1).max(1200) }).strict(),
  z.object({ kind: z.literal('delegate') }).strict(),
])
/** Validated plan with no executable code, tool name, model-supplied offset or file path. */
export type QuickPlan = Extract<z.infer<typeof quickPlanSchema>, { kind: 'ready' }>
/** One capability invocation bound to a semantic target. */
export type QuickStep = QuickPlan['steps'][number]
/** Target identity is resolved again against the current editor for every execution. */
export type QuickTarget = z.infer<typeof targetSchema>
/** The editor owns application, saving and undo; the Host owns validation and learning. */
export type QuickExecution =
  | { kind: 'word'; operations: WordOperation[] }
  | { kind: 'source'; edits: { from: number; to: number; before: string; text: string }[] }
  | { kind: 'control'; action: 'save' | 'run' | 'stop' }
/** Remote preparation cannot authorize a changed file or a changed selection. */
export type QuickPrepared =
  | { kind: 'result'; result: { kind: 'success' | 'error'; text: string } }
  | {
    kind: 'prepared'
    requestId: string
    path: string
    bufferVersion: string
    selection: { from: number; to: number }
    selectionKey: string
    execution: QuickExecution
  }
