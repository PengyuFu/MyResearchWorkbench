import { describe, expect, it } from 'vitest'
import { applyScientificProposal, allowsPartialProposal, scientificInsertion, scientificSelection } from '../src/client/proposal-operations.ts'
import { projectReferences } from '../src/client/project-references.ts'
import type { EditorBuffer, EditProposal } from '../src/client/types.ts'

function file(text: string): EditorBuffer {
  return {
    mode: 'writing', path: 'main.tex', absolutePath: '/fixture/main.tex', text, savedText: text, savedRawText: text,
    diskVersion: 'one', revision: 0, selection: { from: 0, to: 0 }, lineEnding: 'lf', scrollTop: 0, saveState: 'clean',
  }
}

describe('scientific selection and linked proposals', () => {
  it('expands an inner formula selection to the complete source object', () => {
    const source = String.raw`Before.

\begin{equation}\begin{cases}a&x>0\\b&x\leq0\end{cases}\label{eq:a}\end{equation}

After.`
    const buffer = file(source)
    buffer.selection = { from: source.indexOf('a&'), to: source.indexOf('a&') + 1 }
    const selection = scientificSelection(buffer, 'visual')!
    expect(selection.objectKind).toBe('formula')
    expect(selection.selectedText).toContain(String.raw`\begin{equation}`)
    expect(selection.selectedText).toContain(String.raw`\label{eq:a}`)
  })

  it('locates insertion after the focused paragraph and rejects frontmatter', () => {
    const buffer = file(String.raw`\documentclass{article}\title{Title}
\begin{document}
Body paragraph.

Next paragraph.
\end{document}`)
    buffer.selection = { from: buffer.text.indexOf('Body'), to: buffer.text.indexOf('Body') + 3 }
    const target = scientificInsertion(buffer, 'table')
    expect(buffer.text.slice(target.from)).toMatch(/^\s+Next paragraph/u)
    expect(target.from).toBe(target.to)
    buffer.selection = { from: buffer.text.indexOf('Title'), to: buffer.text.indexOf('Title') }
    expect(() => scientificInsertion(buffer, 'table')).toThrow('insertionBodyRequired')
  })

  it('renames a formula label and its same-file references in one exact undo operation', () => {
    const source = String.raw`% preserved
\begin{equation}a=b\label{eq:a}\end{equation}

See \eqref{eq:a} and \ref{eq:a}.
% \ref{eq:a} is a preserved comment`
    const buffer = file(source)
    const from = source.indexOf('\\begin')
    const to = source.indexOf('\\end{equation}') + '\\end{equation}'.length
    const replacement = source.slice(from, to).replace('{eq:a}', '{eq:b}')
    const proposal: EditProposal = { base: { path: 'main.tex', from, to, selectedText: source.slice(from, to),
      bufferVersion: '0', objectKind: 'formula' }, replacement, explanation: 'rename',
    labelChanges: [{ from: 'eq:a', to: 'eq:b' }] }
    expect(allowsPartialProposal(proposal)).toBe(false)
    const result = applyScientificProposal(buffer, proposal, from, to, replacement, false)
    expect(result.text).toContain(String.raw`See \eqref{eq:b} and \ref{eq:b}.`)
    expect(result.text).toContain(String.raw`% \ref{eq:a} is a preserved comment`)
    expect(result).toMatchObject({ from: 0, to: source.length, insert: result.text })
    expect(() => applyScientificProposal(buffer, proposal, from, to, replacement, true)).toThrow('atomicProposalRequired')
  })

  it('rejects label changes with unreviewed child-file dependencies', () => {
    const source = String.raw`\input{child}
\begin{equation}a=b\label{eq:a}\end{equation}`
    const buffer = file(source)
    const proposal: EditProposal = { base: { path: 'main.tex', from: 0, to: source.length,
      selectedText: source, bufferVersion: '0' }, replacement: source.replace('{eq:a}', '{eq:b}'), explanation: '',
    labelChanges: [{ from: 'eq:a', to: 'eq:b' }] }
    expect(() => applyScientificProposal(buffer, proposal, 0, source.length, proposal.replacement, false))
      .toThrow('linkedReferencesNeedProjectReview')
  })
})

describe('existing project references', () => {
  it('uses the main/child graph and bibliography, preserving duplicate definitions', async () => {
    const files: Record<string, string> = {
      'main.tex': String.raw`\input{chapters/methods}\label{sec:shared}\bibliography{references}`,
      'chapters/methods.tex': String.raw`\section{Methods}\label{sec:shared}`,
      'references.bib': '@article{known, title={Known}}\n@book{second, title={Second}}',
    }
    const read = async (path: string) => {
      const text = files[path]
      if (text === undefined) throw new Error('missing')
      return { path, text }
    }
    const labels = await projectReferences('chapters/methods.tex', 'main.tex', 'label', read)
    expect(labels.entries.filter(item => item.key === 'sec:shared')).toHaveLength(2)
    const citations = await projectReferences('chapters/methods.tex', 'main.tex', 'citation', read)
    expect(citations.entries.map(item => item.key)).toEqual(['known', 'second'])
    expect(citations.warnings).toBeUndefined()
  })

  it('reports a missing named bibliography without inventing entries', async () => {
    const result = await projectReferences('main.tex', 'main.tex', 'citation', async (path) => {
      if (path !== 'main.tex') throw new Error('not found')
      return { path, text: String.raw`\bibliography{missing}` }
    })
    expect(result.entries).toEqual([])
    expect(result.warnings).toEqual(['missing.bib: not found'])
  })
})
