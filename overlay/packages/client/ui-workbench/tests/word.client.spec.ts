import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import { wordBuffer, wordDraftDocument, wordPageSelection, wordDocument, wordText, wordTextChange, wordPosition, editorPosition, preservesWordObjects } from '../src/client/word-operations.ts'
import { wordExtensions } from '../src/client/word-schema.ts'
import { WordEdits } from '../src/client/word-controller.ts'
import type { WordMutation, WordSnapshot } from '@deepseek-ai/dsh-workbench-word/types'
import type { WordEditorBuffer, WorkbenchIO } from '../src/client/types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

function snapshot(text = '中文😀 alpha\n', revision = 0): WordSnapshot {
  return { id: 'a'.repeat(32), checkpoint: revision + '-' + 'b'.repeat(32), checkpointHash: 'c'.repeat(64),
    path: 'paper.docx', absolutePath: 'D:/fixture/paper.docx', workspaceRoot: 'D:/fixture',
    revision, savedRevision: 0, checkpointTime: 1, diskVersion: 'original',
    projection: { text, styles: ['Normal'], canUndo: revision > 0, canRedo: false,
      blocks: [{ id: 'paragraph', kind: 'paragraph', from: 0, to: text.length - 1, text: text.slice(0, -1),
        style: 'Normal', level: 0, alignment: 0, spaceBefore: 0, spaceAfter: 0,
        runs: [{ from: 0, to: 2, bold: true }] }] } }
}
const schema = getSchema(wordExtensions({ command: () => {}, protected: () => {}, protectedLabel: 'Protected' }))

describe('Word projection boundaries', () => {
  it('maps UTF-16 text and formatting without treating native paragraph marks as browser positions', () => {
    const source = snapshot()
    const doc = schema.nodeFromJSON(wordDocument(source.projection))
    expect(wordText(doc)).toBe(source.projection.text)
    expect(doc.child(0).child(0).marks[0]?.attrs.bold).toBe(true)
    for (const offset of [0, 2, 4, 5, 10]) expect(wordPosition(doc, editorPosition(doc, offset))).toBe(offset)
  })
  it('does not split surrogate pairs in a minimal replacement', () => {
    expect(wordTextChange('a😀b\n', 'a😄b\n')).toEqual({ kind: 'replace', from: 1, to: 3, before: '😀', text: '😄' })
    expect(wordTextChange('一\n二\n', '一二\n')).toEqual({ kind: 'replace', from: 1, to: 2, before: '\n', text: '' })
    expect(wordTextChange('a\n\n', 'a\n')).toEqual({ kind: 'replace', from: 1, to: 2, before: '\n', text: '' })
  })
  it('keeps protected nodes and rectangular table boundaries intact', () => {
    const source = snapshot()
    source.projection.blocks.push({ ...source.projection.blocks[0]!, id: 'field', kind: 'protected', text: 'REF value', from: 12, to: 21 })
    const before = schema.nodeFromJSON(wordDocument(source.projection))
    const after = schema.nodeFromJSON(wordDocument(snapshot('Changed\n').projection))
    expect(preservesWordObjects(before, after)).toBe(false)
    expect(preservesWordObjects(before, before)).toBe(true)
    const table = snapshot()
    table.projection.blocks = [0, 1].map(column => ({ ...table.projection.blocks[0]!, id: 'cell' + column,
      table: { id: 'table', row: 0, column, rows: 1, columns: 2 } }))
    const doc = schema.nodeFromJSON(wordDocument(table.projection))
    expect(doc.child(0).type.name).toBe('wordTable')
    expect(doc.child(0).child(0).childCount).toBe(2)
    expect(preservesWordObjects(doc, after)).toBe(false)
  })
})

