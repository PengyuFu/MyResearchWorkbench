/** Selected-buffer actions carried through the existing conversation Agent. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment/types'
import type {} from '@deepseek-ai/dsh-llm/types'

declare module '@deepseek-ai/dsh-llm/types' {
  interface LlmRequestPurposeMap {
    'workbench-quick-parse': true
    'workbench-quick-diagnose': true
  }
}

/** Client-minted, session-scoped identity for an idempotent selection request. */
export type WorkbenchActionId = Branded<'WorkbenchActionId'>

/** Immutable UTF-16 buffer positions captured before an AI request. */
export interface WorkbenchSelection {
  readonly path: string
  readonly from: number
  readonly to: number
  readonly selectedText: string
  readonly contextBefore: string
  readonly contextAfter: string
  readonly bufferVersion: string
  /** Scientific object selected in the visual editor, or an insertion anchor. */
  readonly objectKind?: 'text' | 'formula' | 'figure' | 'table' | 'code' | 'insertion'
  readonly nodeId?: string
  /** Existing project assets confirmed by the editor; never model-created paths. */
  readonly assetPaths?: readonly string[]
  /** Session attachments staged only after a successful proposal reaches the editor. */
  readonly attachmentAssets?: readonly WorkbenchAttachmentAsset[]
}

/** A verified existing Harness attachment and its future workspace-relative figure path. */
export interface WorkbenchAttachmentAsset {
  readonly attachmentId: AttachmentId
  readonly kind: 'image' | 'file'
  /** Stable import name; the original attachment name remains in the conversation. */
  readonly name: string
  readonly mimeType: string
  readonly path: string
  readonly sha256: string
}

/** Current editor data; it becomes model-visible only in a logged tool result. */
export interface WorkbenchEditorContext {
  readonly word?: { readonly id: string; readonly revision: number }
  readonly path: string
  readonly text: string
  readonly bufferVersion: string
  readonly selection: { readonly from: number; readonly to: number }
  readonly selected: WorkbenchSelection | null
  readonly insertion: WorkbenchSelection | null
  readonly graphicsPaths: readonly string[]
  /** Current native paragraph addresses; never reused by learned templates. */
  readonly paragraphs?: readonly {
    readonly id: string
    readonly from: number
    readonly to: number
    readonly level: number
    readonly style: string
    readonly table?: import('@deepseek-ai/dsh-workbench-word/types').WordBlock['table']
    readonly pagination?: import('@deepseek-ai/dsh-workbench-word/types').WordBlock['pagination']
  }[]
  /** Native cell rectangle and active story, in addition to UTF-16 text bounds. */
  readonly selectionKey?: string
  readonly redoAvailable?: boolean
}

export type { QuickPrepared, QuickExecution } from './quick-contract.ts'
export type { QuickDialogue, QuickMessage, QuickStatus, QuickReply } from './quick-dialogue.ts'

/** Workspace-local learning controls; counts do not expose document contents. */
export interface QuickLearningStatus {
  readonly enabled: boolean
  readonly active: number
  readonly candidates: number
  readonly stopped: number
}

/** Ordered publication from one browser controller, scoped to the existing Session. */
export interface WorkbenchEditorPublication {
  readonly sessionId: SessionId
  readonly editorId: string
  readonly generation: number
  /** Null releases only this editor's current published buffer. */
  readonly context: WorkbenchEditorContext | null
}

/** Latest explicit conversation actions, reconstructed from successful tool results. */
export interface WorkbenchConversationView {
  /** Notice only; replay cannot execute without claiming a live, revision-bound request. */
  readonly agentOperation?: { readonly requestId: string; readonly seq: number } | null | undefined
  readonly quick?: import('./quick-dialogue.ts').QuickDialogue | null | undefined
  readonly quickHistory?: readonly import('./quick-dialogue.ts').QuickHistoryEntry[] | undefined

  readonly wordUpdated?: {
    readonly seq: number
    readonly path: string
    readonly documentId: string
    readonly revision: number
  } | null | undefined
  readonly open: { readonly seq: number; readonly path: string; readonly mode: 'writing' | 'development' } | null
  readonly prepared: { readonly seq: number; readonly request: WorkbenchSelectionRequest } | null
}

/** Authenticated bytes of an asset already named by a reviewable action. */
export interface WorkbenchAttachmentValue {
  readonly name: string
  readonly mimeType: string
  readonly path: string
  readonly sha256: string
  readonly data: Uint8Array
}

/** An explicitly requested question or proposed replacement. */
export interface WorkbenchSelectionRequest extends WorkbenchSelection {
  readonly sessionId: SessionId
  readonly requestId: string
  readonly mode: 'ask' | 'edit' | 'assist'
  readonly instruction: string
}

/** Address of one action; access is checked against its owning Session. */
export interface WorkbenchActionAddress {
  readonly sessionId: SessionId
  readonly actionId: WorkbenchActionId
}

/** Human review notification; applying and saving remain editor-owned operations. */
export interface WorkbenchReviewRequest extends WorkbenchActionAddress {
  readonly decision: 'accepted' | 'rejected' | 'partial'
  readonly appliedText?: string
  /** Original proposal buffer version checked by the editor before its transaction. */
  readonly baseVersion?: string
}

/** Versioned display data for a review of the originally captured selection. */
export interface WorkbenchReviewContext extends Pick<WorkbenchSelection, 'path' | 'from' | 'to' | 'bufferVersion'> {
  readonly version: 1
  readonly actionId: string
  readonly decision: WorkbenchReviewRequest['decision']
  /** Reviewed selection text, when the editor can report its current contents. */
  readonly appliedText?: string
}

/** A proposed replacement, never a file write or an accepted editor transaction. */
export interface WorkbenchProposal {
  readonly actionId: WorkbenchActionId
  readonly replacement: string
  readonly explanation: string
  readonly base: WorkbenchSelection
  readonly structured?: WorkbenchStructuredProposal
  /** Label renames require one version-checked editor transaction with their references. */
  readonly labelChanges?: readonly { readonly from: string; readonly to: string }[]
}

/** Reviewable scientific objects serialized by the Host into ordinary LaTeX. */
export type WorkbenchStructuredProposal = {
  readonly kind: 'figure'
  readonly assetPath: string
  readonly caption: string
  readonly label?: string
} | {
  readonly kind: 'table'
  readonly headers: readonly string[]
  readonly rows: readonly (readonly string[])[]
  readonly caption?: string
  readonly label?: string
  readonly alignment?: readonly ('l' | 'c' | 'r')[]
}

/** Live progress with settled proposals and reviews recoverable from the owning Session. */
export interface WorkbenchActionValue {
  readonly actionId: WorkbenchActionId
  readonly state: 'queued' | 'generating' | 'proposed' | 'completed' | 'cancelled' | 'failed'
  readonly proposal?: WorkbenchProposal
  readonly error?: string
  readonly errorCode?: 'setup-failed' | 'model-failed' | 'no-answer' | 'no-proposal'
  readonly reviewed?: 'accepted' | 'rejected' | 'partial'
}

/** Deployment limits for user-selected context and retained review actions. */
export interface Config {
  readonly maxDocumentChars: number
  readonly maxSelectionChars: number
  readonly maxContextChars: number
  readonly maxInstructionChars: number
  readonly maxReplacementChars: number
  readonly maxRetainedActions: number
}


declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** An ephemeral command notice; historical notices never authorize replay. */
    'workbench/agent-operation': { requestId: string }
  }
}
