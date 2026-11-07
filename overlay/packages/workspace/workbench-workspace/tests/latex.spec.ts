/** Opt-in smoke against an existing local TeX installation; never installs packages. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { expect, it } from 'vitest'
import { WorkbenchWorkspace } from '../src/index.ts'

const executable = process.env.MRW_LATEX_EXECUTABLE
const latexmkExecutable = process.env.MRW_LATEXMK_EXECUTABLE

/** A self-contained vector figure, so the smoke needs no image converter or font package. */
function figurePdf(): Buffer {
  const stream = 'q\n0.8 0.9 1 rg\n4 4 64 40 re f\n0.1 0.3 0.5 RG\n2 w\n4 4 64 40 re S\n12 24 m 60 24 l S\nQ\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 48] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

it.skipIf(executable === undefined)('compiles, maps SyncTeX both ways, and keeps the last successful PDF after a failed build', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mrw-latex-'))
  const workspace = join(root, '论文 空格')
  await mkdir(join(workspace, '.vscode'), { recursive: true })
  const args = ['-synctex=1', '-interaction=nonstopmode', '-file-line-error', '-no-shell-escape', '%DOCFILE_EXT%']
  if (/miktex/iu.test(executable!)) args.unshift('--disable-installer')
  await writeFile(join(workspace, '.vscode', 'settings.json'), JSON.stringify({
    'latex-workshop.latex.tools': [{ name: 'existing-tex', command: executable, args, cwd: '%DIR%' }],
    'latex-workshop.latex.recipes': [{ name: 'existing-tex', tools: ['existing-tex'] }],
    'latex-workshop.latex.outDir': '%DIR%',
    'latex-workshop.synctex.path': process.env.MRW_SYNCTEX_EXECUTABLE ?? 'synctex',
  }))
  const source = '\\documentclass{article}\n\\begin{document}\nFirst paragraph for source navigation.\n\nSecond paragraph for source navigation.\n\\input{chapter}\n\\end{document}\n'
  await writeFile(join(workspace, 'main.tex'), source)
  await writeFile(join(workspace, 'chapter.tex'), 'Included chapter without a TeX root directive.\n')
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem, { cwd: workspace })
  await ctx.plugin(LocalSubprocessRuntime)
  const endpoint = new WorkbenchWorkspace(ctx, {
    maxDocumentBytes: 1024 * 1024, maxPdfBytes: 8 * 1024 * 1024, maxEntries: 100,
    maxOutputBytes: 128 * 1024, maxCommandBytes: 128 * 1024, maxRetainedJobs: 4,
    jobTimeoutMs: 60_000, synctexTimeoutMs: 10_000, disposeGraceMs: 500,
    pythonCommands: ['python'], synctexCommand: 'unused-fallback-synctex',
  })
  const scope = { sessionId: SessionId('workbench-latex-test'), workspaceRoot: workspace }
  const signal = new AbortController().signal
  try {
    const started = await endpoint.start(scope, { kind: 'latex', path: 'main.tex', recipe: 'auto' }, signal)
    await expect.poll(() => endpoint.status(scope, started.id).state, { timeout: 60_000 }).not.toBe('running')
    expect(endpoint.status(scope, started.id)).toMatchObject({ state: 'succeeded', exitCode: 0, pdf: { sourcePath: 'main.tex' } })
    const good = await endpoint.pdf(scope, 'main.tex', signal)
    expect(good?.sourcePath).toBe('main.tex')
    expect(good?.sourceVersion).toBe((await endpoint.stat(scope, 'main.tex', signal)).version)
    expect(new TextDecoder().decode(good!.data.subarray(0, 5))).toBe('%PDF-')
    const rootPosition = await endpoint.synctexForward(scope, 'main.tex', 3, 1, undefined, signal)
    expect(rootPosition.page).toBe(1)
    const position = await endpoint.synctexForward(scope, 'chapter.tex', 1, 1, 'main.tex', signal)
    expect(position.page).toBe(1)
    const location = await endpoint.synctexReverse(scope, 'main.tex', position.page, position.x, position.y, signal)
    expect(location.path).toBe('chapter.tex')
    expect(location.line).toBeGreaterThan(0)
    await writeFile(join(workspace, 'main.tex'), source.replace('First paragraph', '\\ThisCommandDoesNotExist First paragraph'))
    const failed = await endpoint.start(scope, { kind: 'latex', path: 'main.tex', recipe: 'auto' }, signal)
    await expect.poll(() => endpoint.status(scope, failed.id).state, { timeout: 60_000 }).toBe('failed')
    expect(endpoint.status(scope, failed.id).diagnostics.length).toBeGreaterThan(0)
    expect((await endpoint.pdf(scope, 'main.tex', signal))!.version).toBe(good!.version)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 150_000)

it.skipIf(latexmkExecutable === undefined)('uses an existing latexmk/BibTeX project recipe for a multi-file paper in a Chinese and space path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mrw-latexmk-'))
  const workspace = join(root, '论文 空格')
  const temporary = join(root, 'compiler-temp')
  const ctx = new Context()
  try {
    for (const directory of ['.vscode', 'chapters', 'figures']) await mkdir(join(workspace, directory), { recursive: true })
    await mkdir(temporary)
    // Keep the real local project's recipe shape. PATH must include its already-installed Perl.
    const path = [dirname(latexmkExecutable!), process.env.MRW_LATEXMK_PATH ?? process.env.PATH ?? ''].join(delimiter)
    await writeFile(join(workspace, '.vscode', 'settings.json'), JSON.stringify({
      'latex-workshop.latex.tools': [{
        name: 'local-latexmk', command: latexmkExecutable,
        args: ['-pdf', '-synctex=1', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '%DOCFILE_EXT%'],
        cwd: '%DIR%', env: { PATH: path, TEMP: temporary, TMP: temporary },
      }],
      'latex-workshop.latex.recipes': [{ name: 'Local MiKTeX (pdfLaTeX + BibTeX)', tools: ['local-latexmk'] }],
      'latex-workshop.latex.recipe.default': 'Local MiKTeX (pdfLaTeX + BibTeX)',
      'latex-workshop.latex.outDir': '%DIR%',
      'latex-workshop.synctex.path': process.env.MRW_SYNCTEX_EXECUTABLE ?? 'synctex',
    }))
    // MiKTeX's documented switch overrides automatic installation. Missing packages fail.
    // The fixture-local rc also applies to latexmk's subsequent bibliography/reference passes.
    const installer = /miktex/iu.test(latexmkExecutable!) ? ' --disable-installer' : ''
    await writeFile(join(workspace, 'latexmkrc'), [
      `$pdflatex = 'pdflatex${installer} -no-shell-escape %O %S';`,
      `$bibtex = 'bibtex${installer} %O %S';`,
      '',
    ].join('\n'))
    await writeFile(join(workspace, 'main.tex'), [
      '\\documentclass{article}',
      '\\usepackage{graphicx}',
      '\\begin{document}',
      '\\section{Workbench recipe fixture}',
      'A complete paper must resolve its bibliography citation~\\cite{darcy1856}.',
      '\\clearpage',
      '\\input{chapters/method}',
      '\\clearpage',
      '\\bibliographystyle{plain}',
      '\\bibliography{references}',
      '\\end{document}',
      '',
    ].join('\n'))
    await writeFile(join(workspace, 'chapters', 'method.tex'), [
      '\\section{Included methods}',
      'This included paragraph is the source-navigation target for the fixture.',
      '',
      '\\begin{equation}',
      '  q = -\\frac{k}{\\mu}\\frac{\\mathrm{d}p}{\\mathrm{d}x}',
      '  \\label{eq:darcy}',
      '\\end{equation}',
      '\\begin{figure}[ht]',
      '  \\centering',
      '  \\includegraphics[width=0.45\\linewidth]{figures/domain.pdf}',
      '  \\caption{A vector fixture representing the flow domain.}',
      '  \\label{fig:domain}',
      '\\end{figure}',
      'Equation~\\ref{eq:darcy} describes the domain in Figure~\\ref{fig:domain};',
      'the reference is resolved by BibTeX~\\cite{darcy1856}.',
      '',
    ].join('\n'))
    await writeFile(join(workspace, 'references.bib'), [
      '@book{darcy1856,',
      '  author = {Henry Darcy},',
      '  title = {Les fontaines publiques de la ville de Dijon},',
      '  publisher = {Dalmont},',
      '  year = {1856}',
      '}',
      '',
    ].join('\n'))
    await writeFile(join(workspace, 'figures', 'domain.pdf'), figurePdf())

    await ctx.plugin(LocalFileSystem, { cwd: workspace })
    await ctx.plugin(LocalSubprocessRuntime)
    const endpoint = new WorkbenchWorkspace(ctx, {
      maxDocumentBytes: 1024 * 1024, maxPdfBytes: 8 * 1024 * 1024, maxEntries: 100,
      maxOutputBytes: 256 * 1024, maxCommandBytes: 128 * 1024, maxRetainedJobs: 4,
      jobTimeoutMs: 120_000, synctexTimeoutMs: 10_000, disposeGraceMs: 500,
      pythonCommands: ['python'], synctexCommand: 'unused-fallback-synctex',
    })
    const scope = { sessionId: SessionId('workbench-latexmk-test'), workspaceRoot: workspace }
    const signal = new AbortController().signal
    const started = await endpoint.start(scope, { kind: 'latex', path: 'main.tex', recipe: 'auto' }, signal)
    await expect.poll(() => endpoint.status(scope, started.id).state, { timeout: 125_000 }).not.toBe('running')
    const finished = endpoint.status(scope, started.id)
    expect(finished.state, finished.error ?? finished.output).toBe('succeeded')
    expect(finished).toMatchObject({ exitCode: 0, pdf: { sourcePath: 'main.tex' } })

    const bibliography = await readFile(join(workspace, 'main.bbl'), 'utf8')
    const auxiliary = await readFile(join(workspace, 'main.aux'), 'utf8')
    const log = await readFile(join(workspace, 'main.log'), 'utf8')
    expect(bibliography).toContain('\\bibitem{darcy1856}')
    expect(auxiliary).toMatch(/\\bibcite\{darcy1856\}\{\d+\}/u)
    expect(auxiliary).toContain('\\newlabel{eq:darcy}')
    expect(auxiliary).toContain('\\newlabel{fig:domain}')
    expect(log).toMatch(/figures[/\\]domain\.pdf/u)
    expect(log).not.toMatch(/(?:Citation[^\n]*undefined|Reference[^\n]*undefined)/iu)
    expect(log).not.toMatch(/There were undefined (?:references|citations)/iu)
    expect(log).not.toMatch(/(?:Label\(s\) may have changed|Rerun to get cross-references right)/iu)
    const pdf = await endpoint.pdf(scope, 'main.tex', signal)
    expect(pdf?.sourcePath).toBe('main.tex')
    expect(pdf?.sourceVersion).toBe((await endpoint.stat(scope, 'main.tex', signal)).version)
    expect(new TextDecoder().decode(pdf!.data.subarray(0, 5))).toBe('%PDF-')
    const position = await endpoint.synctexForward(scope, 'chapters/method.tex', 2, 1, 'main.tex', signal)
    expect(position.page).toBe(2)
    const source = await endpoint.synctexReverse(scope, 'main.tex', position.page, position.x, position.y, signal)
    expect(source.path).toBe('chapters/method.tex')
    expect(source.line).toBeGreaterThan(0)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 180_000)
