/** Framed, cancellable protocol over the application's managed subprocess provider. */
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'

const envelope = z.discriminatedUnion('ok', [
  z.object({ id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.string().nullable(), ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() }) }),
])

export class WordBridgeError extends Error {
  constructor(readonly reason: string, message: string, options?: ErrorOptions) { super(message, options) }
}
interface Pending { resolve(value: unknown): void; reject(reason: Error): void; cleanup(): void }
export class WordBridge {
  private handle: SubprocessHandle | undefined
  private readonly pending = new Map<string, Pending>()
  private queue: Promise<void> = Promise.resolve()
  private stopped = false
  constructor(private readonly ctx: Context, private readonly python: string, private readonly script: string,
    private readonly dependency: string, private readonly data: string) {}

  private start(): SubprocessHandle {
    if (this.stopped) throw new WordBridgeError('unavailable', 'The Word service is closed.')
    if (this.handle !== undefined) return this.handle
    const handle = this.ctx.subprocess.spawn({
      argv: [this.python, '-I', '-B', '-u', '-X', 'utf8', this.script, this.dependency, this.data],
      cwd: this.data, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 64 * 1024 } }, graceMs: 2000,
      env: { PYTHONPATH: undefined, PYTHONHOME: undefined },
    })
    this.handle = handle
    const decoder = new StringDecoder('utf8')
    let buffered = ''
    handle.stdout?.on('data', (chunk: Buffer) => {
      buffered += decoder.write(chunk)
      if (buffered.length > 96 * 1024 * 1024) {
        this.fail(handle, new WordBridgeError('protocol', 'The Word response exceeded its limit.'))
        return
      }
      let newline: number
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        try {
          const value = envelope.parse(JSON.parse(line))
          const pending = value.id === null ? undefined : this.pending.get(value.id)
          if (value.id === null || pending === undefined) throw new WordBridgeError('protocol', 'Word returned an unexpected response.')
          this.pending.delete(value.id)
          pending.cleanup()
          if (value.ok) pending.resolve(value.result)
          else pending.reject(new WordBridgeError(value.error.code, value.error.message,
            { cause: value.error.details }))
        } catch (error) {
          this.fail(handle, new WordBridgeError('protocol', 'Word returned an invalid response.', { cause: error }))
        }
      }
    })
    void handle.done.then(() => this.fail(handle, new WordBridgeError('interrupted', 'The Word worker stopped; the last confirmed draft is retained.')),
      error => this.fail(handle, new WordBridgeError('unavailable', 'The Word worker could not start.', { cause: error })))
    return handle
  }

  private fail(handle: SubprocessHandle, error: WordBridgeError): void {
    if (this.handle !== handle) return
    this.handle = undefined
    handle.terminate()
    for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(error) }
    this.pending.clear()
  }

  /** Serialize every COM operation; cancellation stops only the proved-owned worker range. */
  request<T>(method: string, args: object, schema: z.ZodType<T>, signal: AbortSignal, timeout = 30_000): Promise<T> {
    const operation = this.queue.then(async () => {
      signal.throwIfAborted()
      const handle = this.start()
      const result = await new Promise<unknown>((resolve, reject) => {
        const id = randomUUID()
        const abort = () => this.fail(handle, new WordBridgeError('cancelled', 'The operation stopped; the last confirmed draft is retained.'))
        const timer = setTimeout(() => this.fail(handle, new WordBridgeError('timeout', 'Word did not finish in time; the last confirmed draft is retained.')), timeout)
        this.pending.set(id, { resolve, reject, cleanup: () => { clearTimeout(timer); signal.removeEventListener('abort', abort) } })
        signal.addEventListener('abort', abort, { once: true })
        handle.stdin?.write(JSON.stringify({ ...args, id, method }) + '\n', (error) => {
          if (error !== null && error !== undefined) this.fail(handle, new WordBridgeError('interrupted', 'Word could not receive the operation.', { cause: error }))
        })
      })
      return schema.parse(result)
    })
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  async close(): Promise<void> {
    if (this.handle === undefined) { this.stopped = true; return }
    const handle = this.handle
    try { await this.request('shutdown', {}, z.object({ closing: z.literal(true) }), new AbortController().signal, 5000) }
    finally {
      this.stopped = true
      const timeout = setTimeout(() => { if (this.handle === handle) this.fail(handle, new WordBridgeError('unavailable', 'The Word service is closed.')) }, 5000)
      try { await handle.waitForExit() } finally { clearTimeout(timeout) }
    }
  }
}
