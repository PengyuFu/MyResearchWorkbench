import { describe, expect, it } from 'vitest'
import { expandLatex, explicitOutputDirectory, parseLatexSettings, projectRecipe, texDirective } from '../src/recipes.ts'
import { parseDiagnostics } from '../src/diagnostics.ts'

describe('project build recipes', () => {
  it('reads JSONC and preserves explicit recipe order', () => {
    const settings = parseLatexSettings(`{
      // Existing VS Code project settings
      "latex-workshop.latex.tools": [
        {"name":"latex", "command":"xelatex", "args":["%DOC_EXT%"]},
        {"name":"bib", "command":"biber", "args":["%DOCFILE%"]},
      ],
      "latex-workshop.latex.recipes":[{"name":"paper", "tools":["latex","bib","latex"]}],
      "latex-workshop.latex.recipe.default":"paper",
    }`)
    expect(projectRecipe(settings)?.map(tool => tool.command)).toEqual(['xelatex', 'biber', 'xelatex'])
  })

  it('does not silently substitute a missing configured tool', () => {
    expect(() => projectRecipe(parseLatexSettings('{"latex-workshop.latex.recipes":[{"name":"paper","tools":["missing"]}]}'))).toThrow('undefined tool')
    expect(() => parseLatexSettings('{broken')).toThrow('Invalid .vscode')
  })

  it('uses full and extension-free placeholders with the documented Windows spelling', () => {
    const source = 'D:\\论文 空格\\main.tex'
    const out = 'D:\\论文 空格\\build'
    expect(expandLatex('%DOC%|%DOC_EXT%|%DOCFILE%|%DOC_EXT_W32%|%OUTDIR%', source, out, 'D:\\论文 空格')).toBe('D:/论文 空格/main|D:/论文 空格/main.tex|main|D:\\论文 空格\\main.tex|D:/论文 空格/build')
    expect(() => expandLatex('%UNKNOWN%', source, out, 'D:\\论文 空格')).toThrow('Unsupported')
  })

  it('reads explicit source root and engine directives', () => {
    expect(texDirective('% !TeX root = ../论文.tex\nText', 'root')).toBe('../论文.tex')
    expect(texDirective('% !TEX program = xelatex\n', 'program')).toBe('xelatex')
    expect(texDirective('Normal text', 'program')).toBeUndefined()
  })

  it('uses an existing external build command and explicit output-directory flag', () => {
    const settings = parseLatexSettings('{"latex-workshop.latex.external.build.command":"python", "latex-workshop.latex.external.build.args":["build.py"]}')
    expect(projectRecipe(settings)).toEqual([{ name: 'external', command: 'python', args: ['build.py'] }])
    expect(explicitOutputDirectory(['-pdf', '-outdir=build/论文'])).toBe('build/论文')
    expect(explicitOutputDirectory(['--output-directory', 'output'])).toBe('output')
  })

  it('keeps a project local toolchain, environment, cwd, and SyncTeX path together', () => {
    const settings = parseLatexSettings(JSON.stringify({
      'latex-workshop.latex.tools': [{ name: 'local-latexmk', command: 'D:\\Local TeX\\latexmk.exe', args: ['-pdf', '%DOCFILE_EXT%'], cwd: '%DIR%', env: { PATH: 'D:\\Local TeX;D:\\Local Perl', TEMP: 'D:\\Temp' } }],
      'latex-workshop.latex.recipes': [{ name: 'Local TeX', tools: ['local-latexmk'] }],
      'latex-workshop.latex.recipe.default': 'Local TeX',
      'latex-workshop.latex.outDir': '%DIR%',
      'latex-workshop.synctex.path': 'D:\\Local TeX\\synctex.exe',
    }))
    const tool = projectRecipe(settings)?.[0]
    expect(tool?.command).toBe('D:\\Local TeX\\latexmk.exe')
    expect(tool?.env).toEqual({ PATH: 'D:\\Local TeX;D:\\Local Perl', TEMP: 'D:\\Temp' })
    expect(tool?.cwd).toBe('%DIR%')
    expect(expandLatex(tool!.args[1]!, 'D:\\论文 空格\\main.tex', 'D:\\论文 空格', 'D:\\论文 空格')).toBe('main.tex')
    expect(settings['latex-workshop.synctex.path']).toBe('D:\\Local TeX\\synctex.exe')
  })
})

describe('source diagnostics', () => {
  it('keeps Windows paths and source columns in C++ diagnostics', () => {
    expect(parseDiagnostics('D:\\项目\\main.cpp:12:8: error: expected semicolon', 'main.cpp')).toEqual([
      { path: 'D:\\项目\\main.cpp', line: 12, column: 8, severity: 'error', message: 'expected semicolon' },
    ])
  })

  it('resolves relative diagnostics against the producing command, not the workspace root', () => {
    expect(parseDiagnostics('./chapter.tex:2: Undefined control sequence.', 'D:\\项目\\paper\\main.tex', 'D:\\项目\\paper')).toEqual([
      { path: 'D:\\项目\\paper\\chapter.tex', line: 2, severity: 'error', message: 'Undefined control sequence.' },
    ])
  })

  it('links classic TeX, Python traceback, and CUDA output', () => {
    const diagnostics = parseDiagnostics('! Undefined control sequence.\nl.24 \\bad\n  File "hello.py", line 3, in <module>\nValueError: example\nkernel.cu(9): error: missing identifier', 'paper.tex')
    expect(diagnostics.map(item => [item.path, item.line, item.severity])).toEqual([
      ['paper.tex', 24, 'error'], ['hello.py', 3, 'error'], ['kernel.cu', 9, 'error'],
    ])
  })

  it('bounds and deduplicates diagnostics', () => {
    const output = Array.from({ length: 200 }, (_, index) => `file.cpp:${index + 1}:1: warning: example`).join('\n')
    expect(parseDiagnostics(output + '\n' + output, 'file.cpp')).toHaveLength(100)
  })
})
