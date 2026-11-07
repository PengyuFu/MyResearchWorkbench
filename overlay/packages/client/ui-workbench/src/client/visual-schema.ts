/** Tiptap nodes for source-backed scientific documents and their imperative views. */
import { Extension, Mark, Node as TiptapNode, type Editor, type Extensions } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, NodeSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { baseKeymap } from '@tiptap/pm/commands'
import { keymap } from '@tiptap/pm/keymap'
import { history, undo, redo, closeHistory } from '@tiptap/pm/history'
import { tableEditing, goToNextCell } from '@tiptap/pm/tables'
import { gapCursor } from '@tiptap/pm/gapcursor'
import { MathfieldElement } from 'mathlive'
import type { LatexDocument, LatexInline } from './latex-source.types.ts'
import type { VisualKey } from './visual-locales.ts'
import css from './VisualEditor.module.css'

/** An authenticated, locally resolved image or PDF preview. */
export interface VisualAsset {
  url: string
  mimeType: string
}

/** User actions and resource access stay with the owning Workbench controller. */
export interface VisualRuntime {
  t: (key: VisualKey) => string
  readOnly: boolean
  mathFontsDirectory: string
  resolveAsset: (path: string, sourcePath: string, graphicsPaths: string[]) => Promise<VisualAsset>
  openInclude: (path: string) => void
  editReference: (position: number, kind: 'citation' | 'reference', key: string) => void
  save: () => void
  find: () => void
  select: (mode: 'ask' | 'edit') => void
}

/** Decoration identity is local to one mounted editor. */
export interface VisualSchemaOptions {
  runtime: () => VisualRuntime
  targetKey: PluginKey<DecorationSet>
  validateDocument: (document: ProseMirrorNode) => boolean
}

function sourceIdAttribute() {
  return { default: null, keepOnSplit: false, rendered: false }
}

function hiddenAttribute(defaultValue: object | string | number | boolean | null = null) {
  return { default: defaultValue, rendered: false }
}

function selectNode(editor: Editor, getPos: () => number | undefined) {
  const position = getPos()
  if (position !== undefined) editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, position)))
}

function mathNode(name: 'mathInline' | 'mathBlock', options: VisualSchemaOptions) {
  const inline = name === 'mathInline'
  return TiptapNode.create({
    name, group: inline ? 'inline' : 'block', inline, atom: true, selectable: true,
    addAttributes: () => ({
      sourceId: sourceIdAttribute(), token: hiddenAttribute(), latex: hiddenAttribute(''),
      label: hiddenAttribute(''), environment: hiddenAttribute(inline ? '' : 'equation'),
    }),
    parseHTML: () => [{ tag: inline ? 'span[data-visual-math-inline]' : 'div[data-visual-math-block]' }],
    renderHTML: ({ node }) => [inline ? 'span' : 'div', { [inline ? 'data-visual-math-inline' : 'data-visual-math-block']: '', 'data-latex': node.attrs.latex }],
    addNodeView() {
      return ({ node: initialNode, getPos, editor }) => {
        let node = initialNode
        const runtime = options.runtime()
        MathfieldElement.fontsDirectory = runtime.mathFontsDirectory
        MathfieldElement.soundsDirectory = null
        MathfieldElement.keypressSound = null
        MathfieldElement.plonkSound = null
        const dom = document.createElement(inline ? 'span' : 'div')
        dom.className = inline ? css.inlineMath : css.mathBlock
        dom.dataset.visualMath = inline ? 'inline' : 'block'
        dom.dataset.sourceId = String(node.attrs.sourceId ?? '')
        dom.contentEditable = 'false'
        const field = new MathfieldElement()
        field.className = css.mathField
        field.mathVirtualKeyboardPolicy = 'manual'
        field.readOnly = runtime.readOnly
        field.setAttribute('aria-label', runtime.t('visualFormula'))
        field.setAttribute('title', runtime.t('visualMathHint'))
        field.setAttribute('data-visual-math-input', inline ? 'inline' : 'block')
        field.setValue(String(node.attrs.latex ?? ''), { silenceNotifications: true })
        if (!inline) {
          dom.dataset.numbered = String(!String(node.attrs.environment).endsWith('*'))
          dom.dataset.sourceLabel = String(node.attrs.label ?? '')
        }
        dom.append(field)
        const onInput = () => {
          if (options.runtime().readOnly) return
          const position = getPos()
          if (position === undefined) return
          const latex = field.getValue('latex')
          if (latex === node.attrs.latex) return
          const before = editor.state.doc
          editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, latex }))
          if (editor.state.doc === before) field.setValue(String(node.attrs.latex ?? ''), { silenceNotifications: true })
        }
        const onFocus = () => {
          selectNode(editor, getPos)
          editor.view.dispatch(closeHistory(editor.state.tr))
        }
        const onKey = (event: KeyboardEvent) => {
          if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.isComposing) return
          const key = event.key.toLowerCase()
          if (key === 's') {
            event.preventDefault(); event.stopPropagation(); options.runtime().save()
          } else if (key === 'k') {
            event.preventDefault(); event.stopPropagation()
            selectNode(editor, getPos)
            options.runtime().select(event.shiftKey ? 'ask' : 'edit')
          } else if (key === 'z' || key === 'y') {
            event.preventDefault(); event.stopPropagation()
            if (options.runtime().readOnly) return
            if (key === 'y' || event.shiftKey) redo(editor.state, editor.view.dispatch)
            else undo(editor.state, editor.view.dispatch)
          }
        }
        field.addEventListener('input', onInput)
        field.addEventListener('focus', onFocus)
        field.addEventListener('keydown', onKey, true)
        return {
          dom,
          stopEvent: event => field.contains(event.target as globalThis.Node) || event.target === field,
          ignoreMutation: () => true,
          update(nextNode) {
            if (nextNode.type !== node.type) return false
            node = nextNode
            field.readOnly = options.runtime().readOnly
            const nextLatex = String(node.attrs.latex ?? '')
            if (field.getValue('latex') !== nextLatex) field.setValue(nextLatex, { silenceNotifications: true })
            dom.dataset.sourceId = String(node.attrs.sourceId ?? '')
            dom.dataset.sourceLabel = String(node.attrs.label ?? '')
            return true
          },
          selectNode: () => dom.classList.add(css.nodeSelected),
          deselectNode: () => dom.classList.remove(css.nodeSelected),
          destroy() {
            field.removeEventListener('input', onInput)
            field.removeEventListener('focus', onFocus)
            field.removeEventListener('keydown', onKey, true)
          },
        }
      }
    },
  })
}

