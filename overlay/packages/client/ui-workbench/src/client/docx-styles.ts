/** Edit only the authored styles part, as one guarded OOXML package transaction. */
import type { DocxEditorInstance } from '@docx-editor.dev/core/editor'
import { stylesPartOf, serializeOoxmlPart, readOoxmlPart, withPart } from '@docx-editor.dev/core/store'
import type { WordStyleFormat } from '@deepseek-ai/dsh-workbench-word/types'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const value = (element: Element | undefined, name = 'val') => element?.getAttributeNS(W, name)
const child = (element: Element, name: string) =>
  Array.from(element.children).find(node => node.namespaceURI === W && node.localName === name)
function xml(editor: DocxEditorInstance) {
  const surface = editor.surface
  if (surface === null) throw new Error('The DOCX editor is not ready.')
  const part = stylesPartOf(surface.session.currentPackage())
  if (part === undefined) throw new Error('This document does not define paragraph styles.')
  const document = new DOMParser().parseFromString(serializeOoxmlPart(part), 'application/xml')
  if (document.querySelector('parsererror')) throw new Error('The document styles could not be read.')
  return { surface, part, document }
}
function styleAt(document: XMLDocument, level: number): Element | undefined {
  const styles = Array.from(document.documentElement.children).filter(node =>
    node.localName === 'style' && value(node, 'type') === 'paragraph')
  if (level === 0) return styles.find(node => value(node, 'default') === '1' || value(node, 'default') === 'true')
    ?? styles.find(node => value(node, 'styleId')?.toLowerCase() === 'normal')
  return styles.find((node) => {
    const properties = child(node, 'pPr')
    return (properties && value(child(properties, 'outlineLvl')) === String(level - 1))
      || [String(level), 'heading' + String(level), '标题' + String(level)].includes(
        (value(child(node, 'name')) ?? '').toLowerCase().replaceAll(' ', ''))
  })
}
/**
 * Resolve an existing body or heading style without modifying it.
 * @param editor - Authoritative open document.
 * @param level - Body zero or heading one through nine.
 * @returns Existing paragraph style identifier.
 */
export function headingStyle(editor: DocxEditorInstance, level: number): string {
  const { document } = xml(editor), found = styleAt(document, level)
  const id = value(found, 'styleId')
  if (!id) throw new Error('Define this heading style before assigning it.')
  return id
}
/**
 * Update requested properties while preserving unmentioned OOXML.
 * @param editor - Authoritative open document.
 * @param formats - Body and heading style properties to change.
 */
export function configureDocxStyles(editor: DocxEditorInstance, formats: WordStyleFormat[]): void {
  const { surface, part, document } = xml(editor)
  const ensure = (parent: Element, name: string) => {
    const existing = child(parent, name)
    if (existing) return existing
    const node = document.createElementNS(W, 'w:' + name); parent.append(node); return node
  }
  const set = (parent: Element, name: string, attributes: Record<string, string | number>) => {
    const node = ensure(parent, name)
    for (const [key, value] of Object.entries(attributes)) node.setAttributeNS(W, 'w:' + key, String(value))
    return node
  }
  for (const format of formats) {
    if (!Number.isInteger(format.level) || format.level < 0 || format.level > 9) throw new Error('Invalid heading level.')
    let style = styleAt(document, format.level)
    if (!style) {
      style = document.createElementNS(W, 'w:style')
      const stem = format.level === 0 ? 'MRWBody' : 'MRWHeading' + String(format.level)
      let id = stem, suffix = 1
      const ids = new Set(Array.from(document.documentElement.children).map(node => value(node, 'styleId')))
      while (ids.has(id)) id = stem + String(suffix++)
      style.setAttributeNS(W, 'w:type', 'paragraph'); style.setAttributeNS(W, 'w:styleId', id)
      if (format.level === 0) style.setAttributeNS(W, 'w:default', '1')
      set(style, 'name', { val: format.level === 0 ? 'Normal' : 'heading ' + String(format.level) })
      const normal = value(styleAt(document, 0), 'styleId')
      if (normal) set(style, 'basedOn', { val: normal })
      if (format.level > 0) set(ensure(style, 'pPr'), 'outlineLvl', { val: format.level - 1 })
      document.documentElement.append(style)
    }
    const run = ensure(style, 'rPr'), paragraph = ensure(style, 'pPr')
    if (format.font !== undefined) {
      const fonts = set(run, 'rFonts', { ascii: format.font, hAnsi: format.font, eastAsia: format.font, cs: format.font })
      for (const key of ['asciiTheme', 'hAnsiTheme', 'eastAsiaTheme', 'cstheme']) fonts.removeAttributeNS(W, key)
    }
    if (format.size !== undefined) { set(run, 'sz', { val: Math.round(format.size * 2) }); set(run, 'szCs', { val: Math.round(format.size * 2) }) }
    if (format.bold !== undefined) { set(run, 'b', { val: format.bold ? 1 : 0 }); set(run, 'bCs', { val: format.bold ? 1 : 0 }) }
    if (format.alignment !== undefined) set(paragraph, 'jc', { val: ['left', 'center', 'right', 'both'][format.alignment] ?? 'left' })
    if (format.spaceBefore !== undefined) set(paragraph, 'spacing', { before: Math.round(format.spaceBefore * 20), beforeAutospacing: 0 })
    if (format.spaceAfter !== undefined) set(paragraph, 'spacing', { after: Math.round(format.spaceAfter * 20), afterAutospacing: 0 })
    if (format.lineSpacing !== undefined) set(paragraph, 'spacing', { line: Math.round(format.lineSpacing * 240), lineRule: 'auto' })
  }
  const parsed = readOoxmlPart(new XMLSerializer().serializeToString(document), { name: part.name, contentType: part.contentType })
  if (!parsed.ok) throw new Error('Invalid DOCX styles: ' + parsed.reason)
  const result = surface.applyAutomationOps(() => [], undefined, [pkg => withPart(pkg, parsed.part)])
  if (result.rejected) throw new Error(result.reason)
}
