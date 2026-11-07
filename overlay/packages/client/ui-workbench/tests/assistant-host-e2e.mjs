/** Actual Host + Edge ordinary conversation flow; only the external model adapter is scripted. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => { if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1] ?? true]); return pairs }, []))
if (typeof args['source-root'] !== 'string' || typeof args['evidence-root'] !== 'string' || typeof args.python !== 'string') throw new Error('Supply --source-root, a new --evidence-root and the verified --python interpreter path.')
const source = path.resolve(args['source-root']), evidence = path.resolve(args['evidence-root'])
const supplemental = args['supplemental-only'] === 'true'
const resume = typeof args['resume-evidence'] === 'string' ? path.resolve(args['resume-evidence']) : undefined
assert.ok(!supplemental || !resume, 'Supplemental checks use their own new synthetic project and Session.')
const originalReportBytes = resume ? await readFile(path.join(resume, 'report.json')) : undefined
const originalReport = originalReportBytes ? JSON.parse(originalReportBytes) : undefined
const previousEventsBytes = resume ? await readFile(path.join(resume, 'provider-events.jsonl')) : undefined
const previousEvents = previousEventsBytes?.toString('utf8').trim().split('\n').map(JSON.parse) ?? []
const dataRoot = resume ?? evidence, aclOutput = path.join(dataRoot, 'acl-repair')
const fixture = path.join(dataRoot, 'synthetic-project'), profile = path.join(dataRoot, 'edge-profile'), manuscript = path.join(fixture, 'main.tex'), codePath = path.join(fixture, 'sample.py')
const plugin = fileURLToPath(new URL('./fixtures/assistant-host/provider.mjs', import.meta.url))
await mkdir(path.dirname(evidence), { recursive: true }); await mkdir(evidence, { recursive: false })
if (!resume) { await mkdir(path.join(fixture, 'figures'), { recursive: true }); await mkdir(path.join(evidence, 'home')) }
await writeFile(path.join(evidence, 'runner.mjs'), await readFile(new URL(import.meta.url)))
await writeFile(path.join(evidence, 'provider.mjs'), await readFile(plugin))
const paragraph = 'Alpha wording starts this synthetic paragraph. The unchanged middle sentence deliberately provides a long stable context for independent review of two distant edits. Omega wording closes the paragraph.'
const inlineParagraph = 'Cross formula selection starts with prose that intentionally wraps across several visual lines. '
  + 'The stable words before the inline expression remain part of the exact selected source. '.repeat(3)
  + '$a+b=c$'
  + ' The stable words after the inline expression also remain part of the exact selected source.'.repeat(3)
  + ' Cross formula selection ends here.'
const childPath = path.join(fixture, 'parts/child.tex')
const childParagraph = 'Child manuscript text must be edited and saved in its own source file.'
const childBaseline = '% CHILD_PREAMBLE_MUST_REMAIN_EXACT\r\n\\section{Synthetic child}\r\n' + childParagraph
  + '\r\n\r\n% CHILD_TAIL_MUST_REMAIN_EXACT\r\n'
const baseline = String.raw`\documentclass{article}
\usepackage{amsmath,graphicx,booktabs}
% R13_PREAMBLE_MUST_REMAIN_EXACT
\title{Synthetic ordinary conversation review}
\author{Workbench Test}
\begin{document}
\maketitle
${paragraph}${supplemental ? '\n\n' + inlineParagraph + '\n\n\\input{parts/child}' : ''}

Insert chat image here.

Insert exact file here.

Insert rejected image here.

Insert supplied table here.

The linked equation is Eq.~\ref{eq:cases}. The real synthetic image is Fig.~\ref{fig:synthetic}.

\begin{equation}
f(x)=\begin{cases}
x^2 & x\ge0\\
-x & x<0
\end{cases}
\label{eq:cases}
\end{equation}

\begin{table}[htbp]
\centering
\caption{Original synthetic table.}
\label{tab:synthetic}
\begin{tabular}{lcr}
\toprule
Group & Value & Unit\\
\midrule
A & 12 & m\\
B & 24 & s\\
\bottomrule
\end{tabular}
\end{table}

\begin{figure}[htbp]
\centering
\includegraphics[width=0.4\linewidth]{figures/synthetic.png}
\caption{Original synthetic figure.}
\label{fig:synthetic}
\end{figure}

% R13_TAIL_MUST_REMAIN_EXACT
\end{document}
`.replaceAll('\n', '\r\n')
const codeBaseline = 'alpha = 12\r\n# The unchanged middle line deliberately keeps two independent changes apart for review.\r\nomega = 24\r\nprint(alpha, omega)\r\n'
if (!resume) { await writeFile(manuscript, baseline, { flag: 'wx' }); await writeFile(codePath, codeBaseline, { flag: 'wx' }) }
if (supplemental) { await mkdir(path.dirname(childPath)); await writeFile(childPath, childBaseline, { flag: 'wx' }) }
await writeFile(path.join(evidence, 'baseline.tex'), baseline)
// A visible, deterministic synthetic pattern; it does not represent research data.
function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
function pngChunk(kind, data) {
  const name = Buffer.from(kind), length = Buffer.alloc(4), crc = Buffer.alloc(4)
  length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, crc])
}
function syntheticPng(tone = 0) {
  const width = 320, height = 140, raw = Buffer.alloc((width * 3 + 1) * height, 255)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0
    for (let x = 0; x < width; x++) {
      if ((x > 30 && x < 80 && y > 70 && y < 120) || (x > 120 && x < 170 && y > 45 && y < 120) || (x > 210 && x < 260 && y > 20 && y < 120)) {
        const at = y * (width * 3 + 1) + 1 + x * 3; raw[at] = 40 + tone; raw[at + 1] = 118; raw[at + 2] = 178
      }
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}
if (!resume) await writeFile(path.join(fixture, 'figures/synthetic.png'), syntheticPng())
const overlay = [
  '- id: llm-deepseek\n  disabled: true', '- id: llm-deepseek-account\n  disabled: true', '- id: llm-pi-ai\n  disabled: true',
  '- id: session-title-llm\n  disabled: true',
  '- id: agent-default-model\n  config:\n    provider: mrw-scripted\n    model: mrw-protocol-only',
  '- id: directory-picker\n  disabled: true',
  '- insert:\n    - id: directory-picker-browse\n      name: "@deepseek-ai/dsh-host-directory-picker-browse"\n    - id: ui-directory-picker-browse\n      name: "@deepseek-ai/dsh-client-ui-directory-picker-browse"',
  '- insert:\n    - id: mrw-scripted-provider\n      name: ' + JSON.stringify(path.join(evidence, 'provider.mjs').replaceAll('\\', '/')),
].join('\n') + '\n'
await writeFile(path.join(evidence, 'overlay.yml'), overlay)
const require = createRequire(path.join(source, 'apps/web/package.json')), { chromium } = require('playwright')
const sha = value => createHash('sha256').update(value).digest('hex')
const artifactFingerprints = async () => {
  const dist = path.join(source, 'apps/web/dist'), files = ['index.html', ...(await readdir(path.join(dist, 'assets'))).filter(name => /\.(?:js|css)$/.test(name)).map(name => 'assets/' + name)]
  return Object.fromEntries(await Promise.all(files.map(async file => [file, sha(await readFile(path.join(dist, file)))])))
}
const report = { startedAt: new Date().toISOString(), source, evidence, syntheticOnly: true, modelQualityTested: false,
  supplementalOnly: supplemental,
  sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), baselineHash: sha(baseline),
  viewport: { width: 2133, height: 1285 }, artifactsBefore: await artifactFingerprints(), checks: [], rpc: [], browserErrors: [], hosts: [] }
if (resume) {
  assert.ok(originalReport.fatal && originalReport.checks.length === 8 && originalReport.checks.slice(0, 7).every(row => row.status === 'passed'))
  assert.equal(originalReport.checks[7].name, '08-development-chat-creates-opens-and-runs-real-python')
  const sourceChanges = execFileSync('git', ['diff', '--name-only', originalReport.sourceHead, report.sourceHead], { cwd: source, encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  assert.ok(sourceChanges.every(file => ['scripts/client-build-environment.ts', 'scripts/client-build-environment.client.spec.ts'].includes(file)),
    'A resumed actual runtime may only follow the independently checked release-title metadata fix')
  assert.deepEqual(originalReport.artifactsAfter, report.artifactsBefore)
  assert.equal(sha(await readFile(manuscript)), originalReport.finalDiskHash)
  assert.equal(await readFile(codePath, 'utf8'), codeBaseline)
  assert.ok(previousEvents.some(row => row.type === 'tool/result' && row.data.message.isError
    && row.data.message.content.some(part => part.type === 'text'
      && part.text.includes('SetNamedSecurityInfoW failed (Win32 5): grantWrite(' + fixture + ')'))))
  report.sessionId = originalReport.sessionId
  report.priorEvidence = { path: resume, sourceHead: originalReport.sourceHead, sourceChangesSincePriorRun: sourceChanges,
    reportSha256: sha(originalReportBytes), eventSha256: sha(previousEventsBytes),
    checks: originalReport.checks, retainedOriginalFailure: true }
}
const checkpoint = () => writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n')
const scrub = value => String(value).replace(/\u001b\[[0-9;]*m/g, '').replace(/https?:\/\/[^\s"'<>]+/g, value => { try { const url = new URL(value); return url.origin + url.pathname } catch { return '[url]' } })
const env = { ...process.env, DSH_HOME: path.join(dataRoot, 'home'), DSH_AGENTS_HOME: path.join(dataRoot, 'agents'),
  MRW_TEST_SOURCE_ROOT: source, MRW_TEST_EVIDENCE_ROOT: evidence, MRW_TEST_PYTHON: args.python,
  MRW_TEST_WORKSPACE: fixture, MRW_TEST_ACL_OUTPUT: aclOutput }
if (typeof args['acl-powershell'] === 'string') env.MRW_TEST_ACL_POWERSHELL = args['acl-powershell']
for (const key of Object.keys(env)) if (/(KEY|SECRET|TOKEN|PASSWORD)/i.test(key)) delete env[key]
delete env.MRW_DSH_HOME
let host, logFile, page, context, port = '0'
if (resume) {
  const previousLog = await readFile(path.join(resume, 'host-' + originalReport.hosts.length + '.log'), 'utf8')
  const origin = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(previousLog)
  assert.ok(origin, 'The preserved browser origin must come from the actual earlier Host log'); port = origin[1]
}
let logRemainders = new Map()
const poll = async (predicate, message, timeout = 20000) => { const until = Date.now() + timeout; while (Date.now() < until) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 70)) } throw new Error(message) }
async function startHost() {
  logFile = createWriteStream(path.join(evidence, `host-${report.hosts.length + 1}.log`), { flags: 'wx' })
  let text = '', resolveUrl, rejectUrl
  const ready = new Promise((resolve, reject) => { resolveUrl = resolve; rejectUrl = reject })
  host = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--patch', path.join(evidence, 'overlay.yml'), '--no-open', '--host', '127.0.0.1', '--port', port], { cwd: source, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  report.hosts.push({ pid: host.pid, startedAt: new Date().toISOString() })
  logRemainders = new Map()
  const append = (stream, data) => {
    const chunk = data.toString('utf8')
    text = (text + chunk.replace(/\u001b\[[0-9;]*m/g, '')).slice(-200000)
    const lines = ((logRemainders.get(stream) ?? '') + chunk).split(/(?<=\n)/)
    const tail = lines.at(-1)?.endsWith('\n') ? '' : lines.pop() ?? ''
    logRemainders.set(stream, tail)
    for (const line of lines) logFile.write(scrub(line))
    for (const match of text.matchAll(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+[^\s"'<>]*/g)) resolveUrl(match[0])
  }
  host.stdout.on('data', data => append('stdout', data)); host.stderr.on('data', data => append('stderr', data)); host.on('error', rejectUrl); host.once('exit', (code, signal) => rejectUrl(new Error(`Owned Host exited ${code}/${signal}: ${scrub(text).slice(-6000)}`)))
  const timer = setTimeout(() => rejectUrl(new Error('Owned Host startup timed out: ' + scrub(text).slice(-6000))), 90000)
  try { const url = await ready; port = new URL(url).port; return url } finally { clearTimeout(timer) }
}
async function stopHost() {
  if (host?.exitCode === null) { host.kill(); await new Promise(resolve => { host.once('exit', resolve); setTimeout(resolve, 5000).unref() }) }
  for (const tail of logRemainders.values()) if (tail) logFile?.write(scrub(tail))
  logRemainders.clear(); logFile?.end()
}
async function openBrowser(url, previousLocation) {
  context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: !args.headful, locale: 'zh-CN', viewport: { width: 2133, height: 1285 } })
  page = context.pages()[0] ?? await context.newPage(); page.setDefaultTimeout(15000)
  page.on('pageerror', error => report.browserErrors.push(scrub(error)))
  page.on('response', async response => {
    if (!/\/api\/(?:workbenchAssistant|workbenchWorkspace|directoryPicker)\//.test(response.url())) return
    try {
      const body = await response.json(), request = response.request(), input = request.postDataJSON()
      const result = body.result ?? body
      report.rpc.push({ at: new Date().toISOString(), endpoint: new URL(response.url()).pathname, input, output: result })
    } catch {}
  })
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  if (previousLocation) await page.goto(previousLocation)
  await bench().waitFor({ state: 'visible', timeout: 90000 })
  const notice = page.getByRole('dialog', { name: '预览版说明', exact: true })
  if (await notice.isVisible()) await notice.getByRole('button', { name: '继续', exact: true }).click()
}
const bench = () => page.locator('[data-workbench]').first()
const editor = () => bench().locator('[data-workbench-editor]')
const visual = () => editor().locator('[data-workbench-visual-editor]:not([data-readonly="true"]):visible')
const document = () => visual().locator('.ProseMirror')
const card = () => page.locator('[data-workbench-selection]')
const proposal = () => page.locator('[data-workbench-proposal]')
const session = () => bench().locator('[data-conversation-content]').first().getAttribute('data-conversation-session')
const disk = () => readFile(manuscript, 'utf8')
const codeDisk = () => readFile(codePath, 'utf8')
const paragraphNode = () => document().locator(':scope > p').filter({ hasText: /(?:Alpha|Clear|Reviewed) wording/ })
const shot = async name => { const file = path.join(evidence, name + '.png'); await page.screenshot({ path: file, fullPage: true }); return file }
const fullyVisible = locator => locator.evaluate(element => {
  const rect = element.getBoundingClientRect()
  let left = 0, top = 0, right = innerWidth, bottom = innerHeight
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent), box = parent.getBoundingClientRect()
    if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowX)) { left = Math.max(left, box.left); right = Math.min(right, box.right) }
    if (['auto', 'scroll', 'hidden', 'clip'].includes(style.overflowY)) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom) }
  }
  return rect.width > 0 && rect.height > 0 && rect.left >= left - 2 && rect.right <= right + 2 && rect.top >= top - 2 && rect.bottom <= bottom + 2
})

