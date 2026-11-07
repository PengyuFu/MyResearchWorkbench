/** Durable quick-task dialogue, shared by projection and the normal conversation renderer. */
import { z } from 'zod'
import type { Message, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { QuickPlan } from './quick-contract.ts'
import { quickClarificationSchema, readyQuickPlanSchema } from './quick-contract.ts'
import type { WorkbenchEditorContext } from './types.ts'

/** Exact document revision and native selection bound to a submitted task. */
export const quickBindingSchema = z.object({ path: z.string(), bufferVersion: z.string(), documentId: z.string().optional(),
  selectionKey: z.string(), selection: z.object({ from: z.number(), to: z.number() }) })
/** Durable task state retaining original intent, replies and a complete confirmed plan. */
export const quickDialogueSchema = z.object({
  requestId: z.string(), taskId: z.string(), original: z.string(), binding: quickBindingSchema,
  replies: z.array(z.object({ question: z.string(), answer: z.string() })).max(8),
  clarification: quickClarificationSchema.nullable(),
  plan: readyQuickPlanSchema.optional(),
  /** Diagnostic evidence is bounded and never replayed as an editor mutation. */
  diagnosis: z.object({ reason: z.string().max(1000), summary: z.string().max(1600) }).optional(),
  phase: z.enum(['parsing', 'diagnosing', 'clarifying', 'blocked', 'unverified', 'answered', 'applying', 'completed', 'failed', 'cancelled', 'delegated']),
})
/** Compact conversation context for ordinary model turns. */
export const quickHistorySchema = z.object({ requestId: z.string(), instruction: z.string(), path: z.string(),
  phase: quickDialogueSchema.shape.phase, result: z.string() })
/** One bounded quick-operation history item. */
export type QuickHistoryEntry = z.infer<typeof quickHistorySchema>
/** Validated task state restored from session persistence. */
export type QuickDialogue = z.infer<typeof quickDialogueSchema>
/** Choice index bound to the specific request that offered it. */
export interface QuickReply { readonly requestId: string; readonly choice: number }
/** Exact visible user message and the document reference submitted with it. */
export interface QuickMessage {
  readonly requestId: string
  readonly taskId: string
  readonly instruction: string
  readonly path: string
  readonly selectedText: string
  readonly time: number
}
/** Visible execution transition and its recoverable task state. */
export interface QuickStatus {
  readonly requestId: string
  readonly phase: QuickDialogue['phase']
  readonly text: string
  readonly dialogue: QuickDialogue
  readonly elapsedMs: number
  /** A rejected parallel or stale message must not replace the active task. */
  readonly activate?: boolean
}
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Records the exact submitted instruction, task identity and optional document reference for the conversation. */
    'workbench/quick-message': QuickMessage
    /** Records a task transition and its complete clarification state; replay restores presentation without executing the plan. */
    'workbench/quick-status': QuickStatus
  }
}
/**
 * Freeze only identities needed to reject a stale answer; document text is not duplicated.
 * @param frame - Current editor context.
 * @returns Document revision and selection identity.
 */
export function quickBinding(frame: WorkbenchEditorContext): QuickDialogue['binding'] {
  return { path: frame.path, bufferVersion: frame.bufferVersion,
    ...(frame.word ? { documentId: frame.word.id } : {}), selectionKey: frame.selectionKey ?? '', selection: frame.selection }
}
/**
 * A clarification cannot silently move to another document or another revision.
 * @param binding - Frozen task identity.
 * @param frame - Current editor context.
 * @returns Whether the original document revision and selection still match exactly.
 */
export function sameQuickBinding(binding: QuickDialogue['binding'], frame: WorkbenchEditorContext): boolean {
  return binding.path === frame.path && binding.bufferVersion === frame.bufferVersion
    && binding.documentId === frame.word?.id && binding.selectionKey === (frame.selectionKey ?? '')
    && binding.selection.from === frame.selection.from && binding.selection.to === frame.selection.to
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Auditable timings and actual plan, separate from any ordinary Agent turn. */
    'workbench/quick-result': {
      requestId: string
      route: 'local' | 'learned' | 'model' | 'agent'
      path: string
      plan: QuickPlan
      completed: boolean
      verified: boolean
      elapsedMs: number
      error?: string
    }
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Exact bounded input, logged before dispatch; not added to the ordinary model conversation. */
    'workbench/quick-model-request': {
      requestId: string
      capabilityVersion: string
      provider: string
      model: string
      system: string
      messages: Message[]
      maxTokens: number
      purpose?: 'parse' | 'diagnose'
      reasoningEffort?: ReasoningEffortId
    }
    /** Exact validated output or failure of one auxiliary parse. */
    'workbench/quick-model-result': { requestId: string; output: string; error?: string; elapsedMs: number }
  }
}
