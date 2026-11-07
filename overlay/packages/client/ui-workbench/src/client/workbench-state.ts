/** One application-owned IndexedDB writer for complete workbench scenes. */
import { isWorkbenchRecord, type WorkbenchRecord } from './buffer-persistence.ts'

/** Controller-facing persistence; all controllers share one application instance. */
export interface WorkbenchPersistence {
  load(sessionId: string, workspaceRoot: string): Promise<WorkbenchRecord | null>
  stage(record: WorkbenchRecord): void
  flush(): Promise<void>
}

/** Structured durable-state failure; old records are never cleared by an error. */
export class WorkbenchStateError extends Error {
  override readonly name = 'WorkbenchStateError'
  constructor(readonly kind: 'invalid-record' | 'storage-failed', options?: ErrorOptions) {
    super(kind, options)
  }
}

/** Original scope identity; slash normalization follows the Host-returned root.
 * @param sessionId - original Session.
 * @param workspaceRoot - Host-confirmed normalized root.
 * @returns an unambiguous storage key.
 */
export function workbenchStateKey(sessionId: string, workspaceRoot: string): string {
  return JSON.stringify([sessionId, workspaceRoot])
}

/** Atomic writes retain untouched sessions, including scenes never visited this launch. */
export class WorkbenchStateStore implements WorkbenchPersistence {
  private database: Promise<IDBDatabase> | undefined
  private readonly pending = new Map<string, WorkbenchRecord>()
  private flight: Promise<void> | undefined
  private foreground: { sessionId: string; workspaceRoot: string } | undefined
  private foregroundRevision = 0
  private savedForegroundRevision = 0

  /** @param factory - the current renderer's IndexedDB factory.
   * @param committed - complete durable scenes, delivered independently of maintenance I/O.
   * @param retentionError - diagnostic owner; enumeration failure never means an empty scene set.
   */
  constructor(private readonly factory: IDBFactory = indexedDB,
    private readonly committed?: (records: readonly WorkbenchRecord[], sequence: number) => void,
    private readonly retentionError?: (error: unknown) => void) {}

