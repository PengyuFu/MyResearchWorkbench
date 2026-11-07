/** Local-only, non-overwriting asset groups surrounding the existing document CAS write. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, opendir, realpath, unlink } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'

const MAX_FILE_BYTES = 16 * 1024 * 1024, MAX_TOTAL_BYTES = 32 * 1024 * 1024, MAX_FILES = 8
const LOG_DIRECTORY = '.mrw-build/asset-transactions'
const MAX_LOG_BYTES = 128 * 1024
const assetPattern = /^figures\/workbench\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}-[a-f0-9]{8}\.(png|jpg|jpeg|pdf|eps)$/

export interface AssetTransactionPayload { readonly path: string; readonly data: Uint8Array; readonly sha256: string }
export interface AssetCommitRequest {
  readonly sourcePath: string
  readonly text: string
  readonly expectedVersion: string | null
  readonly assets: readonly AssetTransactionPayload[]
}
export interface AssetTransactionCallbacks<T> {
  /** Explicit local provider opt-in. Remote targets must never be mapped onto the Host filesystem. */
  readonly localRoot: string
  /** Must enforce the same authorized workspace scope and contained/realpath guards as the document. */
  resolvePath(relativePath: string, signal: AbortSignal): Promise<string>
  /** Recheck source identity and its original CAS version before creating assets and before writing TeX. */
  preflightDocument(signal: AbortSignal): Promise<void>
  /** The existing ctx.fs.writeText(createIfAbsent/replaceIfVersion) is the sole document writer. */
  commitDocument(signal: AbortSignal): Promise<T>
}
interface AssetEntry { path: string; sha256: string; size: number; status: 'planned' | 'created' | 'reused'; identity?: string }
export interface AssetTransactionRecord {
  readonly version: 1
  readonly transactionId: string
  readonly createdAt: string
  readonly sourcePath: string
  readonly expectedVersion: string | null
  readonly newTextSha256: string
  readonly phase: 'prepared' | 'assets-written' | 'document-committed' | 'rolled-back' | 'needs-recovery'
  readonly assets: readonly AssetEntry[]
  readonly residualPaths?: readonly string[]
  readonly error?: string
}
export interface AssetCommitResult<T> { readonly document: T; readonly created: readonly string[]; readonly reused: readonly string[]; readonly transactionId: string; readonly recoveryLog: string }

/** A partial failure is explicit; callers must not report an asset group as atomically committed. */
export class AssetTransactionError extends Error {
  override readonly name = 'AssetTransactionError'
  constructor(message: string, readonly transactionId: string, readonly residualPaths: readonly string[],
    readonly recoveryLog: string, readonly documentCommitted: boolean, options?: ErrorOptions) { super(message, options) }
}

