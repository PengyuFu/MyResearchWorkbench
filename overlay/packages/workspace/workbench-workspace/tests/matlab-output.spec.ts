/** Native MATLAB byte streams preserve multilingual text, streaming boundaries and bounded tails. */
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { MatlabOutput } from '../src/matlab-output.ts'
import { parseDiagnostics } from '../src/diagnostics.ts'

describe('Windows MATLAB output decoding', () => {
  it('decodes split GBK characters and keeps stdout and stderr independent', async () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    const capture = new MatlabOutput({ stdout, stderr }, 'gb2312', 1024)
    stdout.write(Buffer.from([0xd6]))
    expect(capture.stdout().text).toBe('')
    stdout.write(Buffer.from([0xd0, 0xce]))
    expect(capture.stdout().text).toBe('中')
    stdout.end(Buffer.from([0xc4]))
    stderr.end(Buffer.concat([Buffer.from('error '), Buffer.from([0xd6, 0xd0, 0xce, 0xc4])]))
    await capture.finished
    expect(capture.stdout()).toEqual({ text: '中文', lossy: false })
    expect(capture.stderr()).toEqual({ text: 'error 中文', lossy: false })
  })

  it('prefers valid UTF-8 and preserves characters split across chunks', async () => {
    const stdout = new PassThrough()
    const capture = new MatlabOutput({ stdout, stderr: undefined }, 'gb2312', 1024)
    const bytes = Buffer.from('正确 UTF-8')
    for (const value of bytes) stdout.write(Buffer.from([value]))
    stdout.end()
    await capture.finished
    expect(capture.stdout()).toEqual({ text: '正确 UTF-8', lossy: false })
  })

  it('uses the measured non-Chinese Windows code page rather than a fixed Chinese encoding', async () => {
    const stdout = new PassThrough()
    const capture = new MatlabOutput({ stdout, stderr: undefined }, 'windows-1252', 1024)
    stdout.end(Buffer.from([0x63, 0x61, 0x66, 0xe9]))
    await capture.finished
    expect(capture.stdout()).toEqual({ text: 'café', lossy: false })
  })

  it.each(['utf-8', 'gb2312'])('bounds decoded tails without splitting a character for %s', async (encoding) => {
    const stdout = new PassThrough()
    const capture = new MatlabOutput({ stdout, stderr: undefined }, encoding, 7)
    stdout.write(Buffer.from('a'.repeat(4096)))
    stdout.end(encoding === 'utf-8' ? Buffer.from('中文') : Buffer.from([0xd6, 0xd0, 0xce, 0xc4]))
    await capture.finished
    const result = capture.stdout()
    expect(result).toEqual({ text: 'a中文', lossy: true })
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(7)
    expect(result.text).not.toContain('�')
  })
})

describe('MATLAB error locations', () => {
  it.each(['错误使用 failure (第 2 行)', 'Error using failure (line 2)'])('locates the active source from %s', (header) => {
    const source = 'D:\\论文 副本\\运行 输出\\failure.m'
    const result = parseDiagnostics('{\b' + header + '\nMRW deliberate error\n\n出错 run (第 112 行)\nevalin(...)\n}\b',
      source, 'D:\\论文 副本\\运行 输出')
    expect(result).toEqual([{ path: source, line: 2, severity: 'error', message: 'MRW deliberate error' }])
  })

  it('retains an incomplete error header without inventing a path for another MATLAB function', () => {
    expect(parseDiagnostics('Error in anotherFunction (line 8)\nforeign error', 'D:\\项目\\main.m', 'D:\\项目')).toEqual([])
    expect(parseDiagnostics('Error in main>nested (line 4)', 'D:\\项目\\main.m', 'D:\\项目')).toEqual([
      { path: 'D:\\项目\\main.m', line: 4, severity: 'error', message: 'Error in main>nested (line 4)' },
    ])
  })
})
