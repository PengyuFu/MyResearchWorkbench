/** Decode Windows MATLAB's native-code-page pipes without changing machine or MATLAB settings. */
import type { Readable } from 'node:stream'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'

interface OutputSnapshot { text: string; lossy: boolean }

class TextTail {
  private text = ''
  private lossy = false

  constructor(private readonly maxBytes: number) {}

  append(value: string): void {
    const bytes = Buffer.from(this.text + value, 'utf8')
    if (bytes.byteLength <= this.maxBytes) { this.text += value; return }
    this.lossy = true
    let start = bytes.byteLength - this.maxBytes
    while (start < bytes.byteLength && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1
    this.text = bytes.subarray(start).toString('utf8')
  }

  snapshot(): OutputSnapshot { return { text: this.text, lossy: this.lossy } }
}

class NativeTextStream {
  readonly finished: Promise<void>
  private readonly nativeDecoder: TextDecoder
  private readonly utf8Decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly nativeTail: TextTail
  private readonly utf8Tail: TextTail
  private utf8Valid = true

  constructor(stream: Readable | undefined, encoding: string, maxBytes: number) {
    this.nativeDecoder = new TextDecoder(encoding)
    this.nativeTail = new TextTail(maxBytes)
    this.utf8Tail = new TextTail(maxBytes)
    this.finished = new Promise((resolve) => {
      if (stream === undefined) { resolve(); return }
      let closed = false
      const data = (chunk: Buffer): void => {
        this.nativeTail.append(this.nativeDecoder.decode(chunk, { stream: true }))
        if (this.utf8Valid) {
          try { this.utf8Tail.append(this.utf8Decoder.decode(chunk, { stream: true })) }
          catch { this.utf8Valid = false }
        }
      }
      const finish = (): void => {
        if (closed) return
        closed = true
        stream.off('data', data)
        stream.off('end', finish)
        stream.off('close', finish)
        stream.off('error', finish)
        this.nativeTail.append(this.nativeDecoder.decode())
        if (this.utf8Valid) {
          try { this.utf8Tail.append(this.utf8Decoder.decode()) }
          catch { this.utf8Valid = false }
        }
        resolve()
      }
      stream.on('data', data)
      stream.once('end', finish)
      stream.once('close', finish)
      stream.once('error', finish)
      if (stream.readableEnded || stream.destroyed) finish()
    })
  }

  snapshot(): OutputSnapshot { return this.utf8Valid ? this.utf8Tail.snapshot() : this.nativeTail.snapshot() }
}

/**
 * Bounded, streaming MATLAB output. Valid UTF-8 wins; legacy output uses the measured Windows ANSI encoding.
 * Both candidate decoders retain their own complete-character tail, including while an encoding is undecided.
 */
export class MatlabOutput {
  readonly finished: Promise<void>
  private readonly out: NativeTextStream
  private readonly err: NativeTextStream

  /**
   * @param handle - invocation-owned raw pipes; never pre-decoded UTF-8 strings.
   * @param encoding - Windows ANSI WebName queried in the same subprocess environment.
   * @param maxBytes - maximum UTF-8 bytes retained per decoded stream.
   */
  constructor(handle: Pick<SubprocessHandle, 'stdout' | 'stderr'>, encoding: string, maxBytes: number) {
    this.out = new NativeTextStream(handle.stdout, encoding, maxBytes)
    this.err = new NativeTextStream(handle.stderr, encoding, maxBytes)
    this.finished = Promise.all([this.out.finished, this.err.finished]).then(() => {})
  }

  /** @returns current bounded stdout text without consuming it. */
  stdout(): OutputSnapshot { return this.out.snapshot() }

  /** @returns current bounded stderr text without consuming it. */
  stderr(): OutputSnapshot { return this.err.snapshot() }
}
