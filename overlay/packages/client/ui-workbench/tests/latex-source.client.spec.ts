import { describe, expect, it } from 'vitest'
import {
  applyLatexPatches, createLatexMathPatch, createLatexTablePatch, inlineOffsetToSource,
  parseLatexDocument, parseLatexInline, serializeLatexTable, textToLatex, validateLatexReferences,
} from '../src/client/latex-source.ts'

const manuscript = String.raw`\documentclass{elsarticle}
% Keep this preamble exactly.
\newcommand{\unit}{\mathrm{m}}
\graphicspath{{figures/}{images/}}
\begin{document}
\begin{frontmatter}
\title{Synthetic manuscript}
\author[a]{Researcher\corref{cor}}
\address[a]{A department}
\begin{abstract}
An example with $a+b$ and 20\%.
\end{abstract}
\begin{keyword}Porous media\sep Flow\end{keyword}
\end{frontmatter}
\section{Introduction}\label{sec:intro}
中文😀 first paragraph with \textbf{bold text}, $x^2$, \citep{paperA} and \ref{eq:one}.

Second paragraph.
\begin{equation}
f(x)=\begin{cases}x,&x>0\\0,&x\leq0\end{cases}
\label{eq:one}
\end{equation}
\begin{equation}
\begin{aligned}a&=b\\c&=d\label{eq:two}\end{aligned}
\end{equation}
\begin{figure}[ht]
\includegraphics[width=.8\linewidth]{plot.eps}
\caption{A caption with $x$ and \citealp{paperA}.}
\label{fig:one}
\end{figure}
\begin{table}[ht]
\caption{A merged table}\label{tab:one}
\begin{adjustbox}{max width=\linewidth}
\begin{tabular}{lcc}
\toprule
Name & A & B\\
\midrule
\multirow{2}{*}{Group} & $1$ & 2\\
 & 3 & 4\\
\addlinespace
\multicolumn{3}{l}{A shared note}\\
\bottomrule
\end{tabular}
\end{adjustbox}
\end{table}
\input{methods}
\bibliography{references}
\end{document}`

