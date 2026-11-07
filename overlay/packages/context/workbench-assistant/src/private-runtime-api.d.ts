/** Public declaration of the separately built private execution module. No implementation is included. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { WordOperation, WordPageInfo } from '@deepseek-ai/dsh-workbench-word/types'
import type { ConversationState } from './conversation.ts'
import type { QuickPlan, QuickPrepared } from './quick-contract.ts'
import type { QuickDialogue, QuickReply } from './quick-dialogue.ts'
import type { WorkbenchEditorContext, QuickLearningStatus } from './types.ts'

export declare class QuickRuntime {
  constructor(ctx: Context, readConversation: (session: Session) => ConversationState,
    handoff?: (agent: Agent, dialogue: QuickDialogue, reason: string) => void)
  readonly learning: {
    status(workspace: string, action: 'inspect' | 'pause' | 'resume' | 'clear'): Promise<QuickLearningStatus>
  }
  executeAgentPlan(agent: Agent, frame: WorkbenchEditorContext, editorId: string,
    input: unknown, signal: AbortSignal): Promise<{ kind: 'success' | 'error'; text: string }>
  prepare(agent: Agent, frame: WorkbenchEditorContext, instruction: string, signal: AbortSignal,
    requestId: string, reply?: QuickReply): Promise<QuickPrepared | null>
  claim(sessionId: SessionId, requestId: string, editorId: string): QuickPrepared | null
  reject(agent: Agent, instruction: string, requestId: string, path: string,
    selectedText: string, reason: string): QuickPrepared
  recover(agent: Agent): void
  complete(sessionId: SessionId, requestId: string, error: string | null): Promise<{ kind: 'success' | 'error'; text: string }>
  finishAgentTurn(agent: Agent, instruction: string, completed: boolean): void
  release(sessionId: SessionId): void
  observe(sessionId: SessionId, frame: WorkbenchEditorContext | null): void
  close(): Promise<void>
}

export type QuickWordOperation =
  | { kind: 'operation'; operation: WordOperation; label: string }
  | { kind: 'page'; header?: string; footer?: string; pageNumbers?: boolean; label: string }
  | { kind: 'save'; label: string }

export declare function quickWordPlan(instruction: string, frame: WorkbenchEditorContext): QuickWordOperation | null
export declare function quickPageOperations(plan: Extract<QuickWordOperation, { kind: 'page' }>,
  info: WordPageInfo, path: string): WordOperation[]
export declare function isWordPageTask(instruction: string): boolean

export declare const guideParameters: ToolDefinition['parameters']
export declare function workbenchGuide(input: unknown): object
export declare const workbenchPolicy: string
export declare const agentHandoffPolicy: string
export declare const workbenchToolPriorities: Record<'ask' | 'edit' | 'assist' | 'page', string>
