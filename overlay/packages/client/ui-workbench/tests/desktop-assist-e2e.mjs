/**
 * Packaged MRW 0.5.2 affected-flow acceptance; model boundary is a loopback Messages server.
 * Reuses the owned-app/native-picker lifecycle from verify-desktop-recovery.mjs
 * and the real geometry checks from glass-host-e2e.mjs. All documents are synthetic.
 * Device-scale switches affect only each isolated application launch, never Windows DPI.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { createReadStream, createWriteStream } from 'node:fs'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import path from 'node:path'
import { parseArgs, promisify } from 'node:util'

const { values: args } = parseArgs({ options: {
  'source-root': { type: 'string' }, exe: { type: 'string' },
  'evidence-dir': { type: 'string' }, 'native-helper': { type: 'string' },
  'folder-helper': { type: 'string' },
  'expected-version': { type: 'string', default: '0.5.2' },
  scales: { type: 'string', default: 'native' },
  latexmk: { type: 'string' }, 'perl-directory': { type: 'string' },
  'prepare-only': { type: 'boolean', default: false },
  'reuse-report': { type: 'string' },
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
const fixture = path.join(evidence, '玻璃面板 合成工作区')
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
    realExecutable: true, syntheticDocumentsOnly: true, modelCallsRequested: true, modelBoundary: 'loopback deterministic Messages server; no external model calls or real credentials', modelQualityTested: false, nativeImeExercised: false,
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
const responded = new Set()
const modelServer = createHttpServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const texts = (body.messages ?? []).filter(message => message.role === 'user').flatMap(message =>
        typeof message.content === 'string' ? [message.content] : (message.content ?? []).filter(part => part.type === 'text').map(part => part.text))
      const last = [...texts].reverse().find(text => text.includes('<mrw-selection-context>'))
      const match = last && /<mrw-selection-context>\n([\s\S]*?)\n<\/mrw-selection-context>/.exec(last)
      const selected = match ? JSON.parse(match[1]) : undefined
      const names = (body.tools ?? []).map(tool => tool.name)
      const edit = selected && names.includes('workbench_propose_edit') && selected.instruction.includes('REVISE') && !responded.has(selected.requestId)
      modelRequests.push({ path: request.url, requestId: selected?.requestId, mode: selected?.mode, instruction: selected?.instruction, tools: names, edit })
      if (selected) assert.equal(selected.mode, 'assist')
      if (edit) { assert.ok(names.includes('workbench_propose_edit')); responded.add(selected.requestId) }
      const replacement = selected?.selectedText.includes('Original')
        ? selected.selectedText.replace('Original', 'Revised') : selected?.selectedText.replace('value = 1', 'value = 2')
      const content = edit ? { type: 'tool_use', id: 'proposal-' + selected.requestId, name: 'workbench_propose_edit', input: {} }
        : { type: 'text', text: '' }
      const events = [
        { type: 'message_start', message: { id: 'local-' + modelRequests.length, model: body.model, usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: content },
        { type: 'content_block_delta', index: 0, delta: edit
          ? { type: 'input_json_delta', partial_json: JSON.stringify({ replacement, explanation: 'Deterministic suggestion for UI acceptance.' }) }
          : { type: 'text_delta', text: selected ? 'ASSIST_ANSWER: This selected content is explained without changing it.' : 'Synthetic acceptance session' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: edit ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''))
    } catch (error) { report.modelError = String(error); response.writeHead(500).end('Synthetic model fixture failed') }
  })
})
await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve))
const modelEndpoint = 'http://127.0.0.1:' + modelServer.address().port
let owned, browser, page, launchRecord
const bench = () => page.locator('[data-workbench]').first()
const editor = () => bench().locator('[data-workbench-editor]')
const visual = () => editor().locator('[data-workbench-visual-editor]:visible')
const sourceEditor = () => editor().locator('[data-workbench-code-editor] .cm-content:visible')
const composer = () => page.locator('[data-composer-input]').first()
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
const more = async name => {
  await editor().getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
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
const windowSize = async (width, height) => {
  await nativeWindow('Normal', width, height)
  await settle()
}
const measure = () => page.evaluate(() => {
  const rect = node => {
    const box = node.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom }
  }
  const panel = document.querySelector('[data-workbench-editor]')
  const chat = document.querySelector('[data-workbench-chat]')
  const seat = document.querySelector('[data-composer-seat]')
  const input = document.querySelector('[data-composer-input]')
  const paper = document.querySelector('[data-workbench-visual-editor] .ProseMirror')?.parentElement
  const firstLine = document.querySelector('[data-workbench-code-editor] .cm-line')
  const firstNumber = [...document.querySelectorAll('[data-workbench-code-editor] .cm-lineNumbers .cm-gutterElement')]
    .find(node => node.textContent === '1')
  const glass = getComputedStyle(panel, '::before')
  const inputBox = input.getBoundingClientRect()
  const point = document.elementFromPoint(inputBox.x + inputBox.width / 2, inputBox.y + inputBox.height / 2)
  return {
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    screen: { width: screen.width, height: screen.height, availableWidth: screen.availWidth, availableHeight: screen.availHeight },
    panel: rect(panel), chat: rect(chat), composer: rect(seat), input: rect(input),
    inputReceivesPointer: point === input || input.contains(point),
    documentWidth: document.documentElement.clientWidth, documentScroll: document.documentElement.scrollWidth,
    glass: { fill: glass.backgroundColor, filter: glass.backdropFilter, radius: getComputedStyle(panel).borderRadius },
    paper: paper ? { ink: getComputedStyle(paper).color, fill: getComputedStyle(paper).backgroundColor } : null,
    code: firstLine && firstNumber ? { firstLine: rect(firstLine), firstNumber: rect(firstNumber) } : null,
    anchorSupported: CSS.supports('bottom: anchor(top)') && CSS.supports('anchor-scope: --mrw-composer'),
  }
})
const assertLayout = async name => {
  await settle()
  const value = await measure()
  assert.ok(value.panel.height >= 160, name + ': too little editor height')
  assert.ok(value.documentScroll <= value.documentWidth + 1, name + ': horizontal overflow')
  if (value.chat.width > 0) {
    assert.ok(value.chat.right <= value.panel.x, name + ': left/right overlap')
    assert.ok(value.inputReceivesPointer, name + ': composer is obscured')
  } else {
    assert.ok(await bench().getByRole('button', { name: '对话', exact: true }).isVisible())
    assert.ok(value.panel.width >= 300, name + ': compact editor width')
  }
  assert.ok(parseFloat(value.glass.radius) >= 20, name + ': rounded shell is missing')
  if (value.code) assert.ok(Math.abs(value.code.firstLine.y - value.code.firstNumber.y) < 1, name + ': line numbers are displaced')
  const screenshot = await shot(name)
  const afterShot = await measure()
  assert.deepEqual(afterShot.viewport, value.viewport, 'Screenshot changed renderer metrics')
  return { ...value, screenshot, viewportAfterScreenshot: afterShot.viewport }
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
  if (report.checks.some(check => check.name === name && check.reusedFrom && check.status === 'passed')) return
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
const selectionCard = () => page.locator('[data-workbench-selection]:visible')
const proposal = () => page.locator('[data-workbench-proposal]:visible')
const originalVisual = () => editor().locator('[data-workbench-visual-editor]').filter({ has: page.locator('.ProseMirror[contenteditable="true"]') })
const clearSelection = async () => {
  const button = selectionCard().getByRole('button', { name: '移除选区', exact: true })
  if (await button.isVisible()) await button.click()
}
const selectWriting = async () => {
  const text = originalVisual().locator('.ProseMirror p').filter({ hasText: /(?:Original|Revised) synthetic paragraph/ }).first()
  await text.click({ position: { x: 8, y: 8 } })
  await page.keyboard.press('Home'); await page.keyboard.press('Control+Shift+ArrowDown')
  await originalVisual().getByRole('button', { name: '协助', exact: true }).click()
  assert.equal(await bench().getAttribute('data-focus'), 'editor')
  assert.ok(await originalVisual().isVisible())
}
const sendAssist = async instruction => {
  await selectionCard().getByRole('textbox').fill(instruction)
  await selectionCard().getByRole('button', { name: '发送', exact: true }).click()
  assert.equal(await bench().getAttribute('data-focus'), 'editor')
}
const assertCompact = async name => {
  await proposal().waitFor({ state: 'visible' })
  assert.equal(await proposal().getAttribute('data-presentation'), 'compact')
  const doc = await editor().locator('[class*="documentArea"]').boundingBox()
  const suggestion = await proposal().boundingBox()
  const panel = await editor().boundingBox()
  assert.ok(doc && suggestion && doc.height > 150)
  assert.ok(doc.y + doc.height <= suggestion.y + 1, 'Suggestion must be below the original')
  assert.ok(suggestion.height < panel.height * 0.5, 'Compact review consumed most of the editor')
  for (const label of ['全部采纳', '放弃', '细节', '继续调整']) {
    const button = await proposal().getByRole('button', { name: label, exact: true }).boundingBox()
    assert.ok(button && button.y + button.height <= panel.y + panel.height, 'Review action clipped: ' + label)
  }
  return { document: doc, suggestion, screenshot: await shot(name) }
}
const alignment = async name => {
  const result = await page.evaluate(() => {
    const selector = [...document.querySelectorAll('[data-workbench-mode-selector]')].find(node => node.getBoundingClientRect().width > 0)
    const input = document.querySelector('[data-composer-input]')
    const row = selector?.closest('[class*="workViewRow"]')?.getBoundingClientRect()
    const card = input?.closest('[data-composer-card]')?.getBoundingClientRect() ?? input?.getBoundingClientRect()
    return { row: row?.toJSON(), card: card?.toJSON(), overflow: document.documentElement.scrollWidth - innerWidth }
  })
  assert.ok(result.row && result.card && result.overflow <= 1)
  // The selector row and composer contents share a left edge, with only the input's inner padding.
  assert.ok(Math.abs(result.row.x - result.card.x) < 35, 'Selector did not follow the centered composer')
  return { ...result, screenshot: await shot(name) }
}
try {
  await launch('native')
  await selectWorkspace()
  await nativeWindow('Maximize'); await settle()
  if (args['reuse-report']) {
    assert.ok(path.isAbsolute(args['reuse-report']))
    const previous = JSON.parse(await readFile(args['reuse-report'], 'utf8'))
    assert.deepEqual(previous.product, report.product, 'Only reuse checks of exactly this binary')
    const passedWriting = previous.checks.filter(check => /^Q0[12]/.test(check.name))
    assert.equal(passedWriting.length, 2)
    assert.ok(passedWriting.every(check => check.status === 'passed'))
    report.checks.push(...previous.checks.filter(check => check.status === 'passed').map(check => ({ ...check, reusedFrom: args['reuse-report'] })))
    report.reusedWritingEvidence = args['reuse-report']
    // Create the populated conversation needed for the layout check, without repeating review/accept/undo.
    await openFile('main.tex')
    await selectWriting()
    await sendAssist('EXPLAIN this paragraph.')
    await page.getByText(/ASSIST_ANSWER:/).first().waitFor()
    await poll(async () => await selectionCard().getByRole('button', { name: '发送', exact: true }).isEnabled(), 'Layout setup did not settle')
    await clearSelection()
  } else {
  await check('Q01-writing-assist-question-preserves-editor', async () => {
    await openFile('main.tex')
    await selectWriting()
    await sendAssist('EXPLAIN this paragraph.')
    await page.getByText(/ASSIST_ANSWER:/).first().waitFor()
    await poll(async () => await selectionCard().getByRole('button', { name: '发送', exact: true }).isEnabled(), 'Assist answer did not settle')
    assert.equal(await proposal().count(), 0)
    assert.equal(await readFile(path.join(fixture, 'main.tex'), 'utf8'), manuscript)
    assert.ok(await originalVisual().isVisible())
    return { screenshot: await shot('01-writing-assist-answer'), originalUnchanged: true }
  })
  await check('Q02-Q04-writing-compact-details-refine-discard-accept-undo-reopen', async () => {
    await sendAssist('REVISE the wording.')
    const compact = await assertCompact('02-writing-compact')
    assert.equal(await readFile(path.join(fixture, 'main.tex'), 'utf8'), manuscript)
    await proposal().getByRole('button', { name: '细节', exact: true }).click()
    assert.equal(await proposal().getAttribute('data-presentation'), 'detail')
    const details = await shot('03-writing-details')
    await proposal().getByRole('button', { name: '返回原文', exact: true }).click()
    assert.ok(await originalVisual().isVisible())
    await proposal().getByRole('button', { name: '继续调整', exact: true }).click()
    assert.ok(await originalVisual().isVisible())
    await sendAssist('REVISE with clearer wording.')
    await proposal().waitFor()
    await proposal().getByRole('button', { name: '放弃', exact: true }).click()
    assert.equal(await readFile(path.join(fixture, 'main.tex'), 'utf8'), manuscript)
    await selectWriting()
    await sendAssist('REVISE for acceptance.')
    await proposal().waitFor()
    await proposal().getByRole('button', { name: '全部采纳', exact: true }).click()
    await poll(async () => (await readFile(path.join(fixture, 'main.tex'), 'utf8')).includes('Revised synthetic'), 'Accepted writing did not save')
    await originalVisual().locator('.ProseMirror').click()
    await page.keyboard.press('Control+z')
    await poll(async () => await readFile(path.join(fixture, 'main.tex'), 'utf8') === manuscript, 'Undo did not restore the original document')
    await clearSelection()
    await editor().getByRole('button', { name: '关闭 main.tex', exact: true }).click()
    await openFile('main.tex')
    assert.ok((await originalVisual().innerText()).includes(paragraph))
    return { compact, details, savedAndUndone: true, reopened: true }
  })
  }
  await check('Q05-mode-selector-follows-composer', async () => {
    await editor().locator('[data-workbench-collapse]').click()
    await nativeWindow('Normal', 1640, 1000); await settle()
    const normal = await alignment('04-chat-normal')
    await nativeWindow('Maximize'); await settle()
    const maximized = await alignment('05-chat-maximized')
    return { normal, maximized }
  })
  await check('Q06-Q07-manual-code-file-language-palettes', async () => {
    await mode('开发')
    const samples = []
    for (const [name, text] of Object.entries(codeCases)) {
      const files = editor().getByRole('region', { name: '文件', exact: true })
      await editor().getByRole('button', { name: '文件', exact: true }).click()
      await files.getByRole('button', { name, exact: true }).click()
      await files.waitFor({ state: 'hidden' })
      await sourceEditor().waitFor()
      const colors = await sourceEditor().evaluate(node => ({
        palette: node.closest('[data-workbench-code-theme]')?.getAttribute('data-workbench-code-theme'),
        background: getComputedStyle(node.closest('.cm-editor')).backgroundColor,
        tokens: [...node.querySelectorAll('.cm-line span')].map(token => ({ text: token.textContent, color: getComputedStyle(token).color })),
      }))
      assert.equal(colors.palette, name.endsWith('.m') ? 'scientific' : 'vscode')
      assert.ok(new Set(colors.tokens.map(token => token.color)).size >= 2, 'Missing syntax colors: ' + name)
      assert.equal(await readFile(path.join(fixture, name), 'utf8'), text)
      samples.push({ name, ...colors, screenshot: await shot('06-code-' + path.extname(name).slice(1)) })
    }
    await more('显示设置')
    const settings = editor().getByRole('region', { name: '显示设置', exact: true })
    await settings.getByRole('button', { name: /^编辑器配色 ·/ }).click()
    await page.getByRole('menuitem', { name: 'VS Code 深色', exact: true }).click()
    assert.equal(await editor().getAttribute('data-workbench-code-theme'), 'vscode')
    await settings.getByRole('button', { name: /^编辑器配色 ·/ }).click()
    await page.getByRole('menuitem', { name: '按语言', exact: true }).click()
    await settings.getByRole('button', { name: '关闭', exact: true }).click()
    return { samples, manualOverride: true, fileBytesUnchanged: true }
  })
  await check('Q08-code-assist-compact-details-accept-undo-and-narrow-window', async () => {
    const files = editor().getByRole('region', { name: '文件', exact: true })
    await editor().getByRole('button', { name: '文件', exact: true }).click()
    await files.getByRole('button', { name: '分析 文件.py', exact: true }).click()
    await files.waitFor({ state: 'hidden' })
    await sourceEditor().click(); await page.keyboard.press('Control+a')
    await editor().getByRole('button', { name: '协助', exact: true }).click()
    assert.ok(await sourceEditor().isVisible())
    await sendAssist('EXPLAIN this Python code.')
    await page.getByText(/ASSIST_ANSWER:/).last().waitFor()
    await poll(async () => await selectionCard().getByRole('button', { name: '发送', exact: true }).isEnabled(), 'Code question did not settle')
    await sendAssist('REVISE value to two.')
    const compact = await assertCompact('07-code-compact')
    await proposal().getByRole('button', { name: '细节', exact: true }).click()
    await proposal().getByRole('button', { name: '返回原文', exact: true }).click()
    await proposal().getByRole('button', { name: '全部采纳', exact: true }).click()
    await poll(async () => (await readFile(path.join(fixture, '分析 文件.py'), 'utf8')).includes('value = 2'), 'Code suggestion did not save')
    await sourceEditor().click(); await page.keyboard.press('Control+z')
    await poll(async () => await readFile(path.join(fixture, '分析 文件.py'), 'utf8') === codeFixture, 'Code undo failed')
    await clearSelection()
    await nativeWindow('Normal', 1050, 800); await settle()
    const narrow = await assertLayout('08-code-narrow')
    return { compact, narrow, acceptedAndUndone: true }
  })
  assert.equal(report.browserErrors.length, 0)
  assert.equal(report.modelError, undefined)
  await closeOwned()
} catch (error) {
  report.fatal = scrub(error)
  console.log(JSON.stringify({ fatal: report.fatal.slice(0, 1000) }))
} finally {
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
