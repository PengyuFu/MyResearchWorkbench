/** Windows MATLAB batch results stay pending until their invocation-owned process range exits. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchWorkspace, type Config } from '../src/index.ts'
import type { WorkspaceFileScope } from '@deepseek-ai/dsh-api-workspace-files'

const configuration: Config = {
  maxDocumentBytes: 1024 * 1024, maxPdfBytes: 1024 * 1024, maxEntries: 100,
  maxOutputBytes: 16 * 1024, maxCommandBytes: 128 * 1024, maxRetainedJobs: 4,
  jobTimeoutMs: 30_000, synctexTimeoutMs: 5000, disposeGraceMs: 100,
  pythonCommands: ['python'], synctexCommand: 'synctex',
}

// Only the external process is controlled; the real service owns cancellation and Session job state.
describe.skipIf(process.platform !== 'win32')('Windows MATLAB batch settlement', () => {
  let root: string
  let ctx: Context
  let endpoint: WorkbenchWorkspace
  let scope: WorkspaceFileScope
  let settleControlled: (() => void)[]

  beforeEach(async () => {
    settleControlled = []
    root = await mkdtemp(join(tmpdir(), 'mrw-matlab-lifecycle-'))
    await mkdir(join(root, 'project'))
    await writeFile(join(root, 'project', 'sample.m'), "disp('synthetic')\n")
    ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(LocalSubprocessRuntime)
    endpoint = new WorkbenchWorkspace(ctx, configuration)
    scope = { sessionId: SessionId('matlab-lifecycle-test'), workspaceRoot: root }
  })

  afterEach(async () => {
    for (const settle of settleControlled) settle()
    await ctx.fiber.dispose()
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  function controlledProcess() {
    const direct = Promise.withResolvers<SubprocessOutcome>()
    const range = Promise.withResolvers<boolean>()
    const terminate = vi.fn()
    const waitForExit = vi.fn(() => range.promise)
    const stdout = new PassThrough(), stderr = new PassThrough()
    void range.promise.then(() => { stdout.end(); stderr.end() })
    const handle: SubprocessHandle = {
      stdin: undefined, stdout, stderr, control: undefined,
      collected: {}, done: direct.promise, terminate, waitForExit,
    }
    const spawn = vi.fn((spec: SubprocessSpawnSpec) => {
      spec.signal?.addEventListener('abort', terminate, { once: true })
      return handle
    })
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      if (spec.argv.includes('[System.Text.Encoding]::Default.WebName')) {
        return { stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
          collected: { stdout: { readFrom: () => ({ text: 'gb2312', nextOffset: 6, lossy: false }) } },
          done: Promise.resolve({ exitCode: 0, signal: null }), terminate: () => {}, waitForExit: async () => true }
      }
      return spawn(spec)
    })
    vi.spyOn(ctx.subprocess, 'resolveExecutable').mockImplementation(async value => value)
    settleControlled.push(() => { direct.resolve({ exitCode: 1, signal: null }); range.resolve(true) })
    return { direct, range, terminate, waitForExit, spawn }
  }

  it.each([0, 7])('reaps the batch-owned range after result %i, waits for it, and preserves the result', async (exitCode) => {
    const process = controlledProcess()
    const started = await endpoint.start(scope, {
      kind: 'command', path: 'project/sample.m', command: 'C:\\Tools\\MATLAB.exe',
      args: ['-batch', "run('sample.m')"], cwd: 'project',
    }, new AbortController().signal)
    await expect.poll(() => process.spawn.mock.calls.length).toBe(1)
    expect(process.spawn.mock.calls[0]?.[0].argv).toEqual(['C:\\Tools\\MATLAB.exe', '-wait', '-batch', "run('sample.m')"])
    expect(endpoint.status(scope, started.id).state).toBe('running')
    expect(process.terminate).not.toHaveBeenCalled()
    process.direct.resolve({ exitCode, signal: null })
    await expect.poll(() => process.waitForExit.mock.calls.length).toBe(1)
    expect(process.terminate).toHaveBeenCalledOnce()
    expect(endpoint.status(scope, started.id).state).toBe('running')
    process.range.resolve(true)
    await expect.poll(() => endpoint.status(scope, started.id).state).toBe(exitCode === 0 ? 'succeeded' : 'failed')
    expect(endpoint.status(scope, started.id).exitCode).toBe(exitCode)
  })

  it('keeps an explicit MATLAB wait option without duplication', async () => {
    const process = controlledProcess()
    const started = await endpoint.start(scope, {
      kind: 'command', path: 'project/sample.m', command: 'C:\\Tools\\matlab.exe',
      args: ['-wait', '-batch', "run('sample.m')"], cwd: 'project',
    }, new AbortController().signal)
    await expect.poll(() => process.spawn.mock.calls.length).toBe(1)
    expect(process.spawn.mock.calls[0]?.[0].argv.filter(arg => arg === '-wait')).toHaveLength(1)
    process.direct.resolve({ exitCode: 0, signal: null })
    process.range.resolve(true)
    await expect.poll(() => endpoint.status(scope, started.id).state).toBe('succeeded')
  })

  it.each([
    { command: 'C:\\Tools\\other.exe', args: ['-batch'] },
    { command: 'C:\\Tools\\matlab.exe', args: ['-r', "disp('interactive')"] },
  ])('preserves ordinary lifecycle for $command $args', async ({ command, args }) => {
    const process = controlledProcess()
    const started = await endpoint.start(scope, {
      kind: 'command', path: 'project/sample.m', command, args, cwd: 'project',
    }, new AbortController().signal)
    await expect.poll(() => process.spawn.mock.calls.length).toBe(1)
    expect(process.spawn.mock.calls[0]?.[0].argv).toEqual([command, ...args])
    process.direct.resolve({ exitCode: 0, signal: null })
    await expect.poll(() => process.waitForExit.mock.calls.length).toBe(1)
    expect(endpoint.status(scope, started.id).state).toBe('running')
    expect(process.terminate).not.toHaveBeenCalled()
    process.range.resolve(true)
    await expect.poll(() => endpoint.status(scope, started.id).state).toBe('succeeded')
  })

  it('keeps a cancelled batch pending until both the direct command and its managed range exit', async () => {
    const process = controlledProcess()
    const started = await endpoint.start(scope, {
      kind: 'command', path: 'project/sample.m', command: 'C:\\Tools\\matlab.exe',
      args: ['-batch', 'pause(600)'], cwd: 'project',
    }, new AbortController().signal)
    await expect.poll(() => process.spawn.mock.calls.length).toBe(1)
    const stopping = endpoint.stop(scope, started.id)
    expect(process.terminate).toHaveBeenCalled()
    expect(endpoint.status(scope, started.id).state).toBe('running')
    process.direct.resolve({ exitCode: null, signal: 'SIGTERM' })
    await expect.poll(() => process.waitForExit.mock.calls.length).toBe(1)
    expect(endpoint.status(scope, started.id).state).toBe('running')
    process.range.resolve(true)
    expect((await stopping).state).toBe('cancelled')
  })
})
