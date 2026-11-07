/** Workspace-scoped local Word service; owns documents, bridge lifetime and binary draft references. */
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as schema } from 'zod'
import type { WorkspaceFileScope } from '@deepseek-ai/dsh-api-workspace-files'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-subprocess'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { WordBridge, WordBridgeError } from './bridge.ts'
import { WordOperationFeed } from './operation-feed.ts'
import type { WordOperationNotice } from './types.ts'
import type { WordBinaryCommit, WordResources, WordCheckpoint, WordMutation, WordPageInfo, WordProof, WordProofReference, WordRetention, WordRetentionResult, WordSnapshot } from './types.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' { interface Context { workbenchWord: WorkbenchWord } }

/** Application-owned runtime inputs. Empty inputs keep the service unavailable, without PATH fallback. */
export interface Config { python: string; dependencyRoot: string; dataRoot: string; operationTimeoutMs?: number }
const run = schema.object({ from: schema.number().int().nonnegative(), to: schema.number().int().nonnegative(),
  bold: schema.boolean().optional(), italic: schema.boolean().optional(), underline: schema.boolean().optional(),
  font: schema.string().optional(), size: schema.number().optional() })
const block = schema.object({
  id: schema.string(), kind: schema.enum(['paragraph', 'protected', 'image']), from: schema.number(), to: schema.number(),
  text: schema.string(), style: schema.string(), level: schema.number(), alignment: schema.number(),
  spaceBefore: schema.number(), spaceAfter: schema.number(), lineSpacing: schema.number().optional(), list: schema.string().optional(),
  pagination: schema.object({ pageBreakBefore: schema.boolean().optional(), keepNext: schema.boolean().optional(),
    keepLines: schema.boolean().optional(), explicitBreaks: schema.number().int().nonnegative(),
    sectionBreak: schema.boolean() }).optional(),
  runs: schema.array(run), reason: schema.string().optional(),
  image: schema.object({ width: schema.number(), height: schema.number(), data: schema.string().optional() }).optional(),
  table: schema.object({ id: schema.string(), row: schema.number(), column: schema.number(),
    rows: schema.number(), columns: schema.number(), autoFit: schema.enum(['content', 'window']).optional(), autoRowHeight: schema.boolean().optional() }).optional(),
})
const workerSnapshot = schema.object({
  data: schema.string().optional(),
  pendingOperations: schema.array(schema.custom<WordMutation>()).optional(),
  id: schema.string().regex(/^[a-f0-9]{32}$/u), scope: schema.string(), root: schema.string(), path: schema.string(),
  revision: schema.number().int().nonnegative(), savedRevision: schema.number().int(),
  checkpoint: schema.string().regex(/^\d+-[a-f0-9]{32}$/u), checkpointHash: schema.string().regex(/^[a-f0-9]{64}$/u),
  checkpointTime: schema.number(), baseline: schema.object({ sha256: schema.string(), identity: schema.string() }).nullable(),
  originalStatus: schema.enum(['conflict', 'unavailable']).optional(),
  projection: schema.object({ blocks: schema.array(block), text: schema.string(), styles: schema.array(schema.string()),
    canUndo: schema.boolean(), canRedo: schema.boolean(), readOnly: schema.string().nullable().optional() }),
})
type WorkerSnapshot = schema.infer<typeof workerSnapshot>
interface DocumentOwner { scope: WorkspaceFileScope; root: string; absolutePath: string }
const proofSchema = schema.object({ revision: schema.number(), path: schema.string(), data: schema.string(),
  sha256: schema.string(), createdAt: schema.number(), regions: schema.array(schema.object({
    id: schema.string(), page: schema.number().int().positive(), x: schema.number().nonnegative(), y: schema.number().nonnegative(),
    width: schema.number().positive(), height: schema.number().positive(), font: schema.string(),
    size: schema.number().positive(), alignment: schema.number().int(),
  })) })
