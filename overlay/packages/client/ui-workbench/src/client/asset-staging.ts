/** Durable, bounded browser staging for explicitly selected scientific figure assets. */
import { parseLatexDocument } from './latex-source.ts'
import { requiredTexGroup, texCommands } from './latex-source.scan.ts'

export const STAGED_ASSET_LIMITS = { files: 8, totalBytes: 32 * 1024 * 1024, fileBytes: 16 * 1024 * 1024 } as const

export interface AssetStagingScope { readonly sessionId: string; readonly workspaceRoot: string }
export interface StagedAsset {
  readonly id: string
  readonly name: string
  /** Workspace-relative target, chosen from content identity without overwriting an existing asset. */
  readonly path: string
  readonly mime: string
  readonly sha256: string
  readonly size: number
  readonly createdAt: number
  readonly blob: Blob
  readonly previewKind: 'image' | 'pdf' | 'unavailable'
}
interface StoredAsset extends StagedAsset { readonly key: string; readonly scopeKey: string }
export interface StagedAssetPayload { readonly path: string; readonly data: Uint8Array; readonly sha256: string }
export interface StagedAssetPreview { readonly kind: 'image' | 'pdf' | 'unavailable'; readonly url?: string; dispose(): void }

const formats: Record<string, { mime: string; aliases: readonly string[]; preview: StagedAsset['previewKind'] }> = {
  png: { mime: 'image/png', aliases: ['image/png'], preview: 'image' },
  jpg: { mime: 'image/jpeg', aliases: ['image/jpeg', 'image/jpg'], preview: 'image' },
  jpeg: { mime: 'image/jpeg', aliases: ['image/jpeg', 'image/jpg'], preview: 'image' },
  pdf: { mime: 'application/pdf', aliases: ['application/pdf'], preview: 'pdf' },
  eps: { mime: 'application/postscript', aliases: ['application/postscript', 'application/eps', 'application/x-eps', 'image/eps', 'image/x-eps'], preview: 'unavailable' },
}

function scopeKey(scope: AssetStagingScope): string {
  if (!scope.sessionId || !scope.workspaceRoot || scope.sessionId.length > 1024 || scope.workspaceRoot.length > 8192
    || scope.sessionId.includes('\0') || scope.workspaceRoot.includes('\0')) throw new Error('ASSET_STAGING_SCOPE')
  return JSON.stringify([scope.sessionId, scope.workspaceRoot])
}

/** Validate the file extension, declared MIME and actual bytes before persisting them. */
export function inspectAssetBytes(name: string, mime: string, bytes: Uint8Array): { extension: string; mime: string; previewKind: StagedAsset['previewKind'] } {
  if (!name || name.length > 1024 || /[\0\r\n]/.test(name) || bytes.byteLength === 0 || bytes.byteLength > STAGED_ASSET_LIMITS.fileBytes) {
    throw new Error('ASSET_FILE_SIZE_OR_NAME: Select a nonempty file of at most 16 MiB.')
  }
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''
  const format = formats[extension]
  if (format === undefined) throw new Error('ASSET_FILE_TYPE: Choose PNG, JPEG, PDF or EPS for this LaTeX project.')
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- split always returns at least one string.
  if (mime && mime !== 'application/octet-stream' && !format.aliases.includes(mime.toLowerCase().split(';')[0]!.trim())) {
    throw new Error('ASSET_MIME_MISMATCH: The file extension and MIME type disagree.')
  }
  const begins = (header: readonly number[]) => header.every((value, index) => bytes[index] === value)
  const prefix = new TextDecoder('ascii').decode(bytes.subarray(0, 80))
  const matches = extension === 'png' ? begins([137, 80, 78, 71, 13, 10, 26, 10])
    : extension === 'jpg' || extension === 'jpeg' ? begins([255, 216, 255])
      : extension === 'pdf' ? prefix.startsWith('%PDF-')
        : (prefix.startsWith('%!PS-Adobe-') && prefix.includes('EPSF-')) || begins([197, 208, 211, 198])
  if (!matches) throw new Error('ASSET_SIGNATURE_MISMATCH: The selected bytes do not match the image/PDF format.')
  return { extension, mime: format.mime, previewKind: format.preview }
}

