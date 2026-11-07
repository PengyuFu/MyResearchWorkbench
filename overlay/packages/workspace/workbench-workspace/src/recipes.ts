/** Local LaTeX Workshop recipe settings and TeX directives, without an editor dependency. */
import { posix, win32 } from 'node:path'
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'
import { z } from 'zod'

const toolSchema = z.object({
  name: z.string().min(1), command: z.string().min(1),
  args: z.array(z.string()).max(128).default([]),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
})
const settingsSchema = z.object({
  'latex-workshop.latex.tools': z.array(toolSchema).max(64).optional(),
  'latex-workshop.latex.recipes': z.array(z.object({ name: z.string().min(1), tools: z.array(z.string()).min(1).max(16) })).max(64).optional(),
  'latex-workshop.latex.recipe.default': z.string().optional(),
  'latex-workshop.latex.outDir': z.string().optional(),
  'latex-workshop.latex.external.build.command': z.string().optional(),
  'latex-workshop.latex.external.build.args': z.array(z.string()).max(128).optional(),
  'latex-workshop.synctex.path': z.string().optional(),
})

/** One existing project tool; explicit environment entries are never echoed in output. */
export type LatexTool = z.infer<typeof toolSchema>
/** Validated subset of LaTeX Workshop's project JSONC settings. */
export type LatexSettings = z.infer<typeof settingsSchema>

/**
 * Parse the project file while preserving JSONC support and rejecting invalid recipe data.
 * @param text - .vscode/settings.json contents.
 * @returns supported settings; absent fields do not alter compiler defaults.
 */
export function parseLatexSettings(text: string): LatexSettings {
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true })
  const error = errors[0]
  if (error !== undefined) throw new Error(`Invalid .vscode/settings.json: ${printParseErrorCode(error.error)}`)
  return settingsSchema.parse(value)
}

/**
 * Read a TeX root/program comment from the bounded editor document.
 * @param text - UTF-8 TeX source.
 * @param key - supported directive name.
 * @returns trimmed value, or undefined when the document declares none.
 */
export function texDirective(text: string, key: 'root' | 'program'): string | undefined {
  const match = new RegExp(`^\\s*%\\s*!\\s*(?:TeX|TEX)\\s+${key}\\s*=\\s*(.+?)\\s*$`, 'imu').exec(text)
  return match?.[1]?.trim()
}

/**
 * Expand the documented LaTeX Workshop source/output placeholders.
 * @param value - one command argument, cwd, or environment value.
 * @param source - absolute root .tex path.
 * @param outDir - absolute compiler output directory.
 * @param workspace - absolute Session workspace.
 * @returns expanded text; unresolved placeholders fail instead of launching a wrong recipe.
 */
export function expandLatex(value: string, source: string, outDir: string, workspace: string): string {
  const paths = source.startsWith('/') ? posix : win32
  const ext = paths.extname(source)
  const withoutExt = source.slice(0, source.length - ext.length)
  const slash = (path: string): string => path.replace(/\\/gu, '/')
  const values: Record<string, string> = {
    DOC: slash(withoutExt), DOC_W32: withoutExt,
    DOC_EXT: slash(source), DOC_EXT_W32: source,
    DOCFILE: paths.basename(withoutExt), DOCFILE_EXT: paths.basename(source),
    DIR: slash(paths.dirname(source)), DIR_W32: paths.dirname(source),
    OUTDIR: slash(outDir), OUTDIR_W32: outDir,
    TMPDIR: slash(outDir), WORKSPACE_FOLDER: slash(workspace),
  }
  return value.replace(/%([A-Z_][A-Z_0-9]*)%/gu, (whole: string, name: string) => {
    const replacement = values[name]
    if (replacement === undefined) throw new Error(`Unsupported LaTeX recipe placeholder: ${whole}`)
    return replacement
  })
}

/**
 * Select an existing project recipe by its configured default, otherwise the first one.
 * @param settings - validated project settings.
 * @returns existing tools in recipe order; undefined if no project recipe is declared.
 */
export function projectRecipe(settings: LatexSettings): LatexTool[] | undefined {
  const external = settings['latex-workshop.latex.external.build.command']
  if (external !== undefined && external.trim() !== '') {
    return [{ name: 'external', command: external, args: settings['latex-workshop.latex.external.build.args'] ?? [] }]
  }
  const recipes = settings['latex-workshop.latex.recipes']
  if (recipes === undefined || recipes.length === 0) return undefined
  const preferred = settings['latex-workshop.latex.recipe.default']
  const recipe = preferred === undefined || preferred === 'first' || preferred === 'lastUsed'
    ? recipes[0]
    : recipes.find(item => item.name === preferred)
  if (recipe === undefined) throw new Error(`LaTeX project recipe is unavailable: ${preferred}`)
  const tools = settings['latex-workshop.latex.tools'] ?? []
  return recipe.tools.map((name) => {
    const tool = tools.find(item => item.name === name)
    if (tool === undefined) throw new Error(`LaTeX project recipe refers to an undefined tool: ${name}`)
    return tool
  })
}

/**
 * Infer a recipe's explicit output flag when the project leaves outDir at its default.
 * @param arguments_ - already-expanded tool arguments.
 * @returns the final declared output directory, or undefined when no output flag is present.
 */
export function explicitOutputDirectory(arguments_: readonly string[]): string | undefined {
  let directory: string | undefined
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === undefined) continue
    const match = /^--?(?:outdir|out-directory|output-directory)=(.+)$/u.exec(argument)
    if (match !== null) directory = match[1]
    else if (/^--?(?:outdir|out-directory|output-directory)$/u.test(argument)) directory = arguments_[index + 1]
  }
  return directory
}
