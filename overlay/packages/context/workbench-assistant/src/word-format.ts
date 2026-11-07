/** Bounded conversation formatting. No model-supplied offsets or binary file writes. */
import { z } from 'zod'
import type { WordOperation } from '@deepseek-ai/dsh-workbench-word/types'
import type { WorkbenchEditorContext } from './types.ts'
import { uniqueAnchor } from './conversation-context.ts'

const fields = {
  font: z.string().min(1).max(100).regex(/^[^\u0000\r\n]+$/u).optional(),
  size: z.number().min(6).max(96).optional(), bold: z.boolean().optional(),
  alignment: z.number().int().min(0).max(3).optional(),
  spaceBefore: z.number().min(0).max(100).optional(), spaceAfter: z.number().min(0).max(100).optional(),
  lineSpacing: z.number().min(0.5).max(5).optional(),
}
const style = z.object({ level: z.number().int().min(0).max(9), ...fields }).strict()
export const wordFormatSchema = z.object({
  mode: z.enum(['inspect', 'styles', 'format', 'undo', 'redo']),
  styles: z.array(style).min(1).max(10).optional().describe('Required only for mode styles.'),
  anchor: z.string().min(1).max(65536).optional().describe('Exact unique text anchor for mode format; omit to use the current selection.'),
  headingLevel: z.number().int().min(0).max(9).optional(),
  italic: z.boolean().optional(), underline: z.boolean().optional(),
  strike: z.boolean().optional(), script: z.enum(['baseline', 'superscript', 'subscript']).optional(),
  color: z.string().regex(/^(?:[A-Fa-f0-9]{6}|auto)$/u).optional(),
  highlight: z.enum(['none', 'yellow', 'green', 'cyan', 'magenta', 'blue', 'red', 'darkBlue', 'darkCyan', 'darkGreen', 'darkMagenta', 'darkRed', 'darkYellow', 'darkGray', 'lightGray', 'black']).optional(),
  target: z.enum(['selection', 'document']).optional(),
  list: z.enum(['bullet', 'number', 'none']).optional(), ...fields,
}).strict()
export const wordFormatParameters = z.toJSONSchema(wordFormatSchema)

/** Resolve semantic instructions against the exact acknowledged editor frame. */
export function wordFormatOperation(value: unknown, frame: WorkbenchEditorContext): WordOperation | null {
  const { mode, styles, anchor, target, ...format } = wordFormatSchema.parse(value)
  const hasFormat = anchor !== undefined || target !== undefined || Object.keys(format).length > 0
  if (mode !== 'format' && hasFormat || mode !== 'styles' && styles !== undefined) {
    throw new Error('Use only the parameters belonging to the selected mode.')
  }
  if (frame.word === undefined) throw new Error('Open a Word document and wait for its input to be confirmed first.')
  if (mode === 'inspect') return null
  if (mode === 'undo' || mode === 'redo') return { kind: mode }
  if (mode === 'styles') {
    if (styles === undefined) throw new Error('Provide styles when mode is styles.')
    if (new Set(styles.map(item => item.level)).size !== styles.length) throw new Error('Configure each style level only once.')
    return { kind: 'configure-styles', styles: styles }
  }
  if (Object.keys(format).length === 0) throw new Error('Specify a format or heading level.')
  if (anchor !== undefined && target === 'document') throw new Error('Use either a unique anchor or the whole document.')
  const from = target === 'document' ? 0 : anchor === undefined ? frame.selection.from : uniqueAnchor(frame.text, anchor)
  const to = target === 'document' ? Math.max(0, frame.text.length - (frame.text.endsWith('\n') ? 1 : 0)) : anchor === undefined ? frame.selection.to : from + anchor.length
  return { kind: 'format', from, to, before: frame.text.slice(from, to), preserveSelection: anchor === undefined && target !== 'document', ...format }
}