function imageNode(options: VisualSchemaOptions) {
  return TiptapNode.create({
    name: 'image', group: 'block', atom: true, selectable: true,
    addAttributes: () => ({ path: hiddenAttribute(''), imageIndex: hiddenAttribute(0), sourceImage: hiddenAttribute() }),
    parseHTML: () => [{ tag: 'img', getAttrs: element => ({ path: element.getAttribute('src') ?? '' }) }],
    renderHTML: ({ node }) => ['div', { 'data-visual-image': '', 'data-path': node.attrs.path }],
    addNodeView() {
      return ({ node: initialNode, getPos, editor }) => {
        let node = initialNode
        let request = 0
        let disposed = false
        const dom = document.createElement('div')
        dom.className = css.image
        dom.dataset.visualImage = ''
        dom.contentEditable = 'false'
        dom.tabIndex = 0
        const message = document.createElement('span')
        message.className = css.imageMessage
        const frame = document.createElement('div')
        frame.className = css.imageFrame
        dom.append(frame, message)
        const load = async () => {
          const generation = ++request
          const runtime = options.runtime()
          const path = String(node.attrs.path ?? '')
          dom.dataset.path = path
          frame.replaceChildren()
          message.textContent = runtime.t(path ? 'visualPreviewLoading' : 'visualNoImage')
          message.hidden = false
          if (!path) return
          const base = editor.state.doc.attrs.base as LatexDocument
          try {
            const asset = await runtime.resolveAsset(path, base.file, base.graphicsPaths)
            if (disposed || generation !== request) return
            let preview: HTMLImageElement | HTMLIFrameElement
            if (asset.mimeType === 'application/pdf') {
              preview = document.createElement('iframe')
              preview.src = asset.url
              preview.title = path
              preview.className = css.pdfImage
            } else if (asset.mimeType.startsWith('image/')) {
              preview = document.createElement('img')
              preview.src = asset.url
              preview.alt = path
              preview.loading = 'lazy'
              preview.draggable = false
            } else {
              message.textContent = runtime.t('visualPreviewFailed')
              return
            }
            frame.append(preview)
            message.hidden = true
          } catch (error) {
            if (disposed || generation !== request) return
            message.textContent = runtime.t('visualPreviewFailed')
            message.title = error instanceof Error ? error.message : String(error)
          }
        }
        const onSelect = () => selectNode(editor, getPos)
        dom.addEventListener('click', onSelect)
        dom.addEventListener('focus', onSelect)
        void load()
        return {
          dom, ignoreMutation: () => true,
          update(nextNode) {
            if (nextNode.type !== node.type) return false
            const changed = nextNode.attrs.path !== node.attrs.path
            node = nextNode
            if (changed) void load()
            return true
          },
          selectNode: () => dom.classList.add(css.nodeSelected),
          deselectNode: () => dom.classList.remove(css.nodeSelected),
          destroy() { disposed = true; request++; dom.removeEventListener('click', onSelect); dom.removeEventListener('focus', onSelect) },
        }
      }
    },
  })
}

