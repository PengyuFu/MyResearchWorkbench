/** A deliberately small Tiptap schema for the verified native Word projection. */
import { Node, Mark, Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { baseKeymap } from '@tiptap/pm/commands'
import { keymap } from '@tiptap/pm/keymap'
import { preservesWordObjects } from './word-operations.ts'

export function wordExtensions(runtime: {
  command(kind: 'undo' | 'redo' | 'save' | 'find'): void
  protected(): void
  protectedLabel: string
}) {
  return [
    Node.create({ name: 'doc', topNode: true, content: 'block+' }),
    Node.create({ name: 'text', group: 'inline' }),
    Node.create({ name: 'wordParagraph', group: 'block', content: 'text*',
      addAttributes: () => ({ id: { default: '' }, level: { default: 0 }, style: { default: '' },
        alignment: { default: 0 }, spaceBefore: { default: 0 }, spaceAfter: { default: 0 }, lineSpacing: { default: null },
        table: { default: null }, list: { default: '' } }),
      parseHTML: () => [{ tag: 'p' }],
      renderHTML: ({ node }) => {
        const a = node.attrs, level = Math.max(0, Math.min(6, Number(a.level)))
        return [level ? 'h' + level : 'p', { 'data-word-node': a.id, 'data-word-list': a.list || undefined,
          style: 'text-align:' + (['left', 'center', 'right', 'justify'][Number(a.alignment)] ?? 'left')
            + ';margin-top:' + Math.min(100, Math.max(0, Number(a.spaceBefore))) + 'pt;margin-bottom:'
            + Math.min(100, Math.max(0, Number(a.spaceAfter))) + 'pt'
            + (a.lineSpacing == null ? '' : ';line-height:' + Math.max(0.5, Math.min(5, Number(a.lineSpacing)))) }, 0]
      },
    }),
    Node.create({ name: 'wordObject', group: 'block', atom: true, selectable: true, draggable: false,
      addAttributes: () => ({ id: { default: '' }, level: { default: 0 }, style: { default: '' },
        alignment: { default: 0 }, spaceBefore: { default: 0 }, spaceAfter: { default: 0 }, table: { default: null },
        list: { default: '' }, kind: { default: 'protected' }, text: { default: '' }, reason: { default: '' }, image: { default: null } }),
      parseHTML: () => [{ tag: '[data-word-object]' }],
      renderHTML: ({ node }) => {
        const a = node.attrs, image = a.image as { data?: string; width?: number } | null
        if (a.kind === 'image' && image?.data && /^data:image\/(?:png|jpeg|gif);base64,/u.test(image.data)) {
          return ['figure', { 'data-word-object': a.id, contenteditable: 'false' },
            ['img', { src: image.data, alt: String(a.style), style: 'width:' + Math.max(12, Math.min(500, image.width ?? 320)) + 'pt;max-width:100%' }]]
        }
        return ['div', { 'data-word-object': a.id, 'data-protected': '', contenteditable: 'false', title: runtime.protectedLabel },
          ['small', {}, runtime.protectedLabel], ['div', {}, String(a.text)]]
      },
    }),
    Node.create({ name: 'wordTable', group: 'block', content: 'wordRow+', isolating: true,
      parseHTML: () => [{ tag: 'table' }], renderHTML: () => ['table', {}, ['tbody', {}, 0]] }),
    Node.create({ name: 'wordRow', content: 'wordCell+', parseHTML: () => [{ tag: 'tr' }], renderHTML: () => ['tr', {}, 0] }),
    Node.create({ name: 'wordCell', content: '(wordParagraph|wordObject)+', isolating: true,
      parseHTML: () => [{ tag: 'td' }], renderHTML: () => ['td', {}, 0] }),
    Mark.create({ name: 'wordFormat',
      addAttributes: () => ({ bold: { default: false }, italic: { default: false }, underline: { default: false },
        font: { default: '' }, size: { default: 0 } }),
      parseHTML: () => [{ tag: 'span[data-word-format]' }],
      renderHTML: ({ mark }) => {
        const a = mark.attrs, font = String(a.font).replaceAll(/[";\\<>]/gu, '')
        return ['span', { 'data-word-format': '', style: [
          a.bold ? 'font-weight:700' : '', a.italic ? 'font-style:italic' : '',
          a.underline ? 'text-decoration:underline' : '', font ? 'font-family:"' + font + '"' : '',
          Number(a.size) >= 6 && Number(a.size) <= 96 ? 'font-size:' + Number(a.size) + 'pt' : '',
        ].filter(Boolean).join(';') }, 0]
      },
    }),
    Extension.create({ name: 'wordSafety',
      addKeyboardShortcuts: () => ({
        'Mod-z': () => { runtime.command('undo'); return true },
        'Mod-Shift-z': () => { runtime.command('redo'); return true },
        'Mod-y': () => { runtime.command('redo'); return true },
        'Mod-s': () => { runtime.command('save'); return true },
        'Mod-f': () => { runtime.command('find'); return true },
      }),
      addProseMirrorPlugins: () => [new Plugin({
        filterTransaction: (transaction, state) => {
          if (!transaction.docChanged || transaction.getMeta('word-reconcile')) return true
          if (preservesWordObjects(state.doc, transaction.doc)) return true
          runtime.protected(); return false
        },
      }), keymap(baseKeymap)],
    }),
  ]
}
