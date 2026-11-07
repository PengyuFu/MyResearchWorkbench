/** Scientific proposal admission and deterministic, review-only LaTeX serialization. */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { selectionOf } from './prompt.ts'
import type { Config, WorkbenchActionId, WorkbenchProposal, WorkbenchSelectionRequest, WorkbenchStructuredProposal } from './types.ts'

/** Narrow a JSON object at the external tool or durable metadata boundary. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error(`Invalid or oversized ${name}.`)
  return value
}

/** Escape plain scientific text once; structured values never execute LaTeX commands. */
export function escapeProposalText(value: string): string {
  const replacements: Record<string, string> = {
    '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '%': '\\%', '&': '\\&',
    '$': '\\$', '#': '\\#', '_': '\\_', '^': '\\textasciicircum{}', '~': '\\textasciitilde{}',
  }
  return value.replace(/[\\{}%&$#_^~]/g, character => replacements[character] ?? character).replace(/\r?\n/g, ' ')
}

function normalizeAsset(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '')
}

function label(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,255}$/.test(value)) {
    throw new Error('Use a nonempty LaTeX label containing letters, numbers, colon, dot, underscore or hyphen.')
  }
  return value
}

function numericTokens(value: string): string[] {
  return value.match(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []
}

function validateNumbers(values: readonly string[], request: WorkbenchSelectionRequest): void {
  const evidence = new Set(numericTokens([request.selectedText, request.contextBefore, request.contextAfter, request.instruction].join('\n')))
  const missing = [...new Set(values.flatMap(numericTokens).filter(number => !evidence.has(number)))]
  if (missing.length > 0) {
    throw new Error(`The table contains values absent from the supplied selection, context and instruction: ${missing.slice(0, 8).join(', ')}. Supply the real data or leave those cells empty; do not invent results.`)
  }
}

function parseStructured(value: unknown, request: WorkbenchSelectionRequest, limits: Config): WorkbenchStructuredProposal {
  if (!isRecord(value)) throw new Error('Provide a structured figure or table object.')
  const parsedLabel = label(value.label)
  const labelField = parsedLabel === undefined ? {} : { label: parsedLabel }
  if (value.kind === 'figure') {
    const assetPath = text(value.assetPath, 'figure asset path', 4096)
    if (!request.assetPaths?.includes(assetPath)) {
      throw new Error('Select an existing project image first. A figure asset must exactly match a confirmed assetPaths entry; no image was created.')
    }
    if (/[{}%#$&^~\r\n]/.test(assetPath)) throw new Error('The selected image path cannot be represented safely in LaTeX. Rename the asset first.')
    return { kind: 'figure', assetPath, caption: text(value.caption, 'figure caption', limits.maxReplacementChars), ...labelField }
  }
  if (value.kind !== 'table' || !Array.isArray(value.headers) || value.headers.length < 1 || value.headers.length > 100
    || !Array.isArray(value.rows) || value.rows.length > 1000) throw new Error('Provide a table with 1–100 columns and at most 1000 data rows.')
  const headers = value.headers.map(cell => text(cell, 'table header', limits.maxReplacementChars))
  const rows = value.rows.map((row: unknown) => {
    if (!Array.isArray(row) || row.length !== headers.length) throw new Error('Every table row must have the same number of cells as its headers.')
    return row.map(cell => text(cell, 'table cell', limits.maxReplacementChars))
  })
  const caption = value.caption === undefined ? undefined : text(value.caption, 'table caption', limits.maxReplacementChars)
  const alignment = value.alignment
  if (alignment !== undefined && (!Array.isArray(alignment) || alignment.length !== headers.length
    || !alignment.every(item => item === 'l' || item === 'c' || item === 'r'))) throw new Error('Table alignment must provide one l, c or r entry per column.')
  const values = [...headers, ...rows.flat(), ...(caption === undefined ? [] : [caption])]
  if (values.reduce((size, value) => size + value.length, 0) > limits.maxReplacementChars) throw new Error('The proposed table is too large.')
  validateNumbers(values, request)
  return {
    kind: 'table', headers, rows, ...labelField,
    ...(caption === undefined ? {} : { caption }),
    ...(alignment === undefined ? {} : { alignment }),
  }
}

/** Canonical object source is a replacement proposal, never a write to the document. */
export function serializeStructuredProposal(value: WorkbenchStructuredProposal, newline = '\n'): string {
  const lines: string[] = []
  if (value.kind === 'figure') {
    lines.push('\\begin{figure}[htbp]', '\\centering', `\\includegraphics[width=\\linewidth]{${normalizeAsset(value.assetPath)}}`,
      `\\caption{${escapeProposalText(value.caption)}}`)
  } else {
    lines.push('\\begin{table}[htbp]', '\\centering')
    if (value.caption !== undefined && value.caption !== '') lines.push(`\\caption{${escapeProposalText(value.caption)}}`)
    if (value.label !== undefined) lines.push(`\\label{${value.label}}`)
    lines.push(`\\begin{tabular}{${value.alignment?.join('') ?? 'l'.repeat(value.headers.length)}}`, '\\hline',
      value.headers.map(escapeProposalText).join(' & ') + ' \\\\', '\\hline',
      ...value.rows.map(row => row.map(escapeProposalText).join(' & ') + ' \\\\'), '\\hline', '\\end{tabular}', '\\end{table}')
    return lines.join(newline)
  }
  if (value.label !== undefined) lines.push(`\\label{${value.label}}`)
  lines.push('\\end{figure}')
  return lines.join(newline)
}

function uncomment(source: string): string {
  return source.replace(/(^|[^\\])(?:\\\\)*%[^\r\n]*/gm, match => match.slice(0, match.indexOf('%')))
}

function labels(source: string): string[] {
  return [...uncomment(source).matchAll(/\\label\s*\{([^{}]+)\}/g)].flatMap(match => match[1] === undefined ? [] : [match[1]])
}

function graphics(source: string): string[] {
  return [...uncomment(source).matchAll(/\\includegraphics\*?\s*(?:\[[^\]]*\]\s*)?\{([^{}]+)\}/g)]
    .flatMap(match => match[1] === undefined ? [] : [normalizeAsset(match[1].trim())])
}

function labelChanges(before: string, after: string): WorkbenchProposal['labelChanges'] {
  const previous = labels(before), next = labels(after)
  if (new Set(next).size !== next.length) throw new Error('The proposed object contains duplicate labels. Choose a unique label before applying it.')
  const removed = previous.filter(key => !next.includes(key)), added = next.filter(key => !previous.includes(key))
  if (removed.length === 0) return undefined
  const from = removed[0], to = added[0]
  if (removed.length !== added.length || removed.length > 1 || from === undefined || to === undefined) {
    throw new Error('Label removal or multiple label renames cannot be applied atomically from this selection. Keep the labels or propose one explicit rename at a time.')
  }
  return [{ from, to }]
}

function validateRawAssets(replacement: string, request: WorkbenchSelectionRequest): void {
  const originals = new Set(graphics(request.selectedText))
  const confirmed = new Set(request.assetPaths?.map(normalizeAsset) ?? [])
  for (const path of graphics(replacement)) {
    if (!originals.has(path) && !confirmed.has(path)) throw new Error('The replacement references an unconfirmed image. Select an existing project asset before proposing the figure.')
  }
}

/** Admit a tool result using captured inputs and generate label changes on the Host. */
export function createWorkbenchProposal(args: unknown, request: WorkbenchSelectionRequest, limits: Config): WorkbenchProposal {
  if (!isRecord(args)) throw new Error('Provide replacement or structured data and an explanation.')
  const explanation = text(args.explanation, 'proposal explanation', limits.maxInstructionChars)
  const structured = args.structured === undefined ? undefined : parseStructured(args.structured, request, limits)
  const replacement = structured === undefined
    ? text(args.replacement, 'proposed replacement', limits.maxReplacementChars)
    : /\.docx$/iu.test(request.path) ? structured.kind === 'figure' ? structured.caption + '\n[' + structured.assetPath + ']'
      : [structured.caption ?? '', structured.headers.join('\t'), ...structured.rows.map(row => row.join('\t'))].filter(Boolean).join('\n')
      : serializeStructuredProposal(structured, request.selectedText.includes('\r\n') ? '\r\n' : '\n')
  if (replacement.length > limits.maxReplacementChars) throw new Error('The proposed replacement is too large. Propose a smaller edit.')
  validateRawAssets(replacement, request)
  if (structured === undefined && (request.objectKind === 'table' || /\\begin\{tabular\*?\}/.test(replacement))) {
    // Raw legacy proposals may retain existing LaTeX. Ignore command arguments
    // that express layout rather than scientific table data before admission.
    const scientific = replacement.replace(/\\(?:begin|end|label|ref|cite|includegraphics)\s*(?:\[[^\]]*\])?\{[^{}]*\}/g, '')
      .replace(/\\(?:multirow|multicolumn)\s*\{\d+\}/g, '').replace(/\\(?:cline|cmidrule)\s*\{[\d-]+\}/g, '')
    validateNumbers([scientific], request)
  }
  const changes = /\.docx$/iu.test(request.path) ? undefined : labelChanges(request.selectedText, replacement)
  return {
    actionId: brandString<WorkbenchActionId>(request.requestId), replacement, explanation, base: selectionOf(request),
    ...(structured === undefined ? {} : { structured }), ...(changes === undefined ? {} : { labelChanges: changes }),
  }
}

/** Produce lossless, independent JSON metadata accepted by the Session log. */
export function proposalMetadata(proposal: WorkbenchProposal): JsonValue {
  const { assetPaths, attachmentAssets, ...base } = proposal.base
  let structured: JsonValue | undefined
  if (proposal.structured?.kind === 'figure') structured = { ...proposal.structured }
  else if (proposal.structured?.kind === 'table') {
    const { alignment, headers, rows, ...fields } = proposal.structured
    structured = { ...fields, headers: [...headers], rows: rows.map(row => [...row]),
      ...(alignment === undefined ? {} : { alignment: [...alignment] }) }
  }
  return {
    kind: 'workbench-selection-proposal', actionId: proposal.actionId, replacement: proposal.replacement,
    explanation: proposal.explanation, base: {
      ...base,
      ...(assetPaths === undefined ? {} : { assetPaths: [...assetPaths] }),
      ...(attachmentAssets === undefined ? {} : { attachmentAssets: attachmentAssets.map(asset => ({ ...asset })) }),
    },
    ...(structured === undefined ? {} : { structured }),
    ...(proposal.labelChanges === undefined ? {} : { labelChanges: proposal.labelChanges.map(change => ({ ...change })) }),
  }
}

function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => equalJson(value, right[index]))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equalJson(left[key], right[key]))
}

/** Full comparison prevents altered base/object/label metadata from becoming an accepted proposal. */
export function proposalMatches(meta: JsonValue | undefined, proposal: WorkbenchProposal): boolean {
  return equalJson(meta, proposalMetadata(proposal))
}
