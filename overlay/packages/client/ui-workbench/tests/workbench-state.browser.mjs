/**
 * Real IndexedDB crash-checkpoint and atomic-failure proof with synthetic records only.
 * Runs the product writer in isolated Edge; no application profile or credentials are read.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'tsdown'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const evidence = path.resolve(process.argv[2] ?? path.join(repo, '.tmp/workbench-state-browser'))
const { chromium } = createRequire(path.join(repo, 'apps/web/package.json'))('playwright')
const bundle = path.join(evidence, 'bundle')
await mkdir(bundle, { recursive: true })
await build({ config: false, entry: {
  state: path.join(repo, 'packages/client/ui-workbench/src/client/workbench-state.ts'),
  assets: path.join(repo, 'packages/client/ui-workbench/src/client/asset-staging.ts'),
}, outDir: bundle, format: 'esm', platform: 'browser', dts: false, deps: { alwaysBundle: [/.*/] } })
const server = createServer(async (request, response) => {
  const name = new URL(request.url ?? '/', 'http://localhost').pathname.slice(1)
  if (name === '') {
    response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' })
    response.end('<!doctype html><title>MRW synthetic durable checkpoints</title><script type="module">window.api=await import("/state.js");window.assets=await import("/assets.js");window.ready=true</script>')
  } else if (/^[\w.-]+\.(m?js)$/.test(name)) {
    try { const bytes = await readFile(path.join(bundle, name)); response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(bytes) }
    catch { response.writeHead(404); response.end() }
  } else { response.writeHead(404); response.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = 'http://127.0.0.1:' + server.address().port
const report = { startedAt: new Date().toISOString(), syntheticOnly: true, tests: [], browserErrors: [] }
let context
const open = async () => {
  context = await chromium.launchPersistentContext(path.join(evidence, 'profile'), { channel: 'msedge', headless: true })
  const page = context.pages()[0] ?? await context.newPage()
  page.on('pageerror', error => report.browserErrors.push(String(error)))
  await page.goto(url); await page.waitForFunction(() => window.ready)
  return page
}
try {
  let page = await open()
  report.tests.push(...await page.evaluate(async () => {
    const { WorkbenchStateStore, workbenchStateKey } = window.api
    const check = (value, label) => { if (!value) throw Error(label) }
    const make = (sessionId, workspaceRoot, mark) => ({
      version: 1, sessionId, workspaceRoot, updatedAt: Date.now() - 40 * 86400000,
      mode: 'chat', focus: 'chat', activePaths: { writing: 'notes.txt', development: 'file13.py' },
      panes: { writing: 'source', development: 'source' }, mainFile: '', selection: null,
      instruction: 'SYNTHETIC_ASSIST_' + mark, selectionMode: 'assist', action: null, pdfPositions: {},
      buffers: Array.from({ length: 14 }, (_, index) => ({
        mode: index === 0 ? 'writing' : 'development',
        path: index === 0 ? 'notes.txt' : 'file' + index + '.py',
        absolutePath: workspaceRoot + '/' + (index === 0 ? 'notes.txt' : 'file' + index + '.py'),
        diskVersion: 'synthetic-base', lineEnding: 'lf', revision: 1,
        selection: { from: 2, to: 7 }, scrollTop: 800, visualScrollTop: 430, pane: 'source',
        ...(index === 0 ? { visualState: 'SYNTHETIC'.repeat(10000), draft: { text: mark + 'x'.repeat(1024 * 1024),
          savedText: 'SYNTHETIC_BASE', savedRawText: 'SYNTHETIC_BASE' } } : {}),
      })),
    })
    const store = new WorkbenchStateStore()
    for (let index = 0; index < 10; index++) store.stage(make('session-' + index, '/scope-' + index, 'DRAFT_' + index))
    store.stage(make('other-session', '/scope-0', 'OTHER_DRAFT'))
    store.setForeground('session-0', '/scope-0')
    await store.flush()
    for (let index = 0; index < 10; index++) {
      const scene = await store.load('session-' + index, '/scope-' + index)
      check(scene.buffers.length === 14 && scene.buffers[0].draft.text.length > 1024 * 1024, 'complete large draft')
      check(scene.buffers[0].visualState.length > 65536, 'complete metadata')
      check(scene.updatedAt < Date.now() - 30 * 86400000, 'old record retained')
    }
    check((await store.load('other-session', '/scope-0')).buffers[0].draft.text.startsWith('OTHER_DRAFT'), 'same-root session isolation')
    check(await store.load('session-0', '/other-root') === null, 'workspace isolation')
    // Force a synchronous failure after an earlier put in the same real transaction.
    const rawDatabase = await new Promise((resolve, reject) => {
      const request = indexedDB.open('mrw.workbench.state.v1')
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    const raw = key => new Promise((resolve, reject) => {
      const request = rawDatabase.transaction('scenes').objectStore('scenes').get(key)
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
    })
    const originalA = await raw(workbenchStateKey('session-0', '/scope-0'))
    const originalB = await raw(workbenchStateKey('session-1', '/scope-1'))
    const marker = await raw('commit')
    store.stage(make('session-0', '/scope-0', 'NEW_A'))
    store.stage(make('session-1', '/scope-1', 'NEW_B'))
    const put = IDBObjectStore.prototype.put
    let failed = false
    IDBObjectStore.prototype.put = function(value, key) {
      if (key === workbenchStateKey('session-1', '/scope-1')) throw new DOMException('Synthetic quota fault', 'QuotaExceededError')
      return put.call(this, value, key)
    }
    try { await store.flush() } catch (error) { failed = error.kind === 'storage-failed' }
    finally { IDBObjectStore.prototype.put = put }
    check(failed, 'failure reported')
    check(JSON.stringify(await raw(workbenchStateKey('session-0', '/scope-0'))) === JSON.stringify(originalA), 'earlier put rolled back')
    check(JSON.stringify(await raw(workbenchStateKey('session-1', '/scope-1'))) === JSON.stringify(originalB), 'second old scene retained')
    check((await raw('commit')).sequence === marker.sequence, 'failed checkpoint not acknowledged')
    await store.flush()
    check((await raw('commit')).sequence === marker.sequence + 1, 'successful retry has one commit')
    check((await raw(workbenchStateKey('session-0', '/scope-0'))).buffers[0].draft.text.startsWith('NEW_A'), 'retry writes retained in-memory work')
    const corruptKey = workbenchStateKey('corrupt-session', '/corrupt')
    await new Promise((resolve, reject) => {
      const transaction = rawDatabase.transaction('scenes', 'readwrite')
      transaction.objectStore('scenes').put({ version: 999, marker: 'PRESERVE' }, corruptKey)
      transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error)
    })
    let invalid = false
    try { await store.load('corrupt-session', '/corrupt') } catch (error) { invalid = error.kind === 'invalid-record' }
    check(invalid && (await raw(corruptKey)).marker === 'PRESERVE', 'corrupt scene retained and reported')
    await store.close(); rawDatabase.close()
    const assets = new window.assets.WorkbenchAssetStaging(indexedDB, () => Date.now() - 40 * 86400000)
    const asset = await assets.stage({ sessionId: 'session-0', workspaceRoot: '/scope-0' },
      { name: 'retained.png', blob: new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }) })
    window.assetId = asset.id
    await assets.close()
    return ['14 tabs per scene, 11 original sessions, 10 roots, 40-day records and >1 MiB drafts retained',
      'same-root sessions and different roots isolated', 'quota fault rolls back all prior puts and commit marker',
      'successful retry commits retained work', 'corrupt record remains intact']
  }))
  await context.close(); context = undefined
  page = await open()
  report.tests.push(...await page.evaluate(async () => {
    const store = new window.api.WorkbenchStateStore()
    const scene = await store.load('session-0', '/scope-0')
    if (!scene.buffers[0].draft.text.startsWith('NEW_A') || scene.buffers.length !== 14) throw Error('real profile restart')
    // A foreground-only subsequent launch must not evict untouched scenes.
    store.setForeground('session-0', '/scope-0'); await store.flush()
    const hidden = await store.load('session-9', '/scope-9')
    if (!hidden.buffers[0].draft.text.startsWith('DRAFT_9')) throw Error('unvisited scene was lost')
    const assets = new window.assets.WorkbenchAssetStaging()
    if ((await assets.list({ sessionId: 'session-0', workspaceRoot: '/scope-0' })).length !== 1) throw Error('old referenced asset lost')
    await store.close(); await assets.close()
    return ['real Edge process/profile restart restores complete drafts', 'unvisited records survive later foreground-only flush',
      'staged resource survives forty days and process restart']
  }))
  assert.deepEqual(report.browserErrors, [])
  report.passed = true
} catch (error) {
  report.passed = false; report.failure = String(error); throw error
} finally {
  if (context) await context.close()
  await new Promise(resolve => server.close(resolve))
  report.finishedAt = new Date().toISOString()
  await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: report.passed, checks: report.tests.length, evidence }))
}