  private open(): Promise<IDBDatabase> {
    if (this.database !== undefined) return this.database
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory.open('mrw.workbench.state.v1', 1)
      request.onupgradeneeded = () => { request.result.createObjectStore('scenes') }
      request.onerror = () => reject(new WorkbenchStateError('storage-failed', { cause: request.error }))
      request.onblocked = () => reject(new WorkbenchStateError('storage-failed'))
      request.onsuccess = () => resolve(request.result)
    })
    this.database = opening.catch((error: unknown) => { this.database = undefined; throw error })
    return this.database
  }

  async load(sessionId: string, workspaceRoot: string): Promise<WorkbenchRecord | null> {
    const key = workbenchStateKey(sessionId, workspaceRoot)
    const staged = this.pending.get(key)
    if (staged !== undefined) return staged
    const database = await this.open()
    const value = await new Promise<unknown>((resolve, reject) => {
      const transaction = database.transaction('scenes', 'readonly')
      const request = transaction.objectStore('scenes').get(key)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(new WorkbenchStateError('storage-failed', { cause: request.error }))
    })
    if (value === undefined) return null
    if (!isWorkbenchRecord(value) || value.sessionId !== sessionId || value.workspaceRoot !== workspaceRoot) {
      throw new WorkbenchStateError('invalid-record')
    }
    return value
  }

  stage(record: WorkbenchRecord): void {
    this.pending.set(workbenchStateKey(record.sessionId, record.workspaceRoot), record)
  }

  /** Save the visible scope separately from retained editing scenes.
   * @param sessionId - original visible Session.
   * @param workspaceRoot - Host-confirmed normalized root.
   */
  setForeground(sessionId: string, workspaceRoot: string): void {
    if (this.foreground?.sessionId === sessionId && this.foreground.workspaceRoot === workspaceRoot) return
    this.foreground = { sessionId, workspaceRoot }
    this.foregroundRevision++
  }

  flush(): Promise<void> {
    if (this.flight !== undefined) return this.flight
    const operation = this.commit().finally(() => { if (this.flight === operation) this.flight = undefined })
    this.flight = operation
    return operation
  }

  private async commit(): Promise<void> {
    if (this.pending.size === 0 && this.foregroundRevision === this.savedForegroundRevision) return
    const database = await this.open()
    while (this.pending.size > 0 || this.foregroundRevision !== this.savedForegroundRevision) {
      const batch = new Map(this.pending)
      const foreground = this.foreground
      const revision = this.foregroundRevision
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('scenes', 'readwrite', { durability: 'strict' })
        let failure: unknown
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(new WorkbenchStateError('storage-failed', { cause: failure ?? transaction.error }))
        transaction.onerror = () => { /* The abort event owns the failed transaction result. */ }
        const store = transaction.objectStore('scenes')
        const previous = store.get('commit')
        previous.onsuccess = () => {
          const marker: unknown = previous.result
          const sequence = typeof marker === 'object' && marker !== null && 'sequence' in marker
            && typeof marker.sequence === 'number' && Number.isSafeInteger(marker.sequence) ? marker.sequence + 1 : 1
          try {
            for (const [key, record] of batch) store.put(record, key)
            if (foreground !== undefined) store.put(foreground, 'foreground')
            store.put({ sequence, updatedAt: Date.now() }, 'commit')
          } catch (error) {
            // A synchronous clone/quota failure must also roll back earlier puts in this batch.
            failure = error
            transaction.abort()
          }
        }
      })
      for (const [key, record] of batch) if (this.pending.get(key) === record) this.pending.delete(key)
      this.savedForegroundRevision = revision
    }
    void this.retainCommitted()
  }

  /** Enumerate every committed scene, including unvisited Sessions and Workspaces.
   * Pending in-memory drafts are excluded; their checkpoint base remains in the durable scene
   * and the worker separately pins every checkpoint newer than that acknowledged boundary.
   */
  async retainCommitted(): Promise<void> {
    if (this.committed === undefined) return
    try {
      const database = await this.open()
      const { records, sequence } = await new Promise<{ records: WorkbenchRecord[]; sequence: number }>((resolve, reject) => {
        const transaction = database.transaction('scenes', 'readonly')
        const records: WorkbenchRecord[] = []
        let sequence = 0
        let failure: unknown
        transaction.oncomplete = () => resolve({ records, sequence })
        transaction.onabort = () => reject(new WorkbenchStateError('storage-failed', { cause: failure ?? transaction.error }))
        transaction.onerror = () => { /* The abort owns the failure; no partial enumeration is published. */ }
        const cursor = transaction.objectStore('scenes').openCursor()
        cursor.onsuccess = () => {
          const entry = cursor.result
          if (entry === null) return
          const value: unknown = entry.value
          if (entry.key === 'commit') {
            if (typeof value === 'object' && value !== null && 'sequence' in value
              && typeof value.sequence === 'number' && Number.isSafeInteger(value.sequence)) sequence = value.sequence
            else { failure = new WorkbenchStateError('invalid-record'); transaction.abort(); return }
          } else if (entry.key !== 'foreground') {
            if (!isWorkbenchRecord(value) || entry.key !== workbenchStateKey(value.sessionId, value.workspaceRoot)) {
              failure = new WorkbenchStateError('invalid-record'); transaction.abort(); return
            }
            records.push(value)
          }
          entry.continue()
        }
      })
      this.committed(records, sequence)
    } catch (error) { this.retentionError?.(error) }
  }

  /** Wait for durable writes before releasing this renderer's connection.
   * @returns completion; a failed commit remains a failure.
   */
  async close(): Promise<void> {
    await this.flush()
    if (this.database !== undefined) (await this.database).close()
  }
}