const noop = schema.object({ closed: schema.literal(true) })
const pageInfoSchema = schema.object({
  revision: schema.number().int(), savedRevision: schema.number().int(),
  sectionCount: schema.number().int(), sectionsTruncated: schema.boolean(),
  sections: schema.array(schema.object({
    sectionIndex: schema.number().int(), firstPageDifferent: schema.boolean(), oddEvenDifferent: schema.boolean(),
    headerDistancePt: schema.number(), footerDistancePt: schema.number(),
    regions: schema.array(schema.object({
      position: schema.enum(['header', 'footer']), variant: schema.enum(['default', 'first', 'even']),
      text: schema.string(), truncated: schema.boolean(), fields: schema.array(schema.string()),
      inherited: schema.boolean(), complex: schema.boolean(),
    })),
  })),
  pendingRequestIds: schema.array(schema.string()),
  completed: schema.array(schema.object({
    requestId: schema.string(), revision: schema.number().int(), error: schema.string().nullable(),
  })),
})

/** The only Host owner of Word document mutations. */
export class WorkbenchWord extends TypertRemoteService {
  static inject = ['fs', 'subprocess', 'workspaceFiles', 'typert']
  static Config: z<Config> = z.object({ python: z.string().default(''), dependencyRoot: z.string().default(''), dataRoot: z.string().default(''), operationTimeoutMs: z.natural().min(100).default(5000) })
  private runtime: Config
  private bridge: Promise<WordBridge> | undefined
  private readonly documents = new Map<string, DocumentOwner>()
  private readonly proofs = new Map<string, AbortController>()
  private readonly operationFeed = new WordOperationFeed()
  private readonly operationTimeoutMs: number
  private closing: Promise<void> | undefined

  /** @param ctx - composed filesystem, managed subprocess and Remote services.
   * @param config - explicit bundled runtime and private application data locations. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'workbenchWord')
    this.runtime = config
    const { operationTimeoutMs = 5000 } = WorkbenchWord.Config(config)
    this.operationTimeoutMs = operationTimeoutMs
    ctx.effect(() => () => this.shutdown(), 'workbench-word.bridge')
  }

  /** Bind Desktop-owned, absolute runtime locations before the first document is opened.
   * @param runtime - bundled Python, private pywin32 resource and profile-specific draft directory. */
  configureRuntime(runtime: Config): void {
    if (this.bridge !== undefined) throw new Error('The Word runtime is already in use')
    this.runtime = runtime
  }

  /** Finish Word checkpoints and release working files before Host subprocess disposal.
   * @returns The single close operation, also joined by plugin disposal. */
  shutdown(): Promise<void> {
    return this.closing ??= (async () => {
      for (const controller of this.proofs.values()) controller.abort()
      this.operationFeed.close()
      if (this.bridge !== undefined) await (await this.bridge).close()
    })()
  }

  private async engine(): Promise<WordBridge> {
    if (this.closing !== undefined) throw new WordBridgeError('unavailable', 'The Word service is closing.')
    if (this.bridge !== undefined) return this.bridge
    if (process.platform !== 'win32' || !this.runtime.python || !this.runtime.dependencyRoot || !this.runtime.dataRoot) {
      throw new WordBridgeError('unavailable', 'Local Word is available only in the Windows desktop application.')
    }
    this.bridge = (async () => {
      const names = ['binary_bridge.py', 'safe_save.py', 'storage.py', 'blank.docx']
      const contents = await Promise.all(names.map(name => readFile(new URL('../worker/' + name, import.meta.url))))
      const digest = createHash('sha256').update(Buffer.concat(contents)).digest('hex')
      const directory = join(this.runtime.dataRoot, 'engine', digest)
      await mkdir(directory, { recursive: true })
      for (const [index, name] of names.entries()) {
        const content = contents[index]
        if (content === undefined) throw new WordBridgeError('unavailable', 'A bundled Word resource is missing.')
        await writeFile(join(directory, name), content)
      }
      const data = join(this.runtime.dataRoot, 'documents')
      await mkdir(data, { recursive: true })
      return new WordBridge(this.ctx, this.runtime.python, join(directory, 'binary_bridge.py'), this.runtime.dependencyRoot, data)
    })()
    try { return await this.bridge } catch (error) { this.bridge = undefined; throw error }
  }

  private operationOwner(scope: WorkspaceFileScope): string { return `${scope.sessionId}\0${scope.workspaceRoot}` }