function hash(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex') }
function code(error: unknown, expected: string): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === expected }
function identity(info: BigIntStats): string { return [info.dev, info.ino, info.size, info.birthtimeNs, info.mtimeNs, info.ctimeNs].join(':') }
function samePath(left: string, right: string): boolean { return process.platform === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right) }
function localAbsolute(value: string): boolean { return path.isAbsolute(value) && !/^[/\\]{2}/.test(value) && !/^[a-z][a-z\d+.-]*:\/\//i.test(value) }

/** Reject mutated bytes, unsafe destinations and unsupported file signatures before any write. */
export function validateAssetPayloads(assets: readonly AssetTransactionPayload[]): { path: string; data: Uint8Array; sha256: string }[] {
  if (!Array.isArray(assets) || assets.length > MAX_FILES) throw new Error('ASSET_GROUP_LIMIT: Keep at most 8 files in one save.')
  let total = 0
  const result = new Map<string, { path: string; data: Uint8Array; sha256: string }>()
  for (const asset of assets) {
    if (!assetPattern.test(asset.path) || !/^[a-f0-9]{64}$/.test(asset.sha256)
      || !asset.path.endsWith(`-${asset.sha256.slice(0, 8)}${path.extname(asset.path)}`)) throw new Error('ASSET_PATH: Expected a canonical figures/workbench content-addressed file.')
    if (!(asset.data instanceof Uint8Array) || asset.data.byteLength < 1 || asset.data.byteLength > MAX_FILE_BYTES) throw new Error('ASSET_FILE_LIMIT: Each asset must contain 1 byte to 16 MiB.')
    total += asset.data.byteLength
    if (total > MAX_TOTAL_BYTES) throw new Error('ASSET_GROUP_LIMIT: A save may contain at most 32 MiB of assets.')
    const data = Uint8Array.from(asset.data)
    if (hash(data) !== asset.sha256) throw new Error('ASSET_HASH_MISMATCH: The staged asset changed before save.')
    const extension = path.extname(asset.path)
    const prefix = Buffer.from(data.subarray(0, 80)).toString('ascii')
    const starts = (header: readonly number[]) => header.every((byte, index) => data[index] === byte)
    const valid = extension === '.png' ? starts([137, 80, 78, 71, 13, 10, 26, 10])
      : extension === '.jpg' || extension === '.jpeg' ? starts([255, 216, 255])
        : extension === '.pdf' ? prefix.startsWith('%PDF-')
          : (prefix.startsWith('%!PS-Adobe-') && prefix.includes('EPSF-')) || starts([197, 208, 211, 198])
    if (!valid) throw new Error('ASSET_SIGNATURE_MISMATCH: The asset bytes do not match the destination format.')
    const previous = result.get(asset.path)
    if (previous !== undefined && previous.sha256 !== asset.sha256) throw new Error('ASSET_DUPLICATE_TARGET')
    result.set(asset.path, { path: asset.path, data, sha256: asset.sha256 })
  }
  return [...result.values()]
}

async function rootOf(callbacks: Pick<AssetTransactionCallbacks<unknown>, 'localRoot'>): Promise<string> {
  if (!localAbsolute(callbacks.localRoot)) throw new Error('ASSET_LOCAL_ONLY: Asset import requires an explicitly local workspace.')
  const root = await realpath(callbacks.localRoot)
  if (!localAbsolute(root) || !(await lstat(root)).isDirectory()) throw new Error('ASSET_LOCAL_ONLY')
  return root
}

async function guardedPath(root: string, relative: string, callbacks: Pick<AssetTransactionCallbacks<unknown>, 'resolvePath'>, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  if (!relative || /[\\\0]/.test(relative) || relative.split('/').some(part => part === '..' || part === '.' || part === '')) throw new Error('ASSET_PATH')
  const expected = path.join(root, ...relative.split('/'))
  const authorized = await callbacks.resolvePath(relative, signal)
  if (!localAbsolute(authorized) || !samePath(authorized, expected)) throw new Error('ASSET_TARGET_CHANGED: The authorized target is not the expected local workspace path.')
  let current = root
  for (const component of relative.split('/')) {
    current = path.join(current, component)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error('ASSET_SYMLINK: Open the actual contained path instead of a link.')
      if (current !== expected && !info.isDirectory()) throw new Error('ASSET_PARENT_NOT_DIRECTORY')
    } catch (error) { if (!code(error, 'ENOENT')) throw error }
  }
  return expected
}

async function ensureDirectory(root: string, relative: string, callbacks: Pick<AssetTransactionCallbacks<unknown>, 'resolvePath'>, signal: AbortSignal): Promise<void> {
  const pieces = relative.split('/')
  for (let i = 1; i <= pieces.length; i++) {
    const target = await guardedPath(root, pieces.slice(0, i).join('/'), callbacks, signal)
    try { await mkdir(target) } catch (error) { if (!code(error, 'EEXIST')) throw error }
    const info = await lstat(target)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('ASSET_PARENT_CHANGED')
  }
}