function referenceNode(options: VisualSchemaOptions) {
  return TiptapNode.create({
    name: 'reference', group: 'inline', inline: true, atom: true, selectable: true,
    addAttributes: () => ({
      token: hiddenAttribute(), key: hiddenAttribute(''), kind: hiddenAttribute('reference'), command: hiddenAttribute('ref'),
    }),
    parseHTML: () => [{ tag: 'span[data-visual-reference]' }],
    renderHTML: ({ node }) => ['span', { 'data-visual-reference': '', class: css.reference }, String(node.attrs.key ?? '')],
    addNodeView() {
      return ({ node: initialNode, editor, getPos }) => {
        let node = initialNode
        const dom = document.createElement('span')
        dom.className = css.reference
        dom.contentEditable = 'false'
        dom.tabIndex = 0
        dom.setAttribute('role', 'button')
        dom.dataset.visualReference = ''
        const update = () => {
          const kind = node.attrs.kind === 'citation' ? 'citation' : 'reference'
          const label = options.runtime().t(kind === 'citation' ? 'visualCitation' : 'visualReference')
          const key = String(node.attrs.key ?? '')
          dom.textContent = kind === 'citation' ? '[' + key + ']' : key
          dom.title = label + ': ' + key
          dom.setAttribute('aria-label', label + ': ' + key)
        }
        const open = () => {
          const position = getPos()
          if (position === undefined) return
          selectNode(editor, getPos)
          options.runtime().editReference(position, node.attrs.kind === 'citation' ? 'citation' : 'reference', String(node.attrs.key ?? ''))
        }
        const onKey = (event: KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open() } }
        dom.addEventListener('click', open)
        dom.addEventListener('keydown', onKey)
        update()
        return {
          dom, ignoreMutation: () => true,
          stopEvent: event => dom.contains(event.target as globalThis.Node),
          update(nextNode) { if (nextNode.type !== node.type) return false; node = nextNode; update(); return true },
          selectNode: () => dom.classList.add(css.nodeSelected),
          deselectNode: () => dom.classList.remove(css.nodeSelected),
          destroy() { dom.removeEventListener('click', open); dom.removeEventListener('keydown', onKey) },
        }
      }
    },
  })
}

