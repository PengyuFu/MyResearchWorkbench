// @vitest-environment jsdom
/**
 * The floating plan window surface: it renders the same board, offers docking back
 * to the embedded panel, and hides itself through the Desktop bridge without
 * stopping anything.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { PlanSnapshot } from '@deepseek-ai/dsh-personal-plan/client'
import { PlanWindow, type PlanWindowProps } from '../src/client/PlanWindow.tsx'
import type { PlanInjected, PlanViewState } from '../src/client/plan-source.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  delete (globalThis as { dshDesktop?: unknown }).dshDesktop
})

/** An empty authoritative snapshot. */
function snapshot(): PlanSnapshot {
  return { revision: 1, items: [], tasks: [], proposal: null, run: null, updatedAt: '2026-10-22T00:00:00.000Z' }
}

/** The bridge the Desktop preload exposes. */
function installBridge(): { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn(async () => {})
  ;(globalThis as { dshDesktop?: unknown }).dshDesktop = {
    planWindow: { open: vi.fn(async () => {}), close, focusMain: vi.fn(async () => {}) },
  }
  return { close }
}

/**
 * Render the floating surface over one fixed view state.
 * @returns the dock spy and the Desktop bridge spy.
 */
function mount() {
  const state: PlanViewState = {
    snapshot: snapshot(), status: 'ready', saving: false, saveError: null, stale: false, runError: null,
  }
  const dockBack = vi.fn()
  const bridge = installBridge()
  const face = {
    retry: vi.fn(async () => {}),
    addItem: vi.fn(async () => true),
    updateItem: vi.fn(async () => true),
    deleteItem: vi.fn(async () => true),
    setStatus: vi.fn(async () => true),
    reorder: vi.fn(async () => true),
    addTask: vi.fn(async () => true),
    updateTask: vi.fn(async () => true),
    deleteTask: vi.fn(async () => true),
    reorderTasks: vi.fn(async () => true),
    applyProposal: vi.fn(async () => true),
    discardProposal: vi.fn(async () => true),
    startRun: vi.fn(async () => 'ok'),
    stopRun: vi.fn(async () => 'ok'),
    revealSession: vi.fn(async () => true),
    revealTaskSession: vi.fn(async () => 'ok'),
    requestPanel: vi.fn(async () => true),
  } satisfies Omit<PlanInjected, 'hooks'>
  const props: Partial<PlanWindowProps> = {
    usePlan: <T,>(select: (value: PlanViewState) => T): T => select(state),
    t: makeTranslate(zh) as PlanWindowProps['t'],
    dockBack,
    ...face,
  }
  render(<PlanWindow {...(props as PlanWindowProps)} />)
  return { dockBack, bridge }
}

describe('floating plan window', () => {
  it('renders the same board inside the window surface', () => {
    mount()
    expect(document.querySelector('[data-plan-window]')).toBeTruthy()
    expect(document.querySelector('[data-plan-board="window"]')).toBeTruthy()
    expect(screen.getByText('计划')).toBeTruthy()
    expect(screen.getByText('任务')).toBeTruthy()
  })

  it('docks back through the injected action', () => {
    const { dockBack } = mount()
    fireEvent.click(screen.getByRole('button', { name: '收回主窗口' }))
    expect(dockBack).toHaveBeenCalledTimes(1)
  })

  it('hides only itself when closed', async () => {
    const { bridge } = mount()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '关闭浮窗' })) })
    expect(bridge.close).toHaveBeenCalledTimes(1)
  })

  it('offers no float action inside the floating window', () => {
    mount()
    expect(screen.queryByRole('button', { name: '浮出为独立窗口' })).toBeNull()
  })
})