function editing() {
  let file = wordBuffer(snapshot())
  const calls: WordMutation[] = []
  const responses: ((value: WordSnapshot) => void)[] = []
  let saves = 0, checkpoints = 0
  const word: NonNullable<WorkbenchIO['word']> = {
    open: async () => snapshot(),
    mutate: async (_session, request) => { calls.push(request); return new Promise(resolve => responses.push(resolve)) },
    save: async () => { saves++; return { ...file.word, savedRevision: file.revision } },
    proof: async () => null, stop: async () => {}, close: async () => {},
  }
  const edits = new WordEdits({ io: { word } as WorkbenchIO, session: () => 'fixture' as SessionId,
    get: () => file, put: (_path, next) => { file = next }, checkpoint: () => { checkpoints++ },
    error: () => {}, pendingMessage: () => 'Unconfirmed input retained' })
  return { edits, calls, responses, file: () => file, set: (next: WordEditorBuffer) => { file = next },
    saves: () => saves, checkpoints: () => checkpoints }
}
describe('Word acknowledgement and recovery', () => {
  it('ignores the final editor callback after its tab has closed', () => {
    const edits = new WordEdits({ io: {} as WorkbenchIO, session: () => 'closed' as SessionId,
      get: () => undefined, put: () => { throw new Error('Closed tab must not be recreated') },
      checkpoint: () => {}, error: () => {}, pendingMessage: () => '' })
    expect(() => edits.edit('closed.docx', 'old text', '{}', { from: 0, to: 0 }, 0, '{}')).not.toThrow()
    edits.dispose()
  })
  it('refuses the retired text-projection writer without mutating the open document', () => {
    const test = editing()
    expect(() => test.edits.edit('paper.docx', 'reconstructed text', '{}', { from: 0, to: 0 }, 0, '{}'))
      .toThrow('continuous DOCX writing board')
    expect(test.file().text).toBe('中文😀 alpha\n')
    expect(test.calls).toHaveLength(0)
    expect(test.saves()).toBe(0)
    test.edits.dispose()
  })
  it('retains unconfirmed input on restoration without replaying it', async () => {
    const test = editing()
    const restored = await test.edits.restore({ ...test.file(), pendingWord: { text: 'Unconfirmed\n', document: '{}' }, wordSync: 'syncing' })
    test.set(restored)
    expect(restored.pendingWord?.recovered).toBe(true)
    expect(restored.text).toBe('Unconfirmed\n')
    expect(restored.word.projection.text).toBe('中文😀 alpha\n')
    await test.edits.ready(['paper.docx'])
    expect(test.calls).toHaveLength(0)
    await expect(test.edits.flush('paper.docx')).rejects.toThrow('Unconfirmed input retained')
    test.edits.dispose()
  })
  it('treats format-only Word revisions as an unsaved original', () => {
    const file = wordBuffer(snapshot('unchanged\n', 3))
    expect(file.text).toBe(file.savedText)
    expect(file.saveState).toBe('dirty')
    expect(file.word.savedRevision).toBe(0)
  })
})


describe('native Word page selection', () => {
  it('uses native pages by default and for unmapped restored documents', () => {
    const file = wordBuffer(snapshot())
    expect(file.pane).toBe('pdf')
    expect(wordBuffer(snapshot(), { ...file, pane: 'visual' }).pane).toBe('visual')
    const unsupported = snapshot()
    unsupported.projection.readOnly = 'unmapped-structure'
    expect(wordBuffer(unsupported, { ...file, pane: 'visual' }).pane).toBe('pdf')
  })
  it('maps PDF line wrapping to the exact current UTF-16 source range', () => {
    const file = wordBuffer(snapshot())
    expect(wordPageSelection(file, '中文😀\nalpha')).toMatchObject({
      path: 'paper.docx', from: 0, to: 10, selectedText: '中文😀 alpha', bufferVersion: '0', origin: 'visual',
    })
  })
  it('does not map repeated text, protected objects or pending input to an editable selection', () => {
    expect(wordPageSelection(wordBuffer(snapshot('same same\n')), 'same')).toBeNull()
    const protectedFile = snapshot()
    protectedFile.projection.blocks[0]!.kind = 'protected'
    expect(wordPageSelection(wordBuffer(protectedFile), '中文')).toBeNull()
    expect(wordPageSelection({ ...wordBuffer(snapshot()), wordSync: 'pending' }, '中文')).toBeNull()
  })
})

describe('page input recovery', () => {
  it('retains multiline and Unicode input with the surrounding protected content', () => {
    const source = snapshot('中文😀 alpha\n')
    source.projection.blocks.push({ ...source.projection.blocks[0]!, id: 'field', kind: 'protected',
      text: 'Protected reference', from: source.projection.text.length, to: source.projection.text.length + 19 })
    source.projection.text += 'Protected reference\n'
    const text = '中文😄 first\nsecond alpha\nProtected reference\n'
    const pending = schema.nodeFromJSON(JSON.parse(wordDraftDocument(source.projection, text)))
    expect(wordText(pending)).toBe(text)
    expect(pending.lastChild?.type.name).toBe('wordObject')
    expect(pending.lastChild?.attrs.id).toBe('field')
    expect(source.projection.text).toBe('中文😀 alpha\nProtected reference\n')
  })
})
