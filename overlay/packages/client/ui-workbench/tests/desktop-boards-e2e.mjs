/**
 * Packaged MRW 0.5.3 board isolation acceptance; manual editing, no external model calls.
 * Reuses the owned-app/native-picker lifecycle from verify-desktop-recovery.mjs
 * and the real geometry checks from glass-host-e2e.mjs. All documents are synthetic.
 * Device-scale switches affect only each isolated application launch, never Windows DPI.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'

const { values: args } = parseArgs({ options: {
  'source-root': { type: 'string' }, exe: { type: 'string' },
  'evidence-dir': { type: 'string' }, 'native-helper': { type: 'string' },
  'folder-helper': { type: 'string' },
  'expected-version': { type: 'string', default: '0.5.3' },
  scales: { type: 'string', default: 'native' },
  latexmk: { type: 'string' }, 'perl-directory': { type: 'string' },
  'prepare-only': { type: 'boolean', default: false },
} })
for (const name of ['source-root', 'exe', 'evidence-dir', 'native-helper']) {
  assert.ok(args[name] && path.isAbsolute(args[name]), 'Absolute --' + name + ' required')
}
const source = args['source-root'], executable = args.exe
assert.equal(path.basename(executable).toLowerCase(), 'myresearchworkbench.exe')
assert.ok(!/[\\/]0\.4\.0[\\/]|[\\/]0\.3\.2[\\/]/.test(executable), 'Protected products must never be launched')
const scales = args.scales.split(',')
assert.ok(scales.length > 0 && scales.every(value => ['native', '1', '1.25', '1.5', '2'].includes(value)))
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 6)
const evidence = path.join(args['evidence-dir'], runId)
const fixture = path.join(evidence, '面板隔离 合成工作区')
await mkdir(fixture, { recursive: true })
await writeFile(path.join(evidence, 'runner.mjs'), await readFile(new URL(import.meta.url)))
const windowHelper = path.join(evidence, 'desktop-owned-layout.ps1')
await writeFile(windowHelper, await readFile(new URL('./desktop-owned-layout.ps1', import.meta.url)))
const folderHelperSource = args['folder-helper'] ?? path.join(path.dirname(args['native-helper']), 'native-owned-folder.ps1')
assert.ok(path.isAbsolute(folderHelperSource), 'The native folder helper path must be absolute')
const folderHelper = path.join(evidence, 'native-owned-folder.ps1')
await writeFile(folderHelper, await readFile(folderHelperSource))
const paragraph = 'Original synthetic paragraph describes the method and its assumptions.'
const manuscript = '\\documentclass{article}\n\\begin{document}\n\\section{Test}\n' + paragraph + '\n\\end{document}\n'
const codeFixture = '# Synthetic test only\nvalue = 1\nprint("result", value)\n'
const codeCases = { '分析 文件.py': codeFixture, 'solver.cpp': '// Synthetic test\nint main() { return 1; }\n',
  'kernel.cu': '// Synthetic test\n__global__ void kernel() {}\n', 'calculation.m': '% Synthetic test\nvalue = 1;\ndisp("result");\n' }
await writeFile(path.join(fixture, 'main.tex'), manuscript, { flag: 'wx' })
for (const [name, content] of Object.entries(codeCases)) await writeFile(path.join(fixture, name), content, { flag: 'wx' })
const report = {
  runId, startedAt: new Date().toISOString(), executable, sourceRoot: source,
  expectedVersion: args['expected-version'], fixture, scales,
  compiler: { latexmk: args.latexmk, perlDirectory: args['perl-directory'], environmentScope: 'synthetic fixture recipe only' }, checks: [], launches: [], nativeActions: [], windowActions: [], browserErrors: [],
  scope: {
    realExecutable: true, syntheticDocumentsOnly: true, modelCallsRequested: false, modelBoundary: 'loopback endpoint prevents external calls; no conversation turn requested', modelQualityTested: false, nativeImeExercised: false,
    storageStateInjected: false, viewportEmulation: false, globalDpiChanged: false,
    scaleMethod: 'Each force-device-scale-factor value is an application launch parameter; it is not an OS DPI change or browser zoom.',
    normalQuitAcceptance: 'Out of scope; the native application menu is used only for cleanup. Dedicated desktop recovery acceptance covers normal quit.',
  },
}
const checkpoint = () => writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n')
if (args['prepare-only']) { await checkpoint(); console.log(JSON.stringify({ prepared: true, evidence })); process.exit(0) }
const require = createRequire(path.join(source, 'apps/web/package.json'))
const { chromium } = require('playwright')
const requireDesktop = createRequire(path.join(source, 'apps/desktop/package.json'))
const requireBuilder = createRequire(requireDesktop.resolve('app-builder-lib'))
const asar = requireBuilder('@electron/asar')
const asarPath = path.join(path.dirname(executable), 'resources', 'app.asar')
const packaged = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
assert.equal(packaged.version, args['expected-version'], 'The packaged app is not the requested acceptance version')
const fileHash = file => new Promise((resolve, reject) => {
  const hash = createHash('sha256'), stream = createReadStream(file)
  stream.on('data', chunk => hash.update(chunk)); stream.on('error', reject)
  stream.on('end', () => resolve(hash.digest('hex')))
})
report.product = { packageVersion: packaged.version, executableSha256: await fileHash(executable), asarSha256: await fileHash(asarPath) }
await checkpoint()
const execute = promisify(execFile)
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const scrub = text => String(text).replace(/\u001b\[[0-9;]*m/g, '')
  .replace(/https?:\/\/[^\s"'<>]+/g, value => { try { const url = new URL(value); return url.origin + url.pathname } catch { return '[url]' } })
const poll = async (condition, message, timeout = 30000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(message)
}
const freePort = async () => {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise(resolve => server.close(resolve))
  return address.port
}
const modelRequests = []
const modelServer = createHttpServer((request, response) => {
  modelRequests.push({ path: request.url })
  response.writeHead(503).end('No model request is part of board isolation acceptance.')
})
await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve))
const modelEndpoint = 'http://127.0.0.1:' + modelServer.address().port
let owned, browser, page, launchRecord
const bench = () => page.locator('[data-workbench]').first()
const editor = () => bench().locator('[data-workbench-editor]')
const visual = () => editor().locator('[data-workbench-visual-editor]:visible')
const sourceEditor = () => editor().locator('[data-workbench-code-editor] .cm-content:visible')
const sessionId = () => bench().locator('[data-conversation-content]').first().getAttribute('data-conversation-session')
const shot = async name => {
  const file = path.join(evidence, name + '.png')
  await page.screenshot({ path: file })
  return file
}
const native = async (action = 'Inspect', value) => {
  assert.ok(owned && owned.exitCode === null && owned.pid)
  const output = path.join(evidence, 'native-' + String(report.nativeActions.length + 1).padStart(3, '0') + '.json')
  const nativeArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', args['native-helper'],
    '-OwnedProcessId', String(owned.pid), '-ExpectedExe', executable, '-Action', action, '-OutputFile', output]
  if (value !== undefined) nativeArgs.push(action === 'Keys' ? '-Keys' : '-Name', value)
  const result = await execute(powershell, nativeArgs, { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 25000 })
  const snapshot = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim())
  report.nativeActions.push({ action, output, processId: owned.pid })
  return snapshot
}
const nativeWindow = async (action, width, height) => {
  assert.ok(owned && owned.exitCode === null && owned.pid)
  const command = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', windowHelper,
    '-OwnedProcessId', String(owned.pid), '-ExpectedExe', executable, '-Action', action]
  if (width !== undefined) command.push('-Width', String(width), '-Height', String(height))
  const result = await execute(powershell, command, { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 25000 })
  const snapshot = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim())
  report.windowActions.push({ scale: launchRecord.scale, ...snapshot })
  return snapshot
}
const inspectUntil = async (predicate, message) => {
  let snapshot
  await poll(async () => { snapshot = await native(); return predicate(snapshot) }, message, 45000)
  return snapshot
}
const visibleControl = (snapshot, expression, type) => snapshot.controls.find(control => control.enabled
  && (!type || control.controlType.endsWith(type)) && expression.test(control.name))
const launch = async scale => {
  const launchDirectory = path.join(evidence, 'launch-' + scale)
  const hostHome = path.join(launchDirectory, 'isolated Host home')
  const electronData = path.join(launchDirectory, 'isolated Electron data')
  await mkdir(hostHome, { recursive: true })
  await mkdir(electronData)
  const environment = { ...process.env, MRW_DSH_HOME: hostHome, MRW_ELECTRON_USER_DATA: electronData,
    DEEPSEEK_API_KEY: 'synthetic-local-only', DEEPSEEK_BASE_URL: modelEndpoint }
  for (const key of Object.keys(environment)) if (/(KEY|SECRET|TOKEN|PASSWORD)/i.test(key) && key !== 'DEEPSEEK_API_KEY') delete environment[key]
  delete environment.DSH_HOME
  delete environment.ELECTRON_RUN_AS_NODE
  const port = await freePort()
  const switches = ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port]
  if (scale !== 'native') switches.push('--force-device-scale-factor=' + scale)
  const log = createWriteStream(path.join(launchDirectory, 'desktop.log'), { flags: 'wx' })
  owned = spawn(executable, switches,
    { cwd: evidence, env: environment, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })
  launchRecord = { scale, switches, pid: owned.pid, cdpPort: port, hostHome, electronData, startedAt: new Date().toISOString(),
    resources: { requests: [], workers: [] } }
  report.launches.push(launchRecord)
  const record = launchRecord
  for (const stream of [owned.stdout, owned.stderr]) {
    let pending = ''
    stream.setEncoding('utf8')
    stream.on('data', value => {
      pending += value
      const end = pending.lastIndexOf('\n')
      if (end >= 0) { log.write(scrub(pending.slice(0, end + 1))); pending = pending.slice(end + 1) }
    })
    stream.on('end', () => { if (pending) log.write(scrub(pending)) })
  }
  owned.once('exit', (code, signal) => { record.exitCode = code; record.signal = signal; record.exitedAt = new Date().toISOString(); log.end() })
  await poll(async () => {
    assert.equal(owned.exitCode, null, 'Owned executable exited during startup')
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:' + port); return true } catch { return false }
  }, 'Owned executable did not expose its loopback debugging endpoint', 120000)
  await poll(async () => {
    page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith('dsh-app://app/')
      && new URL(candidate.url()).searchParams.get('mrwPlan') !== '1')
    return Boolean(page)
  }, 'Owned application document did not appear', 120000)
  page.setDefaultTimeout(20000)
  page.on('pageerror', error => report.browserErrors.push(scrub(error)))
  const resources = launchRecord.resources
  const observed = new Map()
  const resourceUrl = value => {
    const parsed = new URL(value)
    parsed.search = ''; parsed.hash = ''
    return parsed.href
  }
  const observeResource = request => {
    if (!['font', 'script', 'stylesheet'].includes(request.resourceType()) && !/mathlive|[/._-]worker[./_-]/i.test(request.url())) return
    let item = observed.get(request)
    if (!item) {
      item = { url: resourceUrl(request.url()), type: request.resourceType(), status: null, failure: null }
      observed.set(request, item)
      resources.requests.push(item)
    }
    return item
  }
  page.on('request', observeResource)
  page.on('response', response => {
    const item = observeResource(response.request())
    if (item) item.status = response.status()
  })
  page.on('requestfailed', request => {
    const item = observeResource(request)
    if (item) item.failure = request.failure()?.errorText ?? 'Unknown resource failure'
  })
  page.on('worker', worker => resources.workers.push({ url: resourceUrl(worker.url()) }))
  await bench().waitFor({ state: 'visible', timeout: 120000 })
  const notice = page.getByRole('dialog', { name: '预览版说明', exact: true })
  if (await notice.isVisible()) await notice.getByRole('button', { name: '继续', exact: true }).click()
  launchRecord.renderer = await page.evaluate(() => ({
    origin: location.origin, protocol: location.protocol, width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
    screenWidth: screen.width, screenHeight: screen.height, availableWidth: screen.availWidth, availableHeight: screen.availHeight,
  }))
  if (scale !== 'native') assert.ok(Math.abs(launchRecord.renderer.dpr - Number(scale)) < 0.01, 'Application scale switch did not take effect')
  launchRecord.nativeWindow = await nativeWindow('Normal', 1640, 1000)
  await page.bringToFront()
  await checkpoint()
}
const selectWorkspace = async () => {
  let add = page.getByRole('button', { name: '添加工作区', exact: true })
  if (!await add.isVisible()) {
    await page.getByRole('button', { name: '选择工作区', exact: true }).click()
    add = page.getByRole('menuitem', { name: '添加工作区…', exact: true })
  }
  // The native modal blocks Electron's click acknowledgement until the folder dialog closes.
  let openingError
  const opening = add.click({ noWaitAfter: true, timeout: 60000 }).catch(error => { openingError = error })
  assert.ok(owned && owned.exitCode === null && owned.pid)
  const selection = await execute(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', folderHelper,
    '-ExpectedProcessId', String(owned.pid), '-ExpectedExecutable', executable, '-FixtureDirectory', fixture],
  { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 30000 })
  launchRecord.nativeFolderSelection = JSON.parse(selection.stdout.replace(/^\uFEFF/, '').trim())
  await opening
  if (openingError) throw openingError
  await poll(async () => (await page.getByRole('button', { name: '选择工作区', exact: true }).innerText()).includes(path.basename(fixture)),
    'The chosen native workspace did not become active')
  await poll(async () => Boolean(await sessionId()), 'The synthetic workspace has no session')
}
const focusChat = async () => {
  const toggle = bench().getByRole('button', { name: '对话', exact: true })
  if (await toggle.isVisible()) await toggle.click()
}
const focusEditor = async () => {
  const name = await bench().getAttribute('data-mode') === 'writing' ? '写作' : '开发'
  const toggle = bench().getByRole('button', { name, exact: true })
  if (await toggle.isVisible()) await toggle.click()
}
const mode = async name => {
  await focusChat()
  await page.locator('[data-workbench-mode-selector]:visible').getByRole('button', { name: '工作视图', exact: true }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
  await focusEditor()
}
const openFile = async name => {
  await mode('写作')
  const files = editor().getByRole('region', { name: '文件', exact: true })
  if (!await files.isVisible()) await editor().getByRole('button', { name: '文件', exact: true }).click()
  await files.getByRole('button', { name, exact: true }).click()
  await files.waitFor({ state: 'hidden' })
}
const settle = async () => {
  let last = ''
  let equal = 0
  await poll(async () => {
    const current = await page.evaluate(() => {
      const panel = document.querySelector('[data-workbench-editor]')?.getBoundingClientRect()
      const seat = document.querySelector('[data-composer-seat]')?.getBoundingClientRect()
      return JSON.stringify([innerWidth, innerHeight, panel?.x, panel?.width, panel?.height, seat?.y])
    })
    equal = current === last ? equal + 1 : 0
    last = current
    return equal >= 2
  }, 'The actual window layout did not settle', 10000)
}
const closeOwned = async () => {
  if (!owned || owned.exitCode !== null) return
  await page.getByRole('menuitem', { name: '应用', exact: true }).click()
  const menu = await inspectUntil(snapshot => Boolean(visibleControl(snapshot, /^(退出|Exit)$/, 'MenuItem')),
    'Owned application menu did not expose Exit for cleanup')
  const exit = visibleControl(menu, /^(退出|Exit)$/, 'MenuItem')
  assert.ok(exit)
  await native('Invoke', exit.name)
  await poll(async () => {
    if (owned.exitCode !== null) return true
    const snapshot = await native('Inspect')
    const confirm = visibleControl(snapshot, /^(退出|Exit)$/, 'Button')
    if (confirm) await native('Invoke', confirm.name)
    return owned.exitCode !== null
  }, 'Owned clean test window did not close; retained for diagnosis', 30000)
  await browser?.close().catch(() => {})
  page = undefined
}
const check = async (name, action) => {
  const start = Date.now()
  try {
    const detail = await action()
    report.checks.push({ name, status: 'passed', elapsedMs: Date.now() - start, detail })
    await checkpoint()
    console.log(JSON.stringify({ name, status: 'passed' }))
  } catch (error) {
    const screenshot = page && !page.isClosed() ? await shot(name + '-failed').catch(() => undefined) : undefined
    if (page && !page.isClosed()) {
      await writeFile(path.join(evidence, name + '-failed.aria.yml'), await page.locator('body').ariaSnapshot().catch(() => '(unavailable)'))
    }
    report.checks.push({ name, status: 'failed', elapsedMs: Date.now() - start, error: scrub(error), screenshot })
    await checkpoint()
    throw error
  }
}
const tabs = () => editor().getByRole('tablist', { name: '文件', exact: true }).getByRole('tab')
const tabNames = async () => (await tabs().allTextContents()).map(name => name.replace('•', '').trim())
const resume = name => page.locator('[data-workbench-mode-selector]:visible').getByRole('button', { name, exact: true })
const collapse = async () => {
  await editor().locator('[data-workbench-collapse]').click()
  await resume('展开写作板').waitFor()
  await resume('展开开发板').waitFor()
}
try {
  await launch('native')
  await selectWorkspace()
  await nativeWindow('Maximize'); await settle()
  await check('B01-separate-tabs-and-writing-development-drafts', async () => {
    await openFile('main.tex')
    assert.deepEqual(await tabNames(), ['main.tex'])
    const paragraphNode = visual().locator('.ProseMirror[contenteditable="true"] p').filter({ hasText: paragraph }).first()
    await paragraphNode.click({ position: { x: 8, y: 8 } })
    await page.keyboard.press('Home')
    await page.keyboard.insertText('Draft ')
    await page.keyboard.press('Control+s')
    await poll(async () => (await readFile(path.join(fixture, 'main.tex'), 'utf8')).includes('Draft ' + paragraph), 'Writing edit did not save')
    await openFile('分析 文件.py')
    assert.equal(await bench().getAttribute('data-mode'), 'development')
    assert.deepEqual(await tabNames(), ['分析 文件.py'])
    await sourceEditor().click()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText('# board draft\n')
    await page.keyboard.press('Control+s')
    await poll(async () => (await readFile(path.join(fixture, '分析 文件.py'), 'utf8')) === codeFixture + '# board draft\n', 'Code edit did not save')
    for (const name of ['solver.cpp', 'kernel.cu', 'calculation.m']) {
      await openFile(name)
      assert.equal(await bench().getAttribute('data-mode'), 'development')
    }
    assert.deepEqual(await tabNames(), Object.keys(codeCases))
    await tabs().filter({ hasText: '分析 文件.py' }).click()
    assert.ok((await sourceEditor().innerText()).includes('# board draft'))
    await mode('写作')
    assert.deepEqual(await tabNames(), ['main.tex'])
    assert.ok((await visual().innerText()).includes('Draft ' + paragraph))
    return { writingTabs: await tabNames(), developmentTabs: Object.keys(codeCases), screenshot: await shot('01-writing-restored') }
  })
  await check('B02-two-resume-buttons-restore-their-own-files-and-undo', async () => {
    await collapse()
    const buttons = await Promise.all(['展开写作板', '展开开发板'].map(async name => ({ name, box: await resume(name).boundingBox() })))
    assert.ok(buttons.every(button => button.box && button.box.width > 0))
    assert.ok(buttons[0].box.x + buttons[0].box.width <= buttons[1].box.x)
    const collapsedShot = await shot('02-both-resume-buttons')
    await resume('展开开发板').click()
    assert.equal(await bench().getAttribute('data-mode'), 'development')
    assert.equal(await editor().getByRole('tab', { selected: true }).innerText(), '分析 文件.py')
    assert.ok((await sourceEditor().innerText()).includes('# board draft'))
    await sourceEditor().click()
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+s')
    await poll(async () => await readFile(path.join(fixture, '分析 文件.py'), 'utf8') === codeFixture, 'Code undo history was lost across board switches')
    assert.ok((await readFile(path.join(fixture, 'main.tex'), 'utf8')).includes('Draft ' + paragraph))
    const codeShot = await shot('03-development-restored')
    await collapse()
    await resume('展开写作板').click()
    assert.equal(await bench().getAttribute('data-mode'), 'writing')
    assert.deepEqual(await tabNames(), ['main.tex'])
    const paragraphNode = visual().locator('.ProseMirror[contenteditable="true"] p').filter({ hasText: 'Draft ' + paragraph }).first()
    await paragraphNode.click({ position: { x: 8, y: 8 } })
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+s')
    await poll(async () => await readFile(path.join(fixture, 'main.tex'), 'utf8') === manuscript, 'Writing undo history was lost across board switches')
    await mode('对话')
    await resume('展开写作板').waitFor()
    await resume('展开开发板').waitFor()
    await resume('展开写作板').click()
    assert.deepEqual(await tabNames(), ['main.tex'])
    return { buttons, collapsedShot, codeShot, pureChatResume: true, writingAndCodeUndoSaved: true }
  })
  assert.equal(report.browserErrors.length, 0)
  assert.equal(modelRequests.length, 0)
  for (const [name, text] of Object.entries(codeCases)) assert.equal(await readFile(path.join(fixture, name), 'utf8'), text)
  assert.equal(await readFile(path.join(fixture, 'main.tex'), 'utf8'), manuscript)
  await closeOwned()
} catch (error) {
  report.fatal = scrub(error)
  console.log(JSON.stringify({ fatal: report.fatal.slice(0, 1000) }))
} finally {
  if (owned && owned.exitCode === null && page && !page.isClosed()) {
    try { await closeOwned() } catch (error) { report.cleanupError = scrub(error) }
  }
  report.modelRequests = modelRequests
  report.finishedAt = new Date().toISOString()
  report.ownedProcessStillRunning = Boolean(owned && owned.exitCode === null)
  report.productUnchanged = report.product.executableSha256 === await fileHash(executable)
    && report.product.asarSha256 === await fileHash(asarPath)
  modelServer.closeAllConnections()
  await new Promise(resolve => modelServer.close(resolve))
  await checkpoint()
}
const failed = Boolean(report.fatal || report.ownedProcessStillRunning || !report.productUnchanged)
console.log(JSON.stringify({ evidence, failed, checks: report.checks.map(({ name, status }) => ({ name, status })) }))
process.exitCode = failed ? 1 : 0
