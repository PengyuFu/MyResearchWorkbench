/** Real Edge/IndexedDB proof using only synthetic assets and an isolated browser profile. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const dependencyRoot = process.env.MRW_TEST_DEPENDENCY_ROOT ?? repo
const evidence = path.resolve(process.argv[2] ?? path.join(repo, '.tmp/asset-staging-browser'))
const requireRoot = createRequire(path.join(dependencyRoot, 'package.json'))
const ts = requireRoot('typescript')
const { chromium } = createRequire(path.join(dependencyRoot, 'apps/web/package.json'))('playwright')
const sourceRoot = path.join(repo, 'packages/client/ui-workbench/src/client')
await mkdir(evidence, { recursive: true })
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  if (pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html;charset=utf-8' })
    response.end('<!doctype html><html lang="en"><meta charset="UTF-8"><title>MRW asset staging verification</title><style>body{font:18px system-ui;max-width:1000px;margin:40px auto}pre{white-space:pre-wrap;font:15px monospace}img{width:96px;height:96px;image-rendering:pixelated}object{width:600px;height:320px}</style><h1>MRW 0.5.0 asset staging</h1><p>Synthetic files · isolated Edge profile · real IndexedDB</p><div id="previews"></div><pre id="result">Running…</pre><script type="module">window.assetApi=await import("/asset-staging.ts");window.ready=true;</script>')
    return
  }
  if (!/^\/(?:asset-staging|latex-source(?:\.(?:inline|scan|table|types))?)\.ts$/.test(pathname)) { response.writeHead(404); response.end(); return }
  try {
    const source = await readFile(path.join(sourceRoot, pathname.slice(1)), 'utf8')
    const result = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: pathname })
    response.writeHead(200, { 'content-type': 'text/javascript;charset=utf-8' }); response.end(result.outputText)
  } catch (error) { response.writeHead(500); response.end(String(error)) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}/`
let context
const browserErrors = []
const report = { timestamp: new Date().toISOString(), scope: 'synthetic only; no Host credentials or research files', tests: [], browserErrors }
async function open() {
  context = await chromium.launchPersistentContext(path.join(evidence, 'profile'), { channel: 'msedge', headless: true, locale: 'zh-CN', viewport: { width: 1365, height: 900 } })
  const page = context.pages()[0] ?? await context.newPage()
  page.on('pageerror', error => browserErrors.push(String(error)))
  await page.goto(url); await page.waitForFunction(() => window.ready)
  return page
}
try {
  let page = await open()
  const seed = await page.evaluate(async () => {
    const api = window.assetApi, check = (value, name) => { if (!value) throw Error(name) }
    const scope = { sessionId: 'asset-session-a', workspaceRoot: 'C:\\synthetic\\work' }
    const otherSession = { ...scope, sessionId: 'asset-session-b' }, otherWorkspace = { ...scope, workspaceRoot: 'C:\\synthetic\\other' }
    const store = new api.WorkbenchAssetStaging()
    const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8
    const draw = canvas.getContext('2d'); draw.fillStyle = '#136a9b'; draw.fillRect(0, 0, 8, 8); draw.fillStyle = '#f2c75e'; draw.fillRect(1, 1, 3, 5)
    const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    const lines = ['%PDF-1.4\n'], offsets = [0]
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 150] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    const stream = 'BT /F1 20 Tf 24 80 Td (MRW synthetic PDF preview) Tj ET\n'; objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}endstream`)
    objects.forEach((object, index) => { offsets.push(lines.join('').length); lines.push(`${index + 1} 0 obj\n${object}\nendobj\n`) })
    const xref = lines.join('').length; lines.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`)
    offsets.slice(1).forEach(offset => lines.push(`${String(offset).padStart(10, '0')} 00000 n \n`))
    lines.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
    const pdf = new Blob(lines, { type: 'application/pdf' })
    const image = await store.stage(scope, { name: '科研 合成图.png', blob: png })
    const documentAsset = await store.stage(scope, { name: 'synthetic-preview.pdf', blob: pdf })
    check((await store.list(scope)).length === 2, 'two assets persisted')
    check((await store.list(otherSession)).length === 0 && (await store.list(otherWorkspace)).length === 0, 'scope isolation')
    await store.discard(otherSession, image.id)
    check(await store.read(scope, image.id), 'foreign discard cannot remove asset')
    check((await store.stage(scope, { name: 'duplicate.png', blob: png })).id === image.id && (await store.list(scope)).length === 2, 'exact duplicate reused')
    const payload = await api.stagedAssetPayload(image)
    const original = new Uint8Array(await png.arrayBuffer())
    check(payload.data.length === original.length && payload.data.every((byte, index) => byte === original[index]), 'exact image bytes')
    const preview = api.createStagedAssetPreview(documentAsset)
    const fetched = await fetch(preview.url), previewData = new Uint8Array(await fetched.arrayBuffer()), pdfData = new Uint8Array(await pdf.arrayBuffer())
    check(fetched.headers.get('content-type') === 'application/pdf' && previewData.length === pdfData.length && previewData.every((byte, index) => byte === pdfData[index]), 'PDF preview MIME and bytes')
    const object = document.createElement('object'); object.type = 'application/pdf'; object.data = preview.url; document.querySelector('#previews').append(object)
    const imagePreview = api.createStagedAssetPreview(image), img = document.createElement('img'); img.src = imagePreview.url; document.querySelector('#previews').append(img); await img.decode()
    const matches = await store.matching(scope, `\\graphicspath{{figures/workbench/}}\n\\begin{document}\\includegraphics{${image.path.split('/').at(-1)}}\\end{document}`, 'main.tex')
    check(matches.length === 1 && matches[0].id === image.id, 'standalone graphicspath match')
    const subfileMatches = await store.matching(scope, `\\includegraphics{../${documentAsset.path}}`, 'C:\\synthetic\\work\\sections\\part.tex')
    check(subfileMatches.length === 1 && subfileMatches[0].id === documentAsset.id, 'absolute source path and relative includegraphics match')
    const result = { tests: ['exact Blob persistence', 'Session/workspace isolation', 'foreign discard denied', 'duplicate hash reuse', 'binary wire byte identity', 'PDF preview exact MIME/bytes', 'browser PNG decoding', 'standalone includegraphics and graphicspath', 'subfile includegraphics matching'], assets: [image, documentAsset].map(({ id, path, mime, size, sha256, previewKind }) => ({ id, path, mime, size, sha256, previewKind })) }
    document.querySelector('#result').textContent = JSON.stringify(result, null, 2)
    await store.close()
    return result
  })
  report.tests.push(...seed.tests)
  report.assets = seed.assets
  await page.screenshot({ path: path.join(evidence, 'preview.png'), fullPage: true })
  await context.close(); context = undefined
  page = await open()
  const restored = await page.evaluate(async expected => {
    const api = window.assetApi, check = (value, name) => { if (!value) throw Error(name) }
    const scope = { sessionId: 'asset-session-a', workspaceRoot: 'C:\\synthetic\\work' }
    const store = new api.WorkbenchAssetStaging()
    const values = await store.list(scope)
    check(values.length === expected.length, 'actual browser restart count')
    for (const original of expected) {
      const asset = values.find(item => item.id === original.id)
      check(asset && asset.size === original.size && asset.mime === original.mime, 'restored metadata')
      const payload = await api.stagedAssetPayload(asset)
      check(payload.sha256 === original.sha256 && payload.data.length === original.size, 'restored bytes digest')
    }
    check((await store.list({ ...scope, sessionId: 'asset-session-b' })).length === 0, 'restored scope isolation')
    await store.close()
    return { count: values.length, tests: ['actual Edge process restart restores blobs', 'restored Blob SHA256 and byte count', 'scope isolation after restart'] }
  }, seed.assets)
  report.tests.push(...restored.tests)
  report.restoredCount = restored.count
  const limits = await page.evaluate(async () => {
    const api = window.assetApi, check = (value, name) => { if (!value) throw Error(name) }
    const scope = { sessionId: 'asset-session-a', workspaceRoot: 'C:\\synthetic\\work' }, other = { ...scope, sessionId: 'asset-session-b' }
    const store = new api.WorkbenchAssetStaging()
    const clear = async owner => { for (const asset of await store.list(owner)) await store.discard(owner, asset.id) }
    await clear(scope)
    const eps = await store.stage(scope, { name: 'synthetic.eps', blob: new Blob(['%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\nshowpage\n'], { type: 'application/postscript' }) })
    check(api.createStagedAssetPreview(eps).kind === 'unavailable', 'EPS never claims visible preview')
    await clear(scope)
    const outcomes = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => store.stage(index % 2 ? other : scope, { name: `quota-${index}.png`, blob: new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, index])], { type: 'image/png' }) })))
    const accepted = outcomes.filter(value => value.status === 'fulfilled').length
    check(accepted === 8 && (await store.list(scope)).length + (await store.list(other)).length === 8, 'concurrent global eight-file limit')
    check(outcomes.filter(value => value.status === 'rejected').every(value => String(value.reason).includes('ASSET_STAGING_QUOTA')), 'quota errors explicit')
    await clear(scope); await clear(other)
    for (let index = 1; index <= 2; index++) {
      const data = new Uint8Array(api.STAGED_ASSET_LIMITS.fileBytes); data.set(new TextEncoder().encode('%PDF-1.4\n')); data[data.length - 1] = index
      await store.stage(scope, { name: `limit-${index}.pdf`, blob: new Blob([data], { type: 'application/pdf' }) })
    }
    let rejectedTotal = false
    try { await store.stage(scope, { name: 'extra.pdf', blob: new Blob(['%PDF-1.4\nextra'], { type: 'application/pdf' }) }) } catch (error) { rejectedTotal = String(error).includes('ASSET_STAGING_QUOTA') }
    check(rejectedTotal, '32 MiB aggregate limit')
    let rejectedSingle = false
    try { await store.stage(scope, { name: 'large.pdf', blob: new Blob([new Uint8Array(api.STAGED_ASSET_LIMITS.fileBytes + 1)], { type: 'application/pdf' }) }) } catch (error) { rejectedSingle = String(error).includes('ASSET_FILE_SIZE') }
    check(rejectedSingle, '16 MiB individual limit')
    await store.close()
    const future = new api.WorkbenchAssetStaging(indexedDB, () => Date.now() + 40 * 86400000)
    check((await future.list(scope)).length > 0, 'staged resources survive forty days')
    await future.close()
    const current = new api.WorkbenchAssetStaging(); check((await current.list(scope)).length === 0, 'expiry deletion committed'); await current.close()
    return { concurrentAccepted: accepted, tests: ['EPS preview explicitly unavailable', 'concurrent eight-file global quota', '32 MiB aggregate quota', '16 MiB single-file quota', 'no automatic expiry of staged resources'] }
  })
  report.tests.push(...limits.tests)
  report.concurrentAccepted = limits.concurrentAccepted
  assert.equal(browserErrors.length, 0, 'No page errors')
  report.status = 'passed'
  report.completedAt = new Date().toISOString()
  await page.evaluate(value => { document.querySelector('#result').textContent = JSON.stringify(value, null, 2) }, report)
  await page.screenshot({ path: path.join(evidence, 'results.png'), fullPage: true })
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  report.status = 'failed'; report.error = String(error?.stack ?? error)
  console.error(report.error); process.exitCode = 1
} finally {
  await context?.close()
  await new Promise(resolve => server.close(resolve))
  await writeFile(path.join(evidence, 'browser-report.json'), JSON.stringify(report, null, 2))
}
