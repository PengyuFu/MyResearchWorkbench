import { describe, expect, it } from 'vitest'
import { WordOperationFeed } from '../src/operation-feed.ts'
import type { WordOperationNotice } from '../src/types.ts'
const notice = (documentId: string, revision: number): WordOperationNotice => ({ kind: 'queued', path: 'paper.docx', documentId, revision })
describe('live Word operation notifications', () => {
  it('subscribes before baseline and isolates owners; disposal releases a waiting reader', async () => {
    const feed = new WordOperationFeed(), abort = new AbortController()
    let baseline!: (values: WordOperationNotice[]) => void
    const iterator = feed.follow('owner', () => new Promise((resolve) => { baseline = resolve }), abort.signal)[Symbol.asyncIterator]()
    const first = iterator.next()
    try {
      expect(feed.available('owner')).toBe(true)
      feed.publish('other', notice('foreign', 1))
      feed.publish('owner', notice('doc', 2))
      baseline([notice('baseline', 1)])
      expect(await first).toEqual({ value: { kind: 'ready' }, done: false })
      expect((await iterator.next()).value).toEqual(notice('doc', 2))
      expect((await iterator.next()).value).toEqual(notice('baseline', 1))
      const waiting = iterator.next()
      abort.abort()
      expect((await waiting).done).toBe(true)
      expect(feed.available('owner')).toBe(false)
    } finally { abort.abort(); feed.close(); await iterator.return?.() }
  })
  it('coalesces document notices and closes every subscriber', async () => {
    const feed = new WordOperationFeed(), abort = new AbortController()
    const iterator = feed.follow('owner', async () => [], abort.signal)[Symbol.asyncIterator]()
    try {
      await iterator.next()
      feed.publish('owner', notice('doc', 2)); feed.publish('owner', notice('doc', 3))
      expect((await iterator.next()).value).toEqual(notice('doc', 3))
      const waiting = iterator.next(); feed.close()
      expect((await waiting).done).toBe(true)
      expect(feed.available('owner')).toBe(false)
    } finally { abort.abort(); feed.close(); await iterator.return?.() }
  })
})
