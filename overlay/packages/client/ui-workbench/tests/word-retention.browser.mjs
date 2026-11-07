/** Real IndexedDB retention enumeration and atomic failure checks, with synthetic scenes only. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'tsdown'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const evidence = path.resolve(process.argv[2])
const { chromium } = createRequire(path.join(repo, 'apps/web/package.json'))('playwright')
await mkdir(evidence, { recursive: true })
await build({ config: false, entry: { state: path.join(repo, 'packages/client/ui-workbench/src/client/workbench-state.ts') },
  outDir: path.join(evidence, 'bundle'), format: 'esm', platform: 'browser', dts: false, deps: { alwaysBundle: [/.*/] } })
const server = createServer(async (request, response) => {
  if (request.url === '/') {
    response.setHeader('content-type', 'text/html')
    response.end('<script type="module">window.api=await import("/state.js");window.ready=true</script>')
  } else if (/^\/[\w.-]+\.m?js$/.test(request.url)) {
    response.setHeader('content-type', 'text/javascript')
    response.end(await readFile(path.join(evidence, 'bundle', request.url.slice(1))))
  } else { response.writeHead(404); response.end() }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = 'http://127.0.0.1:' + server.address().port
const report = { passed: false, tests: [], browserErrors: [] }
let context
async function open() {
  context = await chromium.launchPersistentContext(path.join(evidence, 'profile'), { channel: 'msedge', headless: true })
  const page = context.pages()[0]
  page.on('pageerror', error => report.browserErrors.push(String(error)))
  await page.goto(url); await page.waitForFunction(() => window.ready)
  return page
}
try {
  let page = await open()
  report.tests.push(...await page.evaluate(async () => {
    const check = (v, m) => { if (!v) throw Error(m) }
    const { WorkbenchStateStore, workbenchStateKey } = window.api
    const make = (sessionId, workspaceRoot, mark) => ({
      version: 2, sessionId, workspaceRoot, updatedAt: Date.now(), mode: 'writing', focus: 'editor',
      activePaths: { writing: 'paper.docx', development: null }, panes: { writing: 'pdf', development: 'source' },
      mainFile: '', selection: null, instruction: '', selectionMode: 'assist', action: null, pdfPositions: {},
      buffers: [{ mode: 'writing', path: 'paper.docx', absolutePath: workspaceRoot + '/paper.docx', diskVersion: 'original',
        lineEnding: 'lf', revision: 2, selection: { from: 0, to: 0 }, scrollTop: 0, visualScrollTop: 0, pane: 'pdf',
        word: { snapshot: { id: 'a'.repeat(32), checkpoint: '2-' + 'b'.repeat(32), checkpointHash: 'c'.repeat(64),
          path: 'paper.docx', absolutePath: workspaceRoot + '/paper.docx', workspaceRoot, revision: 2, savedRevision: 0,
          checkpointTime: 1, diskVersion: 'original', projection: { text: mark, blocks: [], styles: [], canUndo: true, canRedo: false } },
          pending: { text: 'UNCONFIRMED-' + mark, document: '{}' }, proof: { revision: 1, version: 'd'.repeat(64) } } }],
    })
    const published = [], errors = []
    const owner = new WorkbenchStateStore(indexedDB, (records, sequence) => published.push({ records, sequence }), error => errors.push(error))
    for (let i = 0; i < 3; i++) owner.stage(make('session-' + i, 'D:/root-' + i, 'BASE-' + i))
    owner.stage(make('same-root-session', 'D:/root-0', 'OTHER'))
    await owner.flush(); await owner.retainCommitted()
    let last = published.at(-1)
    check(last.records.length === 4, 'all persisted scopes enumerated')
    check(last.records.every(r => r.buffers[0].word.pending.text.startsWith('UNCONFIRMED-')), 'pending bases included')
    check(last.records.every(r => r.buffers[0].word.proof.revision === 1), 'stale proofs included')
    owner.stage(make('session-0', 'D:/root-0', 'UNCOMMITTED'))
    await owner.retainCommitted()
    check(published.at(-1).records.find(r => r.sessionId === 'session-0').buffers[0].word.snapshot.projection.text === 'BASE-0',
      'in-memory pending state does not replace durable retain roots')
    owner.stage(make('session-1', 'D:/root-1', 'NEW'))
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function(value, key) {
      if (key === workbenchStateKey('session-1', 'D:/root-1')) throw new DOMException('Synthetic quota failure', 'QuotaExceededError')
      return put.call(this, value, key)
    }
    let failed = false
    try { await owner.flush() } catch { failed = true } finally { IDBObjectStore.prototype.put = put }
    check(failed, 'failed commit reported')
    await owner.retainCommitted()
    check(published.at(-1).sequence === last.sequence, 'failed transaction does not advance retention fence')
    check(published.at(-1).records.find(r => r.sessionId === 'session-0').buffers[0].word.snapshot.projection.text === 'BASE-0',
      'earlier write rolled back')
    await owner.flush(); await owner.retainCommitted()
    check(published.at(-1).sequence === last.sequence + 1, 'retry advances only after successful commit')
    const database = await new Promise(resolve => { const r = indexedDB.open('mrw.workbench.state.v1'); r.onsuccess = () => resolve(r.result) })
    await new Promise(resolve => {
      const tx = database.transaction('scenes', 'readwrite'); tx.objectStore('scenes').put({ version: 999 }, 'corrupt'); tx.oncomplete = resolve
    })
    const count = published.length
    await owner.retainCommitted()
    check(published.length === count && errors.length > 0, 'unknown scene suspends cleanup, never publishes a partial set')
    await owner.close(); database.close()
    return ['all four scenes across three roots enumerated', 'pending-input checkpoint and stale proof references retained',
      'only committed state reaches cleanup', 'quota failure keeps old scene and commit fence', 'retry commits retained work',
      'unreadable scene prevents partial or empty retain publication']
  }))
  await context.close(); context = undefined
  page = await open()
  report.tests.push(...await page.evaluate(async () => {
    const owner = new window.api.WorkbenchStateStore()
    const restored = await owner.load('session-0', 'D:/root-0')
    if (restored.buffers[0].word.pending.text !== 'UNCONFIRMED-UNCOMMITTED') throw Error('pending input restart')
    const inactive = await owner.load('session-2', 'D:/root-2')
    if (inactive.buffers[0].word.snapshot.projection.text !== 'BASE-2') throw Error('inactive scene restart')
    if (inactive.buffers[0].word.proof.revision !== 1) throw Error('stale proof restart')
    await owner.close()
    return ['real browser restart restores pending input', 'unvisited workspace and stale proof survive restart']
  }))
  assert.deepEqual(report.browserErrors, [])
  report.passed = true
} catch (error) { report.failure = String(error); throw error }
finally {
  if (context) await context.close()
  await new Promise(resolve => server.close(resolve))
  await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