/** Build one schema with local editor history, table interaction and resource lifetimes. */
export function createVisualExtensions(options: VisualSchemaOptions): Extensions {
  const sourceAttributes = () => ({ sourceId: sourceIdAttribute() })
  const inlineAttributes = () => ({ token: hiddenAttribute() })
  const captionNode = (name: 'caption' | 'label' | 'note') => TiptapNode.create({
    name, group: 'block', content: name === 'label' ? 'text*' : 'inline*', defining: true,
    addAttributes: () => ({ sourceIndex: hiddenAttribute(0) }),
    parseHTML: () => [{ tag: 'p[data-visual-role="' + name + '"]' }],
    renderHTML: () => ['p', { class: css[name], 'data-visual-role': name, 'data-field-label': options.runtime().t(name === 'label' ? 'visualLabel' : name === 'caption' ? 'visualCaption' : 'visualNote') }, 0],
  })
  const objectNode = (name: 'figure' | 'tableObject') => TiptapNode.create({
    name, group: 'block', content: 'block+', isolating: true, defining: true, selectable: true,
    addAttributes: sourceAttributes,
    parseHTML: () => [{ tag: 'figure[data-visual-object="' + name + '"]' }],
    renderHTML: ({ node }) => ['figure', {
      'data-source-id': node.attrs.sourceId,
      class: name === 'figure' ? css.figure : css.tableObject,
      'data-visual-object': name,
      'data-kind-label': options.runtime().t(name === 'figure' ? 'visualFigureNumber' : 'visualTableNumber'),
    }, 0],
  })
  return [
    TiptapNode.create({
      name: 'doc', topNode: true, content: 'block+',
      addAttributes: () => ({ base: hiddenAttribute() }),
    }),
    TiptapNode.create({ name: 'text', group: 'inline' }),
    TiptapNode.create({
      name: 'paragraph', group: 'block', content: 'inline*',
      addAttributes: sourceAttributes,
      parseHTML: () => [{ tag: 'p' }],
      renderHTML: ({ node }) => ['p', { class: css.paragraph, 'data-source-id': node.attrs.sourceId }, 0],
    }),
    TiptapNode.create({
      name: 'heading', group: 'block', content: 'inline*', defining: true,
      addAttributes: () => ({ ...sourceAttributes(), level: { default: 1 } }),
      parseHTML: () => [1, 2, 3, 4, 5, 6].map(level => ({ tag: 'h' + level, attrs: { level } })),
      renderHTML: ({ node }) => ['h' + Math.min(6, Math.max(1, Number(node.attrs.level))), { class: css.heading, 'data-source-id': node.attrs.sourceId }, 0],
    }),
    TiptapNode.create({
      name: 'field', group: 'block', content: 'inline*', defining: true,
      addAttributes: () => ({ ...sourceAttributes(), field: hiddenAttribute('') }),
      parseHTML: () => [{ tag: 'div[data-visual-field]' }],
      renderHTML: ({ node }) => {
        const labels: Record<string, VisualKey> = { abstract: 'visualAbstract', keyword: 'visualKeywords' }
        const label = labels[String(node.attrs.field)]
        return ['div', { class: css.field, 'data-source-id': node.attrs.sourceId, 'data-visual-field': node.attrs.field, 'data-field-label': label === undefined ? '' : options.runtime().t(label) }, 0]
      },
    }),
    Mark.create({
      name: 'sourceMark', inclusive: true,
      addAttributes: inlineAttributes,
      parseHTML: () => [],
      renderHTML: ({ mark }) => {
        const token = mark.attrs.token as LatexInline | null
        return ['span', { 'data-formats': (token?.marks ?? []).join(' ') }, 0]
      },
    }),
    TiptapNode.create({
      name: 'inlineGroup', inline: true, group: 'inline', content: 'inline*', defining: true,
      addAttributes: inlineAttributes,
      parseHTML: () => [{ tag: 'span[data-visual-inline-group]' }],
      renderHTML: ({ node }) => {
        const token = node.attrs.token as LatexInline | null
        return ['span', { 'data-visual-inline-group': '', 'data-formats': (token?.marks ?? []).join(' ') }, 0]
      },
    }),
    mathNode('mathInline', options), mathNode('mathBlock', options), referenceNode(options),
    TiptapNode.create({
      name: 'hardBreak', inline: true, group: 'inline', atom: true, selectable: false,
      addAttributes: () => ({ token: hiddenAttribute(), raw: hiddenAttribute('\\\\\n') }),
      parseHTML: () => [{ tag: 'br' }],
      renderHTML: () => ['br'],
    }),
    TiptapNode.create({
      name: 'opaqueInline', inline: true, group: 'inline', atom: true, selectable: true,
      addAttributes: () => ({ token: hiddenAttribute(), text: hiddenAttribute('') }),
      parseHTML: () => [],
      renderHTML: ({ node }) => ['span', { class: css.opaqueInline, contenteditable: 'false', title: options.runtime().t('visualUnknownDescription') }, String(node.attrs.text ?? '')],
    }),
    TiptapNode.create({
      name: 'opaqueBlock', group: 'block', atom: true, selectable: true,
      addAttributes: () => ({ ...sourceAttributes(), text: hiddenAttribute('') }),
      parseHTML: () => [],
      renderHTML: ({ node }) => ['div', { class: css.opaqueBlock, contenteditable: 'false' }, String(node.attrs.text || options.runtime().t('visualUnknownObject'))],
    }),
    TiptapNode.create({
      name: 'includeBlock', group: 'block', atom: true, selectable: true,
      addAttributes: () => ({ ...sourceAttributes(), path: hiddenAttribute('') }),
      parseHTML: () => [],
      renderHTML: ({ node }) => ['div', { class: css.include, contenteditable: 'false' }, String(node.attrs.path ?? '')],
      addNodeView() {
        return ({ node }) => {
          const dom = document.createElement('button')
          dom.type = 'button'
          dom.className = css.include
          dom.contentEditable = 'false'
          dom.textContent = options.runtime().t('visualOpenInclude') + ': ' + String(node.attrs.path ?? '')
          dom.addEventListener('click', () => options.runtime().openInclude(String(node.attrs.path ?? '')))
          return { dom, ignoreMutation: () => true }
        }
      },
    }),
    imageNode(options), objectNode('figure'), objectNode('tableObject'),
    captionNode('caption'), captionNode('label'), captionNode('note'),
    TiptapNode.create({
      name: 'table', group: 'block', content: 'tableRow+', isolating: true,
      parseHTML: () => [{ tag: 'table' }],
      renderHTML: () => ['table', { class: css.table }, ['tbody', 0]],
    }),
    TiptapNode.create({
      name: 'tableRow', content: 'tableCell+',
      parseHTML: () => [{ tag: 'tr' }],
      renderHTML: () => ['tr', 0],
    }),
    TiptapNode.create({
      name: 'tableCell', content: 'paragraph+', isolating: true,
      addAttributes: () => ({
        colspan: { default: 1, parseHTML: element => Number(element.getAttribute('colspan') ?? 1) },
        rowspan: { default: 1, parseHTML: element => Number(element.getAttribute('rowspan') ?? 1) },
        colwidth: { default: null }, sourceCell: hiddenAttribute(), header: hiddenAttribute(false),
      }),
      parseHTML: () => [{ tag: 'td' }, { tag: 'th', attrs: { header: true } }],
      renderHTML: ({ node }) => [node.attrs.header ? 'th' : 'td', { colspan: node.attrs.colspan, rowspan: node.attrs.rowspan, 'data-visual-cell': '' }, 0],
    }),
    Extension.create({
      name: 'visualInteraction',
      extendNodeSchema(extension) {
        if (extension.name === 'table') return { tableRole: 'table' }
        if (extension.name === 'tableRow') return { tableRole: 'row' }
        if (extension.name === 'tableCell') return { tableRole: 'cell' }
        return {}
      },
      addKeyboardShortcuts() {
        return {
          'Mod-f': () => { options.runtime().find(); return true },
          'Mod-s': () => { options.runtime().save(); return true },
          'Mod-k': () => { options.runtime().select('edit'); return true },
          'Mod-Shift-k': () => { options.runtime().select('ask'); return true },
          'Mod-z': () => undo(this.editor.state, this.editor.view.dispatch),
          'Mod-y': () => redo(this.editor.state, this.editor.view.dispatch),
          'Mod-Shift-z': () => redo(this.editor.state, this.editor.view.dispatch),
          Tab: () => goToNextCell(1)(this.editor.state, this.editor.view.dispatch),
          'Shift-Tab': () => goToNextCell(-1)(this.editor.state, this.editor.view.dispatch),
          Enter: () => {
            const { $from } = this.editor.state.selection
            const parent = $from.parent
            if (['field', 'caption', 'note', 'label'].includes(parent.type.name)) {
              if (parent.type.name === 'label') return true
              const raw = parent.attrs.field === 'abstract' ? '\n\n' : '\\\\\n'
              return this.editor.commands.insertContent({ type: 'hardBreak', attrs: { raw } })
            }
            return false
          },
          'Shift-Enter': () => this.editor.commands.insertContent({ type: 'hardBreak' }),
        }
      },
      addProseMirrorPlugins() {
        return [
          history(), tableEditing(), gapCursor(), keymap(baseKeymap),
          new Plugin({ filterTransaction: transaction => !transaction.docChanged || ((!options.runtime().readOnly || transaction.getMeta('visual-external') === true) && options.validateDocument(transaction.doc)) }),
          new Plugin<DecorationSet>({
            key: options.targetKey,
            state: {
              init: () => DecorationSet.empty,
              apply(transaction, previous) {
                const target = transaction.getMeta(options.targetKey) as { from: number; to: number } | null | undefined
                if (target === undefined) return previous.map(transaction.mapping, transaction.doc)
                if (target === null || target.to <= target.from) return DecorationSet.empty
                const from = Math.max(0, Math.min(target.from, transaction.doc.content.size))
                const to = Math.max(from, Math.min(target.to, transaction.doc.content.size))
                const node = transaction.doc.nodeAt(from)
                const decoration = node !== null && !node.isText && from + node.nodeSize === to
                  ? Decoration.node(from, to, { class: css.target }) : Decoration.inline(from, to, { class: css.target })
                return DecorationSet.create(transaction.doc, [decoration])
              },
            },
            props: { decorations: state => options.targetKey.getState(state) ?? DecorationSet.empty },
          }),
        ]
      },
    }),
  ]
}

/** Resolve the selected scientific object without changing document state. */
export function selectedVisualObject(editor: Editor): { node: ProseMirrorNode; position: number } | null {
  const selection = editor.state.selection
  if (selection instanceof NodeSelection) return { node: selection.node, position: selection.from }
  const { $from } = selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth)
    if (['tableObject', 'figure', 'mathBlock', 'field', 'heading'].includes(node.type.name)) {
      return { node, position: $from.before(depth) }
    }
  }
  return null
}