async function check(name, action) {
  const start = Date.now()
  try { const detail = await action(); report.checks.push({ name, status: 'passed', elapsedMs: Date.now() - start, detail }); console.log(JSON.stringify({ name, status: 'passed' })); await checkpoint(); return detail }
  catch (error) { const screenshot = page ? await shot(name + '-failed').catch(() => undefined) : undefined; if (page) await writeFile(path.join(evidence, name + '-failed.aria.yml'), await page.locator('body').ariaSnapshot().catch(() => 'unavailable')); report.checks.push({ name, status: 'failed', elapsedMs: Date.now() - start, error: scrub(error.stack ?? error), screenshot }); await checkpoint(); throw error }
}
async function mode(name) { await page.locator('[data-workbench-mode-selector]:visible').getByRole('button', { name: '工作视图', exact: true }).click(); await page.getByRole('menuitem', { name, exact: true }).click() }
async function createWorkspace(dir) {
  const previous = await session(), add = page.getByRole('button', { name: '添加工作区', exact: true })
  if (await add.isVisible()) await add.click(); else { await page.getByRole('button', { name: '选择工作区', exact: true }).click(); await page.getByRole('menuitem', { name: '添加工作区…', exact: true }).click() }
  const dialog = page.getByRole('dialog', { name: '选择工作区目录', exact: true }); await dialog.waitFor()
  await poll(async () => !(await dialog.getByRole('button', { name: '打开', exact: true }).isDisabled()), 'Directory picker initial home listing did not settle')
  await dialog.getByRole('button', { name: '编辑路径', exact: true }).click()
  const input = dialog.getByRole('textbox', { name: '编辑路径', exact: true }); await input.fill(dir)
  await poll(async () => await input.getAttribute('value') === dir, 'Directory input did not commit the requested path')
  await input.press('Enter'); await input.waitFor({ state: 'hidden' })
  await dialog.getByRole('navigation').getByRole('button', { name: path.basename(dir), exact: true }).waitFor()
  await dialog.getByRole('button', { name: '打开', exact: true }).click(); await dialog.waitFor({ state: 'hidden' })
  await poll(async () => {
    const current = await session()
    return Boolean(current) && current !== previous && report.rpc.some(row => row.endpoint.endsWith('/workbenchWorkspace/list')
      && row.input?.payload?.args?.workspaceFileScopeId === current && row.output.value?.workspaceRoot === dir)
  }, 'Workspace did not acknowledge its requested ordinary Session and root')
}
const composer = () => page.getByRole('textbox', { name: /@ 文件或对话$/ })
const currentEvents = async () => (await readFile(path.join(evidence, 'provider-events.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
const events = async () => [...previousEvents, ...await currentEvents()]
const codeRequest = resume ? 'R13_CODE_RETRY' : 'R13_CODE'
const codeCall = row => row.data.callId?.startsWith('r13-' + codeRequest + '-')
const codeResult = row => row.data.message?.toolCallId?.startsWith('r13-' + codeRequest + '-')
function permissionSnapshot() {
  if (typeof args['acl-powershell'] !== 'string') return undefined
  const quote = value => "'" + value.replaceAll("'", "''") + "'"
  const command = '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); '
    + '$a=Get-Acl -LiteralPath ' + quote(fixture) + '; '
    + '[ordered]@{path=' + quote(fixture) + ';owner=$a.Owner;sddl=$a.Sddl;effectivePolicy=(Get-ExecutionPolicy).ToString();'
    + 'policies=@(Get-ExecutionPolicy -List | ForEach-Object {[ordered]@{scope=$_.Scope.ToString();policy=$_.ExecutionPolicy.ToString()}})} | ConvertTo-Json -Depth 4'
  return JSON.parse(execFileSync(args['acl-powershell'], ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }))
}
const noFile = async target => {
  try { await access(target); throw new Error('An unaccepted asset was already written to the project') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}
async function chat(text, attachment) {
  if (attachment) await page.locator('[data-composer-card] input[type="file"]').setInputFiles(attachment)
  await composer().fill(text)
  const send = page.getByRole('button', { name: '发送消息', exact: true })
  await poll(async () => await send.isVisible() && !(await send.isDisabled()), 'Ordinary composer did not admit the message or attachment')
  await send.click()
}
async function completed(key) {
  await page.getByText(new RegExp(key + '_DONE:')).waitFor({ timeout: 45000 })
  await poll(async () => await page.getByRole('button', { name: '发送消息', exact: true }).isVisible(), 'Ordinary turn did not settle')
}
async function completedCode() {
  let approved = false
  await poll(async () => {
    if (await page.getByText(/R13_CODE_DONE:/).isVisible()) return true
    const trace = await currentEvents()
    const failure = trace.find(row => row.type === 'turn/end' && row.data.reason?.kind === 'error')
    if (failure) {
      report.codeFailure = { reason: failure.data.reason, results: trace.filter(row => row.type === 'tool/result' && codeResult(row)) }
      throw new Error('Actual ordinary Python turn failed: ' + failure.data.reason.error?.message)
    }
    const once = page.getByRole('button', { name: '允许一次', exact: true })
    if (!approved && await once.isVisible()) {
      const text = await page.locator('body').innerText()
      assert.ok(text.includes('仅为修复测试目录 ' + fixture), 'Only the exact synthetic-directory diagnosis is authorized')
      assert.ok(text.includes('文件内容和所有者保持不变'))
      assert.equal(typeof args['acl-powershell'], 'string', 'No automatic approval without explicit scoped diagnostic authorization')
      const calls = trace.filter(row => row.type === 'tool/call' && codeCall(row))
      const pending = calls.at(-1); assert.equal(pending.data.name, 'pwsh')
      const toolArgs = JSON.parse(pending.data.arguments)
      assert.ok(toolArgs.command.includes("-AllowRoot '" + fixture + "'")); assert.equal(toolArgs.sandbox_permissions, 'danger-full-access')
      assert.ok(toolArgs.command.startsWith("& '" + args['acl-powershell'] + "' -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "))
      assert.ok(toolArgs.command.includes("-Path '" + fixture + "'")); assert.ok(toolArgs.command.includes("-Out '" + aclOutput + "'"))
      assert.ok(!/Bypass|Set-ExecutionPolicy|runas|Invoke-Expression/.test(toolArgs.command))
      const script = / -File '([^']+)' -Path /.exec(toolArgs.command)?.[1]; assert.ok(script)
      const scriptSha256 = sha(await readFile(script))
      assert.equal(scriptSha256, sha(await readFile(path.join(source, 'packages/sandbox/sandbox-windows-acl/assets/diagnose-windows-sandbox-acl/scripts/diagnose-windows-sandbox-acl.ps1'))))
      report.singleCommandApproval = { callId: pending.data.callId, command: toolArgs.command, justification: toolArgs.justification,
        script, scriptSha256,
        presetBefore: report.codePresetBefore,
        screenshot: await shot('08-acl-diagnostic-single-command-approval') }
      await once.click(); approved = true
    }
    return false
  }, 'Actual Python conversation did not finish after its bounded diagnostic path', 120000)
  await poll(async () => await page.getByRole('button', { name: '发送消息', exact: true }).isVisible(), 'Python turn did not settle')
}
async function saveExpected(expected) {
  await editor().getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('menuitem', { name: '保存', exact: true }).click()
  await poll(async () => await disk() === expected, 'Saved source bytes did not match the exact reviewed replacement')
}
async function currentProposal(key) {
  const trace = await events()
  const prepared = trace.filter(row => row.type === 'tool/result' && row.data.meta?.kind === 'workbench-conversation-prepared'
    && row.data.meta.request.instruction.startsWith(key)).at(-1)?.data.meta.request
  assert.ok(prepared, 'A real preparation tool result must own the proposal')
  const value = trace.find(row => row.type === 'tool/result' && row.data.meta?.kind === 'workbench-selection-proposal'
    && row.data.meta.actionId === prepared.requestId)?.data.meta
  assert.ok(value, 'A real proposal tool result must contain the review object')
  assert.equal(value.base.selectedText, prepared.selectedText)
  return { prepared, value }
}
function expectedReplacement(before, captured) {
  const normalized = before.replaceAll('\r\n', '\n'), { prepared, value } = captured
  assert.equal(normalized.slice(prepared.from, prepared.to), prepared.selectedText)
  return (normalized.slice(0, prepared.from) + value.replacement + normalized.slice(prepared.to)).replaceAll('\n', '\r\n')
}
async function accept(key, before) {
  const captured = await currentProposal(key), expected = expectedReplacement(before, captured)
  await proposal().getByRole('button', { name: '全部采纳', exact: true }).click()
  await proposal().waitFor({ state: 'hidden' }); await saveExpected(expected)
  await writeFile(path.join(evidence, key + '-accepted.tex'), expected)
  return { ...captured, expected }
}
async function preview(key, prompt, attachment) {
  const before = await disk()
  await chat(prompt, attachment); await proposal().waitFor({ state: 'visible', timeout: 45000 })
  await poll(async () => await page.getByRole('button', { name: '发送消息', exact: true }).isVisible(), 'Prepared review turn did not settle')
  assert.equal(await disk(), before, 'Preparing a review may not alter manuscript bytes')
  assert.equal(await session(), report.sessionId)
  const captured = await currentProposal(key)
  if (captured.prepared.attachmentAssets) for (const asset of captured.prepared.attachmentAssets) await noFile(path.join(fixture, asset.path))
  return { before, captured }
}
async function panelAction(name) {
  await editor().getByRole('button', { name: '更多', exact: true }).click()
  await page.getByRole('menuitem', { name, exact: true }).click()
}
async function clearSelection() {
  if (await card().isVisible()) await card().getByRole('button', { name: '移除选区', exact: true }).click()
  const resumeWriting = page.getByRole('button', { name: '展开写作板', exact: true })
  if (await resumeWriting.isVisible()) await resumeWriting.click()
}
async function textEndpoints(target) {
  await target.scrollIntoViewIfNeeded()
  return target.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), nodes = []
    while (walker.nextNode()) if (walker.currentNode.textContent.length) nodes.push(walker.currentNode)
    const first = nodes[0], last = nodes.at(-1), start = document.createRange(), end = document.createRange()
    start.setStart(first, 0); start.setEnd(first, 1)
    end.setStart(last, last.length - 1); end.setEnd(last, last.length)
    const a = start.getBoundingClientRect(), b = end.getBoundingClientRect()
    return { from: { x: a.left + 0.1, y: a.top + a.height / 2 }, to: { x: b.right + 1, y: b.top + b.height / 2 } }
  })
}
async function supplementalChecks() {
  await createWorkspace(fixture); report.sessionId = await session()
  await chat('R13_OPEN 请在写作板打开项目中的 main.tex，保留本会话。'); await completed('R13_OPEN')
  await paragraphNode().waitFor({ timeout: 30000 }); assert.equal(await disk(), baseline)
  await check('S01-ordinary-file-attachment-accept-save-undo-save-consistency', async () => {
    const bytes = syntheticPng(60), result = await preview('R13_FILE',
      'R13_FILE 用附件 original-figure.png 替换正文 Insert exact file here.，先给可视化提案；我会采纳保存后再撤销保存。',
      { name: 'original-figure.png', mimeType: 'application/octet-stream', buffer: bytes })
    const asset = result.captured.prepared.attachmentAssets?.[0]; assert.ok(asset); assert.equal(asset.kind, 'file')
    await poll(async () => proposal().locator('[data-proposal-side="after"] img').evaluateAll(images => images.length === 1 && images.every(image => image.complete && image.naturalWidth > 0)), 'File attachment preview did not decode')
    const reviewScreenshot = await shot('S01-file-review'), accepted = await accept('R13_FILE', result.before)
    assert.notEqual(accepted.expected, baseline)
    const assetFile = path.join(fixture, asset.path), acceptedAsset = await readFile(assetFile)
    assert.equal(sha(acceptedAsset), sha(bytes)); assert.equal(sha(acceptedAsset), asset.sha256)
    const acceptedScreenshot = await shot('S01-accepted-saved')
    await clearSelection(); await panelAction('撤销'); await saveExpected(baseline)
    assert.equal(sha(await readFile(assetFile)), sha(bytes), 'Undo must not delete or modify an already reviewed project resource')
    assert.equal(await readFile(childPath, 'utf8'), childBaseline)
    assert.equal(sha(await readFile(path.join(fixture, 'figures/synthetic.png'))), sha(syntheticPng()))
    assert.ok(!baseline.includes(asset.path)); assert.equal(await session(), report.sessionId)
    return { actualComposer: true, fileAttachmentId: asset.attachmentId, noProjectWriteBeforeAcceptance: true,
      acceptedSourceSha256: sha(accepted.expected), undoSourceSha256: sha(await disk()), originalSourceSha256: sha(baseline),
      exactSourceRestored: true, reviewedResourceRetainedWithoutSourceReference: true, resourcePath: asset.path,
      uploadedAndRetainedResourceSha256: sha(bytes), originalProjectAssetUnchanged: true,
      reviewScreenshot, acceptedScreenshot, undoScreenshot: await shot('S01-undone-saved') }
  })
  await check('S02-child-visual-edit-exact-save-and-reopen', async () => {
    await chat('R13_CHILD_OPEN 在当前会话中打开子文稿 parts/child.tex。'); await completed('R13_CHILD_OPEN')
    const childNode = () => document().locator(':scope > p').filter({ hasText: childParagraph })
    await childNode().waitFor(); const endpoints = await textEndpoints(childNode())
    await page.mouse.click(endpoints.to.x, endpoints.to.y); await page.keyboard.press('End')
    const addition = ' Reviewed through the child writing surface.'
    await page.keyboard.insertText(addition)
    const expectedChild = childBaseline.replace(childParagraph, childParagraph + addition)
    await panelAction('保存')
    await poll(async () => await readFile(childPath, 'utf8') === expectedChild, 'Child edit was not saved to its exact own source bytes')
    assert.equal(await disk(), baseline); assert.equal(await codeDisk(), codeBaseline)
    await chat('R13_REOPEN 返回 main.tex，不改变任何源文件。'); await completed('R13_REOPEN'); await paragraphNode().waitFor()
    await chat('R13_CHILD_REOPEN 再次打开 parts/child.tex，核对刚才的修改。'); await completed('R13_CHILD_REOPEN')
    await poll(async () => (await childNode().innerText()) === childParagraph + addition, 'Reopened child visual text lost the actual edit')
    assert.equal(await readFile(childPath, 'utf8'), expectedChild); assert.equal(await disk(), baseline)
    return { actualVisualTyping: true, childPath: 'parts/child.tex', beforeSha256: sha(childBaseline), afterSha256: sha(expectedChild),
      exactBytesOutsideChildParagraph: true, mainSourceUnchanged: true, childReopened: true, screenshot: await shot('S02-child-reopened') }
  })
  await check('S03-real-cross-line-inline-formula-selection-maps-exact-source', async () => {
    await chat('R13_MAIN_RETURN 返回 main.tex 的写作板，我要框选包含行内公式的正文。'); await completed('R13_MAIN_RETURN')
    const target = document().locator(':scope > p').filter({ hasText: 'Cross formula selection starts' })
    await target.waitFor(); assert.equal(await target.locator('math-field').count(), 1)
    const endpoints = await textEndpoints(target)
    assert.ok(endpoints.to.y - endpoints.from.y > 30, 'The test must actually cross wrapped visual lines')
    await page.mouse.move(endpoints.from.x, endpoints.from.y); await page.mouse.down()
    await page.mouse.move(endpoints.to.x, endpoints.to.y, { steps: 20 }); await page.mouse.up()
    const ask = visual().getByRole('button', { name: '问这一对象', exact: true })
    await poll(async () => !(await ask.isDisabled()), 'Actual cross-formula mouse selection did not enable selection review')
    const visibleSelection = await page.evaluate(() => {
      const selection = window.getSelection(), range = selection.rangeCount ? selection.getRangeAt(0) : null
      return { text: selection?.toString() ?? '', rects: range ? [...range.getClientRects()].map(rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })) : [] }
    })
    await ask.click(); await card().waitFor(); const selectedSource = await card().locator('details pre').textContent()
    assert.equal(selectedSource, inlineParagraph, 'Visual text on both sides of inline math must map to one exact LaTeX source range')
    assert.equal(await disk(), baseline); assert.equal(await session(), report.sessionId)
    const lineCount = new Set(visibleSelection.rects.filter(rect => rect.width > 0 && rect.height > 0).map(rect => Math.round(rect.y))).size
    assert.ok(lineCount > 1)
    await card().locator('summary').click()
    const screenshot = await shot('S03-cross-inline-math-selection'); await clearSelection()
    assert.equal(report.browserErrors.length, 0, report.browserErrors.join('\n'))
    return { realPointerDrag: true, inlineFormula: '$a+b=c$', selectedSource, renderedLinePositions: lineCount,
      selectionDisplayText: visibleSelection.text, exactSourceRange: true, sourceUnchanged: true, noModelQualityClaim: true, screenshot }
  })
}
let expected = resume ? await readFile(manuscript, 'utf8') : baseline
try {
  await openBrowser(await startHost())
  if (supplemental) await supplementalChecks()
  else {
  if (!resume) {
  await check('01-ordinary-chat-opens-manuscript', async () => {
    await createWorkspace(fixture); report.sessionId = await session()
    await chat('R13_OPEN 请在写作板打开项目中的 main.tex，保留本会话。'); await completed('R13_OPEN')
    await paragraphNode().waitFor({ timeout: 30000 })
    assert.equal(await disk(), baseline); assert.equal(await codeDisk(), codeBaseline)
    await poll(async () => visual().locator('figure img').evaluateAll(images => images.length === 1 && images.every(image => image.complete && image.naturalWidth > 0)), 'Project PNG failed to decode')
    assert.equal(await session(), report.sessionId)
    return { sessionId: report.sessionId, viaActualTool: 'workbench_open_file', screenshot: await shot('01-ordinary-open') }
  })
  await check('02-composer-menus-and-file-reference-survive-workboard-switch', async () => {
    const model = page.getByRole('button', { name: /^选择模型，当前/ }), permission = page.getByRole('button', { name: /^访问模式，当前：/ })
    const before = { model: await model.getAttribute('aria-label'), permission: await permission.getAttribute('aria-label'), session: await session() }
    await model.click(); const modelMenu = page.getByRole('menu', { name: '模型与推理等级', exact: true }); await modelMenu.waitFor()
    assert.ok(await fullyVisible(modelMenu)); await page.keyboard.press('Escape')
    await permission.click(); const permissionMenu = page.getByRole('menu').filter({ hasText: '工作区内修改' })
    await permissionMenu.waitFor(); assert.ok(await fullyVisible(permissionMenu)); await page.keyboard.press('Escape')
    await composer().fill('@main')
    const option = page.getByRole('option').filter({ hasText: 'main.tex' }).first(); await option.waitFor({ timeout: 20000 }); await option.click()
    const referenceDraft = await composer().innerText(); assert.ok(referenceDraft.includes('main.tex'))
    await composer().press('Control+A'); await composer().press('Backspace')
    await mode('开发'); await mode('写作'); await paragraphNode().waitFor()
    assert.equal(await model.getAttribute('aria-label'), before.model); assert.equal(await permission.getAttribute('aria-label'), before.permission)
    assert.equal(await session(), before.session)
    return { ...before, menusFullyVisible: true, selectedFileReference: referenceDraft, sameSessionAndPreset: true, screenshot: await shot('02-composer-menus') }
  })
  await check('03-body-instruction-to-project-figure-review-and-exact-save', async () => {
    await paragraphNode().scrollIntoViewIfNeeded()
    const end = await paragraphNode().evaluate(element => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), nodes = []
      while (walker.nextNode()) nodes.push(walker.currentNode)
      const last = nodes.at(-1), range = document.createRange()
      range.setStart(last, last.length - 1); range.setEnd(last, last.length)
      const box = range.getBoundingClientRect(); return { x: box.right, y: box.top + box.height / 2 }
    })
    await page.mouse.click(end.x, end.y); await page.keyboard.press('End'); await page.keyboard.insertText(' Insert project figure here.')
    expected = baseline.replace(paragraph, paragraph + ' Insert project figure here.'); await saveExpected(expected)
    const result = await preview('R13_PROJECT', 'R13_PROJECT 请执行正文中 Insert project figure here. 这条插图指令，使用项目 figures/synthetic.png，先给我可视化提案。')
    await poll(async () => proposal().locator('[data-proposal-side="after"] img').evaluateAll(images => images.length === 1 && images.every(image => image.complete && image.naturalWidth > 0)), 'Existing image was absent from the actual proposal preview')
    const screenshot = await shot('03-project-figure-review')
    const accepted = await accept('R13_PROJECT', result.before); expected = accepted.expected
    assert.equal(accepted.prepared.selectedText, 'Insert project figure here.'); assert.ok(expected.includes('fig:conversation-project'))
    return { bodyInstructionTypedInVisualEditor: true, noWriteBeforeAcceptance: true, exactSourceOutsideMarker: true,
      existingAssetUnmodified: true, assetPath: accepted.prepared.assetPaths[0], acceptedSha256: sha(expected), screenshot }
  })
  for (const config of [
    { key: 'R13_IMAGE', name: 'chat-image.png', mimeType: 'image/png', tone: 30, anchor: 'Insert chat image here.', kind: 'image' },
    { key: 'R13_FILE', name: 'original-figure.png', mimeType: 'application/octet-stream', tone: 60, anchor: 'Insert exact file here.', kind: 'file' },
  ]) await check(config.key === 'R13_IMAGE' ? '04-chat-image-attachment-figure' : '05-original-file-attachment-exact-bytes', async () => {
    const bytes = syntheticPng(config.tone); await writeFile(path.join(evidence, config.name), bytes)
    const result = await preview(config.key, `${config.key} 请用我刚上传的 ${config.name} 替换正文指令 ${config.anchor}，保留原 LaTeX 方法，先审阅再保存。`,
      { name: config.name, mimeType: config.mimeType, buffer: bytes })
    const staged = result.captured.prepared.attachmentAssets?.[0]; assert.ok(staged); assert.equal(staged.kind, config.kind)
    await poll(async () => proposal().locator('[data-proposal-side="after"] img').evaluateAll(images => images.length === 1 && images.every(image => image.complete && image.naturalWidth > 0)), 'Conversation attachment preview did not decode')
    const screenshot = await shot(config.key + '-attachment-review')
    const accepted = await accept(config.key, result.before); expected = accepted.expected
    const saved = await readFile(path.join(fixture, staged.path)); assert.equal(sha(saved), staged.sha256)
    if (config.kind === 'file') assert.equal(sha(saved), sha(bytes), 'Raw file attachment bytes changed')
    const trace = await events(), original = trace.find(row => row.event === 'session/user'
      && row.content?.some(block => block.type === 'text' && block.text.startsWith(config.key)))
    assert.ok(original.content.some(block => block.type === config.kind && block.attachment.attachmentId === staged.attachmentId))
    return { kind: staged.kind, actualSessionAttachmentId: staged.attachmentId, noProjectWriteBeforeAcceptance: true,
      exactReviewedSourceSaved: true, uploadedSha256: sha(bytes), storedAttachmentSha256: staged.sha256, projectSha256: sha(saved),
      verbatimOriginalFile: config.kind === 'file', imageMayBeNormalizedByHarness: config.kind === 'image', screenshot }
  })
  await check('06-rejected-chat-attachment-never-creates-project-file', async () => {
    const bytes = syntheticPng(90), result = await preview('R13_REJECT',
      'R13_REJECT 用 rejected-figure.png 替换 Insert rejected image here.，先给审阅提案，我会放弃。',
      { name: 'rejected-figure.png', mimeType: 'application/octet-stream', buffer: bytes })
    const asset = result.captured.prepared.attachmentAssets[0]
    await proposal().getByRole('button', { name: '放弃', exact: true }).click(); await proposal().waitFor({ state: 'hidden' })
    assert.equal(await disk(), expected); await noFile(path.join(fixture, asset.path))
    return { projectAssetAbsent: true, sourceUnchanged: true, originalSessionAttachmentRetained: true, screenshot: await shot('06-rejected') }
  })
  await check('07-ordinary-table-review-survives-real-host-restart', async () => {
    const result = await preview('R13_TABLE', 'R13_TABLE 把正文 Insert supplied table here. 换成表格，数据为 Group/Value/Unit；A/12/m，B/24/s。先给我审阅提案。')
    assert.equal(await proposal().locator('[data-proposal-side="after"] table').count(), 1)
    const location = page.url(), modelCalls = (await events()).filter(row => row.event === 'model/request' && row.request === 'R13_TABLE').length
    await shot('07-before-restart'); await page.waitForTimeout(400)
    await context.close(); context = undefined; await stopHost(); await openBrowser(await startHost(), location)
    const recover = editor().getByRole('button', { name: '核对并恢复', exact: true })
    await poll(async () => await recover.isVisible() || await proposal().isVisible(), 'Pending ordinary table review did not return after a real restart', 30000)
    if (await recover.isVisible()) await recover.click()
    await proposal().waitFor({ state: 'visible', timeout: 30000 }); assert.equal(await session(), report.sessionId); assert.equal(await disk(), result.before)
    assert.equal((await events()).filter(row => row.event === 'model/request' && row.request === 'R13_TABLE').length, modelCalls)
    const screenshot = await shot('07-restored-table-review'), accepted = await accept('R13_TABLE', result.before); expected = accepted.expected
    return { originalActionId: accepted.prepared.requestId, sameSession: true, noModelRegeneration: true,
      actualBrowserAndHostRestart: true, editableTablePreview: true, exactAcceptedSource: true, screenshot }
  })
  } else {
    await poll(async () => await session() === report.sessionId, 'Preserved browser did not recover the original real Session', 30000)
    assert.equal(await disk(), expected)
  }
  await check('08-development-chat-creates-opens-and-runs-real-python', async () => {
    const generated = path.join(fixture, 'conversation_sample.py'); if (!resume) await noFile(generated)
    else assert.ok((await readFile(generated, 'utf8')).includes('value = 6 * 7'))
    report.permissionsBefore = permissionSnapshot()
    report.codePresetBefore = await page.getByRole('button', { name: /^访问模式，当前：/ }).getAttribute('aria-label')
    await chat(resume
      ? `${codeRequest} 继续本会话刚才失败的合成 Python 测试。仅对 ${fixture} 使用已审阅的系统诊断脚本，单次命令指定 RemoteSigned；验证后保持当前工作区权限，用 ${args.python} 重试原 conversation_sample.py 一次。`
      : `${codeRequest} 请新建 conversation_sample.py，计算 6 * 7，打印 R13_PYTHON_RESULT=42，在开发板打开并用 ${args.python} 运行。`)
    await completedCode(); await editor().locator('.cm-content').waitFor({ timeout: 30000 })
    assert.equal(await session(), report.sessionId); assert.ok((await editor().locator('.cm-content').innerText()).includes('R13_PYTHON_RESULT='))
    const code = await readFile(generated, 'utf8'); assert.ok(code.includes('value = 6 * 7'))
    const calls = (await currentEvents()).filter(row => row.type === 'tool/result' && codeResult(row))
    const failures = calls.filter(row => row.data.message.isError)
    if (report.singleCommandApproval) {
      assert.equal(calls.length, resume ? 3 : 6); assert.equal(failures.length, resume ? 0 : 1)
      if (!resume) assert.ok(JSON.stringify(failures[0]).includes('SetNamedSecurityInfoW failed (Win32 5): grantWrite('))
      assert.equal(await page.getByRole('button', { name: /^访问模式，当前：/ }).getAttribute('aria-label'), report.singleCommandApproval.presetBefore)
      const trace = await currentEvents(), retry = trace.find(row => row.type === 'tool/call' && row.data.callId === calls.at(-1).data.message.toolCallId)
      assert.equal(JSON.parse(retry.data.arguments).sandbox_permissions, undefined, 'The successful retry must retain confinement')
      report.confinedRetry = { callId: retry.data.callId, arguments: JSON.parse(retry.data.arguments), result: calls.at(-1).data }
      report.permissionsAfter = permissionSnapshot()
      assert.equal(report.permissionsAfter.owner, report.permissionsBefore.owner)
      assert.deepEqual(report.permissionsAfter.policies, report.permissionsBefore.policies)
    } else { assert.equal(calls.length, 3); assert.equal(failures.length, 0) }
    assert.ok(JSON.stringify(calls.at(-1)).includes('R13_PYTHON_RESULT=42'))
    assert.equal(await editor().getByRole('button', { name: /^(新建|运行|文件)$/ }).count(), 0)
    return { tools: ['write', 'workbench_open_file', 'pwsh'], realPythonOutput: 'R13_PYTHON_RESULT=42', generatedCodeSha256: sha(code),
      outputInActualConversationToolResult: true, sourceEditorVisible: true,
      existingWindowsDiagnosticRequired: Boolean(report.singleCommandApproval), priorCreationAndOpenEvidence: resume,
      finalExecutionConfined: true, noDevelopmentActionToolbar: true, screenshot: await shot('08-real-python') }
  })
  await check('09-final-session-provenance-and-artifact-integrity', async () => {
    await chat('R13_REOPEN 返回 main.tex 的写作板，保留同一会话、模型和权限。'); await completed('R13_REOPEN'); await paragraphNode().waitFor()
    await chat('R13_NORMAL 确认仍然是当前普通对话。'); await completed('R13_NORMAL')
    const trace = await events(), requests = trace.filter(row => row.event === 'model/request')
    assert.ok(requests.every(row => row.sessionId === report.sessionId && row.provider === 'mrw-scripted' && row.model === 'mrw-protocol-only'))
    const captured = trace.filter(row => row.type === 'tool/result' && row.data.meta?.kind === 'workbench-conversation-prepared')
    assert.equal(captured.length, 5)
    assert.equal(report.rpc.filter(row => row.endpoint.endsWith('/workbenchAssistant/request')).length, 0,
      'Ordinary conversation scenarios must not bypass the composer through selected-text request RPC')
    const reviewMessages = trace.flatMap(row => row.event === 'session/user' ? [{ sessionId: row.sessionId, source: row.source, content: row.content }]
      : row.type === 'agent/inbox/spliced' ? (row.data.inserted ?? []).map(message => ({ sessionId: row.sessionId, ...message })) : [])
    const reviews = new Map()
    for (const message of reviewMessages) if (message.source?.rpcId?.startsWith('workbench-review:')) reviews.set(message.source.rpcId, message)
    assert.equal(reviews.size, 5); assert.ok([...reviews.values()].every(message => message.sessionId === report.sessionId))
    report.reviewProvenance = [...reviews.keys()]
    assert.equal(await disk(), expected); assert.equal(await codeDisk(), codeBaseline)
    assert.equal(sha(await readFile(path.join(fixture, 'figures/synthetic.png'))), sha(syntheticPng()))
    assert.equal(report.browserErrors.length, 0, report.browserErrors.join('\n'))
    return { actualOrdinaryRequests: requests.length, sameSessionAndModel: true, exactReviewedFinalManuscript: true,
      noSelectedTextRequestShortcut: true, allFiveReviewsInOriginalSession: true, existingProjectAssetUnchanged: true,
      modelQualityTested: false, deterministicExternalModelBoundaryOnly: true, screenshot: await shot('09-final') }
  })
  }
} catch (error) { report.fatal = scrub(error.stack ?? error); console.log(JSON.stringify({ fatal: report.fatal.slice(0, 6000) })) }
finally {
  if (report.permissionsBefore && !report.permissionsAfter) report.permissionsAfter = permissionSnapshot()
  if (page) { await shot('final').catch(() => {}); report.finalVisibleText = (await page.locator('body').innerText().catch(() => '')).slice(0, 24000); await writeFile(path.join(evidence, 'final.aria.yml'), await page.locator('body').ariaSnapshot().catch(() => 'unavailable')) }
  report.finalDiskHash = sha(await disk()); report.finalCodeHash = sha(await codeDisk()); report.artifactsAfter = await artifactFingerprints(); report.artifactsChangedDuringRun = JSON.stringify(report.artifactsBefore) !== JSON.stringify(report.artifactsAfter)
  report.finishedAt = new Date().toISOString(); await context?.close().catch(() => {}); await stopHost(); await checkpoint()
}
const failed = Boolean(report.fatal || report.artifactsChangedDuringRun || report.checks.some(row => row.status === 'failed'))
console.log(JSON.stringify({ evidence, checks: report.checks.map(({ name, status }) => ({ name, status })), failed }))
process.exitCode = failed ? 1 : 0
