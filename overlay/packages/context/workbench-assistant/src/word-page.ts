/** Explicit page-region commands resolved from the current acknowledged draft. */
import { z } from 'zod'
import type { WordOperation } from '@deepseek-ai/dsh-workbench-word/types'

export const wordPageSchema = z.object({
  mode: z.enum(['inspect', 'set', 'options']),
  requestId: z.string().uuid().optional().describe('Inspect a returned operation receipt, including while its editor is synchronizing. Never use with editing modes.'),
  sectionIndex: z.number().int().min(0).max(4095).optional().describe('Zero-based section, default 0. Inspect before targeting a multi-section document.'),
  position: z.enum(['header', 'footer']).optional(),
  variant: z.enum(['default', 'first', 'even']).optional(),
  content: z.string().max(2048).regex(/^[^\u0000\r\n]*$/u).optional().describe('Single line. {PAGE}, {NUMPAGES}, {SECTIONPAGES} create live fields, never typed page numbers.'),
  expectedText: z.string().max(4096).optional().describe('Exact existing region text from inspect. Omit only for an empty region.'),
  alignment: z.enum(['left', 'center', 'right']).optional(),
  font: z.string().min(1).max(100).regex(/^[^\u0000\r\n]+$/u).optional(),
  size: z.number().min(6).max(96).optional(),
  firstPageDifferent: z.boolean().optional(),
  oddEvenDifferent: z.boolean().optional(),
  headerDistancePt: z.number().min(0).max(144).optional(),
  footerDistancePt: z.number().min(0).max(144).optional(),
}).strict()
export const wordPageParameters = z.toJSONSchema(wordPageSchema)

/** Validate mode-specific inputs before the command enters the durable queue. */
export function wordPageOperation(input: unknown): WordOperation | null {
  const value = wordPageSchema.parse(input)
  const { mode, sectionIndex = 0, position, variant = 'default', content, expectedText = '', alignment, font, size,
    firstPageDifferent, oddEvenDifferent, headerDistancePt, footerDistancePt } = value
  if (mode === 'inspect') {
    if (Object.keys(value).some(key => key !== 'mode' && key !== 'requestId')) throw new Error('Inspect takes no editing parameters.')
    return null
  }
  if (value.requestId !== undefined) throw new Error('A receipt requestId is read-only; use it only with inspect.')
  const options = { firstPageDifferent, oddEvenDifferent, headerDistancePt, footerDistancePt }
  if (mode === 'options') {
    if (Object.keys(value).some(key => !['mode', 'sectionIndex', ...Object.keys(options)].includes(key))) throw new Error('Use only page options in options mode.')
    if (Object.values(options).every(item => item === undefined)) throw new Error('Specify at least one page option.')
    return { kind: 'page-options', sectionIndex, ...options }
  }
  if (Object.values(options).some(item => item !== undefined)) throw new Error('Set page options in a separate options call.')
  if (position === undefined || content === undefined) throw new Error('Set requires position and content.')
  if (/\{[^}]*\}/u.test(content.replace(/\{(?:PAGE|NUMPAGES|SECTIONPAGES)\}/gu, ''))) throw new Error('Only PAGE, NUMPAGES and SECTIONPAGES fields are supported.')
  return { kind: 'header-footer', sectionIndex, position, variant, content, expectedText, alignment, font, size }
}
