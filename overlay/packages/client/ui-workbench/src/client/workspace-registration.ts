/** Shared registration boundary used by the plugin and its real-core composition test. */
import type { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Workbench } from './Workbench.tsx'
import { NS } from './locales.ts'
import type { WorkbenchInjected } from './types.ts'

/**
 * Register the workbench before the conversation fallback in SlotCore's ranking.
 * @param slots Registry receiving the workbench contribution.
 * @param inject Session-specific editor state and operations.
 * @returns Disposer that removes this contribution.
 */
export function registerWorkbenchWorkspace(
  slots: Pick<SlotCore, 'register'>,
  inject: (sessionId: SessionId | undefined) => WorkbenchInjected,
): () => void {
  // The conversation's fallback uses -100, so this occupant must rank lower.
  return slots.register({ name: 'conversation.workspace', priority: -200, locale: NS, inject }, Workbench)
}