describe('source-backed manuscript projection', () => {
  it('keeps the exact untouched source, including CRLF, Unicode and wrapped tables', () => {
    const source = manuscript.replaceAll('\n', '\r\n')
    const doc = parseLatexDocument(source, 'main.tex')
    expect(doc.source).toBe(source)
    expect(applyLatexPatches(source, [])).toBe(source)
    expect(doc.nodes.filter(n => n.kind === 'text')).toHaveLength(2)
    expect(doc.nodes.filter(n => n.kind === 'math')).toHaveLength(2)
    expect(doc.nodes.find(n => n.field === 'abstract')?.inline.some(t => t.kind === 'math')).toBe(true)
    expect(doc.graphicsPaths).toEqual(['figures/', 'images/'])
    expect(doc.includes.map(item => item.path)).toEqual(['methods'])
    expect(doc.diagnostics).toEqual([])
    for (const node of doc.nodes) {
      expect(source.slice(node.from, node.to)).toBe(node.raw)
      if (node.table) {
        expect(serializeLatexTable(node.table, node.table.rows)).toBe(source.slice(node.table.contentFrom, node.table.contentTo))
      }
      if (node.kind === 'math') expect(applyLatexPatches(source, [createLatexMathPatch(node, node.math!)])).toBe(source)
    }
  })

  it('changes only one formula and retains a label originally nested in aligned', () => {
    const doc = parseLatexDocument(manuscript)
    const node = doc.nodes.filter(n => n.kind === 'math')[1]!
    expect(node.math).not.toContain('label')
    expect(node.mathEmbeddedLabels).toHaveLength(1)
    const patch = createLatexMathPatch(node, node.math!.replace('a&=b', 'a&=2b'))
    const result = applyLatexPatches(manuscript, [patch])
    expect(result.slice(0, patch.from)).toBe(manuscript.slice(0, patch.from))
    expect(result.slice(patch.from + patch.insert.length)).toBe(manuscript.slice(patch.to))
    expect(result.match(/\\label\{eq:two\}/g)).toHaveLength(1)
    expect(parseLatexDocument(result).labels.map(label => label.key)).toEqual(doc.labels.map(label => label.key))
  })

  it('maps escaped text and surrogate pairs back to exact source positions', () => {
    const source = '中文😀 20\\%~of water, $x$ and \\ref{eq:a}.'
    const tokens = parseLatexInline(source)
    const prose = tokens[0]!
    expect(prose.text).toBe('中文😀 20%\u00a0of water, ')
    expect(inlineOffsetToSource(prose, prose.text.indexOf('%'))).toBe(source.indexOf('\\%'))
    expect(inlineOffsetToSource(prose, prose.text.indexOf('%') + 1)).toBe(source.indexOf('~'))
    const math = tokens.find(t => t.kind === 'math')!
    expect(inlineOffsetToSource(math, 0)).toBe(source.indexOf('$'))
    expect(inlineOffsetToSource(math, 1)).toBe(source.indexOf('$') + 3)
    expect(textToLatex('A&B 50%_#${}\\~^')).toBe(String.raw`A\&B 50\%\_\#\$\{\}\textbackslash{}\textasciitilde{}\textasciicircum{}`)
  })

  it('preserves table wrappers and merge arguments while editing a single cell', () => {
    const table = parseLatexDocument(manuscript).nodes.find(n => n.table)!.table!
    expect(table.columns).toBe(3)
    expect(table.rows).toHaveLength(4)
    expect(table.rows[1]!.cells[0]!.rowspan).toBe(2)
    expect(table.rows[2]!.cells[0]!.covered).toBe(true)
    expect(table.rows[3]!.cells[0]!.colspan).toBe(3)
    const cell = table.rows[1]!.cells[0]!
    const result = applyLatexPatches(manuscript, [{ from: cell.contentFrom, to: cell.contentTo, expected: 'Group', insert: 'Modified group' }])
    expect(result).toContain(String.raw`\multirow{2}{*}{Modified group}`)
    expect(result.replace('Modified group', 'Group')).toBe(manuscript)
    const rows = structuredClone(table.rows)
    rows[3]!.cells[0]!.inline = [{ kind: 'text', from: 0, to: 0, contentFrom: 0, contentTo: 0, raw: '', text: 'Changed note' }]
    const patch = createLatexTablePatch(table, rows)
    const modified = applyLatexPatches(manuscript, [patch])
    expect(modified).toContain(String.raw`\multicolumn{3}{l}{Changed note}`)
    expect(modified).toContain('\\toprule')
    expect(modified).toContain('\\midrule')
    expect(modified).toContain('\\bottomrule')
    expect(modified.slice(0, table.contentFrom)).toBe(manuscript.slice(0, table.contentFrom))
    expect(modified.slice(patch.from + patch.insert.length)).toBe(manuscript.slice(table.contentTo))
  })

  it('rejects stale, overlapping and character-splitting edits before returning a result', () => {
    expect(() => applyLatexPatches('abc', [{ from: 0, to: 1, insert: 'A', expected: 'z' }])).toThrow('LATEX_PATCH_STALE')
    expect(() => applyLatexPatches('abc', [{ from: 0, to: 2, insert: 'A' }, { from: 1, to: 3, insert: 'B' }])).toThrow('LATEX_PATCH_OVERLAP')
    expect(() => applyLatexPatches('😀', [{ from: 1, to: 2, insert: 'x' }])).toThrow('LATEX_PATCH_OVERLAP_OR_CHARACTER')
    expect(() => applyLatexPatches('abc', [{ from: -1, to: 0, insert: 'x' }])).toThrow('LATEX_PATCH_RANGE')
  })

  it('keeps unsupported environments explicit and reports missing identities', () => {
    const doc = parseLatexDocument(String.raw`\section{Example}\label{sec:a}
Text \ref{missing} and \citep{unknown}.
\begin{custom}Unmapped object\end{custom}`)
    expect(doc.nodes.find(n => n.kind === 'opaque')?.editable).toBe(false)
    expect(doc.diagnostics.map(d => d.code)).toContain('UNSUPPORTED_ENVIRONMENT')
    expect(validateLatexReferences(doc, ['sec:a'], []).map(d => d.code)).toEqual(['MISSING_REFERENCE', 'MISSING_CITATION'])
  })
})
