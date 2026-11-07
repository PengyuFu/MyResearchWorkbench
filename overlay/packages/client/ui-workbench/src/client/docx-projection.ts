/** Read-only context and UTF-16 anchors derived from the editor's canonical OOXML. */
import type { DocxEditorInstance } from '@docx-editor.dev/core/editor'
import { paragraphTextOf, directParagraphProperties, findNode } from '@docx-editor.dev/core/store'
import type { OoxmlNode } from '@docx-editor.dev/core/store'
import type { WordProjection, WordRun, WordBlock } from '@deepseek-ai/dsh-workbench-word/types'

/** Read only direct run properties; complex stories and unresolved inheritance never become proof. */
function directRuns(paragraph: OoxmlNode | null | undefined, expected: string): WordRun[] {
  if (paragraph?.kind !== 'paragraph') return []
  const runs: WordRun[] = []
  let text = '', supported = true, visited = 0
  const walk = (node: OoxmlNode): void => {
    if (!supported || ++visited > 10000) { supported = false; return }
    if (node.kind === 'paragraph' || node.kind === 'hyperlink') { for (const child of node.children) walk(child); return }
    if (node.kind === 'paragraphProperties' || node.kind === 'bookmarkStart' || node.kind === 'bookmarkEnd') return
    if (node.kind !== 'run') { supported = false; return }
    const from = text.length
    const properties = node.children.find(child => child.kind === 'runProperties')
    const property = (name: string) => properties?.children.find(child => 'localName' in child && child.localName === name)
    const attribute = (name: string, attr = 'val') => {
      const value = property(name)
      return value && 'attributes' in value ? value.attributes.find(item => item.localName === attr)?.value : undefined
    }
    for (const child of node.children) {
      if (child.kind === 'runProperties') continue
      if (child.kind === 'text') for (const value of child.children) { if (value.kind === 'textValue') text += value.value; else supported = false }
      else if (child.kind === 'tab') text += '\t'
      else if (child.kind === 'hardBreak') text += '\n'
      else supported = false
    }
    const bool = (name: string): boolean | undefined => property(name) === undefined ? undefined : !['0', 'false', 'off', 'none'].includes(attribute(name) ?? '1')
    // Mixed script font declarations are left unresolved instead of claiming one font for all text.
    const fonts = ['ascii', 'hAnsi', 'eastAsia', 'cs'].map(name => attribute('rFonts', name))
    const font = fonts.every(value => value !== undefined && value === fonts[0]) ? fonts[0] : undefined
    const size = attribute('sz')
    if (text.length > from) runs.push({ from, to: text.length, bold: bool('b'), italic: bool('i'), underline: bool('u'),
      font, size: size === undefined || !Number.isFinite(Number(size)) ? undefined : Number(size) / 2 })
  }
  walk(paragraph)
  return supported && text === expected ? runs : []
}

/** Structural facts from OOXML, independent of the currently visible page. */
function structuralContext(root: OoxmlNode): Map<string, { table?: WordBlock['table']; pagination: NonNullable<WordBlock['pagination']> }> {
  const result = new Map<string, { table?: WordBlock['table']; pagination: NonNullable<WordBlock['pagination']> }>()
  const named = (node: OoxmlNode, name: string) => 'localName' in node && node.localName === name
  const children = (node: OoxmlNode): readonly OoxmlNode[] => 'children' in node ? node.children : []
  const attribute = (node: OoxmlNode | undefined, name: string) => node && 'attributes' in node ? node.attributes.find(item => item.localName === name)?.value : undefined
  let visited = 0
  const walk = (node: OoxmlNode, table?: WordBlock['table']): void => {
    if (++visited > 100000) throw new Error('The document structure exceeds the inspection limit.')
    if (named(node, 'tbl')) {
      const rows = children(node).filter(child => named(child, 'tr'))
      const props = children(node).find(child => named(child, 'tblPr'))
      const layout = props && children(props).find(child => named(child, 'tblLayout'))
      const preferred = props && children(props).find(child => named(child, 'tblW'))
      const autoFit = attribute(layout, 'type') === 'autofit'
        ? attribute(preferred, 'type') === 'pct' ? 'window' as const : attribute(preferred, 'type') === 'auto' ? 'content' as const : undefined : undefined
      const autoRowHeight = rows.every((row) => {
        const properties = children(row).find(child => named(child, 'trPr'))
        return !properties || !children(properties).some(child => named(child, 'trHeight'))
      })
      const columns = children(children(node).find(child => named(child, 'tblGrid')) ?? node).filter(child => named(child, 'gridCol')).length
      rows.forEach((row, rowIndex) => {
        const cells = children(row).filter(child => named(child, 'tc'))
        let column = 0
        cells.forEach((cell) => {
          const properties = children(cell).find(child => named(child, 'tcPr'))
          const span = Number(attribute(properties && children(properties).find(child => named(child, 'gridSpan')), 'val') ?? 1)
          const width = Number.isSafeInteger(span) && span > 0 && span <= 1000 ? span : 1
          for (const child of children(cell)) walk(child, { id: node.id, row: rowIndex, column,
            rows: rows.length, columns: columns || cells.length, autoFit, autoRowHeight })
          column += width
        })
      })
      return
    }
    if (node.kind === 'paragraph') {
      const properties = children(node).find(child => child.kind === 'paragraphProperties')
      const flag = (name: string): boolean | undefined => {
        const value = properties && children(properties).find(child => named(child, name))
        return value === undefined ? undefined : !['0', 'false', 'off'].includes(attribute(value, 'val') ?? '1')
      }
      let explicitBreaks = 0
      const inspect = (item: OoxmlNode): void => {
        if (named(item, 'br') && attribute(item, 'type') === 'page') explicitBreaks++
        for (const child of children(item)) inspect(child)
      }
      inspect(node)
      result.set(node.id, { ...(table ? { table } : {}), pagination: { pageBreakBefore: flag('pageBreakBefore'), keepNext: flag('keepNext'), keepLines: flag('keepLines'),
        explicitBreaks, sectionBreak: properties !== undefined && children(properties).some(child => named(child, 'sectPr')) } })
      return
    }
    for (const child of children(node)) walk(child, table)
  }
  walk(root)
  return result
}

