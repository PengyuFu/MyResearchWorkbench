/** Native Word task parameters validated before reaching the editor queue. */
import { z } from 'zod'
import type { WordOperation } from '@deepseek-ai/dsh-workbench-word/types'
import type { WorkbenchEditorContext } from './types.ts'
import { uniqueAnchor } from './conversation-context.ts'

const count = z.number().int().min(1).max(100)
const twips = z.number().min(0).max(31680).optional()
// JSON Schema cannot carry the JavaScript Unicode flag; enforce the full name rule locally.
const name = z.string().refine(value => /^[\p{L}][\p{L}\p{N}_]{0,39}$/u.test(value), 'Invalid bookmark name.').meta({
  description: '1–40 Unicode characters. Start with a Unicode letter (including Chinese); use only letters, numbers and underscores thereafter.',
  minLength: 1, maxLength: 40,
})
const command = z.discriminatedUnion('type', [
  z.object({ type: z.literal('autoFitTable'), mode: z.enum(['content', 'window']), resetRowHeights: z.boolean().optional() }).strict(),
  z.object({ type: z.enum(['clearFormatting', 'deleteRow', 'deleteColumn', 'deleteTable', 'mergeCells', 'insertToc', 'removeHyperlink', 'copyFormatting', 'pasteFormatting']) }).strict(),
  z.object({ type: z.literal('insertBreak'), kind: z.enum(['page', 'line', 'section', 'sectionContinuous']) }).strict(),
  z.object({ type: z.enum(['insertTable', 'splitCell']), rows: count, cols: count }).strict(),
  z.object({ type: z.literal('insertRow'), where: z.enum(['above', 'below']) }).strict(),
  z.object({ type: z.literal('insertColumn'), where: z.enum(['left', 'right']) }).strict(),
  z.object({ type: z.literal('selectTableRegion'), region: z.enum(['table', 'row', 'column']) }).strict(),
  z.object({ type: z.literal('setTableCellVerticalAlignment'), alignment: z.enum(['top', 'center', 'bottom']) }).strict(),
  z.object({ type: z.literal('setTableProperties'), styleId: z.string().min(1).max(100).optional(), headerRowCount: z.number().int().min(0).max(100).optional(), columnWidthsTwips: z.array(z.number().int().min(1).max(31680)).min(1).max(100).optional() }).strict(),
  z.object({ type: z.literal('setParagraphPagination'), pageBreakBefore: z.boolean().optional(), keepNext: z.boolean().optional(), keepLines: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('setIndent'), left: twips, right: twips, firstLine: z.number().min(-31680).max(31680).optional() }).strict(),
  z.object({ type: z.literal('setPageSetup'), pageWidth: twips, pageHeight: twips, marginTop: twips, marginRight: twips, marginBottom: twips, marginLeft: twips, orientation: z.enum(['portrait', 'landscape']).optional(), scope: z.enum(['document', 'section']).optional() }).strict(),
  z.object({ type: z.literal('replaceAllMatches'), query: z.string().min(1).max(4096), text: z.string().max(8192), matchCase: z.boolean().optional(), wholeWord: z.boolean().optional() }).strict(),
  z.object({ type: z.literal('insertHyperlink'), href: z.string().max(2048).regex(/^(?:https?:\/\/|mailto:|#)[^\s\u0000]+$/iu), text: z.string().max(8192).optional() }).strict(),
  z.object({ type: z.enum(['insertBookmark', 'deleteBookmark', 'goToBookmark']), name }).strict(),
  z.object({ type: z.literal('refreshToc'), mode: z.enum(['entire', 'pageNumbers']) }).strict(),
  z.object({ type: z.literal('setImageWrapType'), target: z.enum(['inline', 'square', 'squareLeft', 'squareRight', 'tight', 'through', 'topAndBottom', 'behind', 'inFront']), drawingNodeId: z.string().max(200).optional() }).strict(),
  z.object({ type: z.literal('transformImage'), action: z.enum(['rotateCW', 'rotateCCW', 'flipH', 'flipV']), drawingNodeId: z.string().max(200).optional() }).strict(),
  z.object({ type: z.literal('deleteImage'), drawingNodeId: z.string().max(200).optional() }).strict(),
])
export const wordCommandSchema = z.object({ command, anchor: z.string().min(1).max(65536).optional(), target: z.enum(['selection', 'document']).optional() }).strict()
export const wordCommandParameters = z.toJSONSchema(wordCommandSchema)

/** @param input - Model or local command. @param frame - Current confirmed draft. @returns A bounded editor mutation. */
export function wordCommandOperation(input: unknown, frame: WorkbenchEditorContext): WordOperation {
  const value = wordCommandSchema.parse(input)
  if (!frame.word) throw new Error('Open the DOCX writing board first.')
  if (value.anchor !== undefined && value.target === 'document') throw new Error('Choose an anchor or the document, not both.')
  const from = value.target === 'document' ? 0 : value.anchor === undefined ? frame.selection.from : uniqueAnchor(frame.text, value.anchor)
  const to = value.target === 'document' ? Math.max(0, frame.text.length - (frame.text.endsWith('\n') ? 1 : 0)) : value.anchor === undefined ? frame.selection.to : from + value.anchor.length
  if ((value.command.type === 'insertTable' || value.command.type === 'splitCell') && value.command.rows * value.command.cols > 400) throw new Error('Use at most 400 cells in one command.')
  if (value.command.type === 'setParagraphPagination' && value.command.pageBreakBefore === undefined && value.command.keepNext === undefined && value.command.keepLines === undefined) throw new Error('缺少分页设置。')
  return { kind: 'native', command: value.command, from, to, before: frame.text.slice(from, to), preserveSelection: value.anchor === undefined && value.target !== 'document' }
}
