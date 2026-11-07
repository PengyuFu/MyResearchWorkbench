/** User-operated workspace editing and local project execution, exposed through typed Remote methods. */
import { createHash, randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as schema } from 'zod'
import type { WorkspaceFileScope } from '@deepseek-ai/dsh-api-workspace-files'
import type { FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { parseDiagnostics } from './diagnostics.ts'
import { MatlabOutput } from './matlab-output.ts'
import { AssetTransactionError, commitAssetGroup, readAssetTransactions } from './asset-transaction.ts'
import { expandLatex, explicitOutputDirectory, parseLatexSettings, projectRecipe, texDirective, type LatexSettings } from './recipes.ts'
import type {
  WorkbenchAsset, WorkbenchAssetRecovery, WorkbenchEnvironments, WorkbenchDiagnostic, WorkbenchDirectory, WorkbenchDocument,
  WorkbenchFileStat, WorkbenchJob, WorkbenchJobId, WorkbenchPdf,
  WorkbenchPdfInfo, WorkbenchPdfPosition, WorkbenchRunRequest, WorkbenchSaveRequest, WorkbenchSourcePosition, WorkbenchStagedAsset,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context { workbenchWorkspace: WorkbenchWorkspace }
}

/** Deployment limits for explicit user edits and compile/run actions. */
export interface Config {
  readonly maxDocumentBytes: number
  readonly maxPdfBytes: number
  readonly maxEntries: number
  readonly maxOutputBytes: number
  readonly maxCommandBytes: number
  readonly maxRetainedJobs: number
  readonly jobTimeoutMs: number
  readonly synctexTimeoutMs: number
  readonly disposeGraceMs: number
  readonly pythonCommands: string[]
  readonly synctexCommand: string
}

interface JobState {
  readonly id: WorkbenchJobId
  readonly scope: WorkspaceFileScope
  readonly request: WorkbenchRunRequest
  readonly source: WorkbenchDocument
  readonly controller: AbortController
  state: WorkbenchJob['state']
  output: string
  truncated: boolean
  timedOut: boolean
  exitCode: number | null
  error?: string
  pdf?: WorkbenchPdfInfo
  artifacts?: { path: string; version: string }[]
  diagnostics: WorkbenchDiagnostic[]
  diagnosticPath?: string
  commandCwd?: string
  handle?: SubprocessHandle
  matlabOutput?: MatlabOutput
  done: Promise<void>
}

const buildRecordSchema = schema.object({
  path: schema.string(), version: schema.string().regex(/^[a-f\d]{64}$/u), sourceVersion: schema.string(),
  builtAt: schema.string(), sourcePath: schema.string(), synctexPath: schema.string().optional(),
  inputs: schema.array(schema.object({ path: schema.string(), version: schema.string() })).max(5000),
})
type BuildRecord = schema.infer<typeof buildRecordSchema>

/** Decode the same canonical base64 JSON carrier used by Harness file uploads, within tighter figure limits. */
function decodeStagedAssets(assets: readonly WorkbenchStagedAsset[]) {
  const maxFileBytes = 16 * 1024 * 1024
  const maxTotalBytes = 32 * 1024 * 1024
  if (!Array.isArray(assets) || assets.length > 8) throw new Error('ASSET_GROUP_LIMIT')
  const encodedLimit = Math.ceil(maxFileBytes / 3) * 4
  if (assets.some(asset => typeof asset.data !== 'string' || asset.data.length > encodedLimit)
    || assets.reduce((total, asset) => total + asset.data.length, 0) > Math.ceil(maxTotalBytes / 3) * 4 + 16) {
    throw new Error('ASSET_GROUP_LIMIT')
  }
  let total = 0
  return assets.map((asset) => {
    const data = Buffer.from(asset.data, 'base64')
    total += data.byteLength
    if (data.byteLength === 0 || data.byteLength > maxFileBytes || total > maxTotalBytes
      || data.toString('base64') !== asset.data) throw new Error('ASSET_ENCODING_OR_SIZE')
    return { path: asset.path, data, sha256: asset.sha256 }
  })
}

function pathFunctions(path: string): typeof posix { return path.startsWith('/') ? posix : win32 }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

/** Workspace-confined editor storage and Session-owned, cancellable user processes. */
export class WorkbenchWorkspace extends TypertRemoteService {
  static inject = ['fs', 'subprocess', 'workspaceFiles', 'typert']
  static Config: z<Config> = z.object({
    maxDocumentBytes: z.number().step(1).min(1).default(2 * 1024 * 1024),
    maxPdfBytes: z.number().step(1).min(1).default(32 * 1024 * 1024),
    maxEntries: z.number().step(1).min(1).default(1000),
    maxOutputBytes: z.number().step(1).min(1024).default(256 * 1024),
    maxCommandBytes: z.number().step(1).min(1).default(128 * 1024),
    maxRetainedJobs: z.number().step(1).min(1).default(16),
    jobTimeoutMs: z.number().step(1).min(1000).max(2_147_483_647).default(300_000),
    synctexTimeoutMs: z.number().step(1).min(1000).max(2_147_483_647).default(15_000),
    disposeGraceMs: z.number().step(1).min(1).max(60_000).default(1500),
    pythonCommands: z.array(z.string().min(1)).default(['python', 'python3', 'py']),
    synctexCommand: z.string().min(1).default('synctex'),
  })

  private readonly jobs = new Map<WorkbenchJobId, JobState>()
  private readonly navigation = new Set<SubprocessHandle>()
  private readonly lifetime = new AbortController()

  /**
   * @param ctx - composed filesystem, subprocess, and typed Remote providers.
   * @param config - bounded editor/build policy.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'workbenchWorkspace')
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Workbench service disposed'))
      for (const job of this.jobs.values()) job.controller.abort(new Error('Workbench service disposed'))
      for (const handle of this.navigation) handle.terminate()
      await Promise.all([...this.jobs.values()].map(job => job.done).concat(
        [...this.navigation].map(async (handle) => { await handle.waitForExit() }),
      ))
      this.jobs.clear()
    }, 'workbench-workspace.jobs')
  }

  /**
   * Read a complete bounded text buffer with a disk-version guard.
   * @param workspaceFileScope - authorized Session workspace lookup.
   * @param path - workspace-relative or contained absolute file path.
   * @param signal - request cancellation.
   * @returns UTF-8 text and its opaque version; concurrent external changes reject the read.
   */
  @Remote
  async read(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkbenchDocument> {
    const { root, target } = await this.contained(workspaceFileScope, path, signal)
    const before = await this.ctx.fs.stat(target, signal)
    if (before === undefined) throw new RemoteError('workbench/not-found', 'File does not exist', { path })
    if (before.type !== 'file') throw new RemoteError('workbench/not-text', 'Choose a regular UTF-8 text file', { path })
    let data: Uint8Array
    try { data = await this.ctx.fs.readBytes(target, signal, this.config.maxDocumentBytes) }
    catch (error) {
      if (hasCode(error, 'FS_TOO_LARGE')) throw new RemoteError('workbench/too-large', 'This file exceeds the editor size limit', { path, limit: this.config.maxDocumentBytes }, { cause: error })
      throw error
    }
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data) }
    catch (error) { throw new RemoteError('workbench/not-text', 'The editor requires UTF-8 text', { path }, { cause: error }) }
    if (text.includes('\0')) throw new RemoteError('workbench/not-text', 'Binary files cannot be edited as text', { path })
    const after = await this.ctx.fs.stat(target, signal)
    if (after === undefined || before.version !== after.version) throw new RemoteError('workbench/conflict', 'The file changed while it was read; reopen it', { path })
    return { path: this.relative(root, target), absolutePath: this.ctx.fs.processPath(target),
      text, version: after.version, bytes: data.byteLength }
  }

  /**
   * Check disk freshness without retransmitting a complete editor buffer.
   * @param workspaceFileScope - authorized Session workspace lookup.
   * @param path - contained file path.
   * @param signal - request cancellation.
   * @returns the current opaque version and metadata.
   */
  @Remote
  async stat(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkbenchFileStat> {
    const { root, target } = await this.contained(workspaceFileScope, path, signal)
    const info = await this.ctx.fs.stat(target, signal)
    if (info === undefined) throw new RemoteError('workbench/not-found', 'File does not exist', { path })
    if (info.type !== 'file') throw new RemoteError('workbench/not-text', 'Choose a regular text file', { path })
    return { path: this.relative(root, target), absolutePath: this.ctx.fs.processPath(target),
      version: info.version, ...(info.size === undefined ? {} : { bytes: info.size }) }
  }

  /**
   * Save an explicit user buffer atomically without overwriting a newer disk version.
   * @param workspaceFileScope - authorized Session workspace lookup.
   * @param request - complete buffer and the last observed version, or null for a new file.
   * @param signal - cancellation before atomic publication.
   * @returns the committed buffer identity; proposals must be accepted by the user before calling.
   */
  @Remote
  async save(workspaceFileScope: WorkspaceFileScope, request: WorkbenchSaveRequest, signal: AbortSignal): Promise<WorkbenchDocument> {
    const bytes = Buffer.byteLength(request.text, 'utf8')
    if (bytes > this.config.maxDocumentBytes) throw new RemoteError('workbench/too-large', 'This buffer exceeds the editor size limit', { path: request.path, limit: this.config.maxDocumentBytes })
    if (request.text.includes('\0')) throw new RemoteError('workbench/not-text', 'A text buffer cannot contain NUL bytes', { path: request.path })
    const { root, target } = await this.contained(workspaceFileScope, request.path, signal)
    if (request.expectedPath !== undefined && request.expectedPath !== this.ctx.fs.processPath(target)) throw new RemoteError('workbench/conflict', 'The workspace changed. Reopen this file from its original workspace before saving.', { path: request.path })
    const commitDocument = async (commitSignal: AbortSignal): Promise<WorkbenchDocument> => {
      const outcome = await this.ctx.fs.writeText(target, request.text,
        request.version === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: request.version as FsVersion },
        commitSignal, { mode: 'workspace-write', workspaceRoot: workspaceFileScope.workspaceRoot, sessionId: workspaceFileScope.sessionId })
      return { path: this.relative(root, target), absolutePath: this.ctx.fs.processPath(target),
        text: request.text, version: outcome.version, bytes }
    }
    try {
      if (request.assets === undefined || request.assets.length === 0) return await commitDocument(signal)
      const local = await this.localAssetScope(workspaceFileScope, signal)
      const result = await commitAssetGroup({
        sourcePath: this.relative(root, target), text: request.text, expectedVersion: request.version,
        assets: decodeStagedAssets(request.assets),
      }, {
        ...local,
        preflightDocument: async (checkSignal) => {
          const fresh = await this.contained(workspaceFileScope, request.path, checkSignal)
          if (this.ctx.fs.processPath(fresh.root) !== this.ctx.fs.processPath(root)
            || this.ctx.fs.processPath(fresh.target) !== this.ctx.fs.processPath(target)) {
            throw new RemoteError('workbench/conflict', 'The source file identity changed.', { path: request.path })
          }
          const info = await this.ctx.fs.stat(fresh.target, checkSignal)
          if (request.version === null ? info !== undefined : info?.version !== request.version) {
            throw new RemoteError('workbench/conflict', 'The source changed before its image group could be saved.', { path: request.path })
          }
        },
        commitDocument,
      }, signal)
      return result.document
    } catch (error) {
      if (error instanceof AssetTransactionError) {
        throw new RemoteError('workbench/asset-transaction', error.message, {
          path: request.path, transactionId: error.transactionId, residualPaths: [...error.residualPaths],
          recoveryLog: error.recoveryLog, documentCommitted: error.documentCommitted,
        }, { cause: error })
      }
      if (hasCode(error, 'FS_STALE_VERSION') || hasCode(error, 'FS_NOT_OBSERVED')) {
        throw new RemoteError('workbench/conflict', 'The file changed outside this editor. Compare or reopen it before saving.', { path: request.path }, { cause: error })
      }
      throw error
    }
  }

  /** Inspect local asset transaction outcomes without modifying locks or retained files. */
  @Remote
  async assetRecovery(workspaceFileScope: WorkspaceFileScope, signal: AbortSignal): Promise<WorkbenchAssetRecovery> {
    const history = await readAssetTransactions(await this.localAssetScope(workspaceFileScope, signal), signal)
    return {
      records: history.records.map(record => ({ transactionId: record.transactionId, sourcePath: record.sourcePath,
        phase: record.phase, createdAt: record.createdAt, assets: record.assets.map(asset => ({ path: asset.path, status: asset.status })),
        residualPaths: [...(record.residualPaths ?? [])] })),
      issues: [...history.issues], truncated: history.truncated,
      ...(history.activeLock === undefined ? {} : { activeLock: history.activeLock }),
    }
  }

  /** Native binary writes are allowed only when the active provider explicitly maps these same local paths. */
  private async localAssetScope(scope: WorkspaceFileScope, signal: AbortSignal) {
    const { root } = await this.contained(scope, '.', signal)
    const localRoot = this.ctx.fs.processPath(root)
    const localPath = (target: FsTarget): string => {
      const candidate = this.ctx.fs.processPath(target)
      if (this.ctx.fs.processPathFromHostPath(candidate) !== candidate) {
        throw new RemoteError('workbench/unavailable', 'Importing new figure files requires a local workspace.', { reason: 'asset-local-only' })
      }
      return candidate
    }
    localPath(root)
    return {
      localRoot,
      resolvePath: async (relativePath: string, checkSignal: AbortSignal) => {
        const checked = await this.contained(scope, relativePath, checkSignal)
        if (this.ctx.fs.processPath(checked.root) !== localRoot) {
          throw new RemoteError('workbench/conflict', 'The workspace changed during the image save.', { path: relativePath })
        }
        return localPath(checked.target)
      },
    }
  }

  /**
   * List one contained project directory without exposing generated build artifacts.
   * @param workspaceFileScope - authorized Session workspace lookup.
   * @param path - workspace-relative path; empty means workspace root.
   * @param signal - request cancellation.
   * @returns bounded direct children and an explicit truncation marker.
   */
  @Remote
  async list(workspaceFileScope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkbenchDirectory> {
    const { root, target } = await this.contained(workspaceFileScope, path === '' ? '.' : path, signal)
    const children = (await this.ctx.fs.listDir(target, signal)).filter(child => child.name !== '.mrw-build' && child.name !== '.git')
    return { workspaceRoot: this.ctx.fs.processPath(root), path: this.relative(root, target) || '.', truncated: children.length > this.config.maxEntries,
      entries: children.slice(0, this.config.maxEntries).map(child => ({
        name: child.name, type: child.type, ...(child.size === undefined ? {} : { size: child.size }),
      })) }
  }


  /**
   * Resolve a manuscript figure using its existing graphics paths and local EPS counterparts.
   * No conversion or download is implicit; every candidate remains workspace-confined.
   */
  @Remote
  async asset(
    workspaceFileScope: WorkspaceFileScope, path: string, sourcePath: string, graphicsPaths: string[], signal: AbortSignal,
  ): Promise<WorkbenchAsset> {
    if (graphicsPaths.length > 32 || path.length > 4096 || /[\0\r\n]/u.test(path)) throw new RemoteError('gateway/bad-request', 'Invalid figure path', {})
    const source = await this.contained(workspaceFileScope, sourcePath, signal)
    const paths = pathFunctions(this.ctx.fs.processPath(source.target))
    const base = paths.dirname(this.ctx.fs.processPath(source.target))
    const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' }
    const candidates: string[] = []
    for (const directory of ['', ...graphicsPaths]) {
      const original = paths.resolve(base, directory, path)
      const extension = paths.extname(original).toLowerCase()
      if (extension === '.eps') {
        const name = paths.basename(original, extension)
        candidates.push(paths.join(paths.dirname(original), 'pdf', name + '-eps-converted-to.pdf'),
          original.slice(0, -4) + '-eps-converted-to.pdf',
          paths.join(paths.dirname(original), 'jpg', name + '.jpg'), original.slice(0, -4) + '.jpg',
          original.slice(0, -4) + '.png', original.slice(0, -4) + '.pdf')
      } else if (extension === '') candidates.push(...['.pdf', '.png', '.jpg', '.jpeg', '.webp'].map(suffix => original + suffix))
      else candidates.push(original)
    }
    for (const candidate of new Set(candidates)) {
      const { root, target } = await this.contained(workspaceFileScope, candidate, signal)
      const before = await this.ctx.fs.stat(target, signal)
      const mimeType = mime[paths.extname(candidate).toLowerCase()]
      if (before?.type !== 'file' || mimeType === undefined) continue
      const data = await this.ctx.fs.readBytes(target, signal, this.config.maxPdfBytes)
      if ((await this.ctx.fs.stat(target, signal))?.version !== before.version) throw new RemoteError('workbench/conflict', 'The figure changed while it was read', { path })
      return { path: this.relative(root, target), mimeType, version: before.version, data }
    }
    throw new RemoteError('workbench/unavailable', 'No supported local preview exists for this figure. Choose an existing PNG, JPEG, SVG or PDF, or keep the original EPS and its compiled counterpart.', { reason: 'figure-preview-unavailable' })
  }


  /** Discover existing project environments and PATH tools without installing or running them. */
  @Remote
  async environments(workspaceFileScope: WorkspaceFileScope, signal: AbortSignal): Promise<WorkbenchEnvironments> {
    const { target } = await this.contained(workspaceFileScope, '.', signal)
    const root = this.ctx.fs.processPath(target)
    const paths = pathFunctions(root)
    const resolve = async (choices: string[]): Promise<string[]> => {
      const found: string[] = []
      for (const choice of choices) {
        try {
          const executable = await this.ctx.subprocess.resolveExecutable(choice, undefined, signal)
          if (!found.includes(executable)) found.push(executable)
        }
        catch (error) { if (!(error instanceof Error) || error.name !== 'SubprocessExecutableNotFoundError') throw error }
      }
      return found
    }
    return {
      python: await resolve([paths.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
        paths.join(root, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), ...this.config.pythonCommands]),
      cpp: await resolve(['g++', 'clang++', 'cl']), cuda: await resolve(['nvcc']), matlab: await resolve(['matlab']),
    }
  }

  /** Only newly written image/PDF files are attached to a job; existing project figures are not run results. */
  private async captureArtifacts(
    scope: WorkspaceFileScope, directory: string, signal: AbortSignal,
  ): Promise<{ path: string; version: string }[]> {
    const result: { path: string; version: string }[] = []
    const pending = [{ path: directory, depth: 0 }]
    let count = 0
    while (pending.length > 0 && count < 500) {
      const next = pending.pop()
      if (next === undefined) break
      const { target } = await this.contained(scope, next.path, signal)
      const paths = pathFunctions(this.ctx.fs.processPath(target))
      for (const child of await this.ctx.fs.listDir(target, signal)) {
        if (++count > 500) break
        if (child.type === 'directory' && next.depth < 2 && !child.name.startsWith('.') && !['node_modules', '__pycache__', 'venv'].includes(child.name)) {
          pending.push({ path: paths.join(this.ctx.fs.processPath(target), child.name), depth: next.depth + 1 })
        } else if (child.type === 'file' && /\.(?:png|jpe?g|webp|svg|pdf)$/iu.test(child.name)) {
          const location = await this.contained(scope, paths.join(this.ctx.fs.processPath(target), child.name), signal)
          const info = await this.ctx.fs.stat(location.target, signal)
          if (info !== undefined && result.length < 50) {
            result.push({ path: this.relative(location.root, location.target), version: info.version })
          }
        }
      }
    }
    return result
  }

  /**
   * Start one explicit user compilation/run after the editor has saved its buffer.
   * @param workspaceFileScope - Session owner and execution root.
   * @param request - source and executable recipe; no shell interpolation occurs.
   * @param signal - pre-publication request cancellation; published jobs survive UI reconnect.
   * @returns a running job identity; completion is read through status, never inferred from launch.
   */
  @Remote
  async start(workspaceFileScope: WorkspaceFileScope, request: WorkbenchRunRequest, signal: AbortSignal): Promise<WorkbenchJob> {
    this.lifetime.signal.throwIfAborted()
    const source = await this.read(workspaceFileScope, request.path, signal)
    signal.throwIfAborted()
    const running = [...this.jobs.values()].find(job => job.scope.sessionId === workspaceFileScope.sessionId && job.state === 'running')
    if (running !== undefined) throw new RemoteError('workbench/busy', 'Stop or finish the current workspace job first', { id: running.id })
    if (request.kind === 'command' && (request.command === undefined || request.command.trim() === '')) throw new RemoteError('gateway/bad-request', 'Choose an executable for the run command', {})
    if ((request.args?.length ?? 0) > 128 || request.args?.some(arg => arg.length > 32_768 || arg.includes('\0')) === true) throw new RemoteError('gateway/bad-request', 'Command arguments exceed the supported limits', {})
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') > this.config.maxCommandBytes) throw new RemoteError('gateway/bad-request', 'The complete run request exceeds the command size limit', {})
    this.pruneJobs(workspaceFileScope.sessionId)
    const job: JobState = {
      id: randomUUID() as WorkbenchJobId, scope: workspaceFileScope, request, source,
      controller: new AbortController(), state: 'running', output: '', truncated: false,
      timedOut: false, exitCode: null, diagnostics: [], done: Promise.resolve(),
    }
    this.jobs.set(job.id, job)
    job.done = this.execute(job)
    return this.snapshot(job)
  }

  /**
   * Observe a job belonging to the displayed Session.
   * @param workspaceFileScope - authorized owner.
   * @param id - job returned by start.
   * @returns current bounded output and independently reported timeout/exit facts.
   */
  @Remote
  status(workspaceFileScope: WorkspaceFileScope, id: WorkbenchJobId): WorkbenchJob {
    return this.snapshot(this.ownedJob(workspaceFileScope, id))
  }

  /**
   * Recover this Session's currently running job after a renderer reconnect.
   * @param workspaceFileScope - authorized Session owner.
   * @returns the unfinished job, or null after completion or a Host restart.
   */
  @Remote
  current(workspaceFileScope: WorkspaceFileScope): WorkbenchJob | null {
    const job = [...this.jobs.values()].find(value => value.scope.sessionId === workspaceFileScope.sessionId && value.state === 'running')
    return job === undefined ? null : this.snapshot(job)
  }

  /**
   * Stop only this Session's selected job and await its entire managed process range.
   * @param workspaceFileScope - authorized owner.
   * @param id - job returned by start.
   * @returns settled state after process-tree termination.
   */
  @Remote
  async stop(workspaceFileScope: WorkspaceFileScope, id: WorkbenchJobId): Promise<WorkbenchJob> {
    const job = this.ownedJob(workspaceFileScope, id)
    if (job.state === 'running') job.controller.abort(new Error('Stopped by user'))
    await job.done
    return this.snapshot(job)
  }

  /**
   * Read the latest successfully published PDF; failures never replace it.
   * @param workspaceFileScope - authorized Session workspace.
   * @param sourcePath - root .tex or a file declaring a TeX root.
   * @param signal - request cancellation.
   * @returns PDF bytes and build identity, or null when no successful build is recorded.
   */
  @Remote
  async pdf(workspaceFileScope: WorkspaceFileScope, sourcePath: string, signal: AbortSignal): Promise<WorkbenchPdf | null> {
    const source = await this.texRoot(workspaceFileScope, sourcePath, signal)
    const record = await this.latest(workspaceFileScope, source, signal)
    if (record === null) return null
    const { target } = await this.contained(workspaceFileScope, record.path, signal)
    const data = await this.ctx.fs.readBytes(target, signal, this.config.maxPdfBytes)
    if (createHash('sha256').update(data).digest('hex') !== record.version) throw new RemoteError('workbench/conflict', 'The saved PDF changed outside Workbench; compile again before using this preview', { path: record.path })
    return { path: record.path, version: record.version, sourcePath: source.path,
      sourceVersion: record.sourceVersion, builtAt: record.builtAt, inputs: record.inputs,
      stale: !await this.inputsCurrent(workspaceFileScope, record.inputs, signal), data }
  }

  /**
   * Map a saved source location into the latest successful PDF.
   * @param workspaceFileScope - authorized workspace.
   * @param sourcePath - source document carrying the requested location.
   * @param line - one-based source line.
   * @param column - one-based source column.
   * @param rootPath - explicitly selected main .tex, or undefined to follow the source's TeX root directive.
   * @param signal - request cancellation.
   * @returns a page and PDF-point rectangle from SyncTeX.
   */
  @Remote
  async synctexForward(
    workspaceFileScope: WorkspaceFileScope, sourcePath: string, line: number, column: number,
    rootPath: string | undefined, signal: AbortSignal,
  ): Promise<WorkbenchPdfPosition> {
    this.sourceCoordinate(line, column)
    const source = await this.read(workspaceFileScope, sourcePath, signal)
    const root = await this.texRoot(workspaceFileScope, rootPath ?? sourcePath, signal)
    const record = await this.requireLatest(workspaceFileScope, root, signal)
    const { target } = await this.contained(workspaceFileScope, record.path, signal)
    const command = await this.synctexExecutable(workspaceFileScope, root, signal)
    const output = await this.querySyncTeX(command, ['view', '-i', `${line}:${column}:${source.absolutePath}`, '-o', this.ctx.fs.processPath(target)], pathFunctions(root.absolutePath).dirname(root.absolutePath), signal)
    const current = await this.requireLatest(workspaceFileScope, root, signal)
    if (current.path !== record.path || current.version !== record.version) throw new RemoteError('workbench/unavailable', 'The proof changed during navigation. Select the current proof again.', { reason: 'stale-pdf' })
    const field = (name: string): number => Number(new RegExp(`^${name}:([-+\\d.]+)`, 'mu').exec(output)?.[1])
    const page = field('Page'); const x = field('x'); const y = field('y')
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y)) throw new RemoteError('workbench/unavailable', 'No PDF location is available for this source line. Compile with SyncTeX enabled.', { reason: 'synctex-no-match' })
    const width = field('W'); const height = field('H')
    return { page, x, y, width: Number.isFinite(width) ? width : 0, height: Number.isFinite(height) ? height : 0 }
  }

  /**
   * Map a PDF-point position to a source file contained in this workspace.
   * @param workspaceFileScope - authorized workspace.
   * @param sourcePath - root document identifying the successful PDF.
   * @param page - one-based PDF page.
   * @param x - horizontal PDF points from page left.
   * @param y - vertical PDF points from page top.
   * @param signal - request cancellation.
   * @returns a contained source path and one-based cursor location.
   */
  @Remote
  async synctexReverse(
    workspaceFileScope: WorkspaceFileScope, sourcePath: string, page: number, x: number, y: number, signal: AbortSignal,
  ): Promise<WorkbenchSourcePosition> {
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) throw new RemoteError('gateway/bad-request', 'Invalid PDF location', {})
    const source = await this.texRoot(workspaceFileScope, sourcePath, signal)
    const record = await this.requireLatest(workspaceFileScope, source, signal)
    const { target } = await this.contained(workspaceFileScope, record.path, signal)
    const command = await this.synctexExecutable(workspaceFileScope, source, signal)
    const output = await this.querySyncTeX(command, ['edit', '-o', `${page}:${x}:${y}:${this.ctx.fs.processPath(target)}`], pathFunctions(source.absolutePath).dirname(source.absolutePath), signal)
    const current = await this.requireLatest(workspaceFileScope, source, signal)
    if (current.path !== record.path || current.version !== record.version) throw new RemoteError('workbench/unavailable', 'The proof changed during navigation. Select the current proof again.', { reason: 'stale-pdf' })
    const path = /^Input:(.+)$/mu.exec(output)?.[1]?.trim()
    const line = Number(/^Line:(\d+)$/mu.exec(output)?.[1])
    const rawColumn = Number(/^Column:([-\d]+)$/mu.exec(output)?.[1])
    if (path === undefined || !Number.isSafeInteger(line) || line < 1) throw new RemoteError('workbench/unavailable', 'No source location is available at this PDF position', { reason: 'synctex-no-match' })
    const location = await this.contained(workspaceFileScope,
      pathFunctions(source.absolutePath).resolve(pathFunctions(source.absolutePath).dirname(source.absolutePath), path), signal)
    return { path: this.relative(location.root, location.target), line,
      column: Number.isSafeInteger(rawColumn) && rawColumn > 0 ? rawColumn : 1 }
  }

  private async contained(scope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<{ root: FsTarget; target: FsTarget }> {
    if (path.trim() === '' || path.includes('\0')) throw new RemoteError('gateway/bad-request', 'A file or directory path is required', {})
    const root = await this.ctx.fs.resolve(scope.workspaceRoot, { signal })
    const entry = await this.ctx.fs.lstat(path, { cwd: scope.workspaceRoot }, signal)
    if (entry?.type === 'symlink') throw new RemoteError('workbench/outside-workspace', 'Open the actual file instead of a symbolic link', { path })
    const target = await this.ctx.fs.resolve(path, { cwd: scope.workspaceRoot, signal })
    if (!this.ctx.fs.contains(root, target)) throw new RemoteError('workbench/outside-workspace', 'Choose a file inside the current workspace', { path })
    return { root, target }
  }

  private relative(root: FsTarget, target: FsTarget): string {
    const rootPath = this.ctx.fs.processPath(root)
    return pathFunctions(rootPath).relative(rootPath, this.ctx.fs.processPath(target)).replace(/\\/gu, '/')
  }

  private ownedJob(scope: WorkspaceFileScope, id: WorkbenchJobId): JobState {
    const job = this.jobs.get(id)
    if (job === undefined || job.scope.sessionId !== scope.sessionId) throw new RemoteError('workbench/unavailable', 'This job is not available in this Session', { reason: 'job-unavailable' })
    return job
  }

  private pruneJobs(sessionId: WorkspaceFileScope['sessionId']): void {
    const owned = [...this.jobs.values()].filter(job => job.scope.sessionId === sessionId)
    for (const job of owned.slice(0, Math.max(0, owned.length - this.config.maxRetainedJobs + 1))) {
      if (job.state !== 'running') this.jobs.delete(job.id)
    }
  }

  private currentOutput(job: JobState): { output: string; truncated: boolean } {
    const stdout = job.matlabOutput?.stdout() ?? job.handle?.collected.stdout?.readFrom(0)
    const stderr = job.matlabOutput?.stderr() ?? job.handle?.collected.stderr?.readFrom(0)
    const text = job.output + (stdout?.text ?? '') + (stderr?.text ?? '')
    const buffer = Buffer.from(text, 'utf8')
    const truncated = job.truncated || stdout?.lossy === true || stderr?.lossy === true || buffer.byteLength > this.config.maxOutputBytes
    return { output: buffer.byteLength > this.config.maxOutputBytes ? buffer.subarray(buffer.byteLength - this.config.maxOutputBytes).toString('utf8') : text, truncated }
  }

  private snapshot(job: JobState): WorkbenchJob {
    const { output, truncated } = this.currentOutput(job)
    return { id: job.id, path: job.source.path, kind: job.request.kind, state: job.state, output, truncated,
      timedOut: job.timedOut, exitCode: job.exitCode, diagnostics: this.currentDiagnostics(job),
      ...(job.error === undefined ? {} : { error: job.error }), ...(job.pdf === undefined ? {} : { pdf: job.pdf }),
      ...(job.artifacts === undefined ? {} : { artifacts: job.artifacts }) }
  }

  private currentDiagnostics(job: JobState): WorkbenchDiagnostic[] {
    const output = (job.matlabOutput?.stdout().text ?? job.handle?.collected.stdout?.readFrom(0).text ?? '')
      + (job.matlabOutput?.stderr().text ?? job.handle?.collected.stderr?.readFrom(0).text ?? '')
    const current = job.commandCwd === undefined ? []
      : parseDiagnostics(output, job.diagnosticPath ?? job.source.absolutePath, job.commandCwd)
    const seen = new Set<string>()
    return [...job.diagnostics, ...current].filter((diagnostic) => {
      const key = `${diagnostic.path}:${diagnostic.line}:${diagnostic.column ?? ''}:${diagnostic.severity}:${diagnostic.message}`
      if (seen.has(key) || seen.size >= 100) return false
      seen.add(key)
      return true
    })
  }

  private async execute(job: JobState): Promise<void> {
    const timer = setTimeout(() => { job.timedOut = true; job.controller.abort(new Error('Workspace job timed out')) }, this.config.jobTimeoutMs)
    let settledState: WorkbenchJob['state'] = 'failed'
    try {
      const paths = pathFunctions(job.source.absolutePath)
      const cwdRequest = job.request.cwd ?? paths.dirname(job.source.absolutePath)
      const { target: cwdTarget } = await this.contained(job.scope, cwdRequest, job.controller.signal)
      const cwdInfo = await this.ctx.fs.stat(cwdTarget, job.controller.signal)
      if (cwdInfo?.type !== 'directory') throw new Error('Run working directory does not exist')
      const cwd = this.ctx.fs.processPath(cwdTarget)
      const beforeArtifacts = job.request.kind === 'latex' ? [] : await this.captureArtifacts(job.scope, cwd, job.controller.signal)
      if (job.request.kind === 'latex') await this.compile(job)
      else if (job.request.kind === 'python') {
        const executable = job.request.command?.trim() || await this.firstExecutable(this.config.pythonCommands, job.controller.signal)
        await this.command(job, executable, [job.source.absolutePath, ...(job.request.args ?? [])], cwd)
      } else {
        const command = job.request.command
        if (command === undefined) throw new Error('Choose an executable for the run command')
        await this.command(job, command, job.request.args ?? [], cwd)
      }
      if (job.request.kind !== 'latex') {
        const previous = new Map(beforeArtifacts.map(file => [file.path, file.version]))
        job.artifacts = (await this.captureArtifacts(job.scope, cwd, job.controller.signal))
          .filter(file => previous.get(file.path) !== file.version)
      }
      // Publishing latest.json is the build commit point. A later stop cannot undo a completed build.
      if (job.pdf === undefined) job.controller.signal.throwIfAborted()
      settledState = 'succeeded'
    } catch (error) {
      job.error = errorMessage(error)
      settledState = job.controller.signal.aborted && !job.timedOut ? 'cancelled' : 'failed'
    } finally {
      clearTimeout(timer)
      if (job.handle !== undefined) {
        job.handle.terminate()
        try { await job.handle.waitForExit(); await job.matlabOutput?.finished }
        catch (error) { job.error = `Process cleanup failed: ${errorMessage(error)}`; settledState = 'failed' }
        job.diagnostics = this.currentDiagnostics(job)
        const final = this.currentOutput(job); job.output = final.output; job.truncated = final.truncated
        delete job.handle
        delete job.matlabOutput
        delete job.commandCwd
      }
      job.state = settledState
    }
  }

  private async command(job: JobState, command: string, args: string[], cwd: string, env?: Record<string, string>): Promise<void> {
    const signal = job.controller.signal
    const paths = pathFunctions(cwd)
    const executableRequest = !paths.isAbsolute(command) && /[\\/]/u.test(command) ? paths.resolve(cwd, command) : command
    const executable = await this.ctx.subprocess.resolveExecutable(executableRequest, env, signal)
    if (job.request.kind === 'latex' && /(?:[\\/]miktex[\\/]|[\\/]miktex-)/iu.test(executable)) {
      const program = paths.basename(executable).replace(/\.exe$/iu, '').replace(/^miktex-/iu, '').toLowerCase()
      if (program === 'latexmk' && !args.some(value => value.includes('disable-installer'))) args = [...args, '-latexoption=-disable-installer']
      else if (/^(?:latex|pdflatex|xelatex|lualatex|pdftex|xetex|luatex|luahbtex|bibtex|bibtex8)$/u.test(program)
        && !args.some(value => /^--?disable-installer$/u.test(value))) args = ['--disable-installer', ...args]
    }
    signal.throwIfAborted()
    const matlabBatch = paths === win32 && /^matlab(?:\.exe)?$/iu.test(paths.basename(executable)) && args.includes('-batch')
    const runArgs = matlabBatch && !args.includes('-wait') ? ['-wait', ...args] : args
    const matlabEncoding = matlabBatch ? await this.windowsAnsiEncoding(cwd, signal) : undefined
    job.output += `\n> ${[command, ...runArgs].map(value => /\s/u.test(value) ? JSON.stringify(value) : value).join(' ')}\n`
    job.commandCwd = cwd
    job.handle = this.ctx.subprocess.spawn({ argv: [executable, ...runArgs], cwd, env,
      stdio: { stdin: 'ignore', stdout: matlabBatch ? 'pipe' : { maxBytes: this.config.maxOutputBytes },
        stderr: matlabBatch ? 'pipe' : { maxBytes: this.config.maxOutputBytes } },
      graceMs: this.config.disposeGraceMs, signal })
    if (matlabEncoding !== undefined) job.matlabOutput = new MatlabOutput(job.handle, matlabEncoding, this.config.maxOutputBytes)
    const outcome = await job.handle.done
    // -wait makes the Windows launcher report MATLAB's result before its owned service helpers are reaped.
    if (matlabBatch) job.handle.terminate()
    await job.handle.waitForExit()
    await job.matlabOutput?.finished
    job.exitCode = outcome.exitCode
    job.diagnostics = this.currentDiagnostics(job)
    const final = this.currentOutput(job); job.output = final.output; job.truncated = final.truncated
    delete job.handle
    delete job.matlabOutput
    delete job.commandCwd
    signal.throwIfAborted()
    if (outcome.exitCode !== 0) throw new Error(`${command} exited with ${outcome.exitCode === null ? outcome.signal ?? 'an unknown signal' : `code ${outcome.exitCode}`}`)
  }

  /** Read Windows' actual ANSI encoding through the configured execution provider; machine settings stay unchanged. */
  private async windowsAnsiEncoding(cwd: string, signal: AbortSignal): Promise<string> {
    const executable = await this.ctx.subprocess.resolveExecutable('powershell.exe', undefined, signal)
    const handle = this.ctx.subprocess.spawn({
      argv: [executable, '-NoProfile', '-NonInteractive', '-Command', '[System.Text.Encoding]::Default.WebName'],
      cwd, signal, graceMs: this.config.disposeGraceMs,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1024 }, stderr: { maxBytes: 1024 } },
    })
    try {
      const outcome = await handle.done
      signal.throwIfAborted()
      if (outcome.exitCode !== 0) throw new Error('Could not query the Windows MATLAB output encoding')
      const encoding = handle.collected.stdout?.readFrom(0).text.trim()
      if (encoding === undefined || encoding === '') throw new Error('Windows returned no MATLAB output encoding')
      // Validate the measured label before starting MATLAB; never substitute a guessed code page.
      return new TextDecoder(encoding).encoding
    } finally {
      handle.terminate()
      await handle.waitForExit()
    }
  }

  private async firstExecutable(commands: readonly string[], signal: AbortSignal): Promise<string> {
    for (const command of commands) {
      try { return await this.ctx.subprocess.resolveExecutable(command, undefined, signal) }
      catch (error) { if (!(error instanceof Error) || error.name !== 'SubprocessExecutableNotFoundError') throw error }
    }
    throw new Error(`No configured executable is available: ${commands.join(', ')}`)
  }

  private async texRoot(scope: WorkspaceFileScope, path: string, signal: AbortSignal): Promise<WorkbenchDocument> {
    let document = await this.read(scope, path, signal)
    const visited = new Set<string>()
    for (let depth = 0; depth < 8; depth += 1) {
      if (visited.has(document.absolutePath)) throw new Error('Circular TeX root directives')
      visited.add(document.absolutePath)
      const root = texDirective(document.text, 'root')
      if (root === undefined) return document
      const paths = pathFunctions(document.absolutePath)
      document = await this.read(scope, paths.resolve(paths.dirname(document.absolutePath), root), signal)
    }
    throw new Error('TeX root directive chain exceeds eight files')
  }

  private buildBase(source: WorkbenchDocument): string {
    return `.mrw-build/latex/${createHash('sha256').update(source.absolutePath).digest('hex').slice(0, 24)}`
  }

  private async writeGenerated(scope: WorkspaceFileScope, path: string, text: string, signal: AbortSignal): Promise<FsTarget> {
    const { target } = await this.contained(scope, path, signal)
    await this.ctx.fs.writeText(target, text, undefined, signal, { mode: 'workspace-write', workspaceRoot: scope.workspaceRoot, sessionId: scope.sessionId })
    return target
  }

  private async settings(scope: WorkspaceFileScope, source: WorkbenchDocument, signal: AbortSignal): Promise<LatexSettings> {
    const paths = pathFunctions(source.absolutePath)
    const candidates = [paths.join(paths.dirname(source.absolutePath), '.vscode', 'settings.json'), paths.join(scope.workspaceRoot, '.vscode', 'settings.json')]
    for (const path of new Set(candidates)) {
      const { target } = await this.contained(scope, path, signal)
      if (await this.ctx.fs.stat(target, signal) !== undefined) return parseLatexSettings((await this.read(scope, path, signal)).text)
    }
    return {}
  }

  private async compile(job: JobState): Promise<void> {
    const signal = job.controller.signal
    const source = await this.texRoot(job.scope, job.source.path, signal)
    job.diagnosticPath = source.absolutePath
    if (!/\.tex$/iu.test(source.absolutePath)) throw new Error('Choose the project root .tex file before compiling')
    const paths = pathFunctions(source.absolutePath)
    const sourceDir = paths.dirname(source.absolutePath)
    const inputs = await this.captureInputs(job.scope, source, signal)
    const settings = await this.settings(job.scope, source, signal)
    const outputBase = `${this.buildBase(source)}/${job.id}`
    const marker = await this.writeGenerated(job.scope, `${outputBase}/.workbench`, 'Generated build outputs.\n', signal)
    const snapshotDir = paths.dirname(this.ctx.fs.processPath(marker))
    const configured = job.request.recipe === undefined || job.request.recipe === 'auto' ? projectRecipe(settings) : undefined
    let compilerDir = snapshotDir
    if (configured !== undefined) {
      const out = settings['latex-workshop.latex.outDir']
      compilerDir = out === undefined ? sourceDir
        : paths.resolve(sourceDir, expandLatex(out, source.absolutePath, snapshotDir, job.scope.workspaceRoot))
      const recipeOutDir = compilerDir
      if (out === undefined || out === '%DIR%' || out === '%DIR_W32%') {
        for (const tool of configured) {
          const arguments_ = tool.args.map(value => expandLatex(value, source.absolutePath, recipeOutDir, job.scope.workspaceRoot))
          const directory = explicitOutputDirectory(arguments_)
          if (directory !== undefined) {
            const cwd = tool.cwd === undefined ? sourceDir
              : paths.resolve(sourceDir, expandLatex(tool.cwd, source.absolutePath, recipeOutDir, job.scope.workspaceRoot))
            compilerDir = paths.resolve(cwd, directory)
          }
        }
      }
      await this.contained(job.scope, compilerDir, signal)
      for (const tool of configured) {
        const expand = (value: string): string => expandLatex(value, source.absolutePath, recipeOutDir, job.scope.workspaceRoot)
        const cwd = tool.cwd === undefined ? sourceDir : paths.resolve(sourceDir, expand(tool.cwd))
        await this.contained(job.scope, cwd, signal)
        await this.command(job, expand(tool.command), tool.args.map(expand), cwd,
          tool.env === undefined ? undefined : Object.fromEntries(Object.entries(tool.env).map(([name, value]) => [name, expand(value)])))
      }
    } else {
      const directive = texDirective(source.text, 'program')
      const selected = job.request.recipe === undefined || job.request.recipe === 'auto' ? directive : job.request.recipe
      let engine: string
      if (selected === undefined) {
        try { engine = await this.ctx.subprocess.resolveExecutable('latexmk', undefined, signal) }
        catch (error) {
          if (!(error instanceof Error) || error.name !== 'SubprocessExecutableNotFoundError') throw error
          engine = 'pdflatex'
        }
      } else engine = selected
      const isLatexmk = /(?:^|[\\/])latexmk(?:\.exe)?$/iu.test(engine)
      if (isLatexmk) {
        await this.command(job, engine, ['-pdf', '-synctex=1', '-interaction=nonstopmode', '-file-line-error', '-recorder', `-outdir=${compilerDir}`, source.absolutePath], sourceDir)
      } else {
        const arguments_ = ['-synctex=1', '-interaction=nonstopmode', '-file-line-error', '-recorder', '-no-shell-escape', `-output-directory=${compilerDir}`, source.absolutePath]
        await this.command(job, engine, arguments_, sourceDir)
        const stem = paths.basename(source.absolutePath, paths.extname(source.absolutePath))
        const bcf = await this.contained(job.scope, paths.join(compilerDir, `${stem}.bcf`), signal)
        const aux = await this.contained(job.scope, paths.join(compilerDir, `${stem}.aux`), signal)
        if (await this.ctx.fs.stat(bcf.target, signal) !== undefined) {
          await this.command(job, 'biber', [`--input-directory=${compilerDir}`, `--output-directory=${compilerDir}`, stem], sourceDir)
        } else if (await this.ctx.fs.stat(aux.target, signal) !== undefined && /\\bibdata\{/u.test((await this.read(job.scope, paths.join(compilerDir, `${stem}.aux`), signal)).text)) {
          await this.command(job, 'bibtex', [stem], compilerDir, { BIBINPUTS: `${sourceDir}${process.platform === 'win32' ? ';' : ':'}`, BSTINPUTS: `${sourceDir}${process.platform === 'win32' ? ';' : ':'}` })
        }
        await this.command(job, engine, arguments_, sourceDir)
        await this.command(job, engine, arguments_, sourceDir)
      }
    }
    const basename = paths.basename(source.absolutePath, paths.extname(source.absolutePath))
    const pdfFile = paths.join(compilerDir, `${basename}.pdf`)
    const pdfLocation = await this.contained(job.scope, pdfFile, signal)
    const pdfData = await this.ctx.fs.readBytes(pdfLocation.target, signal, this.config.maxPdfBytes)
    if (!new TextDecoder('ascii').decode(pdfData.subarray(0, 5)).startsWith('%PDF-')) throw new Error('The compiler did not produce a readable PDF')
    const snapshotPdf = paths.join(snapshotDir, `${basename}.pdf`)
    if (pdfFile !== snapshotPdf) await this.snapshotBinary(job.scope, snapshotPdf, pdfData, signal)
    let synctexPath: string | undefined
    for (const suffix of ['.synctex.gz', '.synctex']) {
      const original = paths.join(compilerDir, basename + suffix)
      const location = await this.contained(job.scope, original, signal)
      if (await this.ctx.fs.stat(location.target, signal) === undefined) continue
      const saved = paths.join(snapshotDir, basename + suffix)
      if (original !== saved) {
        await this.snapshotBinary(job.scope, saved, await this.ctx.fs.readBytes(location.target, signal, this.config.maxPdfBytes), signal)
      }
      synctexPath = saved
      break
    }
    signal.throwIfAborted()
    if (!await this.inputsCurrent(job.scope, inputs, signal)) throw new RemoteError('workbench/conflict', 'Project inputs changed during compilation. Compile again before navigating this PDF.', { path: source.path })
    const record: BuildRecord = { path: snapshotPdf, version: createHash('sha256').update(pdfData).digest('hex'),
      sourceVersion: source.version, sourcePath: source.absolutePath, builtAt: new Date().toISOString(), inputs,
      ...(synctexPath === undefined ? {} : { synctexPath }) }
    await this.writeGenerated(job.scope, `${this.buildBase(source)}/latest.json`, JSON.stringify(record), signal)
    job.pdf = { path: record.path, version: record.version, sourcePath: source.path,
      sourceVersion: record.sourceVersion, builtAt: record.builtAt, inputs: record.inputs }
  }


  /** Bind authoring inputs before compilation; generated outputs never invalidate their own build. */
  private async captureInputs(scope: WorkspaceFileScope, source: WorkbenchDocument, signal: AbortSignal): Promise<BuildRecord['inputs']> {
    const inputs: BuildRecord['inputs'] = []
    const pending = ['.']
    const paths = pathFunctions(source.absolutePath)
    const mainPdf = source.absolutePath.slice(0, -paths.extname(source.absolutePath).length) + '.pdf'
    let entries = 0
    while (pending.length > 0) {
      const directory = pending.pop()
      if (directory === undefined) break
      const { target } = await this.contained(scope, directory, signal)
      for (const child of await this.ctx.fs.listDir(target, signal)) {
        if (++entries > 5000) throw new RemoteError('workbench/unavailable', 'This workspace is too broad for a bounded publication build. Select the manuscript project folder.', { reason: 'build-input-limit' })
        const path = directory === '.' ? child.name : directory + '/' + child.name
        if (child.type === 'directory') {
          if (!['.git', '.mrw-build', 'node_modules', '.venv', '__pycache__'].includes(child.name)) pending.push(path)
          continue
        }
        if (child.type !== 'file' || (!/\.(?:tex|bib|sty|cls|bst|eps|png|jpe?g|svg|pdf|json|cfg|def|csv|dat)$/iu.test(path) && !/^(?:\.)?latexmkrc$/iu.test(child.name)) || /-eps-converted-to\.pdf$/iu.test(path)) continue
        const location = await this.contained(scope, path, signal)
        if (this.ctx.fs.processPath(location.target) === mainPdf) continue
        const info = await this.ctx.fs.stat(location.target, signal)
        if (info?.type === 'file') inputs.push({ path: this.relative(location.root, location.target), version: info.version })
      }
    }
    if (!inputs.some(input => input.path === source.path)) inputs.push({ path: source.path, version: source.version })
    return inputs.sort((a, b) => a.path.localeCompare(b.path))
  }

  private async inputsCurrent(scope: WorkspaceFileScope, inputs: BuildRecord['inputs'], signal: AbortSignal): Promise<boolean> {
    for (const input of inputs) {
      const { target } = await this.contained(scope, input.path, signal)
      const info = await this.ctx.fs.stat(target, signal)
      if (info?.version !== input.version) return false
    }
    return true
  }

  private async snapshotBinary(scope: WorkspaceFileScope, path: string, data: Uint8Array, signal: AbortSignal): Promise<void> {
    const { target } = await this.contained(scope, path, signal)
    const absolute = this.ctx.fs.processPath(target)
    if (this.ctx.fs.processPathFromHostPath(absolute) !== absolute) throw new Error('Custom recipe PDF snapshots currently require a local workspace filesystem')
    signal.throwIfAborted()
    await writeFile(absolute, data, { flag: 'wx', mode: 0o600, signal })
  }

  private async latest(scope: WorkspaceFileScope, source: WorkbenchDocument, signal: AbortSignal): Promise<BuildRecord | null> {
    const path = `${this.buildBase(source)}/latest.json`
    const { target } = await this.contained(scope, path, signal)
    if (await this.ctx.fs.stat(target, signal) === undefined) return null
    const record = buildRecordSchema.parse(JSON.parse((await this.read(scope, path, signal)).text))
    if (record.sourcePath !== source.absolutePath) throw new Error('The saved PDF belongs to a different source document; compile this document again')
    await this.contained(scope, record.path, signal)
    return record
  }

  private async requireLatest(scope: WorkspaceFileScope, source: WorkbenchDocument, signal: AbortSignal): Promise<BuildRecord> {
    const record = await this.latest(scope, source, signal)
    if (record === null || record.synctexPath === undefined) throw new RemoteError('workbench/unavailable', 'Compile this document with SyncTeX enabled first', { reason: 'synctex-unavailable' })
    if (!await this.inputsCurrent(scope, record.inputs, signal)) throw new RemoteError('workbench/unavailable', 'This PDF was built from older project inputs. Compile again before using source navigation.', { reason: 'stale-pdf' })
    await this.contained(scope, record.synctexPath, signal)
    return record
  }

  private sourceCoordinate(line: number, column: number): void {
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1) throw new RemoteError('gateway/bad-request', 'Source line and column must be positive integers', {})
  }

  private async synctexExecutable(scope: WorkspaceFileScope, source: WorkbenchDocument, signal: AbortSignal): Promise<string> {
    const settings = await this.settings(scope, source, signal)
    const command = settings['latex-workshop.synctex.path']?.trim() || this.config.synctexCommand
    const paths = pathFunctions(source.absolutePath)
    return !paths.isAbsolute(command) && /[\\/]/u.test(command) ? paths.resolve(paths.dirname(source.absolutePath), command) : command
  }

  private async querySyncTeX(command: string, args: string[], cwd: string, requestSignal: AbortSignal): Promise<string> {
    const signal = AbortSignal.any([requestSignal, this.lifetime.signal, AbortSignal.timeout(this.config.synctexTimeoutMs)])
    const executable = await this.ctx.subprocess.resolveExecutable(command, undefined, signal)
    const handle = this.ctx.subprocess.spawn({ argv: [executable, ...args], cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: this.config.maxOutputBytes }, stderr: { maxBytes: this.config.maxOutputBytes } },
      graceMs: this.config.disposeGraceMs, signal })
    this.navigation.add(handle)
    try {
      const outcome = await handle.done
      await handle.waitForExit()
      signal.throwIfAborted()
      if (outcome.exitCode !== 0) throw new Error(handle.collected.stderr?.readFrom(0).text || 'SyncTeX could not locate this position')
      return handle.collected.stdout?.readFrom(0).text ?? ''
    } finally {
      handle.terminate()
      try { await handle.waitForExit() } finally { this.navigation.delete(handle) }
    }
  }
}

export default WorkbenchWorkspace
