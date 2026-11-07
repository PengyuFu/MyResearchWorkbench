import type { WebContents } from 'electron'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectDesktopDocument } from '../src/quit-document.ts'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

function page() {
  const executeJavaScript = vi.fn<WebContents['executeJavaScript']>()
  executeJavaScript.mockResolvedValue(false)
  return { executeJavaScript, isDestroyed: vi.fn(() => false) }
}

describe('inspectDesktopDocument', () => {
  it('has no live document before creation or after destruction', async () => {
    expect(await inspectDesktopDocument(undefined)).toBe('clean')
    const contents = page()
    contents.isDestroyed.mockReturnValue(true)
    expect(await inspectDesktopDocument(contents)).toBe('clean')
    expect(contents.executeJavaScript).not.toHaveBeenCalled()
  })

  it('dispatches the existing cancelable beforeunload listeners without unloading the page', async () => {
    const contents = page()
    expect(await inspectDesktopDocument(contents)).toBe('clean')
    const source = contents.executeJavaScript.mock.calls[0]![0]
    const document = new EventTarget()
    expect(await runInNewContext(source, { Event, CustomEvent, window: document })).toBe(false)
    const veto = vi.fn((event: Event) => { event.preventDefault() })
    document.addEventListener('beforeunload', veto)
    expect(await runInNewContext(source, { Event, CustomEvent, window: document })).toBe(true)
    expect(veto).toHaveBeenCalledOnce()
    expect(veto.mock.calls[0]![0].cancelable).toBe(true)
  })

  it('waits for durable document checkpoints before checking whether unload is allowed', async () => {
    const contents = page()
    await inspectDesktopDocument(contents)
    const source = contents.executeJavaScript.mock.calls[0]![0]
    const document = new EventTarget()
    const checkpoint = Promise.withResolvers<undefined>()
    const order: string[] = []
    document.addEventListener('dsh:prepare-close', (event) => {
      order.push('checkpoint')
      ;(event as CustomEvent<{ waitUntil(operation: Promise<void>): void }>).detail.waitUntil(checkpoint.promise)
    })
    document.addEventListener('beforeunload', () => { order.push('unload') })
    const pending = runInNewContext(source, { Event, CustomEvent, window: document }) as Promise<boolean>
    expect(order).toEqual(['checkpoint'])
    checkpoint.resolve(undefined)
    expect(await pending).toBe(false)
    expect(order).toEqual(['checkpoint', 'unload'])
  })

  it('reports an explicit document veto', async () => {
    const contents = page()
    contents.executeJavaScript.mockResolvedValue(true)
    expect(await inspectDesktopDocument(contents)).toBe('unsaved')
  })

  it('does not trust malformed answers or a document destroyed during inspection', async () => {
    const malformed = page()
    malformed.executeJavaScript.mockResolvedValue('false')
    expect(await inspectDesktopDocument(malformed)).toBe('unavailable')
    const destroyed = page()
    destroyed.isDestroyed.mockReturnValueOnce(false).mockReturnValue(true)
    expect(await inspectDesktopDocument(destroyed)).toBe('unavailable')
  })

  it('reports renderer failure without authorizing a silent quit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const contents = page()
    contents.executeJavaScript.mockRejectedValue(new Error('renderer crashed'))
    expect(await inspectDesktopDocument(contents)).toBe('unavailable')
    expect(console.warn).toHaveBeenCalledWith('desktop quit: document inspection unavailable', expect.any(Error))
  })

  it('bounds an unresponsive renderer and ignores its late answer', async () => {
    vi.useFakeTimers()
    const response = Promise.withResolvers<boolean>()
    const contents = page()
    contents.executeJavaScript.mockReturnValue(response.promise)
    const inspection = inspectDesktopDocument(contents)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await inspection).toBe('unavailable')
    response.resolve(false)
    expect(await inspection).toBe('unavailable')
    expect(vi.getTimerCount()).toBe(0)
  })
})
