/** Reconstruct reviewable actions exclusively from their original Session's accepted history. */
import type {} from '@deepseek-ai/dsh-agent/types'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import { ACTION_PREFIX, PROPOSE_TOOL, REVIEW_PREFIX, decodeEnvelope, selectionRequestFromMessage } from './prompt.ts'
import { createWorkbenchProposal, isRecord, proposalMatches } from './proposal.ts'
import { PREPARE_EDIT_TOOL, requestFromPreparedMetadata } from './conversation.ts'
import type { Config, WorkbenchActionAddress, WorkbenchActionValue, WorkbenchProposal, WorkbenchSelectionRequest } from './types.ts'

/** Durable facts needed for review without a process-local Agent or action object. */
export interface RecoveredWorkbenchAction {
  readonly request: WorkbenchSelectionRequest
  readonly value: WorkbenchActionValue
}

function reviewDecision(message: UserMessage, address: WorkbenchActionAddress, request: WorkbenchSelectionRequest, limits: Config): WorkbenchActionValue['reviewed'] {
  const source = message.source
  if (source.kind !== 'user' || !('rpcId' in source) || source.rpcId !== REVIEW_PREFIX + address.actionId) return undefined
  const content = message.content.find(block => block.type === 'text')
  const raw = content?.type === 'text' ? decodeEnvelope(content.text, 'review') : undefined
  if (!isRecord(raw) || raw.version !== 1 || raw.actionId !== address.actionId || raw.path !== request.path
    || raw.from !== request.from || raw.to !== request.to || raw.bufferVersion !== request.bufferVersion
    || (raw.decision !== 'accepted' && raw.decision !== 'rejected' && raw.decision !== 'partial')
    || (raw.appliedText !== undefined && (typeof raw.appliedText !== 'string' || raw.appliedText.length > limits.maxReplacementChars))) return undefined
  return raw.decision
}

/**
 * Match the original selection, exact tool call, successful result and turn settlement.
 * Inherited fork history cannot authorize an action in its child Session. Review inbox
 * insertions are already durable even before their next-step user/message projection.
 */
