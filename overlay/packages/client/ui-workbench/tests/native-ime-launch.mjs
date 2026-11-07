/** Launch the final EXE in isolated roots, select the fixture in the real native folder dialog, and run the native IME observer. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1])
for (const key of ['--source-root', '--exe', '--fixture', '--evidence']) assert.ok(args.get(key), 'Missing ' + key)
const source = path.resolve(args.get('--source-root'))
const exe = path.resolve(args.get('--exe'))
const fixture = path.resolve(args.get('--fixture'))
const evidence = path.resolve(args.get('--evidence'))
assert.equal(path.basename(fixture), 'native-ime-fixture-20261022')
assert.match(path.basename(exe), /MyResearchWorkbench.*\.exe$/i)
const sha = value => createHash('sha256').update(value).digest('hex')
await mkdir(evidence, { recursive: false })
await writeFile(path.join(evidence, 'launcher.mjs'), await readFile(new URL(import.meta.url)))
const report = {
  startedAt: new Date().toISOString(), exe, fixture, evidence,
  executableSha256: sha(await readFile(exe)),
  packagedAppSha256: sha(await readFile(path.join(path.dirname(exe), 'resources/app.asar'))),
  profileIsolation: { userData: path.join(evidence, 'electron'), host: path.join(evidence, 'home') },
  globalDisplaySettingsChanged: false, nativeFolderDialogSubstituted: false, modelRequestsInitiated: false,
}
const checkpoint = () => writeFile(path.join(evidence, 'launch-report.json'), JSON.stringify(report, null, 2) + '\n')
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (/(KEY|SECRET|TOKEN|PASSWORD|PROXY)/i.test(key)
    || ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH', 'DSH_HOME', 'DSH_AGENTS_HOME', 'MRW_DSH_HOME', 'MRW_ELECTRON_USER_DATA'].includes(key)) delete env[key]
}
env.MRW_ELECTRON_USER_DATA = report.profileIsolation.userData
env.MRW_DSH_HOME = report.profileIsolation.host
env.DSH_TELEMETRY_DISABLED = '1'
env.DEEPSEEK_API_KEY = 'keyless-native-ime-smoke'
const require = createRequire(path.join(source, 'apps/web/package.json'))
const { _electron } = require('playwright')
const run = promisify(execFile)
let app, page, processExit, exited = false
const poll = async (fn, message, timeout = 30000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(message)
}
try {
  const server = createServer()
  const cdpPort = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
  assert.ok(Number.isInteger(cdpPort) && cdpPort > 0 && cdpPort < 65536)
  report.cdpPort = cdpPort
  app = await _electron.launch({ executablePath: exe,
    args: ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + cdpPort], env, timeout: 120000 })
  const launched = app.process()
  processExit = new Promise(resolve => launched.once('close', (code, signal) => { exited = true; resolve({ code, signal }) }))
  report.launcherPid = launched.pid
  await poll(async () => {
    page = app.windows().find(candidate => candidate.url().startsWith('dsh-app://app/'))
    return Boolean(page)
  }, 'Main packaged application page did not open', 120000)
  page.setDefaultTimeout(15000)
  await page.locator('[data-workbench]').first().waitFor({ timeout: 120000 })
  const notice = page.getByRole('dialog', { name: '预览版说明', exact: true })
  if (await notice.isVisible()) await notice.getByRole('button', { name: '继续', exact: true }).click()
  report.application = await app.evaluate(({ app, BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().startsWith('dsh-app://app/'))
    if (!window) throw new Error('Main packaged BrowserWindow is missing')
    window.maximize()
    const display = screen.getDisplayMatching(window.getBounds())
    const raw = window.getNativeWindowHandle()
    return { mainProcessId: process.pid, executablePath: process.execPath,
      versions: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome },
      version: app.getVersion(), windowTitle: window.getTitle(), packaged: app.isPackaged, userData: app.getPath('userData'),
      hwnd: (raw.length === 8 ? raw.readBigUInt64LE().toString() : raw.readUInt32LE().toString()),
      zoomFactor: window.webContents.getZoomFactor(), zoomLevel: window.webContents.getZoomLevel(),
      bounds: window.getBounds(), contentBounds: window.getContentBounds(),
      display: { id: display.id, bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor } }
  })
  report.pid = report.application.mainProcessId
  assert.ok(Number.isSafeInteger(report.pid) && report.pid > 0)
  assert.equal(path.resolve(report.application.executablePath).toLowerCase(), exe.toLowerCase())
  assert.equal(report.application.version, '0.5.0')
  assert.equal(report.application.packaged, true)
  assert.doesNotMatch(report.application.windowTitle, /\b0\.4\.0\b/, 'Native title still identifies the protected older product')
  assert.equal(path.resolve(report.application.userData).toLowerCase(), report.profileIsolation.userData.toLowerCase())
  await poll(async () => Boolean(await page.locator('[data-conversation-content]').first()
    .getAttribute('data-conversation-session')), 'Initial conversation Session has not settled')
  const previousSession = await page.locator('[data-conversation-content]').first().getAttribute('data-conversation-session')
  // Electron's native modal can keep the renderer click pending until the folder dialog closes.
  const opening = page.getByRole('button', { name: '添加工作区', exact: true }).first()
    .click({ noWaitAfter: true, timeout: 60000 })
  const directoryHelper = path.join(source, 'packages/client/ui-workbench/tests/native-ime-directory.ps1')
  const selecting = run('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', directoryHelper,
      '-ExpectedProcessId', String(report.pid), '-ExpectedExecutable', exe, '-FixtureDirectory', fixture],
    { windowsHide: true, encoding: 'utf8', timeout: 30000 })
  const [, selected] = await Promise.all([opening, selecting])
  assert.equal(selected.stderr.trim(), '')
  report.nativeDirectorySelection = JSON.parse(selected.stdout)
  await poll(async () => {
    const sessionId = await page.locator('[data-conversation-content]').first().getAttribute('data-conversation-session')
    if (!sessionId || sessionId === previousSession) return false
    const result = await page.evaluate(async ({ sessionId, rpcId }) => {
      const response = await fetch('/api/workbenchWorkspace/read', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: 'workbenchWorkspace/read',
          payload: { args: { workspaceFileScopeId: sessionId, path: 'ime-main.tex' } } }),
      })
      if (!response.ok) return null
      return response.json()
    }, { sessionId, rpcId: randomUUID() })
    if (!result?.result?.ok) return false
    const value = result.result.value
    if (path.resolve(value.absolutePath).toLowerCase() !== path.join(fixture, 'ime-main.tex').toLowerCase()) return false
    assert.equal(sha(value.text), 'a77562f4fce86b5a898a214b1b05303b60e4fbd183a80c2bdb175583dbf42990')
    report.selectedSession = sessionId
    report.selectedFileIdentity = { absolutePath: value.absolutePath, sha256: sha(value.text) }
    return true
  }, 'Native folder selection did not bind the requested fixture Session')
  report.nativeWindowAfterSelection = await app.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find(value => value.webContents.getURL().startsWith('dsh-app://app/'))
    if (!window) throw new Error('Main BrowserWindow missing after native selection')
    const display = screen.getDisplayMatching(window.getBounds())
    return { windowTitle: window.getTitle(), maximized: window.isMaximized(), bounds: window.getBounds(), contentBounds: window.getContentBounds(),
      zoomFactor: window.webContents.getZoomFactor(), zoomLevel: window.webContents.getZoomLevel(),
      displayCount: screen.getAllDisplays().length,
      display: { id: display.id, bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor } }
  })
  report.renderer = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
    screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight } }))
  await checkpoint()
  const actualDebuggingPort = await app.evaluate(({ app }) => app.commandLine.getSwitchValue('remote-debugging-port'))
  assert.equal(actualDebuggingPort, String(cdpPort), 'Owned Electron launch did not retain its selected loopback CDP port')
  const observer = path.join(source, 'packages/client/ui-workbench/tests/native-ime.browser.mjs')
  try {
    const result = await run(process.execPath, [observer, '--source-root', source, '--cdp', 'http://127.0.0.1:' + cdpPort,
      '--pid', String(report.pid), '--exe', exe, '--hwnd', report.application.hwnd,
      '--fixture', fixture, '--evidence', path.join(evidence, 'native-input')],
      { cwd: source, windowsHide: true, encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024 })
    report.observer = { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    report.observer = { exitCode: error.code, stdout: error.stdout, stderr: error.stderr }
    throw error
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = String(error.stack ?? error); process.exitCode = 1
  if (page) {
    await page.screenshot({ path: path.join(evidence, 'launch-failure.png') }).catch(() => {})
    await writeFile(path.join(evidence, 'launch-failure.aria.yml'), await page.locator('body').ariaSnapshot().catch(() => '(unavailable)'))
  }
} finally {
  if (app && !exited) {
    report.quitMethod = 'app.quit through the product normal before-quit boundary; no app.exit or process-name kill'
    await app.evaluate(({ app }) => { app.quit() }).catch(() => {})
    let quitTimer
    report.exit = await Promise.race([
      processExit,
      new Promise(resolve => { quitTimer = setTimeout(() => resolve({ timeout: true }), 30000) }),
    ])
    clearTimeout(quitTimer)
    if (report.exit.timeout || report.exit.code !== 0 || report.exit.signal !== null) {
      report.status = 'failed'; process.exitCode = 1
    }
  }
  report.finishedAt = new Date().toISOString()
  await checkpoint()
  console.log(JSON.stringify({ status: report.status, report: path.join(evidence, 'launch-report.json') }))
}
