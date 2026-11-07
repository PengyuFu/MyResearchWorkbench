import { describe, expect, it } from 'vitest'
import { parseLatexDocument } from '../src/client/latex-source.ts'
import { compileVisualDocument, mapSourceSelection, mapVisualSelection, projectVisualDocument, visualNodeSize } from '../src/client/visual-projection.ts'
import type { VisualNode } from '../src/client/visual-projection.ts'

const manuscript = String.raw`% Keep this source header.
\documentclass{article}
\usepackage{amsmath,multirow,booktabs,graphicx}
\begin{document}
\begin{frontmatter}
\title{A \emph{careful} title}
\author[one]{An Author}
\begin{abstract}
Abstract with $a+b$ and 15\%.
\end{abstract}
\begin{keyword}water\sep porous media\end{keyword}
\end{frontmatter}
\section{Methods}\label{sec:methods}
First  paragraph has 20\% and $x^2$; see \eqref{eq:main} and \citep[p.~2]{refA}.

Second paragraph keeps its \textbf{bold words}.
% Keep the neighboring comment.
\begin{equation}
\begin{aligned}a&=b\\ c&=d\label{eq:main}\end{aligned}
\end{equation}
\begin{figure}[htbp]
\centering
\includegraphics[width=0.75\linewidth]{figures/a.eps}
\caption[Short]{Caption with $Q$ and \ref{sec:methods}.}
\label{fig:a}
\end{figure}
\begin{table}[htbp]
\caption{A small table}
\begin{adjustbox}{max width=\linewidth}
\begin{tabular}{lc}
\toprule
Name & Value\\
\midrule
\multirow{2}{*}{Water} & $1$\\
 & $2$\\
\bottomrule
\end{tabular}
\end{adjustbox}
\label{tab:a}
\begin{minipage}{\linewidth}\footnotesize Note with $z$.\end{minipage}
\end{table}
\end{document}
`.replace(/\n/g, '\r\n')

function project(source = manuscript): VisualNode { return projectVisualDocument(parseLatexDocument(source, 'synthetic.tex')) }
function find(node: VisualNode, predicate: (node: VisualNode) => boolean): VisualNode | undefined {
  if (predicate(node)) return node
  for (const child of node.content ?? []) { const match = find(child, predicate); if (match) return match }
  return undefined
}
function positionOf(document: VisualNode, target: VisualNode): number {
  const walk = (node: VisualNode, start: number): number => {
    if (node === target) return start
    let at = node.type === 'doc' ? start : start + 1
    for (const child of node.content ?? []) { const found = walk(child, at); if (found >= 0) return found; at += visualNodeSize(child) }
    return -1
  }
  return walk(document, 0)
}

