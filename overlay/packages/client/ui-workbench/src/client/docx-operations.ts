/** User and reviewed AI commands enter the same editor mutation/undo path. */
import type { DocxEditorInstance } from '@docx-editor.dev/core/editor'
import type { EditorCommand, EditorExecOptions, HistoryGroup } from '@docx-editor.dev/core/contracts/editor'
import type { WordOperation } from '@deepseek-ai/dsh-workbench-word/types'
import { sniffImageMime, projectDrawing, findNode } from '@docx-editor.dev/core/store'
import { configureDocxStyles, headingStyle } from './docx-styles.ts'
import { docxPosition, docxProjection, docxSelection } from './docx-projection.ts'
import { applyDocxPage } from './docx-page.ts'
import { applyDocxNative } from './docx-native.ts'

function exec(editor: DocxEditorInstance, command: EditorCommand, options?: EditorExecOptions): void {
  const result = editor.exec(command, options)
  if (!result.ok) throw new Error(result.reason)
}
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
/**
 * Apply an accepted command through the retained OOXML editor.
 * @param editor - Authoritative open document.
 * @param operation - Validated user or reviewed assistant command.
 */
export async function applyDocxOperation(editor: DocxEditorInstance, operation: WordOperation, group?: HistoryGroup): Promise<void> {
  if (operation.kind === 'header-footer' || operation.kind === 'page-options') { applyDocxPage(editor, operation, group); return }
  if (operation.kind === 'undo' || operation.kind === 'redo') { exec(editor, { type: operation.kind }); return }
  if (operation.kind === 'configure-styles') { configureDocxStyles(editor, operation.styles); return }
  if (operation.kind === 'resize-image') {
    const surface = editor.surface
    const part = surface?.session.part()
    const node = part && findNode(part, operation.nodeId)
    const drawing = node?.kind === 'drawing' && part ? projectDrawing(node, { ownerPartName: part.name,
      limits: { maxCompatibilityBranches: 64, maxVisitedElements: 4096, maxDrawingDepth: 64 }, supportedMcRequires: new Set() }) : null
    if (!drawing || !surface) throw new Error('The selected image no longer exists.')
    const cx = Math.round(operation.width * 12700)
    const cy = Math.round(cx * drawing.extentEmu.cy / drawing.extentEmu.cx)
    const result = surface.applyAutomationOps(() => [{ op: 'resizeDrawing', drawingNodeId: drawing.drawingNodeId, extentEmu: { cx, cy } }])
    if (result.rejected) throw new Error(result.reason)
    return
  }
  if (!('from' in operation)) return
  const projection = docxProjection(editor)
  if (operation.before !== undefined && projection.text.slice(operation.from, operation.to) !== operation.before) {
    throw new Error('The selected DOCX text changed. Review the current draft before applying.')
  }
  if ((operation.kind === 'native' || operation.kind === 'format') && operation.preserveSelection) {
    const selection = docxSelection(editor, projection)
    if (selection.from !== operation.from || selection.to !== operation.to) throw new Error('The selection changed before the command. Select the target again.')
  } else exec(editor, { type: 'setSelection', range: {
    anchor: docxPosition(projection, operation.from), head: docxPosition(projection, operation.to) } })
  if (operation.kind === 'native') { applyDocxNative(editor, operation.command); return }
  if (operation.kind === 'replace') {
    const from = docxPosition(projection, operation.from), to = docxPosition(projection, operation.to)
    const surface = editor.surface
    if (surface && from.paragraphId === to.paragraphId && !/[\r\n\v\f\u2028\u2029]/u.test(operation.text)
      && editor.getEditingMode() === 'editing') {
      // Insert inside the original run BEFORE deleting it. Deleting the full run
      // first loses its rFonts/sz/theme/language properties and falls back to defaults.
      const result = surface.applyAutomationOps(() => [
        ...(operation.text ? [{ op: 'insertText' as const, paragraphId: from.paragraphId,
          offset: from.offset, text: operation.text, bias: 'right' as const }] : []),
        ...(to.offset > from.offset ? [{ op: 'deleteText' as const, paragraphId: from.paragraphId,
          start: from.offset + operation.text.length, end: to.offset + operation.text.length }] : []),
      ])
      if (result.rejected) throw new Error(result.reason)
    } else {
      const format = editor.getSelectionFormatting()
      const historyGroup = group ?? editor.beginHistoryGroup(), options = { historyGroup }
      try {
        exec(editor, { type: 'insertText', text: operation.text }, options)
        if (operation.text && format) {
          const updated = docxProjection(editor)
          exec(editor, { type: 'setSelection', range: { anchor: docxPosition(updated, operation.from),
            head: docxPosition(updated, operation.from + operation.text.length) } }, options)
          if (format.fontFamily) exec(editor, { type: 'setMarkAttr', mark: 'fontFamily', attr: 'family', value: format.fontFamily }, options)
          if (format.fontSizeHalfPoints) exec(editor, { type: 'setMarkAttr', mark: 'fontSize', attr: 'val', value: format.fontSizeHalfPoints }, options)
        }
      } finally { if (!group) historyGroup.end() }
    }
    return
  }
  if (operation.kind === 'image') {
    if (operation.data === undefined) throw new Error('The selected image bytes are unavailable.')
    const data = Uint8Array.from(atob(operation.data), character => character.charCodeAt(0))
    const mime = sniffImageMime(data)
    if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/gif' && mime !== 'image/bmp' && mime !== 'image/webp') throw new Error('The image format is not supported.')
    const bitmap = await createImageBitmap(new Blob([data], { type: mime }))
    const widthPoints = operation.width ?? Math.min(400, bitmap.width * 0.75)
    const heightPoints = widthPoints * bitmap.height / bitmap.width
    bitmap.close()
    const result = await editor.executeImageCommand({ type: 'insertImage', data, mime, widthPoints, heightPoints })
    if (!result.ok) throw new Error(result.reason)
    if (operation.caption) exec(editor, { type: 'insertText', text: '\n' + operation.caption })
    return
  }
  if (operation.kind === 'table') {
    const html = '<table>' + operation.rows.map(row => '<tr>' + row.map(cell => '<td><p>' + escape(cell) + '</p></td>').join('') + '</tr>').join('')
      + '</table>' + (operation.caption ? '<p>' + escape(operation.caption) + '</p>' : '')
    if (editor.surface?.pasteRich(operation.rows.map(row => row.join('\t')).join('\n'), html) !== true) {
      throw new Error('The table cannot be inserted at this selection.')
    }
    return
  }
  const historyGroup = group ?? editor.beginHistoryGroup(), options = { historyGroup }
  try {
    if (operation.font !== undefined) exec(editor, { type: 'setMarkAttr', mark: 'fontFamily', attr: 'family', value: operation.font }, options)
    if (operation.size !== undefined) exec(editor, { type: 'setMarkAttr', mark: 'fontSize', attr: 'val', value: Math.round(operation.size * 2) }, options)
    for (const [property, enabled] of [['b', operation.bold], ['i', operation.italic], ['u', operation.underline], ['strike', operation.strike]] as const) {
      if (enabled === undefined) continue
      const surface = editor.surface
      if (!surface) throw new Error('The DOCX editor is not mounted.')
      const reason = surface.setRunProperty(property, { val: property === 'u' ? enabled ? 'single' : 'none' : enabled ? '1' : '0' })
      if (reason !== null) throw new Error(reason)
    }
    for (const [property, value] of [['vertAlign', operation.script], ['color', operation.color], ['highlight', operation.highlight]] as const) {
      if (value === undefined) continue
      const surface = editor.surface
      if (!surface) throw new Error('The DOCX editor is not mounted.')
      const reason = surface.setRunProperty(property, { val: value })
      if (reason !== null) throw new Error(reason)
    }
    if (operation.style !== undefined) {
      const styleId = editor.getDocumentStyles().find(style => style.name === operation.style || style.styleId === operation.style)?.styleId
      if (styleId === undefined) throw new Error('The document does not define this paragraph style.')
      exec(editor, { type: 'setParagraphStyle', styleId }, options)
    }
    if (operation.headingLevel !== undefined) {
      const id = headingStyle(editor, operation.headingLevel)
      exec(editor, { type: 'setParagraphStyle', styleId: id }, options)
    }
    if (operation.alignment !== undefined) exec(editor, { type: 'setAlignment',
      align: (['left', 'center', 'right', 'justify'] as const)[operation.alignment] ?? 'left' }, options)
    if (operation.lineSpacing !== undefined) exec(editor, { type: 'setLineSpacing', rule: 'multiple', value: operation.lineSpacing }, options)
    if (operation.spaceBefore !== undefined || operation.spaceAfter !== undefined) exec(editor, {
      type: 'setParagraphSpacing', ...(operation.spaceBefore === undefined ? {} : { beforePt: operation.spaceBefore }),
      ...(operation.spaceAfter === undefined ? {} : { afterPt: operation.spaceAfter }) }, options)
    if (operation.list === 'none') {
      const active = editor.surface?.isListActive('ordered') ? 'ordered' : editor.surface?.isListActive('bullet') ? 'bullet' : null
      if (active !== null) exec(editor, { type: 'toggleList', kind: active }, options)
    } else if (operation.list !== undefined) {
      const kind = operation.list === 'number' ? 'ordered' : 'bullet'
      if (!editor.surface?.isListActive(kind)) exec(editor, { type: 'toggleList', kind }, options)
    }
  } finally { if (!group) historyGroup.end() }
}
