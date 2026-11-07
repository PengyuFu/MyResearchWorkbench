import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkbenchWorkspace, type Config } from '../src/index.ts'
import type { WorkspaceFileScope } from '@deepseek-ai/dsh-api-workspace-files'

const configuration: Config = {
  maxDocumentBytes: 1024 * 1024, maxPdfBytes: 1024 * 1024, maxEntries: 100,
  maxOutputBytes: 16 * 1024, maxCommandBytes: 128 * 1024, maxRetainedJobs: 4,
  jobTimeoutMs: 30_000, synctexTimeoutMs: 5000, disposeGraceMs: 100,
  pythonCommands: ['python'], synctexCommand: 'synctex',
}
const signal = (): AbortSignal => new AbortController().signal

describe('user workspace editing and process ownership', () => {
  let root: string
  let workspace: string
  let outside: string
  let ctx: Context
  let endpoint: WorkbenchWorkspace
  let scope: WorkspaceFileScope

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mrw-workbench-'))
    workspace = join(root, '项目 空格')
    outside = join(root, 'outside')
    await mkdir(workspace)
    await mkdir(outside)
    ctx = new Context()
    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    endpoint = new WorkbenchWorkspace(ctx, configuration)
    scope = { sessionId: SessionId('workbench-test-session'), workspaceRoot: workspace }
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('preserves UTF-8 BOM and CRLF while rejecting stale and blind overwrites', async () => {
    const original = '\uFEFF第一段。\r\nSecond paragraph.\r\n'
    await writeFile(join(workspace, '论文.tex'), original)
    const first = await endpoint.read(scope, '论文.tex', signal())
    expect(first.text).toBe(original)
    const saved = await endpoint.save(scope, { path: first.path, text: original + 'More.\r\n', version: first.version }, signal())
    expect(await readFile(join(workspace, '论文.tex'), 'utf8')).toBe(saved.text)
    await writeFile(join(workspace, '论文.tex'), 'External edit is authoritative.\n')
    await expect(endpoint.save(scope, { path: saved.path, text: 'Stale proposal', version: saved.version }, signal())).rejects.toMatchObject({ code: 'workbench/conflict' })
    await expect(endpoint.save(scope, { path: saved.path, text: 'Blind creation', version: null }, signal())).rejects.toMatchObject({ code: 'workbench/conflict' })
    expect(await readFile(join(workspace, '论文.tex'), 'utf8')).toBe('External edit is authoritative.\n')
  })

  it('browses the real root, nested Chinese directories and a file without rooted child paths', async () => {
    await mkdir(join(workspace, '资料 空格', '第二层'), { recursive: true })
    await writeFile(join(workspace, 'root.tex'), 'Root document.\n')
    await writeFile(join(workspace, '资料 空格', '第二层', '论文.tex'), 'Nested document.\n')
    const rootList = await endpoint.list(scope, '.', signal())
    expect(rootList.path).toBe('.')
    expect(rootList.entries.map(entry => entry.name)).toContain('root.tex')
    expect((await endpoint.list(scope, '', signal())).path).toBe('.')
    const first = await endpoint.list(scope, '资料 空格', signal())
    expect(first.path).toBe('资料 空格')
    const nested = await endpoint.list(scope, first.path + '/第二层', signal())
    expect(nested.path).toBe('资料 空格/第二层')
    const file = await endpoint.read(scope, nested.path + '/论文.tex', signal())
    await endpoint.save(scope, { path: file.path, text: file.text + 'Saved.\n', version: file.version }, signal())
    expect((await endpoint.read(scope, file.path, signal())).text).toBe('Nested document.\nSaved.\n')
    expect((await endpoint.list(scope, '.', signal())).path).toBe('.')
  })

  it('creates a new file explicitly and reports external changes without reading the buffer again', async () => {
    const created = await endpoint.save(scope, { path: 'new.py', text: 'print("hello")\n', version: null }, signal())
    expect((await endpoint.stat(scope, 'new.py', signal())).version).toBe(created.version)
    await writeFile(join(workspace, 'new.py'), 'print("edited elsewhere")\n')
    expect((await endpoint.stat(scope, 'new.py', signal())).version).not.toBe(created.version)
  })

  it('confines parent traversal and resolved junctions to the actual workspace', async () => {
    await writeFile(join(outside, 'secret.py'), 'Outside content')
    await expect(endpoint.read(scope, '../outside/secret.py', signal())).rejects.toMatchObject({ code: 'workbench/outside-workspace' })
    await symlink(outside, join(workspace, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(endpoint.read(scope, 'outside-link/secret.py', signal())).rejects.toMatchObject({ code: 'workbench/outside-workspace' })
    await expect(endpoint.save(scope, { path: 'outside-link/new.py', text: 'escape', version: null }, signal())).rejects.toMatchObject({ code: 'workbench/outside-workspace' })
  })

  it('rejects invalid UTF-8 and oversized files without returning a truncated editable document', async () => {
    await writeFile(join(workspace, 'binary.py'), Buffer.from([0xff, 0xfe, 0x00]))
    await expect(endpoint.read(scope, 'binary.py', signal())).rejects.toMatchObject({ code: 'workbench/not-text' })
    await writeFile(join(workspace, 'large.py'), '汉'.repeat(Math.ceil(configuration.maxDocumentBytes / 3) + 1))
    await expect(endpoint.read(scope, 'large.py', signal())).rejects.toMatchObject({ code: 'workbench/too-large' })
  })

  it('runs an actual installed executable with a space/non-ASCII working directory', async () => {
    await writeFile(join(workspace, 'run.js'), 'console.log("workspace:" + process.cwd());\n')
    const started = await endpoint.start(scope, { kind: 'command', path: 'run.js', command: process.execPath, args: [join(workspace, 'run.js')] }, signal())
    await expect.poll(() => endpoint.status(scope, started.id).state, { timeout: 15_000 }).toBe('succeeded')
    const finished = endpoint.status(scope, started.id)
    expect(finished.output).toContain(`workspace:${workspace}`)
    expect(finished.exitCode).toBe(0)
    expect(finished.timedOut).toBe(false)
  })

  it('resolves compiler diagnostics from the command cwd when the workspace has duplicate filenames', async () => {
    const paper = join(workspace, 'paper')
    await mkdir(paper)
    await writeFile(join(workspace, 'chapter.tex'), 'Root chapter must not be selected.\n')
    await writeFile(join(paper, 'chapter.tex'), 'This is the included chapter.\n')
    await writeFile(join(paper, 'main.tex'), '\\input{chapter}\n')
    const started = await endpoint.start(scope, {
      kind: 'command', path: 'paper/main.tex', command: process.execPath,
      args: ['-e', 'console.log("./chapter.tex:2: Undefined control sequence."); process.exitCode = 1;'],
    }, signal())
    await expect.poll(() => endpoint.status(scope, started.id).state, { timeout: 15_000 }).toBe('failed')
    const diagnostic = endpoint.status(scope, started.id).diagnostics[0]
    expect(diagnostic).toMatchObject({ path: join(paper, 'chapter.tex'), line: 2, severity: 'error' })
    expect((await endpoint.read(scope, diagnostic!.path, signal())).path).toBe('paper/chapter.tex')
    expect((await endpoint.read(scope, diagnostic!.path, signal())).text).toBe('This is the included chapter.\n')
  })

  it('stops the selected process tree, rejects cross-Session control, and keeps a second job from overlapping', async () => {
    const child = join(workspace, 'child.js')
    await writeFile(child, 'setInterval(() => {}, 1000);\n')
    await writeFile(join(workspace, 'parent.js'), `import { spawn } from 'node:child_process';\nconst child = spawn(process.execPath, [${JSON.stringify(child)}], { stdio: 'ignore' });\nconsole.log('child-pid:' + child.pid);\nsetInterval(() => {}, 1000);\n`)
    const request = { kind: 'command' as const, path: 'parent.js', command: process.execPath, args: [join(workspace, 'parent.js')] }
    expect(endpoint.current(scope)).toBeNull()
    const started = await endpoint.start(scope, request, signal())
    await expect.poll(() => endpoint.status(scope, started.id).output, { timeout: 15_000 }).toContain('child-pid:')
    const childPid = Number(/child-pid:(\d+)/u.exec(endpoint.status(scope, started.id).output)?.[1])
    expect(Number.isSafeInteger(childPid)).toBe(true)
    expect(endpoint.current(scope)?.id).toBe(started.id)
    expect(endpoint.current({ ...scope, sessionId: SessionId('other-session') })).toBeNull()
    await expect(endpoint.start(scope, request, signal())).rejects.toMatchObject({ code: 'workbench/busy' })
    await expect(endpoint.stop({ ...scope, sessionId: SessionId('other-session') }, started.id)).rejects.toMatchObject({ code: 'workbench/unavailable' })
    const stopped = await endpoint.stop(scope, started.id)
    expect(stopped.state).toBe('cancelled')
    expect(endpoint.current(scope)).toBeNull()
    expect(() => process.kill(childPid, 0)).toThrow()
  })
  it('checks actual destination identity in addition to CAS when the workspace changes', async () => {
    await writeFile(join(workspace, 'same.tex'), 'same text')
    const file = await endpoint.read(scope, 'same.tex', signal())
    await expect(endpoint.save(scope, { path: file.path, text: 'new', version: file.version, expectedPath: join(outside, 'same.tex') }, signal())).rejects.toMatchObject({ code: 'workbench/conflict' })
    expect(await readFile(join(workspace, 'same.tex'), 'utf8')).toBe('same text')
  })

  it('previews existing EPS counterparts without changing source assets and preserves the workspace boundary', async () => {
    await mkdir(join(workspace, 'figures', 'pdf'), { recursive: true })
    await writeFile(join(workspace, 'main.tex'), '\\graphicspath{{figures/}}')
    await writeFile(join(workspace, 'figures', 'sample.eps'), '%!PS-Adobe EPS fixture')
    await writeFile(join(workspace, 'figures', 'pdf', 'sample-eps-converted-to.pdf'), '%PDF-1.4\nfixture')
    const asset = await endpoint.asset(scope, 'sample.eps', 'main.tex', ['figures/'], signal())
    expect(asset.path).toBe('figures/pdf/sample-eps-converted-to.pdf')
    expect(asset.mimeType).toBe('application/pdf')
    await expect(endpoint.asset(scope, '../outside/figure.png', 'main.tex', [], signal())).rejects.toMatchObject({ code: 'workbench/outside-workspace' })
    expect(await readFile(join(workspace, 'figures', 'sample.eps'), 'utf8')).toBe('%!PS-Adobe EPS fixture')
  })

  it('binds PDF navigation to included-file versions and keeps the previous successful snapshot', async () => {
    await mkdir(join(workspace, '.vscode'))
    await writeFile(join(workspace, 'main.tex'), '\\input{chapter}\n')
    await writeFile(join(workspace, 'chapter.tex'), 'Original included text.\n')
    const script = "require('fs').writeFileSync('main.pdf','%PDF-1.4\\nfixture');require('fs').writeFileSync('main.synctex','fixture');"
    await writeFile(join(workspace, '.vscode', 'settings.json'), JSON.stringify({
      'latex-workshop.latex.tools': [{ name: 'fixture', command: process.execPath, args: ['-e', script], cwd: '%DIR%' }],
      'latex-workshop.latex.recipes': [{ name: 'fixture', tools: ['fixture'] }],
    }))
    const started = await endpoint.start(scope, { kind: 'latex', path: 'main.tex' }, signal())
    await expect.poll(() => endpoint.status(scope, started.id).state).toBe('succeeded')
    const before = await endpoint.pdf(scope, 'main.tex', signal())
    expect(before?.stale).toBe(false)
    expect(before?.inputs.map(input => input.path)).toContain('chapter.tex')
    await writeFile(join(workspace, 'chapter.tex'), 'Inserted at the beginning.\nOriginal included text.\n')
    expect((await endpoint.pdf(scope, 'main.tex', signal()))?.stale).toBe(true)
    await expect(endpoint.synctexForward(scope, 'chapter.tex', 2, 1, 'main.tex', signal())).rejects.toMatchObject({ code: 'workbench/unavailable', details: { reason: 'stale-pdf' } })
    await expect(endpoint.synctexReverse(scope, 'main.tex', 1, 20, 20, signal())).rejects.toMatchObject({ code: 'workbench/unavailable', details: { reason: 'stale-pdf' } })
    expect((await endpoint.pdf(scope, 'main.tex', signal()))?.version).toBe(before?.version)
  })

  it('honors an explicitly chosen Python executable and associates only new figure outputs with its job', async () => {
    await writeFile(join(workspace, 'existing.png'), 'existing')
    await writeFile(join(workspace, 'runtime.py'), "console.log('selected-runtime:' + process.execPath); require('fs').writeFileSync('result.png','new result');")
    const started = await endpoint.start(scope, { kind: 'python', path: 'runtime.py', command: process.execPath }, signal())
    await expect.poll(() => endpoint.status(scope, started.id).state).toBe('succeeded')
    const job = endpoint.status(scope, started.id)
    expect(job.output).toContain('selected-runtime:' + process.execPath)
    expect(job.artifacts?.map(file => file.path)).toEqual(['result.png'])
  })

  it('commits imported figure bytes with the observed source and exposes the completed journal', async () => {
    const data = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'))
    const sha256 = createHash('sha256').update(data).digest('hex')
    const assetPath = 'figures/workbench/sample-' + sha256.slice(0, 8) + '.png'
    const original = '\uFEFFBefore.\r\n'
    await writeFile(join(workspace, 'main.tex'), original)
    const observed = await endpoint.read(scope, 'main.tex', signal())
    const text = original + '\\includegraphics{' + assetPath + '}\r\n'
    const saved = await endpoint.save(scope, { path: observed.path, expectedPath: observed.absolutePath, version: observed.version,
      text, assets: [{ path: assetPath, data: Buffer.from(data).toString('base64'), sha256 }] }, signal())
    expect(saved.text).toBe(text)
    expect(await readFile(join(workspace, 'main.tex'), 'utf8')).toBe(text)
    expect(new Uint8Array(await readFile(join(workspace, assetPath)))).toEqual(data)
    const history = await endpoint.assetRecovery(scope, signal())
    expect(history.activeLock).toBeUndefined()
    expect(history.records).toHaveLength(1)
    expect(history.records[0]).toMatchObject({ phase: 'document-committed', sourcePath: 'main.tex',
      assets: [{ path: assetPath, status: 'created' }], residualPaths: [] })
    await endpoint.save(scope, { path: saved.path, version: saved.version, text: original }, signal())
    expect(new Uint8Array(await readFile(join(workspace, assetPath)))).toEqual(data)
  })

  it('rejects a stale imported-figure group before writing any project image', async () => {
    const data = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
    const sha256 = createHash('sha256').update(data).digest('hex')
    const assetPath = 'figures/workbench/stale-' + sha256.slice(0, 8) + '.png'
    await writeFile(join(workspace, 'main.tex'), 'Before.\n')
    const observed = await endpoint.read(scope, 'main.tex', signal())
    await writeFile(join(workspace, 'main.tex'), 'Externally changed.\n')
    await expect(endpoint.save(scope, { path: observed.path, version: observed.version, text: '\\includegraphics{' + assetPath + '}',
      assets: [{ path: assetPath, data: Buffer.from(data).toString('base64'), sha256 }] }, signal())).rejects.toMatchObject({ code: 'workbench/conflict' })
    await expect(readFile(join(workspace, assetPath))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(workspace, 'main.tex'), 'utf8')).toBe('Externally changed.\n')
  })

  it('refuses native asset writes when the filesystem provider does not expose the same Host path', async () => {
    const data = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 2])
    const sha256 = createHash('sha256').update(data).digest('hex')
    const assetPath = 'figures/workbench/local-' + sha256.slice(0, 8) + '.png'
    await writeFile(join(workspace, 'main.tex'), 'Before.\n')
    const observed = await endpoint.read(scope, 'main.tex', signal())
    const mapping = vi.spyOn(ctx.fs, 'processPathFromHostPath').mockReturnValue(undefined)
    try {
      await expect(endpoint.save(scope, { path: observed.path, version: observed.version, text: 'New.',
        assets: [{ path: assetPath, data: Buffer.from(data).toString('base64'), sha256 }] }, signal())).rejects.toMatchObject({ code: 'workbench/unavailable' })
      expect(await readFile(join(workspace, 'main.tex'), 'utf8')).toBe('Before.\n')
      await expect(readFile(join(workspace, assetPath))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { mapping.mockRestore() }
  })

})