async function readStableBytes(target: string, maxBytes = MAX_FILE_BYTES): Promise<{ sha256: string; identity: string; data: Uint8Array } | undefined> {
  try {
    const entry = await lstat(target, { bigint: true })
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > BigInt(maxBytes)) throw new Error('ASSET_TARGET_INVALID')
    const handle = await open(target, 'r')
    try {
      const before = await handle.stat({ bigint: true })
      if (identity(entry) !== identity(before)) throw new Error('ASSET_TARGET_CHANGED')
      const buffer = Buffer.alloc(Number(before.size) + 1)
      let length = 0
      while (length < buffer.byteLength) {
        const read = await handle.read(buffer, length, buffer.byteLength - length, length)
        if (read.bytesRead === 0) break
        length += read.bytesRead
      }
      const bytes = buffer.subarray(0, length)
      const after = await handle.stat({ bigint: true })
      if (bytes.byteLength > maxBytes || identity(before) !== identity(after) || identity(after) !== identity(await lstat(target, { bigint: true }))) throw new Error('ASSET_TARGET_CHANGED')
      return { sha256: hash(bytes), identity: identity(after), data: bytes }
    } finally { await handle.close() }
  } catch (error) { if (code(error, 'ENOENT')) return undefined; throw error }
}

async function observe(target: string, maxBytes = MAX_FILE_BYTES): Promise<{ sha256: string; identity: string } | undefined> {
  const read = await readStableBytes(target, maxBytes)
  return read === undefined ? undefined : { sha256: read.sha256, identity: read.identity }
}

/**
 * Create verified assets exclusively, then delegate one document CAS transaction.
 * A journal and a local lock describe partial outcomes; this is not a multi-file
 * atomic filesystem transaction. Uncertain or externally changed files are retained.
 */