  /**
   * Deliver queued commands immediately to the authenticated editor.
   * @param workspaceFileScope - Session and workspace access resolved by the gateway.
   * @param signal - Stream cancellation.
   * @returns Readiness followed by pending-document notices.
   */
  @Remote({ mode: 'stream' })
  async *followOperations(workspaceFileScope: WorkspaceFileScope, signal: AbortSignal): AsyncIterable<WordOperationNotice> {
    await this.ctx.fs.resolve(workspaceFileScope.workspaceRoot, { signal })
    yield* this.operationFeed.follow(this.operationOwner(workspaceFileScope), async () => {
      const notices: WordOperationNotice[] = []
      for (const [id, owner] of this.documents) {
        if (owner.scope.sessionId !== workspaceFileScope.sessionId
          || owner.scope.workspaceRoot !== workspaceFileScope.workspaceRoot) continue
        const snapshot = await this.checkpoint(workspaceFileScope, id, signal)
        if ((snapshot.pendingOperations?.length ?? 0) > 0) notices.push({ kind: 'queued', path: snapshot.path, documentId: id, revision: snapshot.revision })
      }
      return notices
    }, signal)
  }

  /**
   * Queue a command and return only after the editor confirms its checkpoint.
   * @param scope - Authenticated document owner.
   * @param request - Revision-checked operation.
   * @param signal - Caller cancellation.
   * @returns Confirmed draft; a timeout reports an unresolved request, never success.
   */
  async applyAndWait(scope: WorkspaceFileScope, request: WordMutation, signal: AbortSignal): Promise<WordSnapshot> {
    if (!this.operationFeed.available(this.operationOwner(scope))) throw new WordBridgeError('unavailable', 'The writing board is not connected. Open the document in the board before editing it.')
    await this.mutate(scope, request, signal)
    const owner = await this.owner(scope, request.documentId, signal)
    const started = Date.now()
    const statusSchema = schema.object({ state: schema.enum(['pending', 'completed', 'missing']), revision: schema.number().int(), error: schema.string().nullable() })
    while (Date.now() - started < this.operationTimeoutMs) {
      const status = await (await this.engine()).request('operation-status', { documentId: request.documentId,
        requestId: request.requestId, scope: scope.sessionId, root: owner.root }, statusSchema, signal)
      if (status.state === 'completed') {
        if (status.error !== null) throw new WordBridgeError('editor-refused', status.error)
        return this.checkpoint(scope, request.documentId, signal)
      }
      if (status.state === 'missing') throw new WordBridgeError('operation-missing', 'The editor request has no confirmed result.')
      await delay(40, undefined, { signal })
    }
    throw new WordBridgeError('operation-timeout', `The editor did not confirm request ${request.requestId} within the operation deadline. Inspect its receipt before retrying; do not report completion or edit the file externally.`)
  }

  private async location(scope: WorkspaceFileScope, path: string, signal: AbortSignal) {
    signal.throwIfAborted()
    if (!path || path.includes('\0') || !/\.docx$/iu.test(path)) throw new WordBridgeError('unsupported', 'Choose a macro-free .docx document.')
    const root = await this.ctx.fs.resolve(scope.workspaceRoot, { signal })
    const entry = await this.ctx.fs.lstat(path, { cwd: scope.workspaceRoot }, signal)
    if (entry?.type === 'symlink') throw new WordBridgeError('outside-workspace', 'Open the actual file instead of a link.')
    const target = await this.ctx.fs.resolve(path, { cwd: scope.workspaceRoot, signal })
    if (!this.ctx.fs.contains(root, target)) throw new WordBridgeError('outside-workspace', 'Choose a document inside this workspace.')
    const absolutePath = this.ctx.fs.processPath(target)
    if (this.ctx.fs.processPathFromHostPath(absolutePath) !== absolutePath || absolutePath.startsWith('\\\\')) {
      throw new WordBridgeError('unsupported', 'Word requires a local workspace.')
    }
    return { root: this.ctx.fs.processPath(root), target, absolutePath }
  }

