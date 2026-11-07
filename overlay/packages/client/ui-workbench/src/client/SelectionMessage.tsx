/** Display-only projection of the logged selection protocol. */
import { useState } from 'react'
import type { UserTextNodeProps, UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './Workbench.module.css'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    'workbench-selection': { path: string; mode: 'ask' | 'edit' | 'assist'; instruction: string; selectedText: string }
  }
}

/** The immutable transcript keeps its full context; this rule only changes display. */
export const selectionMessageRule: UserTextRule<'workbench-selection'> = {
  id: 'workbench-selection', order: -100,
  match(text, from) {
    if (from !== 0 || !text.startsWith('[Workbench selected-text request]')) return
    const open = '<mrw-selection-context>\n'
    const close = '\n</mrw-selection-context>'
    const start = text.lastIndexOf(open)
    if (start < 0 || !text.endsWith(close)) return
    try {
      const value: unknown = JSON.parse(text.slice(start + open.length, -close.length))
      if (typeof value !== 'object' || value === null || !('path' in value) || typeof value.path !== 'string'
        || !('instruction' in value) || typeof value.instruction !== 'string'
        || !('selectedText' in value) || typeof value.selectedText !== 'string'
        || !('mode' in value) || (value.mode !== 'ask' && value.mode !== 'edit' && value.mode !== 'assist')) return
      return { id: 'workbench-selection', start: 0, end: text.length,
        data: { path: value.path, mode: value.mode, instruction: value.instruction, selectedText: value.selectedText } }
    } catch (_error) { return }
  },
}

/** An expandable source excerpt avoids putting protocol JSON into a chat bubble. */
export function SelectionMessage({ node, interactive, t }: UserTextNodeProps<'workbench-selection'> & PropsLocale<'workbench'>) {
  const [expanded, setExpanded] = useState(false)
  const { path, mode, instruction, selectedText } = node.data
  if (!interactive) return <span>{instruction} · {path}</span>
  return <span className={css.selectionMessage}>
    <span className={css.selectionMessageHeading}><strong>{mode === 'assist' ? t('assistSelection') : mode === 'ask' ? t('askSelection') : t('editSelection')}</strong><span title={path}>{path}</span></span>
    <span className={css.selectionMessageInstruction}>{instruction}</span>
    <button type="button" className={css.quietButton} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '⌄' : '›'} {selectedText.length} {t('selectionCount')}</button>
    {expanded && <span className={css.selectionMessageExcerpt}>{selectedText}</span>}
  </span>
}
