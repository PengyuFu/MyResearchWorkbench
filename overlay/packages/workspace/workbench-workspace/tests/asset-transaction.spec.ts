/** Real temporary-filesystem checks for partial asset groups and their recovery journal. */
import { createHash, randomUUID } from 'node:crypto'
import { access, appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AssetTransactionError, commitAssetGroup, readAssetTransactions, validateAssetPayloads } from '../src/asset-transaction.ts'
import type { AssetCommitRequest, AssetTransactionCallbacks } from '../src/asset-transaction.ts'

const roots: string[] = []
const signal = () => new AbortController().signal
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex')
function payload(suffix = '') {
  const data = Buffer.from('%PDF-1.4\n% Synthetic asset ' + suffix + '\n%%EOF\n')
  const sha256 = hash(data)
  return { data, sha256, path: `figures/workbench/fixture-${sha256.slice(0, 8)}.pdf` }
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mrw-asset-transaction-'))
  roots.push(root)
  const original = '% Synthetic document\nOriginal.\n'
  const target = path.join(root, 'main.tex')
  await writeFile(target, original, 'utf8')
  const asset = payload()
  const request: AssetCommitRequest = { sourcePath: 'main.tex', text: original + `\\includegraphics{${asset.path}}\n`, expectedVersion: hash(original), assets: [asset] }
  const callbacks: AssetTransactionCallbacks<{ version: string }> = {
    localRoot: root,
    async resolvePath(relative) { return path.join(root, ...relative.split('/')) },
    async preflightDocument() { if (hash(await readFile(target)) !== request.expectedVersion) throw new Error('DOCUMENT_CAS_CONFLICT') },
    async commitDocument() { await callbacks.preflightDocument(signal()); await writeFile(target, request.text, 'utf8'); return { version: hash(request.text) } },
  }
  return { root, original, target, asset, request, callbacks }
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('asset group save', () => {
  it('writes exact bytes exclusively, then the document CAS, and records the committed outcome', async () => {
    const f = await fixture()
    const outcome = await commitAssetGroup(f.request, f.callbacks, signal())
    expect(await readFile(path.join(f.root, f.asset.path))).toEqual(f.asset.data)
    expect(await readFile(f.target, 'utf8')).toBe(f.request.text)
    expect(outcome.created).toEqual([f.asset.path])
    expect(outcome.reused).toEqual([])
    const history = await readAssetTransactions(f.callbacks, signal())
    expect(history.records[0]?.phase).toBe('document-committed')
    expect(history.activeLock).toBeUndefined()
    expect(history.issues).toEqual([])
  })

  it('reuses only byte-identical existing assets and rejects a collision before any document write', async () => {
    const f = await fixture()
    await mkdir(path.join(f.root, 'figures/workbench'), { recursive: true })
    await writeFile(path.join(f.root, f.asset.path), f.asset.data)
    const outcome = await commitAssetGroup(f.request, f.callbacks, signal())
    expect(outcome.created).toEqual([])
    expect(outcome.reused).toEqual([f.asset.path])
    const g = await fixture()
    await mkdir(path.join(g.root, 'figures/workbench'), { recursive: true })
    await writeFile(path.join(g.root, g.asset.path), 'previous unrelated bytes')
    await expect(commitAssetGroup(g.request, g.callbacks, signal())).rejects.toThrow('ASSET_TARGET_EXISTS')
    expect(await readFile(g.target, 'utf8')).toBe(g.original)
    expect(await readFile(path.join(g.root, g.asset.path), 'utf8')).toBe('previous unrelated bytes')
  })

  it('preflights the complete group so a later collision cannot leave an earlier asset behind', async () => {
    const f = await fixture(), second = payload('second')
    await mkdir(path.join(f.root, 'figures/workbench'), { recursive: true })
    await writeFile(path.join(f.root, second.path), 'existing different data')
    await expect(commitAssetGroup({ ...f.request, assets: [f.asset, second] }, f.callbacks, signal())).rejects.toThrow('ASSET_TARGET_EXISTS')
    await expect(access(path.join(f.root, f.asset.path))).rejects.toThrow()
    expect(await readFile(f.target, 'utf8')).toBe(f.original)
  })

  it('rolls back only its unchanged created files when the document writer fails before changing source', async () => {
    const f = await fixture()
    f.callbacks.commitDocument = async () => { throw new Error('SIMULATED_WRITE_FAILURE') }
    const failure = await commitAssetGroup(f.request, f.callbacks, signal()).catch(error => error)
    expect(failure).toBeInstanceOf(AssetTransactionError)
    expect(failure.residualPaths).toEqual([])
    expect(failure.documentCommitted).toBe(false)
    await expect(access(path.join(f.root, f.asset.path))).rejects.toThrow()
    expect(await readFile(f.target, 'utf8')).toBe(f.original)
    expect((await readAssetTransactions(f.callbacks, signal())).records[0]?.phase).toBe('rolled-back')
  })

  it('retains and reports externally modified assets instead of deleting another writer’s bytes', async () => {
    const f = await fixture()
    f.callbacks.commitDocument = async () => { await writeFile(path.join(f.root, f.asset.path), 'external update'); throw new Error('WRITE_FAILURE') }
    const failure = await commitAssetGroup(f.request, f.callbacks, signal()).catch(error => error)
    expect(failure.residualPaths).toEqual([f.asset.path])
    expect(await readFile(path.join(f.root, f.asset.path), 'utf8')).toBe('external update')
    expect((await readAssetTransactions(f.callbacks, signal())).records[0]?.phase).toBe('needs-recovery')
  })

  it('retains created assets when a changed source makes rollback ownership uncertain', async () => {
    const f = await fixture()
    f.callbacks.commitDocument = async () => { await writeFile(f.target, 'External source including the new figure.'); throw new Error('DOCUMENT_CAS_CONFLICT') }
    const failure = await commitAssetGroup(f.request, f.callbacks, signal()).catch(error => error)
    expect(failure.residualPaths).toEqual([f.asset.path])
    expect(await readFile(f.target, 'utf8')).toContain('External source')
    expect(await readFile(path.join(f.root, f.asset.path))).toEqual(f.asset.data)
  })

  it('rejects stale document state, unsafe paths, tampered content and remote providers before asset creation', async () => {
    const f = await fixture()
    await writeFile(f.target, 'External version')
    await expect(commitAssetGroup(f.request, f.callbacks, signal())).rejects.toThrow('DOCUMENT_CAS_CONFLICT')
    await expect(access(path.join(f.root, 'figures'))).rejects.toThrow()
    expect(() => validateAssetPayloads([{ ...f.asset, path: '../escape.pdf' }])).toThrow('ASSET_PATH')
    expect(() => validateAssetPayloads([{ ...f.asset, data: Buffer.from('%PDF-1.4\nchanged') }])).toThrow('ASSET_HASH')
    await expect(commitAssetGroup(f.request, { ...f.callbacks, localRoot: 'ssh://other-host/project' }, signal())).rejects.toThrow('ASSET_LOCAL_ONLY')
  })

  it('refuses symbolic-link parents and an existing transaction lock without overwriting either', async () => {
    const f = await fixture(), other = await fixture()
    await symlink(other.root, path.join(f.root, 'figures'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(commitAssetGroup(f.request, f.callbacks, signal())).rejects.toThrow('ASSET_SYMLINK')
    expect(await readFile(other.target, 'utf8')).toBe(other.original)
    const g = await fixture()
    await mkdir(path.join(g.root, '.mrw-build/asset-transactions'), { recursive: true })
    const lock = path.join(g.root, '.mrw-build/asset-transactions/active.lock')
    await writeFile(lock, 'existing recovery lock')
    await expect(commitAssetGroup(g.request, g.callbacks, signal())).rejects.toThrow('ASSET_TRANSACTION_BUSY')
    expect(await readFile(lock, 'utf8')).toBe('existing recovery lock')
  })

  it('bounds directory metadata and journal count without hiding an active lock', async () => {
    const f = await fixture(), outcome = await commitAssetGroup(f.request, f.callbacks, signal())
    const record = (await readAssetTransactions(f.callbacks, signal())).records[0]!
    const directory = path.dirname(outcome.recoveryLog)
    await Promise.all(Array.from({ length: 70 }, async () => {
      const transactionId = randomUUID()
      await writeFile(path.join(directory, transactionId + '.jsonl'), JSON.stringify({ ...record, transactionId }) + '\n')
    }))
    const lock = path.join(directory, 'active.lock')
    await writeFile(lock, 'an interrupted save retained for explicit review')
    const history = await readAssetTransactions(f.callbacks, signal())
    expect(history.records).toHaveLength(64)
    expect(history.truncated).toBe(true)
    expect(history.activeLock).toBe(lock)
    expect(await readFile(lock, 'utf8')).toContain('interrupted save')
    const g = await fixture(), unrelated = path.join(g.root, '.mrw-build/asset-transactions')
    await mkdir(unrelated, { recursive: true })
    await Promise.all(Array.from({ length: 280 }, async (_, index) => { await writeFile(path.join(unrelated, `unrelated-${index}.txt`), '') }))
    expect((await readAssetTransactions(g.callbacks, signal())).truncated).toBe(true)
  })

  it('recovers the last complete bounded journal record while reporting an interrupted tail', async () => {
    const f = await fixture(), outcome = await commitAssetGroup(f.request, f.callbacks, signal())
    await appendFile(outcome.recoveryLog, '{"unfinished":')
    const history = await readAssetTransactions(f.callbacks, signal())
    expect(history.records[0]?.phase).toBe('document-committed')
    expect(history.issues[0]).toContain('incomplete final record')
    await appendFile(outcome.recoveryLog, 'x'.repeat(128 * 1024))
    const bounded = await readAssetTransactions(f.callbacks, signal())
    expect(bounded.records).toHaveLength(0)
    expect(bounded.issues[0]).toContain('ASSET_TARGET_INVALID')
  })
})