/** Produce an ASCII path safe for LaTeX, Windows and content-addressed reuse. */
export function stagedAssetPath(name: string, sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('ASSET_SHA256')
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  if (extension === undefined || formats[extension] === undefined) throw new Error('ASSET_FILE_TYPE')
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- split always returns at least one string.
  const basename = name.replaceAll('\\', '/').split('/').at(-1)!.slice(0, -extension.length - 1)
  const stem = basename.normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 64) || 'asset'
  return `figures/workbench/${stem}-${sha256.slice(0, 8)}.${extension}`
}

async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('')
}

function publicAsset(stored: StoredAsset): StagedAsset {
  const { key: _key, scopeKey: _scopeKey, ...asset } = stored
  return asset
}

/** The quota is global; lookup and deletion always require the exact Session/workspace pair. */
export class WorkbenchAssetStaging {
  private database: Promise<IDBDatabase> | undefined
  constructor(private readonly factory: IDBFactory | undefined = globalThis.indexedDB,
    private readonly now: () => number = Date.now, private readonly databaseName = 'mrw-workbench-assets-v1') {}

  private open(): Promise<IDBDatabase> {
    if (this.database !== undefined) return this.database
    if (this.factory === undefined) return Promise.reject(new Error('ASSET_STAGING_UNAVAILABLE: Browser storage is unavailable.'))
    this.database = new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- Immutable factory checked above.
      const request = this.factory!.open(this.databaseName, 1)
      request.onupgradeneeded = () => { request.result.createObjectStore('assets', { keyPath: 'key' }) }
      request.onerror = () => { this.database = undefined; reject(request.error ?? new Error('ASSET_STAGING_OPEN_FAILED')) }
      request.onblocked = () => { this.database = undefined; reject(new Error('ASSET_STAGING_BLOCKED: Close an older workbench window and retry.')) }
      request.onsuccess = () => {
        const database = request.result
        database.onversionchange = () => { database.close(); this.database = undefined }
        resolve(database)
      }
    })
    return this.database
  }

  private async transact<T>(operation: (store: IDBObjectStore, records: StoredAsset[]) => T): Promise<T> {
    const database = await this.open()
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('assets', 'readwrite')
      const store = transaction.objectStore('assets')
      let result: T
      let failure: unknown
      transaction.oncomplete = () => { resolve(result) }
      transaction.onerror = () => { reject(failure ?? transaction.error ?? new Error('ASSET_STAGING_WRITE_FAILED')) }
      transaction.onabort = () => { reject(failure ?? transaction.error ?? new Error('ASSET_STAGING_ABORTED')) }
      const all = store.getAll(undefined, STAGED_ASSET_LIMITS.files + 1)
      all.onsuccess = () => {
        try {
          const active = all.result as StoredAsset[]
          if (active.length > STAGED_ASSET_LIMITS.files) throw new Error('ASSET_STAGING_QUOTA: Staging storage exceeds its bounded capacity.')
          result = operation(store, active)
        } catch (error) { failure = error; transaction.abort() }
      }
    })
  }

  /** Persist original bytes before a figure can be accepted into the document buffer. */
  async stage(scope: AssetStagingScope, input: { readonly name: string; readonly blob: Blob }): Promise<StagedAsset> {
    const scopeId = scopeKey(scope)
    if (input.blob.size === 0 || input.blob.size > STAGED_ASSET_LIMITS.fileBytes) throw new Error('ASSET_FILE_SIZE: Select a nonempty file of at most 16 MiB.')
    const bytes = new Uint8Array(await input.blob.arrayBuffer())
    const format = inspectAssetBytes(input.name, input.blob.type, bytes)
    const sha256 = await digest(bytes)
    const key = `${scopeId}:${sha256}`
    const createdAt = this.now()
    const stored: StoredAsset = { key, scopeKey: scopeId, id: sha256, name: input.name, path: stagedAssetPath(input.name, sha256),
      mime: format.mime, sha256, size: bytes.byteLength, createdAt,
      blob: input.blob, previewKind: format.previewKind }
    return this.transact((store, records) => {
      const existing = records.find(record => record.key === key)
      if (existing !== undefined) return publicAsset(existing)
      if (records.length >= STAGED_ASSET_LIMITS.files
        || records.reduce((size, record) => size + record.size, 0) + stored.size > STAGED_ASSET_LIMITS.totalBytes) {
        throw new Error('ASSET_STAGING_QUOTA: Keep at most 8 files and 32 MiB of pending assets. Discard unused assets before adding more.')
      }
      store.add(stored)
      return publicAsset(stored)
    })
  }

  /** Read current-scope assets; only explicit discard or a completed save releases their bytes. */
  async list(scope: AssetStagingScope): Promise<StagedAsset[]> {
    const key = scopeKey(scope)
    return this.transact((_store, records) => records.filter(record => record.scopeKey === key).map(publicAsset))
  }

  async read(scope: AssetStagingScope, id: string): Promise<StagedAsset | undefined> {
    return (await this.list(scope)).find(record => record.id === id)
  }

  /** Discard only the browser staging copy; committed project assets are never deleted. */
  async discard(scope: AssetStagingScope, id: string): Promise<void> {
    const key = scopeKey(scope)
    await this.transact((store, records) => {
      const record = records.find(value => value.scopeKey === key && value.id === id)
      if (record !== undefined) store.delete(record.key)
    })
  }

  /** Select staging bytes referenced by this buffer's parsed includegraphics commands. */
  async matching(scope: AssetStagingScope, source: string, sourcePath = ''): Promise<StagedAsset[]> {
    const document = parseLatexDocument(source, sourcePath)
    let relativeSource = sourcePath.replaceAll('\\', '/')
    if (/^(?:[A-Za-z]:|\/)/.test(relativeSource)) {
      const root = scope.workspaceRoot.replaceAll('\\', '/').replace(/\/$/, '')
      const insensitive = /^[A-Za-z]:/.test(root)
      if (!(insensitive ? relativeSource.toLowerCase().startsWith(root.toLowerCase() + '/') : relativeSource.startsWith(root + '/'))) throw new Error('ASSET_SOURCE_SCOPE')
      relativeSource = relativeSource.slice(root.length + 1)
    }
    const base = relativeSource.split('/').slice(0, -1).join('/')
    const candidates = new Set<string>()
    const paths = texCommands(source).filter(command => command.name === 'includegraphics' || command.name === 'includegraphics*').flatMap((command) => {
      const group = requiredTexGroup(source, command.to)
      return group === null ? [] : [source.slice(group.contentFrom, group.contentTo)]
    })
    for (const imagePath of paths) for (const directory of ['', ...document.graphicsPaths]) {
      const path = relativePath([base, directory, imagePath].filter(Boolean).join('/'))
      if (path !== undefined) candidates.add(path)
    }
    return (await this.list(scope)).filter(asset => candidates.has(asset.path) || candidates.has(asset.path.replace(/\.[^.]+$/, '')))
  }

  /** Release the connection; persisted records remain available after remount or restart. */
  async close(): Promise<void> {
    const database = this.database
    this.database = undefined
    if (database !== undefined) (await database).close()
  }
}