export async function commitAssetGroup<T>(request: AssetCommitRequest, callbacks: AssetTransactionCallbacks<T>, signal: AbortSignal): Promise<AssetCommitResult<T>> {
  signal.throwIfAborted()
  const assets = validateAssetPayloads(request.assets)
  if (!request.sourcePath || request.sourcePath.length > 4096 || request.sourcePath.includes('\0')
    || (request.expectedVersion !== null && typeof request.expectedVersion !== 'string')
    || typeof request.text !== 'string' || request.text.includes('\0') || Buffer.byteLength(request.text, 'utf8') > MAX_TOTAL_BYTES) throw new Error('ASSET_SOURCE_IDENTITY')
  const root = await rootOf(callbacks)
  await callbacks.preflightDocument(signal)
  const transactionId = randomUUID()
  const logRelative = `${LOG_DIRECTORY}/${transactionId}.jsonl`
  const entries: AssetEntry[] = []
  // Validate every target before creating even the first scientific asset.
  for (const asset of assets) {
    const target = await guardedPath(root, asset.path, callbacks, signal)
    const existing = await observe(target)
    if (existing !== undefined && existing.sha256 !== asset.sha256) throw new Error(`ASSET_TARGET_EXISTS: ${asset.path} contains different bytes; nothing was overwritten.`)
    entries.push({ path: asset.path, sha256: asset.sha256, size: asset.data.byteLength, status: existing === undefined ? 'planned' : 'reused' })
  }
  await ensureDirectory(root, LOG_DIRECTORY, callbacks, signal)
  const lockPath = await guardedPath(root, `${LOG_DIRECTORY}/active.lock`, callbacks, signal)
  let lock: FileHandle
  try { lock = await open(lockPath, 'wx', 0o600) } catch (error) {
    if (code(error, 'EEXIST')) throw new AssetTransactionError('ASSET_TRANSACTION_BUSY: Another save or an interrupted asset transaction holds the local lock. Inspect the recovery records before retrying.', transactionId, [], lockPath, false, { cause: error })
    throw error
  }
  const lockBytes = JSON.stringify({ version: 1, transactionId, pid: process.pid, createdAt: new Date().toISOString() })
  let lockIdentity: string | undefined
  let log: FileHandle | undefined
  let recoveryLog = path.join(root, ...logRelative.split('/'))
  let committed = false
  let record: AssetTransactionRecord = { version: 1, transactionId, createdAt: new Date().toISOString(), sourcePath: request.sourcePath,
    expectedVersion: request.expectedVersion, newTextSha256: hash(request.text), phase: 'prepared', assets: entries }
  const appendRecord = async (): Promise<void> => { await log!.writeFile(JSON.stringify(record) + '\n', 'utf8'); await log!.sync() }
  try {
    await lock.writeFile(lockBytes, 'utf8'); await lock.sync(); await lock.close()
    const observedLock = await observe(lockPath, 4096)
    if (observedLock?.sha256 !== hash(lockBytes)) throw new Error('ASSET_LOCK_CHANGED')
    lockIdentity = observedLock.identity
    recoveryLog = await guardedPath(root, logRelative, callbacks, signal)
    log = await open(recoveryLog, 'ax', 0o600)
    await appendRecord()
    await ensureDirectory(root, 'figures/workbench', callbacks, signal)
    for (const [index, asset] of assets.entries()) {
      signal.throwIfAborted()
      const entry = entries[index]!
      const target = await guardedPath(root, asset.path, callbacks, signal)
      let handle: FileHandle | undefined
      try {
        handle = await open(target, 'wx', 0o600)
        entry.status = 'created'
        await handle.writeFile(asset.data); await handle.sync()
      } catch (error) {
        if (!code(error, 'EEXIST')) throw error
        const existing = await observe(target)
        if (existing?.sha256 !== asset.sha256) throw new Error(`ASSET_TARGET_CHANGED: ${asset.path} was not overwritten.`)
        entry.status = 'reused'
      } finally { await handle?.close() }
      if (entry.status === 'created') {
        const written = await observe(target)
        if (written?.sha256 !== asset.sha256) throw new Error(`ASSET_TARGET_CHANGED: ${asset.path}`)
        entry.identity = written.identity
      }
      await appendRecord()
    }
    record = { ...record, phase: 'assets-written' }; await appendRecord()
    await callbacks.preflightDocument(signal)
    for (const entry of entries) {
      const target = await guardedPath(root, entry.path, callbacks, signal)
      if ((await observe(target))?.sha256 !== entry.sha256) throw new Error(`ASSET_TARGET_CHANGED: ${entry.path}`)
    }
    signal.throwIfAborted()
    const document = await callbacks.commitDocument(signal)
    committed = true
    record = { ...record, phase: 'document-committed' }; await appendRecord()
    return { document, created: entries.filter(entry => entry.status === 'created').map(entry => entry.path),
      reused: entries.filter(entry => entry.status === 'reused').map(entry => entry.path), transactionId, recoveryLog }
  } catch (error) {
    const residualPaths: string[] = []
    const cleanupSignal = AbortSignal.timeout(5000)
    let sourceUnchanged = false
    if (!committed) { try { await callbacks.preflightDocument(cleanupSignal); sourceUnchanged = true } catch { /* Changed or uncertain source prevents destructive cleanup. */ } }
    for (const entry of entries.filter(value => value.status === 'created')) {
      if (committed || !sourceUnchanged || entry.identity === undefined) { residualPaths.push(entry.path); continue }
      try {
        const target = await guardedPath(root, entry.path, callbacks, cleanupSignal)
        const current = await observe(target)
        if (current === undefined) continue
        if (current.identity !== entry.identity || current.sha256 !== entry.sha256
          || identity(await lstat(target, { bigint: true })) !== entry.identity) { residualPaths.push(entry.path); continue }
        await unlink(target)
      } catch { residualPaths.push(entry.path) }
    }
    const message = error instanceof Error ? error.message : String(error)
    record = { ...record, phase: residualPaths.length > 0 || committed ? 'needs-recovery' : 'rolled-back', residualPaths, error: message.slice(0, 4096) }
    if (log !== undefined) { try { await appendRecord() } catch { /* The prior complete log snapshot still records planned files. */ } }
    throw new AssetTransactionError(committed ? `The document was saved but its asset journal could not finish. Reopen the document before retrying. ${message}`
      : `The asset group was not recorded as successful. ${residualPaths.length ? 'Some created files were retained because their state was uncertain. ' : ''}${message}`,
    transactionId, residualPaths, recoveryLog, committed, { cause: error })
  } finally {
    await log?.close().catch(() => undefined)
    await lock.close().catch(() => undefined)
    try {
      const current = await observe(lockPath, 4096)
      if (lockIdentity !== undefined && current?.identity === lockIdentity && current.sha256 === hash(lockBytes)) await unlink(lockPath)
    } catch { /* An uncertain lock remains visible for explicit recovery. */ }
  }
}