/**
 * Derive read-only text and style context from the live model.
 * @param editor - Authoritative open document.
 * @returns Text, anchors and current history availability.
 */
export function docxProjection(editor: DocxEditorInstance): WordProjection {
  const surface = editor.surface
  if (surface === null) throw new Error('The DOCX editor is not ready.')
  const session = surface.session, part = session.part(), structure = structuralContext(part.root)
  const headings = new Map(session.documentOutline().map(item => [item.blockId, item.level + 1]))
  let offset = 0
  const blocks = session.paragraphIds().map((id) => {
    const text = paragraphTextOf(part, id) ?? ''
    const properties = directParagraphProperties(part, id)
    const style = properties.find(property => property.localName === 'pStyle')
      ?.attributes?.val ?? ''
    const spacing = properties.find(property => property.localName === 'spacing')?.attributes
    const alignment = properties.find(property => property.localName === 'jc')?.attributes?.val
    const block = { ...structure.get(id), id, kind: 'paragraph' as const, from: offset, to: offset + text.length,
      text, style, level: headings.get(id) ?? 0,
      alignment: alignment === 'center' ? 1 : alignment === 'right' || alignment === 'end' ? 2 : alignment === 'both' || alignment === 'distribute' ? 3 : 0,
      spaceBefore: Number(spacing?.before ?? 0) / 20, spaceAfter: Number(spacing?.after ?? 0) / 20,
      ...(spacing?.line !== undefined && (!spacing.lineRule || spacing.lineRule === 'auto') ? { lineSpacing: Number(spacing.line) / 240 } : {}),
      runs: directRuns(findNode(part, id), text) }
    offset = block.to + 1
    return block
  })
  return { blocks, text: blocks.map(block => block.text + '\n').join(''),
    styles: session.documentStyles().map(style => style.name),
    canUndo: session.canUndo(), canRedo: session.canRedo(),
    readOnly: editor.snapshot().editable ? null : 'protected-document' }
}
/**
 * Map a document offset to an editor paragraph anchor.
 * @param projection - Current read-only context.
 * @param offset - UTF-16 document offset.
 * @returns Clamped semantic paragraph position.
 */
export function docxPosition(projection: WordProjection, offset: number): { paragraphId: string; offset: number } {
  const block = projection.blocks.find(block => block.from <= offset && block.to >= offset)
    ?? projection.blocks.at(-1)
  if (block === undefined) throw new Error('The DOCX selection is unavailable.')
  return { paragraphId: block.id, offset: Math.max(0, Math.min(block.text.length, offset - block.from)) }
}
/**
 * Map the editor selection to document offsets.
 * @param editor - Authoritative open document.
 * @param projection - Context from the same model revision.
 * @returns Ordered UTF-16 selection offsets.
 */
export function docxSelection(editor: DocxEditorInstance, projection: WordProjection): { from: number; to: number } {
  const selection = editor.surface?.state().selection
  const offset = (position: { paragraphId: string; offset: number }) => {
    const block = projection.blocks.find(block => block.id === position.paragraphId)
    return block === undefined ? 0 : block.from + Math.min(block.text.length, position.offset)
  }
  if (selection === undefined) return { from: 0, to: 0 }
  const anchor = offset(selection.anchor), head = offset(selection.head)
  return { from: Math.min(anchor, head), to: Math.max(anchor, head) }
}