describe('lossless visual projection', () => {
  it('projects standard article preamble metadata without touching definitions or wrappers', () => {
    const source = String.raw`% Preserve this header and commented \title{hidden}.
\documentclass{article}
\newcommand{\example}{\title{definition only}}
\title[Short]{A preamble title}
\author{An Author}
\address[one]{An Institute}
\ead{mail@example.test}
\cortext[cor]{Corresponding author}
\begin{document}
\maketitle
Body with $x$.
\end{document}
`.replace(/\n/g, '\r\n')
    const doc = project(source)
    expect(doc.content?.filter(node => node.type === 'field').map(node => node.attrs?.field)).toEqual(['title', 'author', 'address', 'ead', 'cortext'])
    expect(compileVisualDocument(doc).source).toBe(source)
    const title = find(doc, node => node.type === 'field' && node.attrs?.field === 'title')!
    title.content![0]!.text = 'Edited title'
    expect(compileVisualDocument(doc).source).toBe(source.replace('A preamble title', 'Edited title'))
  })

  it('round trips all supported objects, CRLF, comments and wrappers exactly', () => {
    const doc = project()
    const result = compileVisualDocument(doc)
    expect(result.source).toBe(manuscript)
    expect(result.maps.length).toBeGreaterThan(30)
  })

  it('edits text within an escaped token and recomputes subsequent selection offsets', () => {
    const doc = project()
    const text = find(doc, node => !!node.text?.startsWith('First paragraph'))!
    text.text = text.text!.replace('First', 'A longer first')
    const math = find(doc, node => node.type === 'mathInline' && node.attrs?.latex === 'x^2')!
    const ref = find(doc, node => node.type === 'reference' && node.attrs?.key === 'eq:main')!
    const result = compileVisualDocument(doc)
    expect(result.source).toBe(manuscript.replace('First', 'A longer first'))
    const selection = mapVisualSelection(result, { from: positionOf(doc, math), to: positionOf(doc, ref) + 1 })!
    expect(result.source.slice(selection.from, selection.to)).toBe('$x^2$; see \\eqref{eq:main}')
    expect(mapSourceSelection(result, selection)).toEqual({ from: positionOf(doc, math), to: positionOf(doc, ref) + 1 })
  })

  it('keeps nested formula labels inside their equation after math edits', () => {
    const doc = project()
    const equation = find(doc, node => node.type === 'mathBlock')!
    equation.attrs!.latex = String.raw`\begin{cases}a+b&x>0\\c&x\leq0\end{cases}`
    equation.attrs!.label = 'eq:changed'
    const source = compileVisualDocument(doc).source
    expect(source).toContain(String.raw`\label{eq:changed}`)
    expect(source).not.toContain(String.raw`\label{eq:main}`)
    expect(source.slice(0, source.indexOf('\\begin{equation}'))).toBe(manuscript.slice(0, manuscript.indexOf('\\begin{equation}')))
    expect(source.slice(source.indexOf('\\end{equation}'))).toBe(manuscript.slice(manuscript.indexOf('\\end{equation}')))
  })

  it('changes one table cell without rewriting neighboring source or span wrappers', () => {
    const doc = project()
    const text = find(doc, node => node.type === 'text' && node.text === 'Water')!
    text.text = 'Oil & water'
    const source = compileVisualDocument(doc).source
    expect(source).toBe(manuscript.replace('{Water}', '{Oil \\& water}'))
  })

  it('inserts and removes rows, merges cells, and preserves outer table layout', () => {
    const doc = project()
    const table = find(doc, node => node.type === 'table')!
    const header = table.content![0]!
    header.content = [{ type: 'tableCell', attrs: { colspan: 2, rowspan: 1, sourceCell: header.content![0]!.attrs!.sourceCell ?? null }, content: [header.content![0]!.content![0]!, header.content![1]!.content![0]!] }]
    table.content!.push({ type: 'tableRow', content: ['New', '3'].map(text => ({ type: 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })) })
    const source = compileVisualDocument(doc).source
    expect(source).toContain(String.raw`\multicolumn{2}{c}{\shortstack[l]{Name\\Value}}`)
    expect(source).toContain('New & 3\\\\')
    expect(source).toContain(String.raw`\begin{adjustbox}{max width=\linewidth}`)
    expect(source).toContain('\\bottomrule')
    const reparsed = parseLatexDocument(source)
    expect(reparsed.diagnostics).toEqual([])
    expect(reparsed.nodes.find(node => node.table)!.table!.rows).toHaveLength(4)
    table.content!.pop()
    expect(compileVisualDocument(doc).source).not.toContain('New & 3')
  })

  it('handles paragraph split, rich text merge, duplicate IDs and explicit reordering rejection', () => {
    const doc = project('Before $x$.\n\nAfter \\emph{y}.')
    const before = doc.content![0]!
    const after = doc.content![1]!
    before.content!.push({ type: 'text', text: ' Joined ' }, ...after.content!)
    doc.content = [before, { type: 'paragraph', attrs: { sourceId: before.attrs!.sourceId ?? null }, content: [{ type: 'text', text: 'Added.' }] }]
    const source = compileVisualDocument(doc).source
    expect(source).toContain('Before $x$. Joined After \\emph{y}.')
    expect(source).toContain('Added.')
    expect(source.match(/After/g)).toHaveLength(1)
    const reordered = project('One.\n\nTwo.')
    reordered.content!.reverse()
    expect(() => compileVisualDocument(reordered)).toThrow('VISUAL_REORDER_UNSUPPORTED')
  })

  it('updates figure caption, image path and label while preserving options', () => {
    const doc = project()
    const figure = find(doc, node => node.type === 'figure')!
    const image = figure.content!.find(node => node.type === 'image')!
    image.attrs!.path = 'figures/new.eps'
    const caption = figure.content!.find(node => node.type === 'caption')!
    caption.content![0]!.text = 'Updated caption with '
    const label = figure.content!.find(node => node.type === 'label')!
    label.content![0]!.text = 'fig:new'
    const source = compileVisualDocument(doc).source
    expect(source).toBe(manuscript.replace('figures/a.eps', 'figures/new.eps').replace('Caption with', 'Updated caption with').replace('{fig:a}', '{fig:new}'))
  })

  it('keeps surviving column alignment when inserting or deleting an interior column', () => {
    const source = String.raw`\begin{table}\begin{tabular}{lcr}Left & Center & Right\\\end{tabular}\end{table}`
    const inserted = project(source)
    const row = find(inserted, node => node.type === 'tableRow')!
    row.content!.splice(1, 0, { type: 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'New' }] }] })
    expect(compileVisualDocument(inserted).source).toContain('\\begin{tabular}{lccr}')
    const removed = project(source)
    find(removed, node => node.type === 'tableRow')!.content!.splice(1, 1)
    expect(compileVisualDocument(removed).source).toContain('\\begin{tabular}{lr}')
  })

  it('omits empty labels on new objects and removes a deliberately cleared old label', () => {
    const doc = project('A paragraph.')
    doc.content!.push({ type: 'figure', attrs: { sourceId: null }, content: [
      { type: 'image', attrs: { path: 'figures/new.pdf' } },
      { type: 'caption', content: [{ type: 'text', text: 'New caption' }] },
      { type: 'label', content: [] },
    ] })
    expect(compileVisualDocument(doc).source).not.toContain('\\label{}')
    const existing = project()
    find(existing, node => node.type === 'figure')!.content!.find(node => node.type === 'label')!.content = []
    const result = compileVisualDocument(existing).source
    expect(result).not.toContain('\\label{fig:a}')
    expect(result).not.toContain('\\label{}')
  })
})