export interface AssetTransactionHistory { readonly records: readonly AssetTransactionRecord[]; readonly issues: readonly string[]; readonly truncated: boolean; readonly activeLock?: string }

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function journalRecord(value: unknown, expectedId: string): value is AssetTransactionRecord {
  return isRecord(value) && value.version === 1 && value.transactionId === expectedId && typeof value.createdAt === 'string'
    && typeof value.sourcePath === 'string' && value.sourcePath.length <= 4096
    && (value.expectedVersion === null || typeof value.expectedVersion === 'string') && typeof value.newTextSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.newTextSha256)
    && ['prepared', 'assets-written', 'document-committed', 'rolled-back', 'needs-recovery'].includes(String(value.phase))
    && Array.isArray(value.assets) && value.assets.length <= MAX_FILES && value.assets.every(asset => isRecord(asset)
      && typeof asset.path === 'string' && assetPattern.test(asset.path) && typeof asset.sha256 === 'string' && /^[a-f0-9]{64}$/.test(asset.sha256)
      && typeof asset.size === 'number' && asset.size > 0 && asset.size <= MAX_FILE_BYTES && ['planned', 'created', 'reused'].includes(String(asset.status)))
    && (value.residualPaths === undefined || Array.isArray(value.residualPaths) && value.residualPaths.every(item => typeof item === 'string' && assetPattern.test(item)))
}

/** Bounded journal inspection retains incomplete tails as an explicit issue; it never deletes assets or locks. */
export async function readAssetTransactions(callbacks: Pick<AssetTransactionCallbacks<unknown>, 'localRoot' | 'resolvePath'>, signal: AbortSignal): Promise<AssetTransactionHistory> {
  const root = await rootOf(callbacks)
  const directory = await guardedPath(root, LOG_DIRECTORY, callbacks, signal)
  let directoryHandle
  try { directoryHandle = await opendir(directory) } catch (error) { if (code(error, 'ENOENT')) return { records: [], issues: [], truncated: false }; throw error }
  const names: string[] = []
  let scanned = 0, truncated = false
  // Bound directory metadata as well as file bytes; do not materialize an arbitrary directory.
  for await (const file of directoryHandle) {
    signal.throwIfAborted()
    if (++scanned > 256) { truncated = true; break }
    if (!file.isFile() || !/^[a-f0-9-]{36}\.jsonl$/.test(file.name)) continue
    if (names.length === 64) { truncated = true; break }
    names.push(file.name)
  }
  names.sort()
  const records: AssetTransactionRecord[] = [], issues: string[] = []
  for (const name of names) {
    signal.throwIfAborted()
    try {
      const target = await guardedPath(root, `${LOG_DIRECTORY}/${name}`, callbacks, signal)
      const observed = await readStableBytes(target, MAX_LOG_BYTES)
      if (observed === undefined) continue
      const text = new TextDecoder('utf8', { fatal: true }).decode(observed.data)
      const lines = text.split('\n')
      if (lines.at(-1) !== '') issues.push(`${name}: incomplete final record retained.`)
      lines.pop()
      let latest: AssetTransactionRecord | undefined
      for (const line of lines) { const value: unknown = JSON.parse(line); if (!journalRecord(value, name.slice(0, -6))) throw new Error('Invalid journal record.'); latest = value }
      if (latest !== undefined) records.push(latest)
    } catch (error) { issues.push(`${name}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  // A directory truncation must not hide the one lock that prevents a new save.
  const lockTarget = await guardedPath(root, `${LOG_DIRECTORY}/active.lock`, callbacks, signal)
  let activeLock: string | undefined
  try { await lstat(lockTarget); activeLock = lockTarget } catch (error) { if (!code(error, 'ENOENT')) throw error }
  return { records, issues, truncated, ...(activeLock === undefined ? {} : { activeLock }) }
}