  private async owner(scope: WorkspaceFileScope, documentId: string, signal: AbortSignal) {
    const owner = this.documents.get(documentId)
    if (owner === undefined || owner.scope.sessionId !== scope.sessionId) throw new WordBridgeError('scope', 'Reopen the document in its original session.')
    const location = await this.location(scope, owner.absolutePath, signal)
    if (location.root !== owner.root || location.absolutePath !== owner.absolutePath) {
      throw new WordBridgeError('scope', 'The document workspace changed. Its draft has been retained.')
    }
    return owner
  }

  private value(value: WorkerSnapshot, scope: WorkspaceFileScope, root: string): WordSnapshot {
    if (value.scope !== scope.sessionId || value.root !== root) throw new WordBridgeError('protocol', 'The document response belongs to another workspace.')
    this.documents.set(value.id, { scope, root, absolutePath: value.path })
    return { id: value.id, path: relative(root, value.path).replaceAll('\\', '/'), absolutePath: value.path, workspaceRoot: root,
      revision: value.revision, savedRevision: value.savedRevision, checkpoint: value.checkpoint,
      checkpointHash: value.checkpointHash, checkpointTime: value.checkpointTime, diskVersion: value.baseline?.sha256 ?? null,
      projection: value.projection, data: value.data, engine: 'ooxml', pendingOperations: value.pendingOperations,
      originalStatus: value.originalStatus }
  }
  private failure(error: unknown): never {
    if (error instanceof RemoteError) throw error
    if (error instanceof WordBridgeError) throw new RemoteError('word/failure', error.message, { reason: error.reason }, { cause: error })
    throw new RemoteError('word/failure', 'The Word operation failed; the last confirmed draft is retained.',
      { reason: 'failed', diagnostic: error instanceof Error ? error.message : String(error) }, { cause: error })
  }

  /** Read bounded page regions and command receipts from the confirmed draft.
   * @param scope - Authenticated session and workspace.
   * @param documentId - Open document identity.
   * @param signal - Read cancellation.
   * @returns Section options, region text and queued/settled operation identifiers. */
  async pageInfo(scope: WorkspaceFileScope, documentId: string, signal: AbortSignal): Promise<WordPageInfo> {
    try {
      const owner = await this.owner(scope, documentId, signal)
      return await (await this.engine()).request('page-info', { scope: scope.sessionId, root: owner.root, documentId }, pageInfoSchema, signal)
    } catch (error) { return this.failure(error) }
  }

  /** Open or create a private working copy; recovery never writes the original.
   * @param workspaceFileScope - authenticated Session and current workspace.
   * @param path - contained .docx path.
   * @param create - create a new unsaved document.
   * @param recovery - exact durable checkpoint reference, when restoring a scene.
   * @param signal - opening cancellation.
   * @returns a Word projection and durable binary checkpoint. */
  @Remote
  async open(workspaceFileScope: WorkspaceFileScope, path: string, create: boolean,
    recovery: WordCheckpoint | null, signal: AbortSignal): Promise<WordSnapshot> {
    try {
      const location = await this.location(workspaceFileScope, path, signal)
      if (recovery === null && !create) await this.ctx.fs.readBytes(location.target, signal, 64 * 1024 * 1024)
      const engine = await this.engine()
      const result = await engine.request('open', { scope: workspaceFileScope.sessionId, root: location.root, path: location.absolutePath, create,
        ...(recovery === null ? {} : { documentId: recovery.id, checkpoint: recovery.checkpoint, checkpointHash: recovery.checkpointHash,
          revision: recovery.revision }) },
      workerSnapshot, signal)
      return this.value(result, workspaceFileScope, location.root)
    } catch (error) { return this.failure(error) }
  }

  /** Confirm a byte-native draft; the Host never re-edits its contents.
   * @param workspaceFileScope - authenticated workspace.
   * @param request - exact editor output and confirmed base revision.
   * @param signal - cancellation before checkpoint acknowledgement.
   * @returns the durable binary checkpoint. */
  @Remote
  async commit(workspaceFileScope: WorkspaceFileScope, request: WordBinaryCommit, signal: AbortSignal): Promise<WordSnapshot> {
    try {
      const owner = await this.owner(workspaceFileScope, request.documentId, signal)
      const bytes = Buffer.from(request.data, 'base64')
      if (bytes.length > 64 * 1024 * 1024 || bytes.toString('base64') !== request.data
        || createHash('sha256').update(bytes).digest('hex') !== request.sha256) {
        throw new WordBridgeError('invalid', 'The DOCX checkpoint failed its integrity check.')
      }
      const result = await (await this.engine()).request('commit-bytes',
        { ...request, scope: workspaceFileScope.sessionId, root: owner.root }, workerSnapshot, signal)
      return this.value(result, workspaceFileScope, owner.root)
    } catch (error) { return this.failure(error) }
  }

