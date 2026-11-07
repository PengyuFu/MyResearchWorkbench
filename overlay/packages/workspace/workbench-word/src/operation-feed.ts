/** Session-scoped delivery of durable editor requests; the worker owns their state. */
import type { WordOperationNotice } from './types.ts'

/** Owns live subscribers without retaining document bytes or duplicating the operation queue. */
export class WordOperationFeed {
  private readonly followers = new Map<string, Set<{ push(value: WordOperationNotice): void; close(): void }>>()

  /** @param key - Authenticated session/workspace identity. @returns Whether an editor can receive work. */
  available(key: string): boolean { return (this.followers.get(key)?.size ?? 0) > 0 }

  /** @param key - Authenticated owner. @param value - Notice emitted after the worker commits its queue. */
  publish(key: string, value: WordOperationNotice): void {
    for (const follower of this.followers.get(key) ?? []) follower.push(value)
  }

  /** Wake and release every subscriber at service disposal. */
  close(): void {
    for (const group of this.followers.values()) for (const follower of group) follower.close()
    this.followers.clear()
  }

  /**
   * Subscribe before reading pending work so reconnect cannot miss a queued request.
   * @param key - Authenticated owner.
   * @param baseline - Current durable pending documents.
   * @param signal - Consumer lifetime.
   * @returns Readiness and coalesced document notices.
   */
  async *follow(key: string, baseline: () => Promise<WordOperationNotice[]>, signal: AbortSignal): AsyncIterable<WordOperationNotice> {
    signal.throwIfAborted()
    const pending = new Map<string, WordOperationNotice>()
    let wake: (() => void) | undefined
    let closed = false
    const follower = {
      push(value: WordOperationNotice) { pending.set(value.kind === 'ready' ? '' : value.documentId, value); wake?.() },
      close() { closed = true; wake?.() },
    }
    const group = this.followers.get(key) ?? new Set()
    this.followers.set(key, group)
    group.add(follower)
    const abort = () => follower.close()
    signal.addEventListener('abort', abort, { once: true })
    try {
      for (const value of await baseline()) follower.push(value)
      yield { kind: 'ready' }
      while (!closed && !signal.aborted) {
        const values = [...pending.values()]
        pending.clear()
        for (const value of values) yield value
        if (!closed && !signal.aborted && pending.size === 0) await new Promise<void>((resolve) => { wake = resolve })
        wake = undefined
      }
    } finally {
      signal.removeEventListener('abort', abort)
      group.delete(follower)
      if (group.size === 0) this.followers.delete(key)
    }
  }
}
