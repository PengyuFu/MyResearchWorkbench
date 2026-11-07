/** Durable projection of explicit conversation requests to open or review an editor target. */
import type { Context } from '@deepseek-ai/cordis'
import { z as zod } from 'zod'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ProjectionHandle } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { isRecord } from './proposal.ts'
import { selectionOf, selectionRequestFromData } from './prompt.ts'
import { quickDialogueSchema, quickHistorySchema } from './quick-dialogue.ts'
import type { Config, WorkbenchConversationView, WorkbenchSelectionRequest } from './types.ts'

export const READ_CONTEXT_TOOL = 'workbench_read_context'
export const OPEN_FILE_TOOL = 'workbench_open_file'
export const PREPARE_EDIT_TOOL = 'workbench_prepare_edit'

export interface ConversationState {
  readonly inheritedEventCount: number
  readonly quickRequestIds: readonly string[]
  readonly view: WorkbenchConversationView
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap { workbench: WorkbenchConversationView }
}

/** Serialize the exact captured request as both model context and durable tool metadata. */
export function preparedMetadata(request: WorkbenchSelectionRequest): JsonValue {
  const { assetPaths, attachmentAssets, ...selection } = selectionOf(request)
  return {
    kind: 'workbench-conversation-prepared', version: 1,
    request: {
      ...selection, sessionId: request.sessionId, requestId: request.requestId, mode: request.mode, instruction: request.instruction,
      ...(assetPaths === undefined ? {} : { assetPaths: [...assetPaths] }),
      ...(attachmentAssets === undefined ? {} : { attachmentAssets: attachmentAssets.map(asset => ({ ...asset })) }),
    },
  }
}

/** Decode only a validated tool result owned by this Session. */
export function requestFromPreparedMetadata(
  value: unknown, sessionId: SessionId, limits: Config,
): WorkbenchSelectionRequest | undefined {
  if (!isRecord(value) || value.kind !== 'workbench-conversation-prepared' || value.version !== 1
    || !isRecord(value.request) || value.request.sessionId !== sessionId || typeof value.request.requestId !== 'string') return undefined
  return selectionRequestFromData(value.request, sessionId, value.request.requestId, limits)
}

/** The projection consumes only committed successful native or nested tool outcomes. */
export async function registerConversationProjection(ctx: Context, limits: Config): Promise<ProjectionHandle<ConversationState>> {
  const openSchema = zod.object({ seq: zod.number(), path: zod.string(), mode: zod.enum(['writing', 'development']) }).nullable()
  const preparedSchema = zod.object({
    seq: zod.number(),
    request: zod.custom<WorkbenchSelectionRequest>(value => isRecord(value) && typeof value.sessionId === 'string'
      && requestFromPreparedMetadata({ kind: 'workbench-conversation-prepared', version: 1, request: value },
        value.sessionId as SessionId, limits) !== undefined),
  }).nullable()
  const wordSchema = zod.object({ seq: zod.number(), path: zod.string(),
    documentId: zod.string(), revision: zod.number() }).nullable().optional()
  const viewSchema = zod.object({ open: openSchema, prepared: preparedSchema, wordUpdated: wordSchema,
    agentOperation: zod.object({ requestId: zod.string(), seq: zod.number() }).nullable().optional(),
    quick: quickDialogueSchema.nullable().optional(), quickHistory: zod.array(quickHistorySchema).max(12).optional() })
  const stateSchema = zod.object({ inheritedEventCount: zod.number(), quickRequestIds: zod.array(zod.string()), view: viewSchema })
  return await ctx.sessionProjections.register<'workbench', ConversationState>({
    key: 'workbench', stateVersion: 5, stateSchema,
    init: (_header, inheritedEventCount) => ({ inheritedEventCount, quickRequestIds: [], view: { open: null, prepared: null } }),
    apply: (state, event) => {
      if (event.seq < state.inheritedEventCount) return state
      if (event.type === 'workbench/agent-operation') return { ...state, view: { ...state.view,
        agentOperation: { requestId: event.data.requestId, seq: event.seq } } }
      if (event.type === 'workbench/quick-message') return { ...state, quickRequestIds: [...state.quickRequestIds, event.data.requestId], view: { ...state.view,
        quickHistory: [...(state.view.quickHistory ?? []), { requestId: event.data.requestId, instruction: event.data.instruction,
          path: event.data.path, phase: 'parsing' as const, result: '' }].slice(-12) } }
      if (event.type === 'workbench/quick-status') return { ...state, view: { ...state.view, quick: event.data.activate === false ? state.view.quick : event.data.dialogue,
        quickHistory: (state.view.quickHistory ?? []).map(item => item.requestId === event.data.requestId
          ? { ...item, phase: event.data.phase, result: event.data.text } : item) } }
      const meta = event.type === 'tool/result' && !event.data.message.isError ? event.data.meta
        : event.type === 'tool/ptc-dispatch' && !event.data.isError ? event.data.meta : undefined
      if (!isRecord(meta)) return state
      if (meta.kind === 'workbench-open-file' && typeof meta.path === 'string'
        && (meta.mode === 'writing' || meta.mode === 'development')) {
        return { ...state, view: { ...state.view, open: { seq: event.seq, path: meta.path, mode: meta.mode } } }
      }
      if (meta.kind === 'workbench-word-updated' && typeof meta.path === 'string'
        && typeof meta.documentId === 'string' && typeof meta.revision === 'number') {
        return { ...state, view: { ...state.view, wordUpdated: {
          seq: event.seq, path: meta.path, documentId: meta.documentId, revision: meta.revision,
        } } }
      }
      if (!isRecord(meta.request) || typeof meta.request.sessionId !== 'string') return state
      const request = requestFromPreparedMetadata(meta, meta.request.sessionId as SessionId, limits)
      if (request === undefined) return state
      return { ...state, view: { ...state.view, prepared: { seq: event.seq, request } } }
    },
    wire: { viewSchema, view: state => state.view },
  })
}
