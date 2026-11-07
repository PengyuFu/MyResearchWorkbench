/** Compact display of a logged review while retaining its full model-visible text. */
import { useState } from 'react'
import type { UserTextNodeProps, UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { WorkbenchReviewContext } from '@deepseek-ai/dsh-workbench-assistant/types'
import css from './Workbench.module.css'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    'workbench-review': WorkbenchReviewContext
  }
}

const fields = new Set(['version', 'decision', 'path', 'actionId', 'from', 'to', 'bufferVersion', 'appliedText'])

/** Match only the versioned review envelope, never ordinary acceptance wording. */
export const reviewMessageRule: UserTextRule<'workbench-review'> = {
  id: 'workbench-review', order: -100,
  match(text, from) {
    const prefix = '[Workbench edit review]\n'
    if (from !== 0 || !text.startsWith(prefix)) return
    const open = '<mrw-review-context>\n'
    const close = '\n</mrw-review-context>'
    const start = text.indexOf(open, prefix.length)
    if (start < 0 || !text.endsWith(close) || text.indexOf(open, start + open.length) !== -1) return
    try {
      const value: unknown = JSON.parse(text.slice(start + open.length, -close.length))
      if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).some(key => !fields.has(key))
        || !('version' in value) || value.version !== 1
        || !('decision' in value) || (value.decision !== 'accepted' && value.decision !== 'partial' && value.decision !== 'rejected')
        || !('path' in value) || typeof value.path !== 'string' || value.path.trim() === ''
        || !('actionId' in value) || typeof value.actionId !== 'string' || value.actionId.trim() === ''
        || !('from' in value) || typeof value.from !== 'number' || !Number.isSafeInteger(value.from) || value.from < 0
        || !('to' in value) || typeof value.to !== 'number' || !Number.isSafeInteger(value.to) || value.to < value.from
        || !('bufferVersion' in value) || typeof value.bufferVersion !== 'string' || value.bufferVersion.trim() === '') return
      const appliedText = 'appliedText' in value ? value.appliedText : undefined
      if (appliedText !== undefined && typeof appliedText !== 'string') return
      return { id: 'workbench-review', start: 0, end: text.length, data: {
        version: 1, decision: value.decision, path: value.path, actionId: value.actionId,
        from: value.from, to: value.to, bufferVersion: value.bufferVersion,
        ...(appliedText === undefined ? {} : { appliedText }),
      } }
    } catch (_error) { return }
  },
}

/**
 * Render the review decision and optionally the accepted selection as plain text.
 * @param props Parsed review, display policy and locale-owned strings.
 * @returns A concise summary; the original transcript remains unchanged.
 */
export function ReviewMessage({ node, interactive, t }: UserTextNodeProps<'workbench-review'> & PropsLocale<'workbench'>) {
  const [expanded, setExpanded] = useState(false)
  const { path, decision, appliedText } = node.data
  const summary = t(decision === 'accepted' ? 'reviewAccepted' : decision === 'partial' ? 'reviewPartial' : 'reviewRejected')
  const filename = path.split(/[\\/]/).at(-1) ?? path
  if (!interactive) return <span>{summary} · {filename}</span>
  return <span className={css.selectionMessage} data-workbench-review="">
    <span className={css.selectionMessageHeading}><strong>{summary}</strong><span title={path}>{filename}</span></span>
    {decision !== 'rejected' && appliedText !== undefined && <>
      <button type="button" className={css.quietButton} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? t('hideReviewedText') : t('showReviewedText')}</button>
      {expanded && <span className={css.selectionMessageExcerpt}>{appliedText === '' ? t('reviewedEmpty') : appliedText}</span>}
    </>}
  </span>
}
