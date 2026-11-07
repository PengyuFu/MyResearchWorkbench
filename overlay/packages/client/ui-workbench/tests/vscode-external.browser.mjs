/** Real VS Code edits against the explicit DNAPL verification copy and a separately owned built Workbench Host. */
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1])
for (const name of ['--source-root', '--evidence-root', '--paper-manifest', '--vscode', '--expected-sha']) {
  assert.ok(args.get(name), 'Missing ' + name)
}
const source = path.resolve(args.get('--source-root'))
const evidence = path.resolve(args.get('--evidence-root'))
const codeExe = path.resolve(args.get('--vscode'))
const expectedSha = args.get('--expected-sha')
const manifest = JSON.parse(await readFile(args.get('--paper-manifest'), 'utf8'))
assert.equal(path.basename(manifest.copy), 'Workbench_0.5.0_验证副本')
assert.notEqual(path.resolve(manifest.copy).toLowerCase(), path.resolve(manifest.original).toLowerCase())
const mainPath = path.join(manifest.copy, manifest.main)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const initial = await readFile(mainPath)
assert.equal(sha(initial), expectedSha, 'Refuse a manuscript copy changed since the reviewed checkpoint')
const originalHashes = async () => Object.fromEntries(await Promise.all(manifest.files.map(async file => [
  file.relative, sha(await readFile(path.join(manifest.original, file.relative))),
])))
const originalExpected = Object.fromEntries(manifest.files.map(file => [file.relative, file.sha256]))
assert.deepEqual(await originalHashes(), originalExpected, 'Original input no longer matches protected baseline')
await mkdir(evidence, { recursive: false })
await writeFile(path.join(evidence, 'runner.mjs'), await readFile(new URL(import.meta.url)))
const knownDiskHashes = new Set([expectedSha])
const report = {
  startedAt: new Date().toISOString(), source, evidence, codeExe,
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8', windowsHide: true }).trim(),
  artifactSha256: sha(await readFile(path.join(source, 'packages/client/ui-workbench/lib/client.js'))),
  workspaceTrust: 'VS Code default, unchanged; no trust-disabling flag or setting',
  paper: { copy: manifest.copy, main: manifest.main, initialSha256: expectedSha, initialBytes: initial.length },
  hostMode: 'built dsh Web profile with test-only browse chooser and owned graceful-stop observer',
  transportSubstitution: false, modelRequestsInitiated: false, sourceWrites: false, checks: [], browserErrors: [],
}
const checkpoint = () => writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n')
await checkpoint()
const scrub = value => String(value).replace(/\u001b\[[0-9;]*m/g, '').replace(/https?:\/\/[^\s"'<>]+/g, value => {
  try { const url = new URL(value); return url.origin + url.pathname } catch { return '[url]' }
})
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (/(KEY|SECRET|TOKEN|PASSWORD|PROXY)/i.test(key)
    || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'DSH_HOME', 'DSH_AGENTS_HOME', 'MRW_DSH_HOME'].includes(key)) delete env[key]
}
const observer = path.join(evidence, 'owned-host-lifecycle.mjs')
await writeFile(observer, "export const name='vscode-smoke-stop';export function apply(ctx){const receive=x=>{if(x==='mrw-smoke-stop')process.emit('SIGTERM')};ctx.effect(()=>{process.on('message',receive);return()=>process.off('message',receive)})}\n")
const patch = path.join(evidence, 'owned-host.patch.json')
await writeFile(patch, JSON.stringify([
  { id: 'directory-picker', disabled: true },
  { insert: [
    { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
    { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
    { id: 'vscode-smoke-stop', name: pathToFileURL(observer).href },
  ] },
]) + '\n')
const host = spawn(process.execPath, [
  '--no-experimental-strip-types', path.join(source, 'apps/cli/lib/bin.js'), '--profile', 'web',
  '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open',
], {
  cwd: source, env: { ...env, DSH_HOME: path.join(evidence, 'home'), DSH_AGENTS_HOME: path.join(evidence, 'agent-home'),
    DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: 'keyless-external-editor-smoke' },
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
})
const log = createWriteStream(path.join(evidence, 'host.log'), { flags: 'wx' })
const ready = Promise.withResolvers(), hostExit = Promise.withResolvers()
let startup = '', hostClosed = false
const tails = new Map()
for (const [name, stream] of [['stdout', host.stdout], ['stderr', host.stderr]]) {
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    const combined = (tails.get(name) ?? '') + chunk
    const index = combined.lastIndexOf('\n')
    if (index >= 0) log.write(scrub(combined.slice(0, index + 1)))
    tails.set(name, combined.slice(index + 1))
    startup = (startup + chunk.replace(/\u001b\[[0-9;]*m/g, '')).slice(-100000)
    const match = /dsh web: (http:\/\/[^\s]+)/u.exec(startup)
    if (match) ready.resolve(match[1])
  })
}
host.once('error', error => ready.reject(error))
host.once('close', (code, signal) => {
  hostClosed = true
  hostExit.resolve({ code, signal })
  ready.reject(new Error('Owned Host closed before ready'))
})
const timeout = setTimeout(() => ready.reject(new Error('Owned Host startup timeout')), 120000)
const require = createRequire(path.join(source, 'apps/web/package.json'))
const { chromium, _electron } = require('playwright')
let browser, page, codeApp, codePage, sessionId, rpc
const poll = async (predicate, label, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  throw new Error(label)
}
const check = async (name, action) => {
  const started = Date.now()
  try {
    const detail = await action()
    report.checks.push({ name, status: 'passed', elapsedMs: Date.now() - started, detail })
    console.log(JSON.stringify({ name, status: 'passed' }))
  } catch (error) {
    report.checks.push({ name, status: 'failed', error: scrub(error.stack ?? error) })
    throw error
  } finally { await checkpoint() }
}
const bench = () => page.locator('[data-workbench]').first()
const editor = () => bench().locator('[data-workbench-editor]')
const codeEditor = () => editor().locator('.cm-content[contenteditable="true"]:visible')
const panelAction = async name => {
  await editor().getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}
const shot = async (target, name) => {
  await target.screenshot({ path: path.join(evidence, name + '.png') })
  return name + '.png'
}
const selectWorkspace = async () => {
  const previous = await bench().locator('[data-conversation-content]').first().getAttribute('data-conversation-session')
  const add = page.getByRole('button', { name: '添加工作区', exact: true })
  if (await add.isVisible()) await add.click()
  else {
    await page.getByRole('button', { name: '选择工作区', exact: true }).click()
    await page.getByRole('menuitem', { name: '添加工作区…', exact: true }).click()
  }
  const dialog = page.getByRole('dialog', { name: '选择工作区目录', exact: true })
  await dialog.getByRole('button', { name: '编辑路径', exact: true }).click()
  const input = dialog.getByRole('textbox', { name: '编辑路径', exact: true })
  await input.fill(manifest.copy)
  await input.press('Enter')
  await input.waitFor({ state: 'hidden' })
  await dialog.getByRole('button', { name: '打开', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  await poll(async () => {
    const current = await bench().locator('[data-conversation-content]').first().getAttribute('data-conversation-session')
    return Boolean(current) && current !== previous
  }, 'Workspace Session was not created')
  sessionId = await bench().locator('[data-conversation-content]').first().getAttribute('data-conversation-session')
  const viewButton = page.locator('[data-workbench-mode-selector]:visible').getByRole('button', { name: '工作视图', exact: true })
  const writingItem = page.getByRole('menuitem', { name: '写作', exact: true })
  await poll(async () => {
    if (await writingItem.isVisible()) return true
    if (await viewButton.getAttribute('aria-expanded') !== 'true') await viewButton.click()
    return await writingItem.isVisible()
  }, 'Writing menu did not remain open after the new Session mounted')
  await writingItem.click()
  const folder = editor().getByRole('region', { name: '文件', exact: true })
  if (!(await folder.isVisible())) await panelAction('文件')
  await folder.getByRole('button', { name: manifest.main, exact: true }).click()
  await editor().locator('.ProseMirror[contenteditable="true"]').waitFor({ timeout: 60000 })
  await panelAction('查看 TeX 源码')
  await codeEditor().waitFor()
}
const variants = (before, marker) => {
  const text = before.toString('utf8')
  const normalized = text.replaceAll('\r\n', '\n')
  return [
    Buffer.from(marker + '\n' + normalized),
    Buffer.from((marker + '\n' + normalized).replaceAll('\n', '\r\n')),
    Buffer.concat([Buffer.from(marker + '\n'), before]),
    Buffer.concat([Buffer.from(marker + '\r\n'), before]),
  ]
}
const registerVariants = (before, marker) => {
  const candidates = variants(before, marker)
  for (const value of candidates) knownDiskHashes.add(sha(value))
  return new Set(candidates.map(sha))
}
const stageCodePrefix = async marker => {
  await codePage.bringToFront()
  await codePage.keyboard.press('Escape')
  await codePage.mouse.move(5, 5)
  await codePage.keyboard.press('Control+1')
  await codePage.keyboard.press('Control+Home')
  await codePage.keyboard.insertText(marker + '\n')
}
const waitCodeSave = async (before, marker) => {
  const accepted = registerVariants(before, marker)
  await codePage.keyboard.press('Control+s')
  await poll(async () => accepted.has(sha(await readFile(mainPath))), 'VS Code save did not match the exact marker and permitted EOL variants')
  const after = await readFile(mainPath)
  return { bytes: after, detail: { beforeSha256: sha(before), afterSha256: sha(after),
    beforeBytes: before.length, afterBytes: after.length,
    normalizedMixedEndings: after.toString('utf8').endsWith(before.toString('utf8').replaceAll('\r\n', '\n'))
      && !after.toString('utf8').endsWith(before.toString('utf8')) } }
}
try {
  const url = await ready.promise
  clearTimeout(timeout)
  const auth = await fetch(url, { redirect: 'manual' })
  const cookie = auth.headers.getSetCookie()[0]?.split(';', 1)[0]
  assert.ok(cookie)
  rpc = async (method, methodArgs, expectSuccess = true) => {
    const rpcId = randomUUID()
    const response = await fetch(new URL('/api/' + method, url), {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: methodArgs } }),
      signal: AbortSignal.timeout(30000),
    })
    assert.equal(response.status, 200)
    const envelope = await response.json()
    assert.equal(envelope.rpcId, rpcId)
    if (expectSuccess) { assert.equal(envelope.result.ok, true); return envelope.result.value }
    return envelope.result
  }
  browser = await chromium.launchPersistentContext(path.join(evidence, 'edge-profile'), {
    channel: 'msedge', headless: false, locale: 'zh-CN', viewport: null, args: ['--start-maximized'],
  })
  page = browser.pages()[0] ?? await browser.newPage()
  page.on('pageerror', error => report.browserErrors.push(scrub(error)))
  page.setDefaultTimeout(15000)
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await bench().waitFor({ timeout: 90000 })
  const notice = page.getByRole('dialog', { name: '预览版说明', exact: true })
  if (await notice.isVisible()) await notice.getByRole('button', { name: '继续', exact: true }).click()
  await selectWorkspace()
  report.display = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
    screen: { width: screen.width, height: screen.height, availableWidth: screen.availWidth, availableHeight: screen.availHeight } }))
  codeApp = await _electron.launch({ executablePath: codeExe,
    args: ['--new-window', '--disable-extensions', '--skip-welcome', '--skip-release-notes', mainPath],
    env, timeout: 60000 })
  report.code = { ...await codeApp.evaluate(({ app }) => ({ version: app.getVersion(), userData: app.getPath('userData') })),
    pid: codeApp.process().pid }
  codePage = await codeApp.firstWindow()
  codePage.setDefaultTimeout(15000)
  await codePage.locator('.monaco-workbench').waitFor({ timeout: 60000 })
  const restricted = codePage.getByRole('button', { name: /(?:Open in Restricted Mode|No, I don't trust the authors)/i })
  if (await restricted.isVisible()) { await restricted.click(); report.restrictedModeSelected = true }
  await codePage.getByRole('tab', { name: new RegExp(manifest.main.replace(/[.*+?^$()|[\]\\]/g, '\\$&')) }).waitFor({ timeout: 60000 })
  let cleanBytes
  const cleanMarker = '% MRW_VSCODE_EXTERNAL_CLEAN_' + randomUUID()
  await check('actual VS Code save reloads a clean Workbench buffer', async () => {
    await stageCodePrefix(cleanMarker)
    const saved = await waitCodeSave(initial, cleanMarker)
    cleanBytes = saved.bytes
    await page.bringToFront()
    await poll(async () => (await codeEditor().innerText()).includes(cleanMarker), 'Workbench clean buffer did not reload external VS Code changes')
    assert.equal(await editor().getByRole('alert').filter({ hasText: '文件已被其他程序修改' }).count(), 0)
    return { ...saved.detail, workbenchScreenshot: await shot(page, 'clean-workbench'), codeScreenshot: await shot(codePage, 'clean-vscode') }
  })
  await check('actual VS Code external save preserves a dirty Workbench buffer and rejects stale CAS', async () => {
    const before = await rpc('workbenchWorkspace/read', { workspaceFileScopeId: sessionId, path: manifest.main })
    const externalMarker = '% MRW_VSCODE_EXTERNAL_DIRTY_' + randomUUID()
    const localMarker = '% MRW_WORKBENCH_DIRTY_' + randomUUID()
    await stageCodePrefix(externalMarker)
    registerVariants(cleanBytes, localMarker)
    await page.bringToFront()
    await codeEditor().click()
    await page.keyboard.press('Control+Home')
    await page.keyboard.insertText(localMarker + '\n')
    const dirtyAt = Date.now()
    await codePage.bringToFront()
    const external = await waitCodeSave(cleanBytes, externalMarker)
    const externalSaveAfterDirtyMs = Date.now() - dirtyAt
    await page.bringToFront()
    await poll(async () => await editor().getByRole('alert').filter({ hasText: '文件已被其他程序修改' }).isVisible(),
      'Workbench did not preserve and flag the dirty external-change conflict')
    assert.ok((await codeEditor().innerText()).includes(localMarker), 'Local unsaved text was lost')
    assert.equal((await readFile(mainPath, 'utf8')).includes(localMarker), false, 'Local autosave overwrote the external editor')
    await panelAction('保存')
    assert.equal(sha(await readFile(mainPath)), sha(external.bytes), 'Conflict Save changed the external file')
    const stale = await rpc('workbenchWorkspace/save', { workspaceFileScopeId: sessionId, request: {
      path: manifest.main, expectedPath: mainPath, version: before.version, text: localMarker + '\n' + before.text,
    } }, false)
    assert.equal(stale.ok, false)
    assert.equal(stale.error?.code, 'workbench/conflict')
    assert.equal(sha(await readFile(mainPath)), sha(external.bytes), 'Stale CAS mutated the external file')
    await editor().getByRole('button', { name: '与磁盘比较', exact: true }).click()
    await editor().getByText('磁盘内容', { exact: true }).waitFor()
    assert.ok((await editor().locator('pre').innerText()).includes(externalMarker))
    const screenshot = await shot(page, 'dirty-conflict-and-comparison')
    await editor().getByRole('button', { name: '采用磁盘内容', exact: true }).click()
    await editor().getByText('用磁盘内容替换当前未保存内容？', { exact: true }).waitFor()
    await editor().getByRole('button', { name: '采用磁盘内容', exact: true }).click()
    await poll(async () => !(await codeEditor().innerText()).includes(localMarker), 'Confirmed disk reload did not discard the owned test draft')
    return { ...external.detail, externalSaveAfterDirtyMs, localDraftRetained: true,
      staleCasCode: stale.error.code, externalBytesPreserved: true, screenshot }
  })
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = scrub(error.stack ?? error); process.exitCode = 1
  if (page) {
    await shot(page, 'workbench-failure').catch(() => {})
    await writeFile(path.join(evidence, 'workbench-failure.aria.yml'), await page.locator('body').ariaSnapshot().catch(() => '(unavailable)'))
  }
  if (codePage) {
    await shot(codePage, 'vscode-failure').catch(() => {})
    await writeFile(path.join(evidence, 'vscode-failure.aria.yml'), await codePage.locator('body').ariaSnapshot().catch(() => '(unavailable)'))
  }
} finally {
  clearTimeout(timeout)
  if (codeApp) await codeApp.close().catch(error => { report.codeCloseError = scrub(error); process.exitCode = 1 })
  await browser?.close()
  report.paper.currentBeforeRestoreSha256 = sha(await readFile(mainPath))
  if (knownDiskHashes.has(report.paper.currentBeforeRestoreSha256) && sha(initial) === expectedSha) {
    if (report.paper.currentBeforeRestoreSha256 !== expectedSha) await writeFile(mainPath, initial)
    report.paper.restoredSha256 = sha(await readFile(mainPath))
    report.paper.restoredExact = report.paper.restoredSha256 === expectedSha
  } else {
    report.paper.restoreBlocked = 'Current bytes do not match any owned, exact intended edit; preserved for review'
    report.status = 'failed'; process.exitCode = 1
  }
  report.paper.originalInputHashesAfter = await originalHashes()
  report.paper.originalUnchanged = JSON.stringify(report.paper.originalInputHashesAfter) === JSON.stringify(originalExpected)
  if (!report.paper.originalUnchanged || !report.paper.restoredExact) { report.status = 'failed'; process.exitCode = 1 }
  let forced = false
  const force = setTimeout(() => { if (!hostClosed) { forced = true; host.kill('SIGKILL') } }, 15000)
  if (!hostClosed && host.connected) host.send('mrw-smoke-stop')
  else if (!hostClosed) { forced = true; host.kill('SIGKILL') }
  report.hostExit = { ...await hostExit.promise, forced }
  clearTimeout(force)
  if (forced || report.hostExit.code !== 0 || report.hostExit.signal !== null) { report.status = 'failed'; process.exitCode = 1 }
  for (const tail of tails.values()) if (tail) log.write(scrub(tail))
  await new Promise(resolve => log.end(resolve))
  report.finishedAt = new Date().toISOString()
  await checkpoint()
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, report: path.join(evidence, 'report.json') }))
}
