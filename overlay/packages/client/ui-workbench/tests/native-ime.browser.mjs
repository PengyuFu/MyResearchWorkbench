/**
 * Native Windows IME probe for an already-open, caller-owned packaged Workbench.
 * Setup must select the explicit synthetic fixture workspace before attachment.
 * Chinese text is produced only by guarded Win32 scan-code events and the active OS IME.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { promisify } from 'node:util'

const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1])
for (const key of ['--source-root', '--cdp', '--pid', '--exe', '--hwnd', '--fixture', '--evidence']) assert.ok(args.get(key), 'Missing ' + key)
const source = path.resolve(args.get('--source-root'))
const fixture = path.resolve(args.get('--fixture'))
const evidence = path.resolve(args.get('--evidence'))
assert.equal(path.basename(fixture), 'native-ime-fixture-20261022')
const endpoint = new URL(args.get('--cdp'))
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))
assert.equal(endpoint.username + endpoint.password, '')
const exe = path.resolve(args.get('--exe'))
assert.match(path.basename(exe), /MyResearchWorkbench.*\.exe$/i)
const pid = Number(args.get('--pid')), hwnd = args.get('--hwnd')
assert.ok(Number.isSafeInteger(pid) && pid > 0)
assert.match(hwnd, /^\d+$/)
const sha = value => createHash('sha256').update(value).digest('hex')
const baseline = {
  'ime-main.tex': 'a77562f4fce86b5a898a214b1b05303b60e4fbd183a80c2bdb175583dbf42990',
  'ime-check.py': 'a2d46f6c57fcf4b5934b3565ce350e5031fb76d9f28fec2591ae23bd7417c35b',
}
const initial = {}
for (const [name, hash] of Object.entries(baseline)) {
  initial[name] = await readFile(path.join(fixture, name), 'utf8')
  assert.equal(sha(initial[name]), hash, 'Synthetic fixture changed before native input: ' + name)
}
await mkdir(evidence, { recursive: false })
await writeFile(path.join(evidence, 'runner.mjs'), await readFile(new URL(import.meta.url)))
const report = {
  startedAt: new Date().toISOString(), exe, pid, hwnd, fixture, evidence,
  inputMethod: 'Win32 SendInput physical scan-code events received by the active native Windows IME',
  syntheticCompositionEvents: false, unicodeInjection: false, clipboardInput: false,
  globalInputSettingsChanged: false, setup: 'Existing caller-owned Session; fixture identity verified through read-only authenticated Remote',
  checks: [], helperObservations: [], compositionEvents: [], browserErrors: [],
}
const checkpoint = () => writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n')
const run = promisify(execFile)
const native = async (mode, text = '', screenshot = '', click) => {
  const helperPath = path.join(source, 'packages/client/ui-workbench/tests/native-ime-keyboard.ps1')
  const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
    '-ExpectedProcessId', String(pid), '-ExpectedExecutable', exe, '-WindowHandle', hwnd, '-Mode', mode]
  if (text) argv.push('-Text', text)
  if (screenshot) argv.push('-ScreenshotPath', path.join(evidence, screenshot))
  if (click) argv.push('-ClientX', String(click.x), '-ClientY', String(click.y),
    '-ViewportWidth', String(click.width), '-ViewportHeight', String(click.height))
  const result = await run('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', argv,
    { windowsHide: true, encoding: 'utf8', timeout: 15000 })
  assert.equal(result.stderr.trim(), '')
  const observation = JSON.parse(result.stdout)
  report.helperObservations.push(observation)
  await checkpoint()
  return observation
}
const require = createRequire(path.join(source, 'apps/web/package.json'))
const { chromium } = require('playwright')
const browser = await chromium.connectOverCDP(endpoint.href)
const page = browser.contexts().flatMap(context => context.pages()).find(candidate =>
  candidate.url().startsWith('dsh-app://app/') && !new URL(candidate.url()).searchParams.has('mrwPlan'))
assert.ok(page, 'Packaged Workbench page not found')
page.setDefaultTimeout(15000)
page.on('pageerror', error => report.browserErrors.push(String(error)))
const bench = () => page.locator('[data-workbench]').first()
const editor = () => bench().locator('[data-workbench-editor]')
const poll = async (fn, message, timeout = 20000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(message)
}
const action = async name => {
  await editor().getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}
const mode = async name => {
  const button = page.locator('[data-workbench-mode-selector]:visible').getByRole('button', { name: '工作视图', exact: true })
  const item = page.getByRole('menuitem', { name, exact: true })
  await poll(async () => {
    if (await item.isVisible()) return true
    if (await button.getAttribute('aria-expanded') !== 'true') await button.click()
    return await item.isVisible()
  }, 'Mode menu did not remain open after Session composition')
  await item.click()
}
const open = async name => {
  const existingTab = editor().getByRole('tab', { name, exact: true })
  if (await existingTab.isVisible()) {
    await existingTab.click()
    await poll(async () => (await existingTab.getAttribute('aria-selected')) === 'true', 'Requested file tab did not become active')
    return
  }
  const fileRegion = editor().getByRole('region', { name: '文件', exact: true })
  if (!(await fileRegion.isVisible())) await action('文件')
  await fileRegion.getByRole('button', { name, exact: true }).click()
  await editor().getByRole('tab', { name, exact: true }).waitFor()
  assert.equal(await editor().getByRole('tab', { name, exact: true }).getAttribute('aria-selected'), 'true')
}
const readRemote = async name => {
  const sessionId = await bench().locator('[data-conversation-content]').first().getAttribute('data-conversation-session')
  const value = await page.evaluate(async ({ sessionId, name, rpcId }) => {
    const response = await fetch('/api/workbenchWorkspace/read', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'workbenchWorkspace/read',
        payload: { args: { workspaceFileScopeId: sessionId, path: name } } }),
    })
    if (!response.ok) throw new Error('Read-only fixture identity request failed: ' + response.status)
    return response.json()
  }, { sessionId, name, rpcId: randomUUID() })
  assert.equal(value.result.ok, true)
  assert.equal(path.resolve(value.result.value.absolutePath).toLowerCase(), path.join(fixture, name).toLowerCase())
  assert.equal(sha(value.result.value.text), baseline[name])
}
const events = () => page.evaluate(() => window.__mrwNativeImeEvidence ?? [])
const resetEvents = () => page.evaluate(() => { window.__mrwNativeImeEvidence = [] })
const snapshot = async name => {
  await page.screenshot({ path: path.join(evidence, name + '.png') })
  return name + '.png'
}
const check = async (name, fn) => {
  const start = Date.now()
  try {
    const detail = await fn()
    report.checks.push({ name, status: 'passed', elapsedMs: Date.now() - start, detail })
    console.log(JSON.stringify({ name, status: 'passed' }))
  } catch (error) {
    report.checks.push({ name, status: 'failed', elapsedMs: Date.now() - start, error: String(error.stack ?? error) })
    throw error
  } finally { await checkpoint() }
}
const nativeClick = async locator => {
  const point = await locator.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { x: rect.left + Math.min(12, rect.width / 2), y: rect.top + Math.min(12, rect.height / 2),
      width: innerWidth, height: innerHeight }
  })
  await native('Focus')
  await native('Click', '', '', point)
}
const compose = async (label, textLocator, before) => {
  const attempts = []
  for (let attempt = 0; attempt < 2; attempt++) {
    await resetEvents()
    const start = await native('Type', 'nihao')
    // This machine's Sogou can keep preedit in its native candidate window until Space commits it.
    await new Promise(resolve => setTimeout(resolve, 250))
    const during = await events()
    const hasComposition = during.some(event => event.type === 'compositionstart' && event.isTrusted)
    const hasLiteralPinyin = (await textLocator.innerText()).includes('nihao')
    attempts.push({ attempt: attempt + 1, helper: start, during })
    report.compositionAttempts ??= []
    report.compositionAttempts.push({ label, attempt: attempt + 1, during })
    await checkpoint()
    if (!hasComposition && hasLiteralPinyin) {
      const actual = await textLocator.innerText()
      assert.ok(actual.includes('nihao'), 'Native keys produced neither observed IME composition nor literal pinyin')
      await page.keyboard.press('Control+z')
      await poll(async () => (await textLocator.innerText()) === before, 'Cannot safely undo owned literal-pinyin probe')
      if (attempt === 0) { await native('ShiftTap'); continue }
      throw new Error('Native active input method did not produce Chinese composition after the observed Shift tap')
    }
    const composingScreenshot = await snapshot(label + '-composing')
    const nativeCompositionView = await native('Inspect', '', label + '-native-composing.png')
    await native('Commit')
    await poll(async () => {
      const value = await events()
      return value.some(event => event.type === 'compositionend' && event.isTrusted)
        || ((await textLocator.innerText()).includes('你好') && value.some(event => event.type === 'input' && event.isTrusted))
    }, 'Native candidate did not commit Chinese through a trusted editor input event after Space')
    const observed = await events()
    const trustedInputs = observed.filter(event => event.type === 'input' && event.isTrusted)
    const committed = observed.filter(event => event.type === 'compositionend').at(-1)?.data
      ?? trustedInputs.map(event => event.data ?? '').join('')
    assert.equal(committed, '你好', 'Record the actual native IME candidate; do not substitute injected Unicode')
    assert.ok(trustedInputs.length > 0, 'Native commit must produce a trusted editor input event')
    assert.ok(observed.filter(event => event.type.startsWith('composition')).every(event => event.isTrusted))
    assert.ok((await textLocator.innerText()).includes('你好'))
    const preeditMode = hasComposition ? 'DOM composition plus native candidate window'
      : 'Native external candidate window; inspect captured physical screenshot; no pre-commit DOM composition event'
    report.compositionEvents.push({ label, preeditMode, attempts, observed })
    await checkpoint()
    return { composingScreenshot, nativeCompositionView, preeditMode, committed, attempts: attempts.length,
      trustedCompositionEvents: observed.filter(event => event.type.startsWith('composition')).length,
      trustedInputEvents: trustedInputs.length }
  }
}
try {
  await bench().waitFor()
  report.nativeBefore = await native('Inspect')
  report.display = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
    screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight } }))
  for (const name of Object.keys(baseline)) await readRemote(name)
  await page.evaluate(() => {
    window.__mrwNativeImeEvidence = []
    window.__mrwNativeImeListener = event => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-workbench-editor]')) return
      window.__mrwNativeImeEvidence.push({ type: event.type, data: event.data ?? null,
        inputType: event.inputType ?? null, isComposing: event.isComposing ?? null, isTrusted: event.isTrusted,
        timeStamp: event.timeStamp, tag: event.target.tagName,
        editor: event.target.closest('.ProseMirror') ? 'visual' : event.target.closest('.cm-content') ? 'code' : 'other' })
    }
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input']) {
      document.addEventListener(type, window.__mrwNativeImeListener, true)
    }
  })
  await check('native Chinese IME in editable visual paragraph writes an exact UTF-8 source patch', async () => {
    await mode('写作')
    await open('ime-main.tex')
    const visual = editor().locator('.ProseMirror[contenteditable="true"]')
    await visual.waitFor()
    const paragraph = visual.locator('p').filter({ hasText: 'This paragraph receives Chinese composition.' }).first()
    assert.equal(await paragraph.innerText(), 'This paragraph receives Chinese composition.')
    await nativeClick(paragraph)
    await page.keyboard.press('Home')
    const detail = await compose('visual-paragraph', paragraph, 'This paragraph receives Chinese composition.')
    const expected = initial['ime-main.tex'].replace('This paragraph receives Chinese composition.', '你好This paragraph receives Chinese composition.')
    await poll(async () => (await readFile(path.join(fixture, 'ime-main.tex'), 'utf8')) === expected,
      'Native visual input did not persist the exact source patch')
    const writtenSha256 = sha(await readFile(path.join(fixture, 'ime-main.tex')))
    await open('ime-check.py')
    await open('ime-main.tex')
    await poll(async () => (await editor().locator('.ProseMirror').innerText()).includes('你好This paragraph'),
      'Saved Chinese visual paragraph was not retained after reopening')
    return { ...detail, initialSha256: baseline['ime-main.tex'], writtenSha256, exactPatch: true,
      screenshot: await snapshot('visual-paragraph-committed-and-reopened') }
  })
  await check('native Chinese IME in the code editor persists a Python comment without altering executable lines', async () => {
    await mode('开发')
    await open('ime-check.py')
    const code = editor().locator('.cm-content[contenteditable="true"]:visible')
    await code.waitFor()
    await nativeClick(code)
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('End')
    const before = await code.innerText()
    const detail = await compose('python-comment', code, before)
    const expected = initial['ime-check.py'].replace('# Native input verification: ', '# Native input verification: 你好')
    await poll(async () => (await readFile(path.join(fixture, 'ime-check.py'), 'utf8')) === expected,
      'Native code input did not persist the exact comment patch')
    const writtenSha256 = sha(await readFile(path.join(fixture, 'ime-check.py')))
    await open('ime-main.tex')
    await open('ime-check.py')
    await poll(async () => (await editor().locator('.cm-content').innerText()).includes('# Native input verification: 你好'),
      'Saved Chinese code comment was not retained after reopening')
    return { ...detail, initialSha256: baseline['ime-check.py'], writtenSha256, exactPatch: true,
      screenshot: await snapshot('python-comment-committed-and-reopened') }
  })
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = String(error.stack ?? error); process.exitCode = 1
  await snapshot('native-ime-failure').catch(() => {})
  report.nativeFailure = await native('Inspect', '', 'native-ime-failure-physical.png').catch(error => ({ error: String(error) }))
} finally {
  report.lastObservedEvents = await events().catch(error => [{ error: String(error) }])
  report.nativeAfter = await native('Inspect').catch(error => ({ error: String(error) }))
  await page.evaluate(() => {
    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input']) {
      document.removeEventListener(type, window.__mrwNativeImeListener, true)
    }
    delete window.__mrwNativeImeListener
  }).catch(() => {})
  report.finalFixtureHashes = {}
  for (const name of Object.keys(baseline)) report.finalFixtureHashes[name] = sha(await readFile(path.join(fixture, name)))
  report.finishedAt = new Date().toISOString()
  await checkpoint()
  await browser.close()
  console.log(JSON.stringify({ status: report.status, report: path.join(evidence, 'report.json') }))
}