export function recoverWorkbenchAction(
  events: readonly SessionEvent[], inheritedEventCount: number, address: WorkbenchActionAddress, limits: Config,
): RecoveredWorkbenchAction | undefined {
  let request: WorkbenchSelectionRequest | undefined
  let requestMessageId: string | undefined
  let currentTurn: number | undefined
  let actionTurn: number | undefined
  let state: WorkbenchActionValue['state'] = 'queued'
  let proposal: WorkbenchProposal | undefined
  let reviewed: WorkbenchActionValue['reviewed']
  let answered = false
  let ambiguous = false
  const calls = new Map<string, WorkbenchProposal>()
  const pending = new Map<string, UserMessage>()
  const ordinaryMessages = new Map<number, UserMessage>()
  const preparationCalls = new Map<string, number>()
  const queues: { 'next-turn': UserMessage[]; 'next-step': UserMessage[] } = { 'next-turn': [], 'next-step': [] }
  const observeRequest = (message: UserMessage): void => {
    const source = message.source
    if (source.kind !== 'user' || !('rpcId' in source) || source.rpcId !== ACTION_PREFIX + address.actionId) return
    const decoded = selectionRequestFromMessage(message, address.sessionId, limits)
    if (decoded === undefined) { ambiguous = true; return }
    if (requestMessageId !== undefined && requestMessageId !== message.id) { ambiguous = true; return }
    request = decoded
    requestMessageId = message.id
  }
  const observeReview = (message: UserMessage): void => {
    if (request === undefined || proposal === undefined) return
    const decision = reviewDecision(message, address, request, limits)
    if (decision === undefined) return
    if (reviewed !== undefined && reviewed !== decision) { ambiguous = true; return }
    reviewed = decision
  }
  const observePreparation = (callId: string, meta: unknown): void => {
    const turn = preparationCalls.get(callId)
    if (turn === undefined) return
    const original = ordinaryMessages.get(turn)
    const decoded = requestFromPreparedMetadata(meta, address.sessionId, limits)
    if (original === undefined || decoded?.requestId !== address.actionId || decoded.mode !== 'edit') return
    const instruction = original.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    if (decoded.instruction !== instruction || request !== undefined) { ambiguous = true; return }
    request = decoded
    requestMessageId = original.id
    actionTurn = turn
    state = 'generating'
  }
  for (const event of events) {
    // Fold the full inbox so later own splices retain their checked offsets.
    if (event.type === 'agent/inbox/spliced') {
      const splice = event.data
      const removed = queues[splice.target].splice(splice.start, splice.removedCount ?? 0, ...splice.inserted)
      for (const message of removed) pending.delete(message.id)
      for (const message of splice.inserted) pending.set(message.id, message)
      if (event.seq < inheritedEventCount) continue
      for (const message of splice.inserted) { observeRequest(message); observeReview(message) }
      if (splice.outcome === 'canceled' && removed.some(message => message.id === requestMessageId) && actionTurn === undefined) state = 'cancelled'
      continue
    }
    if (event.seq < inheritedEventCount) continue
    if (event.type === 'turn/start') currentTurn = event.data.turn
    else if (event.type === 'user/message') {
      observeRequest(event.data)
      observeReview(event.data)
      if (event.data.id === requestMessageId && currentTurn !== undefined) { actionTurn = currentTurn; state = 'generating' }
      const source = event.data.source
      if (currentTurn !== undefined && source.kind === 'user' && (!('rpcId' in source) || typeof source.rpcId !== 'string'
        || !source.rpcId.startsWith(ACTION_PREFIX) && !source.rpcId.startsWith(REVIEW_PREFIX))) {
        ordinaryMessages.set(currentTurn, event.data)
      }
    } else if (event.type === 'assistant/message' && event.data.turn === actionTurn) {
      answered ||= event.data.message.content.some(block => block.type === 'text' && block.text.trim().length > 0)
    } else if (event.type === 'tool/call' && event.data.name === PREPARE_EDIT_TOOL) {
      preparationCalls.set(event.data.callId, event.data.turn)
    } else if (event.type === 'tool/ptc-dispatch-start' && event.data.name === PREPARE_EDIT_TOOL && currentTurn !== undefined) {
      preparationCalls.set(event.data.subCallId, currentTurn)
    } else if (event.type === 'tool/ptc-dispatch' && !event.data.isError) {
      observePreparation(event.data.subCallId, event.data.meta)
    } else if (event.type === 'tool/call' && event.data.turn === actionTurn && event.data.name === PROPOSE_TOOL && request?.mode !== undefined && request.mode !== 'ask') {
      try { calls.set(event.data.callId, createWorkbenchProposal(JSON.parse(event.data.arguments), request, limits)) }
      catch { /* Invalid tool attempts never authorize a proposal. */ }
    } else if (event.type === 'tool/result' && !event.data.message.isError) {
      observePreparation(event.data.message.toolCallId, event.data.meta)
      if (event.data.turn !== actionTurn) continue
      const expected = calls.get(event.data.message.toolCallId)
      if (expected !== undefined && proposalMatches(event.data.meta, expected)) {
        if (proposal !== undefined) ambiguous = true
        proposal = expected
      }
    } else if (event.type === 'turn/end') {
      if (event.data.turn === actionTurn) {
        state = event.data.reason.kind === 'completed'
          ? proposal !== undefined ? 'proposed' : request?.mode !== 'edit' && answered ? 'completed' : 'failed'
          : event.data.reason.kind === 'aborted' ? 'cancelled' : 'failed'
      }
      if (event.data.turn === currentTurn) currentTurn = undefined
    }
  }
  if (request === undefined || requestMessageId === undefined || ambiguous) return undefined
  if (state === 'queued' && !pending.has(requestMessageId)) state = 'cancelled'
  return {
    request,
    value: {
      actionId: address.actionId, state,
      ...(state === 'proposed' && proposal !== undefined ? { proposal } : {}),
      ...(state === 'proposed' && reviewed !== undefined ? { reviewed } : {}),
      ...(state === 'failed' ? { errorCode: 'model-failed' as const, error: 'The recorded selection turn did not produce a completed proposal. Send the selection again.' } : {}),
    },
  }
}