  /**
   * Settle a queued command after the canonical editor applies or refuses it.
   * @param workspaceFileScope - Authenticated workspace scope.
   * @param documentId - Open document identity.
   * @param requestId - Queued command identity.
   * @param error - Refusal message or null after application.
   * @param signal - Request cancellation signal.
   */
  @Remote
  async resolveOperation(workspaceFileScope: WorkspaceFileScope, documentId: string,
    requestId: string, error: string | null, signal: AbortSignal): Promise<void> {
    try {
      const owner = await this.owner(workspaceFileScope, documentId, signal)
      await (await this.engine()).request('resolve-operation', {
        documentId, requestId, error, scope: workspaceFileScope.sessionId, root: owner.root,
      }, schema.object({ resolved: schema.literal(true) }), signal)
    } catch (failure) { this.failure(failure) }
  }

  /** Supply packaged shaping code and requested installed fonts, never network fallbacks.
   * @param workspaceFileScope - authenticated workspace boundary.
   * @param families - document-declared families; unknown families are reported missing.
   * @param signal - cancellation of the bounded read.
   * @returns local font bytes and the pinned shaping binary. */
  @Remote
  async resources(workspaceFileScope: WorkspaceFileScope, families: string[], signal: AbortSignal): Promise<WordResources> {
    try {
      await this.ctx.fs.resolve(workspaceFileScope.workspaceRoot, { signal })
      if (families.length > 100 || families.some(family => family.length > 100)) {
        throw new WordBridgeError('invalid', 'The document font request is too large.')
      }
      const catalog: Record<string, readonly string[]> = {
        'calibri': ['calibri.ttf', 'calibrib.ttf', 'calibrii.ttf', 'calibriz.ttf'],
        'times new roman': ['times.ttf', 'timesbd.ttf', 'timesi.ttf', 'timesbi.ttf'],
        'arial': ['arial.ttf', 'arialbd.ttf', 'ariali.ttf', 'arialbi.ttf'],
        'cambria': ['cambria.ttc', 'cambriab.ttf', 'cambriai.ttf', 'cambriaz.ttf'],
        'cambria math': ['cambria.ttc'],
        '宋体': ['simsun.ttc'], 'simsun': ['simsun.ttc'],
        '黑体': ['simhei.ttf'], 'simhei': ['simhei.ttf'],
        '微软雅黑': ['msyh.ttc', 'msyhbd.ttc'], 'microsoft yahei': ['msyh.ttc', 'msyhbd.ttc'],
        '等线': ['Deng.ttf', 'Dengb.ttf'], 'dengxian': ['Deng.ttf', 'Dengb.ttf'],
        'segoe ui': ['segoeui.ttf', 'segoeuib.ttf', 'segoeuii.ttf', 'segoeuiz.ttf'],
      }
      const fonts: WordResources['fonts'] = [], missing: string[] = []
      const directory = join(process.env.SystemRoot ?? 'C:/Windows', 'Fonts')
      for (const family of new Set(families)) {
        const files = catalog[family.toLowerCase()]
        if (files === undefined) { missing.push(family); continue }
        let found = false
        for (const [index, name] of files.entries()) {
          signal.throwIfAborted()
          try {
            const data = await readFile(join(directory, name))
            if (data.byteLength > 32 * 1024 * 1024) continue
            fonts.push({ family, weight: index % 2 === 1 ? 700 : 400, style: index >= 2 ? 'italic' : 'normal',
              data: data.toString('base64'), sha256: createHash('sha256').update(data).digest('hex'),
              faceIndex: family.toLowerCase() === 'cambria math' ? 1 : 0 })
            found = true
          } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
          }
        }
        if (!found) missing.push(family)
      }
      const wasm = await readFile(new URL('../worker/harfbuzz.wasm', import.meta.url))
      return { wasm: wasm.toString('base64'), fonts, missing }
    } catch (error) { return this.failure(error) }
  }

  /** Queue a revision-checked conversation operation for the sole browser document owner.
   * @param workspaceFileScope - current authenticated workspace.
   * @param request - bounded document operation, never a script or arbitrary COM member.
   * @param signal - cancellation; an interrupted operation retains its last confirmed checkpoint.
   * @returns the unchanged checkpoint with a durable pending operation. */
  @Remote
  async mutate(workspaceFileScope: WorkspaceFileScope, request: WordMutation, signal: AbortSignal): Promise<WordSnapshot> {
    try {
      const owner = await this.owner(workspaceFileScope, request.documentId, signal)
      let operation: object = request.operation
      if (request.operation.kind === 'image') {
        const image = request.operation
        if (image.data !== undefined) {
          const bytes = Buffer.from(image.data, 'base64')
          if (bytes.length > 16 * 1024 * 1024 || bytes.toString('base64') !== image.data
            || createHash('sha256').update(bytes).digest('hex') !== image.sha256) throw new WordBridgeError('invalid', 'The staged image failed its integrity check.')
          operation = image
        } else {
          const root = await this.ctx.fs.resolve(workspaceFileScope.workspaceRoot, { signal })
          const target = await this.ctx.fs.resolve(image.path, { cwd: dirname(owner.absolutePath), signal })
          if (!this.ctx.fs.contains(root, target)) throw new WordBridgeError('outside-workspace', 'Choose an image inside this workspace.')
          const bytes = await this.ctx.fs.readBytes(target, signal, 16 * 1024 * 1024)
          operation = { ...image, data: Buffer.from(bytes).toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }
        }
      }
      const result = await (await this.engine()).request('mutate',
        { ...request, operation, scope: workspaceFileScope.sessionId, root: owner.root }, workerSnapshot, signal)
      this.operationFeed.publish(this.operationOwner(workspaceFileScope), { kind: 'queued', path: relative(owner.root, result.path).replaceAll('\\', '/'), documentId: result.id, revision: result.revision })
      return this.value(result, workspaceFileScope, owner.root)
    } catch (error) { return this.failure(error) }
  }

  /** Publish an explicit save through the native no-overwrite transaction.
   * @param workspaceFileScope - authenticated workspace.
   * @param documentId - owned document.
   * @param revision - acknowledged revision to save.
   * @param requestId - stable request identity.
   * @param path - optional new destination; an existing Save As target is never overwritten.
   * @param signal - cancellation before a confirmed commit.
   * @returns saved state only after successful publication. */
  @Remote
  async save(workspaceFileScope: WorkspaceFileScope, documentId: string, revision: number,
    requestId: string, path: string | null, signal: AbortSignal): Promise<WordSnapshot> {
    try {
      const owner = await this.owner(workspaceFileScope, documentId, signal)
      const location = await this.location(workspaceFileScope, path ?? owner.absolutePath, signal)
      const result = await (await this.engine()).request('save', { documentId, revision, requestId, path: location.absolutePath,
        scope: workspaceFileScope.sessionId, root: owner.root }, workerSnapshot, signal)
      const saved = this.value(result, workspaceFileScope, owner.root)
      if (path === null) this.operationFeed.publish(this.operationOwner(workspaceFileScope),
        { kind: 'saved', path: saved.path, documentId, revision: saved.revision })
      return saved
    } catch (error) { return this.failure(error) }
  }

  /** Return the already durable, confirmed state without replaying edits.
   * @param workspaceFileScope - authenticated workspace.
   * @param documentId - owned document.
   * @param signal - cancellation.
   * @returns the latest confirmed checkpoint reference. */
  @Remote
  async checkpoint(workspaceFileScope: WorkspaceFileScope, documentId: string, signal: AbortSignal): Promise<WordSnapshot> {
    try {
      const owner = await this.owner(workspaceFileScope, documentId, signal)
      const result = await (await this.engine()).request('snapshot', { documentId, scope: workspaceFileScope.sessionId, root: owner.root }, workerSnapshot, signal)
      return this.value(result, workspaceFileScope, owner.root)
    } catch (error) { return this.failure(error) }
  }

  /** Generate a revision-bound Word PDF without opening a viewer.
   * @param workspaceFileScope - authenticated workspace.
   * @param documentId - owned document.
   * @param revision - exact revision for the proof.
   * @param cached - retrieve the retained proof without starting Word pagination.
   * @param reference - exact persisted proof identity, or null for the latest retained proof.
   * @param signal - cancellation of this proof.
   * @returns bounded PDF bytes and the revision they represent. */
  @Remote
  async proof(workspaceFileScope: WorkspaceFileScope, documentId: string, revision: number,
    cached: boolean, reference: WordProofReference | null, signal: AbortSignal): Promise<WordProof | null> {
    const controller = new AbortController()
    try {
      const owner = await this.owner(workspaceFileScope, documentId, signal)
      if (this.proofs.has(documentId)) throw new WordBridgeError('busy', 'A proof is already being generated.')
      this.proofs.set(documentId, controller)
      const result = await (await this.engine()).request(cached ? 'cached-proof' : 'proof', { documentId, revision, reference, scope: workspaceFileScope.sessionId, root: owner.root },
        proofSchema.nullable(), AbortSignal.any([signal, controller.signal]), 180_000)
      if (result === null) return null
      const data = Buffer.from(result.data, 'base64')
      if (createHash('sha256').update(data).digest('hex') !== result.sha256) throw new WordBridgeError('protocol', 'The proof did not pass its integrity check.')
      return { revision: result.revision, data: Uint8Array.from(data), version: result.sha256,
        builtAt: new Date(result.createdAt).toISOString(), regions: result.regions }
    } catch (error) { return this.failure(error) }
    finally { if (this.proofs.get(documentId) === controller) this.proofs.delete(documentId) }
  }

  /** Reclaim only files behind the complete durable scene references.
   * @param workspaceFileScope - authenticated Session and current workspace; no cross-scope sweep.
   * @param retention - persisted references, including inactive tabs and pending-input bases.
   * @param signal - cancellation; failed enumeration never calls this operation.
   * @returns cleanup diagnostics without document paths.
   */
  @Remote
  async retain(workspaceFileScope: WorkspaceFileScope, retention: WordRetention, signal: AbortSignal): Promise<WordRetentionResult> {
    try {
      const resolved = await this.ctx.fs.resolve(workspaceFileScope.workspaceRoot, { signal })
      const root = this.ctx.fs.processPath(resolved)
      if (root.replaceAll('\\', '/').replace(/\/+$/u, '') !== retention.workspaceRoot) {
        throw new WordBridgeError('scope', 'The scene workspace changed; its drafts have been retained.')
      }
      return await (await this.engine()).request('retain', {
        scope: workspaceFileScope.sessionId, root, documents: retention.documents,
      }, schema.object({ deleted: schema.number().int().nonnegative(), failures: schema.array(schema.string()) }), signal)
    } catch (error) { return this.failure(error) }
  }

  /** Stop a proof owned by this Session. Confirmed drafts remain durable.
   * @param workspaceFileScope - authenticated workspace.
   * @param documentId - owned document.
   * @param signal - request cancellation. */
  @Remote
  async stop(workspaceFileScope: WorkspaceFileScope, documentId: string, signal: AbortSignal): Promise<void> {
    try { await this.owner(workspaceFileScope, documentId, signal); this.proofs.get(documentId)?.abort() }
    catch (error) { return this.failure(error) }
  }

  /** Release this document's write ownership after its draft is confirmed.
   * @param workspaceFileScope - authenticated workspace.
   * @param documentId - owned document.
   * @param discard - Remove the retained draft when explicitly requested.
   * @param signal - cancellation. */
  @Remote
  async close(workspaceFileScope: WorkspaceFileScope, documentId: string, discard: boolean, signal: AbortSignal): Promise<void> {
    try {
      const owner = await this.owner(workspaceFileScope, documentId, signal)
      await (await this.engine()).request('close', { documentId, discard, scope: workspaceFileScope.sessionId, root: owner.root }, noop, signal)
      this.documents.delete(documentId)
    } catch (error) { return this.failure(error) }
  }
}
export default WorkbenchWord
