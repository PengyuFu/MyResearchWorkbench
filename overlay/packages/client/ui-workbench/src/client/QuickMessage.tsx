/** Registered quick-operation messages share the ordinary scrollable conversation. */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { QuickMessage as Message, QuickStatus } from '@deepseek-ai/dsh-workbench-assistant/types'
import css from './Workbench.module.css'

export interface QuickMessageState { readonly message?: Message; readonly status?: QuickStatus }
declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap { 'workbench-quick': QuickMessageState }
}
/** Durable request, clarification and receipt are correlated before presentation. */
export const quickMessageDefinition: ConversationNodeDefinition<QuickMessageState> = {
  kind: 'workbench-quick', target: 'chat',
  match(event) {
    if (event.type === 'workbench/quick-message') return { id: event.data.requestId, role: 'start', exclusive: true }
    if (event.type === 'workbench/quick-status' || event.type === 'workbench/quick-result'
      || event.type === 'workbench/quick-model-request' || event.type === 'workbench/quick-model-result') {
      return { id: event.data.requestId, role: 'update', exclusive: true }
    }
    return null
  },
  start(_context, match) {
    return match.event.type === 'workbench/quick-message' ? { message: match.event.data } : {}
  },
  update({ state }, { event }) {
    if (event.type === 'workbench/quick-message') return { ...state, message: event.data }
    if (event.type === 'workbench/quick-status') return { ...state, status: event.data }
    return state
  },
  buildViewNode(context): ChatConversationViewNode | null {
    if (!context.state?.message) return null
    return { key: context.key, kind: 'workbench-quick', id: context.id, target: 'chat',
      anchorSeq: context.start?.event.seq ?? 0, location: { kind: 'session' }, visibility: context.state.status?.phase === 'delegated' ? 'hidden' : 'visible',
      groupTree: 'exchange', data: context.state }
  },
}
export interface QuickMessageActions {
  answerQuick(requestId: string, choice: number, label: string): Promise<void>
  stopQuick(): void
}
type QuickMessageProps = PropsRuntime<'conversation.chat.node', 'workbench-quick'>
  & PropsLocale<'workbench'> & QuickMessageActions
/** User messages remain visible; choices and results occupy the answer area, never the input. */
export function QuickMessage({ node, t, answerQuick, stopQuick }: QuickMessageProps) {
  const { message, status } = node.data
  if (!message) return null
  const choices = status?.dialogue.clarification?.choices ?? []
  const waiting = status?.phase === 'clarifying' || status?.phase === 'blocked' && choices.length > 0
  const running = status === undefined || status.phase === 'parsing' || status.phase === 'diagnosing' || status.phase === 'applying'
  return <article className={css.quickExchange} data-workbench-request={message.requestId}>
    <div className={css.quickUser}>
      <p>{message.instruction}</p>
      <details className={css.quickReference}>
        <summary>{message.path.split(/[\\/]/u).at(-1)}</summary>
        {message.selectedText !== '' && <pre>{message.selectedText}</pre>}
      </details>
    </div>
    <div className={css.quickAnswer} aria-live="polite" data-workbench-phase={status?.phase ?? 'parsing'}>
      <div className={css.quickStatus}>
        <span>{status?.phase === 'diagnosing' ? t('quickDiagnosing') : status?.phase === 'blocked' ? t('quickBlocked') : status?.phase === 'unverified' ? t('quickUnverified') : running ? t('quickProcessing') : waiting ? t('quickNeedsAnswer') : status?.phase === 'failed' ? t('quickFailed')
          : status?.phase === 'cancelled' ? t('cancelled') : status?.phase === 'answered' ? t('quickAnswered') : t('quickCompleted')}</span>
        {status && !running && status.elapsedMs > 0 && <small>{(status.elapsedMs / 1000).toFixed(1)} s</small>}
        {running && <button type="button" className={css.quietButton} onClick={stopQuick}>{t('cancel')}</button>}
      </div>
      <p className={status?.phase === 'failed' ? css.errorText : undefined}>{status?.text ?? t('quickProcessing')}</p>
      {choices.length > 0 && <div className={css.quickChoices} aria-label={t('quickChoices')}>
        {choices.map((choice, index) => <button type="button" key={index} data-workbench-choice={index}
          disabled={!waiting} onClick={() => { void answerQuick(message.requestId, index, choice.label) }}>
          <span>{index + 1}</span>{choice.label}
        </button>)}
      </div>}
      {waiting && <small className={css.hint}>{t('quickReplyHint')}</small>}
    </div>
  </article>
}
