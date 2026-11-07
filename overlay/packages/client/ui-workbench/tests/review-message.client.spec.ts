/** Review display accepts its exact versioned protocol without rewriting the transcript. */
import { describe, expect, it } from 'vitest'
import type { WorkbenchReviewContext } from '@deepseek-ai/dsh-workbench-assistant/types'
import { reviewMessageRule } from '../src/client/ReviewMessage.tsx'

const review: WorkbenchReviewContext = {
  version: 1, decision: 'accepted', path: 'chapters/results.tex', actionId: 'review-action',
  from: 17, to: 48, bufferVersion: '2', appliedText: '已采纳的正文\n\\alpha + 1',
}

function envelope(data: unknown): string {
  return `[Workbench edit review]\nModel-facing review instructions stay in the transcript.\n<mrw-review-context>\n${JSON.stringify(data)}\n</mrw-review-context>`
}

function match(text: string, from = 0) {
  return reviewMessageRule.match(text, from, { read: () => undefined })
}

describe('workbench review message projection', () => {
  it.each(['accepted', 'partial', 'rejected'] as const)('recognizes the complete %s envelope and preserves the original text', (decision) => {
    const data: WorkbenchReviewContext = { ...review, decision }
    const text = envelope(data)
    const original = text
    expect(match(text)).toEqual({ id: 'workbench-review', start: 0, end: text.length, data })
    expect(text).toBe(original)
    expect(match(text, 1)).toBeUndefined()
  })

  it('accepts a partial review without claiming known current text', () => {
    const data: WorkbenchReviewContext = {
      version: 1, decision: 'partial', path: review.path, actionId: review.actionId,
      from: review.from, to: review.to, bufferVersion: review.bufferVersion,
    }
    const text = envelope(data)
    expect(match(text)).toEqual({ id: 'workbench-review', start: 0, end: text.length, data })
  })

  it.each([
    ['unsupported version', { ...review, version: 2 }],
    ['unknown decision', { ...review, decision: 'saved' }],
    ['missing required field', { ...review, bufferVersion: undefined }],
    ['unknown field', { ...review, saved: true }],
    ['empty path', { ...review, path: ' ' }],
    ['negative offset', { ...review, from: -1 }],
    ['reversed range', { ...review, to: 3 }],
    ['fractional offset', { ...review, from: 1.5 }],
    ['non-text content', { ...review, appliedText: null }],
  ])('keeps %s visible as ordinary text', (_name, data) => {
    expect(match(envelope(data))).toBeUndefined()
  })

  it('does not collapse ordinary acceptance wording or malformed marker text', () => {
    expect(match('I accepted the proposed replacement for this selection.')).toBeUndefined()
    expect(match(envelope(review).replace('[Workbench edit review]', '[Something else]'))).toBeUndefined()
    expect(match(envelope(review) + '\nadditional user text')).toBeUndefined()
    expect(match(envelope(review).replace('<mrw-review-context>', '<mrw-review-context>\n<mrw-review-context>'))).toBeUndefined()
    expect(match('[Workbench edit review]\n<mrw-review-context>\n{broken\n</mrw-review-context>')).toBeUndefined()
  })
})
