// @vitest-environment jsdom
/** Hierarchical manuscript navigation preserves document positions and current selection. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ManuscriptOutline } from '../src/client/ManuscriptOutline.tsx'

afterEach(cleanup)
it('nests headings, folds branches and navigates duplicate titles by position', () => {
  const navigate = vi.fn()
  const entries = [
    { position: 0, level: 0, label: 'Title' },
    { position: 10, level: 1, label: 'Methods' },
    { position: 20, level: 2, label: 'Baseline' },
    { position: 30, level: 3, label: 'Grid' },
    { position: 40, level: 1, label: 'Results' },
    { position: 50, level: 2, label: 'Baseline' },
  ]
  const view = render(<ManuscriptOutline entries={entries} currentPosition={55} onNavigate={navigate} t={key => key} />)
  const trigger = view.container.querySelector('summary') as HTMLElement
  fireEvent.click(trigger)
  const methods = screen.getByRole('button', { name: 'Methods' }).closest('li') as HTMLElement
  expect(within(methods).getByRole('button', { name: 'Grid' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'visualCollapseSection: Methods' }))
  expect(screen.queryByRole('button', { name: 'Grid' })).toBeNull()
  const baseline = screen.getByRole('button', { name: 'Baseline' })
  expect(baseline.getAttribute('aria-current')).toBe('location')
  fireEvent.click(baseline)
  expect(navigate).toHaveBeenCalledWith(50)
  expect(screen.queryByRole('navigation')).toBeNull()
  view.rerender(<ManuscriptOutline entries={entries.map(entry => entry.position === 50 ? { ...entry, label: 'Revised' } : entry)} currentPosition={55} onNavigate={navigate} t={key => key} />)
  fireEvent.click(trigger)
  expect(screen.getByRole('button', { name: 'Revised' })).toBeTruthy()
  fireEvent.keyDown(trigger, { key: 'Escape' })
  expect(screen.queryByRole('navigation')).toBeNull()
  expect(document.activeElement).toBe(trigger)
})
