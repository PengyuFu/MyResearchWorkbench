// @vitest-environment jsdom
/** Identical changed tokens must remain distinguishable in a real review card. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Proposal } from '../src/client/Proposal.tsx'
import { en } from '../src/client/locales.ts'
import type { EditProposal, SelectionSnapshot } from '../src/client/types.ts'

afterEach(cleanup)

describe('workbench proposal context', () => {
  it('keeps a compact result reviewable and switches detail views without accepting it', () => {
    const selectedText = 'Original sentence.'
    const base: SelectionSnapshot = { path: 'draft.txt', from: 0, to: selectedText.length, selectedText,
      contextBefore: '', contextAfter: '', bufferVersion: '1', lineFrom: 1, lineTo: 1 }
    const props = { proposal: { base, replacement: 'Clearer sentence.', explanation: '' }, selection: base,
      stale: false, accept: vi.fn(), discard: vi.fn(), refine: vi.fn(), locate: vi.fn(),
      onDetails: vi.fn(), onDocument: vi.fn(), t: (key: keyof typeof en) => en[key], fontSize: 16,
      mathFontsDirectory: '', resolveAsset: async () => ({ url: 'blob:fixture', mimeType: 'image/png' }) }
    const view = render(<Proposal {...props} presentation="compact" />)
    expect(view.getByLabelText(en.afterChange).textContent).toBe('Clearer sentence.')
    expect(view.getAllByRole('button').slice(-4).map(button => button.textContent)).toEqual([
      en.accept, en.discard, en.proposalDetails, en.refine,
    ])
    fireEvent.click(view.getByRole('button', { name: en.proposalDetails }))
    expect(props.onDetails).toHaveBeenCalledOnce()
    view.rerender(<Proposal {...props} presentation="detail" />)
    fireEvent.click(view.getByRole('button', { name: en.returnDocument }))
    expect(props.onDocument).toHaveBeenCalledOnce()
    expect(props.accept).not.toHaveBeenCalled()
    view.rerender(<Proposal {...props} presentation="compact" stale />)
    expect(view.getByRole('button', { name: en.accept }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(view.getByRole('button', { name: en.discard }))
    expect(props.discard).toHaveBeenCalledOnce()
  })

  it('shows exact source lines and surrounding line text without changing hunk acceptance', () => {
    const selectedText = 'TOKEN = "first";\nconst unchanged = "Enough unchanged content to keep the two token edits separate.";\nconst OMEGA_TOKEN = "last";'
    const selection: SelectionSnapshot = {
      path: 'sample.cpp', from: 120, to: 120 + selectedText.length, selectedText,
      contextBefore: 'earlier content\nconst ALPHA_', contextAfter: ' // trailing context\nnext line',
      bufferVersion: '3', lineFrom: 12, lineTo: 14,
    }
    const proposal: EditProposal = { base: selection, replacement: selectedText.replaceAll('TOKEN', 'REVISED'), explanation: '' }
    const accept = vi.fn()
    const view = render(<Proposal presentation="detail" onDetails={vi.fn()} onDocument={vi.fn()} proposal={proposal} selection={selection} stale={false} accept={accept}
      discard={vi.fn()} refine={vi.fn()} locate={vi.fn()} t={key => en[key]}
      fontSize={17} mathFontsDirectory="/local-fonts" resolveAsset={async () => ({ url: 'blob:fixture', mimeType: 'image/png' })} />)
    expect(view.getByText('1 / 2 · Source line 12')).toBeTruthy()
    expect(view.getByText('2 / 2 · Source line 14')).toBeTruthy()
    const context = view.getAllByLabelText('Source line context')
    expect(context.map(element => element.textContent)).toEqual([
      'const ALPHA_TOKEN = "first";', 'const OMEGA_TOKEN = "last"; // trailing context',
    ])
    const buttons = view.getAllByRole('button', { name: 'Accept change' })
    const second = buttons[1]
    if (second === undefined) throw new Error('Second independent change is missing')
    fireEvent.click(second)
    expect(accept.mock.calls).toEqual([[1]])
  })
})