function relativePath(path: string): string | undefined {
  if (/^(?:[A-Za-z]:|\/|\\)/.test(path)) return undefined
  const parts: string[] = []
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') { if (parts.length === 0) return undefined; parts.pop() } else parts.push(part)
  }
  return parts.join('/')
}

/** Create a bounded-lifetime image/PDF preview; new EPS files require a separate visible preview. */
export function createStagedAssetPreview(asset: StagedAsset): StagedAssetPreview {
  if (asset.previewKind === 'unavailable') return { kind: 'unavailable', dispose() {} }
  const url = URL.createObjectURL(new Blob([asset.blob], { type: asset.mime }))
  return { kind: asset.previewKind, url, dispose() { URL.revokeObjectURL(url) } }
}

/** Read and verify exact bytes at the final save boundary; wire transport remains binary. */
export async function stagedAssetPayload(asset: StagedAsset): Promise<StagedAssetPayload> {
  if (asset.blob.size !== asset.size || asset.size > STAGED_ASSET_LIMITS.fileBytes || asset.size < 1) throw new Error('ASSET_STAGING_CORRUPT')
  const data = new Uint8Array(await asset.blob.arrayBuffer())
  inspectAssetBytes(asset.name, asset.mime, data)
  if (await digest(data) !== asset.sha256 || stagedAssetPath(asset.name, asset.sha256) !== asset.path) throw new Error('ASSET_STAGING_CORRUPT')
  return { path: asset.path, data, sha256: asset.sha256 }
}
