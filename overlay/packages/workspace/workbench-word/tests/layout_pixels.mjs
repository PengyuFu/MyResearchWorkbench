/** Compare Word-generated page pixels using the project's existing PDF engine. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
const [source, evidence, output = 'pixel-comparison.json'] = process.argv.slice(2)
const require = createRequire(path.join(source, 'packages/client/ui-sidebar-documentpreview/package.json'))
const pdfModule = require.resolve('pdfjs-dist/legacy/build/pdf.mjs')
const { createCanvas } = createRequire(pdfModule)('@napi-rs/canvas')
const { getDocument } = await import(pathToFileURL(pdfModule).href)
const hash = value => createHash('sha256').update(value).digest('hex')
const report = { passed: false, checks: [] }
try {
  const original = JSON.parse(await readFile(path.join(evidence, 'report.json'), 'utf8'))
  assert.equal(original.passed, true)
  for (const check of original.checks) {
    const tasks = await Promise.all([check.boardPdf,check.referencePdf].map(async file =>
      getDocument({data:new Uint8Array(await readFile(file)),useSystemFonts:false})))
    const [a,b] = await Promise.all(tasks.map(task=>task.promise))
    try {
      assert.equal(a.numPages,b.numPages)
      const pages=[]
      for(let n=1;n<=a.numPages;n++) {
        const results=[]
        for(const [index,pdf] of [a,b].entries()) {
          const page=await pdf.getPage(n),view=page.getViewport({scale:1})
          const canvas=createCanvas(Math.ceil(view.width),Math.ceil(view.height)),context=canvas.getContext('2d')
          await page.render({canvasContext:context,viewport:view}).promise
          results.push({width:canvas.width,height:canvas.height,
            sha256:hash(context.getImageData(0,0,canvas.width,canvas.height).data)})
          if(n===1)await writeFile(path.join(evidence,check.name+(index===0?'-board.png':'-word.png')),canvas.toBuffer('image/png'))
        }
        assert.deepEqual(results[0],results[1],check.name+' page '+n+' differs')
        pages.push({page:n,...results[0]})
      }
      report.checks.push({name:check.name,passed:true,pages})
    } finally { await Promise.all(tasks.map(task=>task.destroy())) }
  }
  report.passed=true
} catch(error) {report.error=String(error);process.exitCode=1}
await writeFile(path.join(evidence,output),JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report))
